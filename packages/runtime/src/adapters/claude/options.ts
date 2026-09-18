/**
 * Построение опций запроса для Claude Agent SDK.
 *
 * SDK-функция `query()` принимает огромный меш опций, но верхние слои (api, agent)
 * оперируют runtime-нейтральным контрактом: RuntimeRunInput плюс непрозрачный меш
 * `hooks`. Этот модуль - единственное место, где намерение превращается в конкретные
 * опции Claude: разрешения, хуки, окружение запускаемого `claude`, модель, effort,
 * возобновление сессий.
 *
 * Правило приоритета в модуле единообразно: структурированное поле на `exec`
 * (RuntimeExecutionIntent) важнее одноименного значения из мешa `hooks`, а меш важнее
 * умолчания. Меш `hooks` - это Record<string, unknown>: он пересекает границы пакетов
 * без строгой типизации, поэтому каждое чтение сопровождается typeof-проверкой и
 * явным фолбэком undefined. Здесь действует тот же дух, что и в Nullable Cast Rule:
 * тип не «уточняется» кастом в обход рантайм-проверки.
 *
 * Обход разрешений (bypassPermissions) закрощен двойным затвором: его нет без
 * доверенного токена (../../trust.ts), поэтому произвольные данные из профиля или UI
 * не могут включить его самостоятельно - токен непроксируется через JSON и доступен
 * только внутреннему коду оркестратора.
 */

import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type {
  RuntimeEvent,
  RuntimeRunInput,
  RuntimeSessionForkInput,
  RuntimeSubagentStartCallback,
  RuntimeToolUseCallback,
} from "../../types.js";
import { isValidTrustToken } from "../../trust.js";
import { buildClaudeHooks } from "./hooks.js";
import { PROXY_ENV_VARS } from "../../proxyEnv.js";
import { CLAUDE_MODEL_EFFORT_LEVELS, resolveModelEffortOption } from "../../modelEffort.js";

// Промежуточное представление намерения выполнения после разбора меша hooks.
// Все поля опциональны и не имеют дефолтов здесь: «не задано» и «задано как false/0» -
// разные состояния для SDK, и различие сохраняется до самого buildClaudeQueryOptions.
export interface ClaudeRuntimeExecutionOptions {
  // null означает «бюджета нет вообще», undefined - «лимит не задавали»; SDK различает
  // эти состояния, поэтому тип явно союзный, а не просто optional.
  maxBudgetUsd?: number | null;
  // Имя агента из .claude/agents: уезжает в extraArgs как `--agent`, а само определение
  // читает Claude Code, а не наш адаптер - отсюда только строка.
  agentDefinitionName?: string;
  // Литералы двух наших сценариев дополнены `| string`: SDK знает и другие режимы
  // разрешений, и адаптер не сужает чужие значения до собственного словаря.
  permissionMode?: "acceptEdits" | "bypassPermissions" | string;
  // Отдельный флаг, а не значение permissionMode: он управляет опасным параметром
  // обхода и потому проверяется вместе с trust-токеном.
  allowDangerouslySkipPermissions?: boolean;
  // Путь к бинарнику `claude` в обход PATH: нужен в Docker, где PATH минимален, и в
  // тестах с подставным исполняемым файлом.
  pathToClaudeCodeExecutable?: string;
  // Откуда SDK берет настройки: по умолчанию только проект, чтобы пользовательский
  // ~/.claude не менял поведение агента исподтишка.
  settingSources?: string[];
  // Меш настроек SDK, прошедший через parseSdkSettings: сохраняет и attribution, и
  // незнакомые нам ключи.
  settings?: ClaudeSdkSettings;
  // Текст, дописываемый к системному промпту preset'а (контекст конкретной задачи).
  systemPromptAppend?: string;
  // Хуки - живые функции, а не данные: они не переживают сериализацию и создаются
  // только внутри процесса уже после разбора меша.
  postToolUseHooks?: HookCallback[];
  subagentStartHooks?: HookCallback[];
  // Запрос потоковых частичных сообщений: нужен живым стримам в UI, но повышает шум
  // в событиях, поэтому по умолчанию выключен.
  includePartialMessages?: boolean;
  // Ограничение числа шагов агента: страховка от зацикливания, а не средство
  // управления стоимостью (для стоимости есть maxBudgetUsd).
  maxTurns?: number;
  // Таймауты разделены на «старт» (ожидание первого вывода) и «ран» (общий потолок):
  // это разные сбои, и лечатся они по-разному.
  queryStartTimeoutMs?: number;
  queryStartRetryDelayMs?: number;
  runTimeoutMs?: number;
  // Переопределения окружения для дочернего процесса (независимо от транспорта).
  environment?: Record<string, string>;
  // Потоковые колбэки необязательны: без них запрос работает, просто становится
  // «чёрным ящиком» для вызывающего кода.
  stderr?: (chunk: string) => void;
  onEvent?: (event: RuntimeEvent) => void;
  abortController?: AbortController;
  onToolUse?: RuntimeToolUseCallback;
  onSubagentStart?: RuntimeSubagentStartCallback;
}

// Узкое подмножество pino-логгера: опциональные методы позволяют собирать опции без
// логгера (тесты), а вызовы пишутся через logger?.debug?.(...) без веток.
export interface ClaudeOptionsLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

// Сужение недоверенного значения до записи: null при отсутствии объекта, поэтому
// каждый читатель обязан проверить результат перед доступом к полям (Nullable Cast
// Rule). Массивы здесь не отбраковываются, как в парсерах payload'ов: у массива нет
// именованных полей, чтения вернут undefined, и значение просто уйдёт в фолбэк.
function toRecord(value: unknown): Record<string, unknown> | null {
  // Проверка `value != null` покрывает разом и null, и undefined: `!=` (нестрогое
  // сравнение) здесь уместно именно из-за этой двойной семантики, хотя в остальном
  // коде предпочтение отдается строгому `!==`.
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Claude Code SDK `settings` — расширяемый меш, передаваемый запускаемому
 * `claude` дословно. AIF формирует только `attribution`; любой другой ключ
 * (например `outputStyle`, `sandbox`, настройки разрешений) проходит без изменений.
 *
 * Семантика attribution (docs Agent SDK / Claude Code):
 *   - `commit` / `pr` в пустую строку → скрывают этот attribution.
 *   - поле отсутствует → Claude Code применяет свой дефолтный attribution.
 * Пустые строки — задокументированный механизм подавления, они передаются
 * как есть и НЕ нормализуются. Старые сборки Claude Code
 * (<2.1.x fixed) отвергали пустые строки на старте — краш это баг версии,
 * а не причина срезать контракт подавления.
 */
// Тип сознательно не перечисляет все ключи SDK: AIF формирует только attribution,
// а остальное («песочница», стили вывода) проходит насквозь без потерь, поэтому
// индексная сигнатура сохраняет меш открытым, а не превращает его в whitelist.
export type ClaudeSdkSettings = { attribution?: { commit?: string; pr?: string } } & Record<
  string,
  unknown
>;

/**
 * Разбирает непрозрачный меш SDK `settings` из `RuntimeExecutionIntent.hooks`,
 * сохраняя каждый ключ (attribution + любые дополнения). Возвращает `undefined`
 * для null/не-объекта, чтобы вызывающий применил собственный default.
 */
// Валидации по замыслу нет: это pass-through меш, и строгая типизация здесь лишь
// тихо вырезала бы незнакомые ключи SDK, с которыми мы не работали.
function parseSdkSettings(raw: unknown): ClaudeSdkSettings | undefined {
  const rec = toRecord(raw);
  return rec ? (rec as ClaudeSdkSettings) : undefined;
}

// Санация окружения: дочерний процесс принимает только строковые значения, поэтому
// числа и null из профиля вырезаются - иначе spawn упал бы далеко от места ошибки.
// Фильтр с type predicate (`entry is [string, string]`) убирает каст законно: после
// filter TypeScript сам видит тип массива пар без приведений.
function toStringRecord(value: Record<string, unknown> | null): Record<string, string> | undefined {
  // Отсутствие значения и пустой объект не различаются: с точки зрения потребителя
  // «переопределений нет» и «переопределения пустые» - одно и то же состояние.
  if (!value) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return Object.fromEntries(entries);
}

/**
 * Разрешает per-profile переопределения окружения из `profile.options.environment`.
 *
 * Читает `Record<string, string>` из блока options профиля и возвращает
 * его как plain-карту ключ/значение (не-строки отбрасываются). Возвращает
 * `undefined`, когда переопределений не настроено.
 *
 * Массивы явно отвергаются, хотя `typeof [] === "object"` — без
 * этой защиты профиль вида `environment: ["x"]` просочился бы как
 * env-запись `{ "0": "x" }`, что противоречит документированному контракту.
 *
 * Используется и SDK-путём (через `parseExecutionOptions`), и CLI-путём
 * (через `buildCuratedEnv` в `cli.ts`), так что одно поле профиля доходит до
 * запускаемого `claude` вне зависимости от транспорта. Типовой кейс:
 * фиксация `CLAUDE_CONFIG_DIR` на профиль, чтобы разные проекты Handoff жили
 * в разных домашних каталогах `~/.claude/` (мульти-аккаунт) без
 * мутации окружения host-процесса.
 */
export function resolveProfileEnvironment(
  input: RuntimeRunInput,
): Record<string, string> | undefined {
  // Проверка массива - та самая ловушка из документации выше: typeof [] === "object",
  // и без Array.isArray профиль вида environment: ["x"] просочился бы в переменные
  // окружения как { "0": "x" }, нарушая задокументированный контракт.
  const candidate = toRecord(input.options)?.environment;
  if (candidate == null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }
  // Каст к Record<string, unknown> здесь не сужает доверие: выше уже проверено, что это
  // не-массив объект, а каст лишь переводит `object` в форму, которую понимает
  // строковый фильтр внутри toStringRecord.
  return toStringRecord(candidate as Record<string, unknown>);
}

// Утиная типизация поверх union'а: запрос форка приходит как расширенный
// RuntimeRunInput, и поле ищется через Partial-каст для чтения. Каст здесь безопасен:
// он не снимает nullable и не сужает доверие - фактическое наличие строки проверяет
// typeof в рантайме, а без проверки строка могла бы оказаться undefined.
function readForkSourceSessionId(input: RuntimeRunInput): string | null {
  // Утиная типизация: sourceSessionId есть только у запросов форка, поэтому поле ищется
  // через Partial-каст и проверяется в рантайме. Возвращается нормализованное значение:
  // пробельная строка не считается валидным id сессии.
  const sourceSessionId = (input as Partial<RuntimeSessionForkInput>).sourceSessionId;
  return typeof sourceSessionId === "string" && sourceSessionId.trim().length > 0
    ? sourceSessionId.trim()
    : null;
}

// ---------------------------------------------------------------------------------
// Разбор входного намерения (RuntimeRunInput + меш hooks) в опции выполнения Claude.
// ---------------------------------------------------------------------------------

/**
 * Разбирает универсальный RuntimeExecutionIntent + специфичные для Claude hooks в ClaudeRuntimeExecutionOptions.
 */
// Универсальный разбор: структурированный `exec` (намерение, понятное всем рантаймам)
// имеет приоритет над специфичным для Claude мешом `hooks`. Оба источника читаются
// с typeof-проверками: exec может отсутствовать у старых вызывающих, а hooks -
// пересекает границы пакетов как Record<string, unknown>.
export function parseExecutionOptions(
  input: RuntimeRunInput,
  adapterDefaults?: { pathToClaudeCodeExecutable?: string },
): ClaudeRuntimeExecutionOptions {
  const exec = input.execution;
  // Меш копируется: разбор читает поля из стабильного снимка, и даже если вызывающий
  // код изменит исходный объект позже, опции этого запуска от этого не поплывут.
  const hooks = (exec?.hooks ?? {}) as Record<string, unknown>;
  const src = { ...hooks };

  // Многоступенчатая цепочка приоритетов на примере maxBudgetUsd: сначала exec, потом
  // число из меша, потом явный null («без бюджета»), иначе undefined («не сказано»).
  // Различение null/undefined сохраняется специально: SDK и cli.ts по-разному
  // трактуют «лимита нет вообще» и «лимита не задавали».
  // Важно про `??`: он пропускает только null и undefined, в отличие от `||`, который
  // отбросил бы и 0, и пустую строку. Для числовых лимитов это принципиально: 0 -
  // валидное значение «не тратить дополнительно», и его нельзя спутать с отсутствием.
  const maxBudgetUsd =
    exec?.maxBudgetUsd !== undefined
      ? exec.maxBudgetUsd
      : typeof src.maxBudgetUsd === "number"
        ? src.maxBudgetUsd
        : src.maxBudgetUsd === null
          ? null
          : undefined;

  return {
    maxBudgetUsd,
    // agentDefinitionName ищется сначала в структурированном intent, и только потом в
    // меше: так вызывающий может переопределить агента программно, не пересобирая меш.
    agentDefinitionName:
      exec?.agentDefinitionName ??
      (typeof src.agentDefinitionName === "string" ? src.agentDefinitionName : undefined),
    // Структурированный запрос обхода важнее permissionMode из меша: exec приходит из
    // управляемого кода workflow'ов, а меш - из данных профиля, которым доверие ниже.
    permissionMode: exec?.bypassPermissions
      ? "bypassPermissions"
      : typeof src.permissionMode === "string"
        ? src.permissionMode
        : undefined,
    // Двойной затвор обхода разрешений: запрос из intent (или булев флаг в меше) И
    // валидный trust-токен. Токен - непрозрачный Symbol (см. ../../trust.ts): его
    // нельзя подделать через JSON или данные из UI, поэтому флаг доходит до SDK только
    // при вызове из доверенного внутреннего кода оркестратора.
    allowDangerouslySkipPermissions:
      (exec?.bypassPermissions ||
        (typeof src.allowDangerouslySkipPermissions === "boolean" &&
          src.allowDangerouslySkipPermissions)) &&
      isValidTrustToken(src._trustToken)
        ? true
        : undefined,
    pathToClaudeCodeExecutable:
      typeof src.pathToClaudeCodeExecutable === "string"
        ? src.pathToClaudeCodeExecutable
        : adapterDefaults?.pathToClaudeCodeExecutable,
    // Array.isArray + фильтр по typeof: меш может содержать что угодно, а SDK ждет
    // именно строки; незнакомые элементы молча отбрасываются, вместо того чтобы ломать
    // запуск на этапе spawn.
    settingSources: Array.isArray(src.settingSources)
      ? src.settingSources.filter((value): value is string => typeof value === "string")
      : undefined,
    // Не-объект (строка, массив, null) отсеивается здесь: настройки - это словарь, и
    // попытка передать другую форму стала бы ошибкой уже внутри SDK.
    settings: parseSdkSettings(src.settings),
    // systemPromptAppend из intent важнее значения в меше: текст, добавленный кодом,
    // всегда специфичнее того, что лежит в профиле.
    systemPromptAppend:
      exec?.systemPromptAppend ??
      (typeof src.systemPromptAppend === "string" ? src.systemPromptAppend : undefined),
    // Проверка typeof === "function" обязательна: функции не переживают сериализацию,
    // и меш, пришедший через границу процесса, содержит не-функции. Передача такого
    // значения в SDK вспыхнула бы ошибкой в момент вызова хука, далеко от причины.
    postToolUseHooks: Array.isArray(src.postToolUseHooks)
      ? (src.postToolUseHooks.filter(
          (value): value is HookCallback => typeof value === "function",
        ) as HookCallback[])
      : undefined,
    subagentStartHooks: Array.isArray(src.subagentStartHooks)
      ? (src.subagentStartHooks.filter(
          (value): value is HookCallback => typeof value === "function",
        ) as HookCallback[])
      : undefined,
    // includePartialMessages и maxTurns читаются по тому же принципу exec -> меш:
    // структурированное намерение перекрывает данные профиля.
    includePartialMessages:
      exec?.includePartialMessages ??
      (typeof src.includePartialMessages === "boolean" ? src.includePartialMessages : undefined),
    maxTurns: exec?.maxTurns ?? (typeof src.maxTurns === "number" ? src.maxTurns : undefined),
    // Таймауты переименовываются по пути: в intent они называются startTimeoutMs и
    // startRetryDelayMs (общие для всех рантаймов), а в опциях выполнения - по смыслу
    // фазы запроса. Смешение имен было бы источником ошибок при чтении кода.
    queryStartTimeoutMs:
      exec?.startTimeoutMs ??
      (typeof src.queryStartTimeoutMs === "number" ? src.queryStartTimeoutMs : undefined),
    queryStartRetryDelayMs:
      exec?.startRetryDelayMs ??
      (typeof src.queryStartRetryDelayMs === "number" ? src.queryStartRetryDelayMs : undefined),
    // runTimeoutMs - общий потолок длительности, в отличие от queryStartTimeoutMs
    // (ожидание первого вывода): два разных сбоя, две разные настройки.
    runTimeoutMs:
      exec?.runTimeoutMs ?? (typeof src.runTimeoutMs === "number" ? src.runTimeoutMs : undefined),
    // Порядок слияния задаёт приоритет: env из меша -> env профиля -> env задачи.
    // Spread от undefined - no-op в JS, поэтому цепочке не нужны guard'ы на каждом
    // шаге: отсутствующий слой просто не перекрывает предыдущие.
    environment: {
      ...toStringRecord(toRecord(src.environment)),
      ...resolveProfileEnvironment(input),
      ...exec?.environment,
    },
    // stderr-колбэк переезжает из intent (onStderr) под своим именем: у сторонних
    // рантаймов он имеет тот же смысл, а SDK ждет поле stderr.
    stderr:
      exec?.onStderr ??
      (typeof src.stderr === "function" ? (src.stderr as (chunk: string) => void) : undefined),
    onEvent:
      exec?.onEvent ??
      // Колбэк проверяется на function: только в процессе это гарантировано, а меш может
      // прийти из сериализованных данных, где функции нет.
      (typeof src.onEvent === "function"
        ? (src.onEvent as (event: RuntimeEvent) => void)
        : undefined),
    // instanceof вместо проверки формы: глобальный AbortController в Node один на
    // процесс, и проверка отбрасывает похожие, но чужие объекты из меша. Значение из
    // exec заведомо живой контроллер, там instanceof не нужен.
    abortController:
      exec?.abortController ??
      (src.abortController instanceof AbortController ? src.abortController : undefined),
    // Колбэки инструментов и субагентов берутся только из exec: в меше функции не
    // выживают (сериализация), и искать их там бессмысленно.
    onToolUse: exec?.onToolUse,
    onSubagentStart: exec?.onSubagentStart,
  };
}

// ---------------------------------------------------------------------------
// Окружение и опции запроса SDK
// ---------------------------------------------------------------------------

// Белый список переменных, наследуемых запускаемым `claude`. Окружение получает не
// только сам CLI: оно доходит до хуков и инструментов, то есть в зону доступности
// агента, поэтому тотальное наследование process.env утекло бы произвольные секреты
// хоста. Точные имена (HOME, PATH) задают одну переменную, префиксы с подчёркиванием
// (XDG_, LC_) - семейство. PROXY_ENV_VARS добавляет прокси-настройки: без них запуск
// в Docker остаётся без сети.
const ALLOWED_ENV_PREFIXES = [
  "ANTHROPIC_",
  "OPENAI_",
  "CLAUDE_",
  "AIF_",
  "HANDOFF_",
  "NODE_",
  "HOME",
  "USER",
  "LANG",
  "LC_",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "XDG_",
  "EDITOR",
  "VISUAL",
  "FORCE_COLOR",
  "NO_COLOR",
  ...PROXY_ENV_VARS,
];
// Массив остаётся нетипизированным string[]: элементы - произвольные префиксы, и
// сужать тип до литералов смысла нет - сравнение идет по startsWith.

// Элементы списка играют двойную роль без разделения на два набора: проверка
// «точное равенство ИЛИ префикс» пропускает и точные имена (HOME), и семейства
// (XDG_). Для точных запись проходит и по startsWith, но явное равенство читается
// как документация намерения.
function isAllowedEnvKey(key: string): boolean {
  return ALLOWED_ENV_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix));
}

// Результат сборки со счётчиками: debug-лог показывает, сколько переменных прошло и
// сколько отрезали, и вопрос «почему моя переменная не видна в хуке» закрывается из
// лога, а не отладчиком.
interface ResolvedEnvironment {
  // Итоговое окружение дочернего процесса: унаследованное по allowlist плюс все
  // явные переопределения (исполнительное намерение, профиль, задача).
  env: Record<string, string>;
  // Счётчики существуют только ради диагностического лога: они ничего не решают и не
  // должны влиять на содержимое env.
  forwardedCount: number;
  filteredCount: number;
  droppedDisallowedPrefixKeys: string[];
}

// Сборка окружения: сначала унаследованные переменные через allowlist, затем явные
// переопределения из execution (они важнее), в конце - ключ и baseUrl из профиля.
function resolveEnvironment(
  input: RuntimeRunInput,
  execution: ClaudeRuntimeExecutionOptions,
): ResolvedEnvironment {
  const base: Record<string, string> = {};
  let forwardedCount = 0;
  let filteredCount = 0;
  const droppedDisallowedPrefixKeys = new Set<string>();
  // Object.entries превращает env в массив пар [ключ, значение]. Значение может быть
  // undefined (переменная удалена в рантайме), поэтому проверка value != null стоит
  // первой: сравнение с null/undefined ловит оба случая сразу.
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null && isAllowedEnvKey(key)) {
      // Значение копируется в новый объект: мутировать process.env нельзя, а дочернему
      // процессу нужен именно снимок, а не ссылка на живое окружение родителя.
      base[key] = value;
      forwardedCount += 1;
    } else if (value != null) {
      // Переменная есть, но allowlist её не пропустил: считаем отфильтрованные и
      // запоминаем npm_* отдельно, чтобы предупреждение было полезным.
      filteredCount += 1;
      // npm_* фиксируются в отдельный список для предупреждения: npm добавляет десятки
      // таких переменных при запуске скриптов, и без выборки «отброшено» утонуло бы
      // в шуме из-под любого реального конфига.
      if (key.startsWith("npm_")) {
        droppedDisallowedPrefixKeys.add(key);
      }
    }
  }
  // Явные переопределения накладываются последними: env задачи важнее env родительского
  // процесса, включая случай, когда allowlist уже пропустил старое значение.
  for (const [key, value] of Object.entries(execution.environment ?? {})) {
    base[key] = value;
  }

  // Поля профиля читаются как unknown и проверяются по typeof: options приходит из БД
  // или HTTP и типизирован лишь номинально - на границе процесса гарантий нет.
  const optionRecord = toRecord(input.options);
  const apiKeyEnvVar =
    typeof optionRecord?.apiKeyEnvVar === "string" ? optionRecord.apiKeyEnvVar : null;
  // Пустая строка приравнивается к отсутствию ключа (trim().length > 0): профиль с
  // очищенным полем не должен превращаться в «пустой ключ», перетирающий рабочий.
  const apiKey =
    typeof optionRecord?.apiKey === "string" && optionRecord.apiKey.trim().length > 0
      ? optionRecord.apiKey.trim()
      : null;
  const baseUrl = typeof optionRecord?.baseUrl === "string" ? optionRecord.baseUrl : null;
  // Имя стандартной переменной ключа выбирается по протоколу провайдера: нативный
  // Anthropic читает ANTHROPIC_API_KEY, всё остальное трактуется как
  // OpenAI-совместимый транспорт. Сравнение по id, а не по тексту baseUrl: baseUrl
  // может быть прокси с антропическим protocol id.
  const standardApiKeyEnvVar =
    (input.providerId ?? "").toLowerCase() === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";

  // Явный ключ из профиля пишется и в названную переменную, и в стандартную - но
  // стандартная заполняется только когда пуста: allowlist уже мог принести осознанное
  // значение из process.env, и перетирать его нельзя.
  if (apiKey) {
    if (apiKeyEnvVar) {
      base[apiKeyEnvVar] = apiKey;
    }
    if (!base[standardApiKeyEnvVar]) {
      base[standardApiKeyEnvVar] = apiKey;
    }
  } else if (apiKeyEnvVar && !base[apiKeyEnvVar] && process.env[apiKeyEnvVar]) {
    // Если задано только имя переменной (без значения в профиле), перечитываем её из
    // process.env напрямую: кастомные имена (ZAI_API_KEY) не проходят allowlist при
    // наследовании, и ключ иначе не дошёл бы до дочернего процесса.
    base[apiKeyEnvVar] = process.env[apiKeyEnvVar]!;
    // `!` безопасен: условие выше уже проверило истинность того же чтения; TypeScript
    // просто не связывает два отдельных обращения к process.env в одно сужение.
    if (!base[standardApiKeyEnvVar]) {
      base[standardApiKeyEnvVar] = process.env[apiKeyEnvVar]!;
    }
  }
  // base URL пишется в переменную той протокольной семьи, которую выбрал профиль:
  // антропический клиент смотрит ANTHROPIC_BASE_URL, совместимые - OPENAI_BASE_URL.
  if (baseUrl) {
    if ((input.providerId ?? "").toLowerCase() === "anthropic") {
      base.ANTHROPIC_BASE_URL = baseUrl;
    } else {
      base.OPENAI_BASE_URL = baseUrl;
    }
  }

  // Возврат пары «готовое окружение + счётчики»: вызывающий код логирует цифры, но не
  // принимает по ним решений - диагностика отделена от управления.
  return {
    env: base,
    forwardedCount,
    filteredCount,
    droppedDisallowedPrefixKeys: [...droppedDisallowedPrefixKeys],
  };
}

// Системный промпт задачи и append склеиваются в одну строку: SDK не знает про нашу
// наслоенность, а trim+filter вырезают пустые куски, чтобы в контекст модели не
// попадали лишние переводы строк от незаполненных слоёв.
function mergeSystemPromptAppend(
  input: RuntimeRunInput,
  execution: ClaudeRuntimeExecutionOptions,
): string {
  // Склейка через двойной перевод строки: два текста остаются раздельными абзацами, а
  // не слипаются в один непроницаемый блок инструкций.
  const values = [input.systemPrompt, execution.systemPromptAppend]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  return values.join("\n\n");
}

// ---------------------------------------------------------------------------------
// Нормализация effort и сборка финального объекта опций для query().
// ---------------------------------------------------------------------------------

// Ре-экспорт общих уровней effort под claude-именем: словарь определён один раз в
// ../../modelEffort.ts, а алиас держит чтение адаптера локальным.
export const CLAUDE_EFFORT_LEVELS = CLAUDE_MODEL_EFFORT_LEVELS;
// `(typeof МАССИВ)[number]` - способ TS превратить const-массив литералов в union-тип:
// дописывание элемента в список автоматически расширяет и тип, без ручного дублирования.
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];
// Числовая шкала effort (1..4) - условность UI-профилей; SDK понимает только метки,
// поэтому таблица переводит одно в другое. Индексация вне карты (0, 5) даёт undefined,
// который потребитель гасит в null ниже.
const CLAUDE_NUMERIC_EFFORT_MAP: Record<number, ClaudeEffortLevel> = {
  1: "low",
  2: "medium",
  3: "high",
  4: "max",
};

// Нормализация effort из произвольного значения профиля в метку или null. Строка
// проходит через общий resolveModelEffortOption даже когда список известен: резолвер
// терпим к регистру и синонимам, а мусор возвращает как null вместо того, чтобы
// протащить его в SDK. Числа прогоняются через Math.floor: 2.7 трактуется как
// «medium», а не как ошибка - опечатка в профиле не должна ломать запуск.
export function normalizeClaudeEffort(
  rawEffort: unknown,
  options?: Record<string, unknown>,
): string | null {
  if (typeof rawEffort === "string") {
    return resolveModelEffortOption(
      options ?? { effort: rawEffort },
      "effort",
      CLAUDE_EFFORT_LEVELS,
    );
  }
  if (typeof rawEffort === "number" && Number.isFinite(rawEffort)) {
    return CLAUDE_NUMERIC_EFFORT_MAP[Math.floor(rawEffort)] ?? null;
  }
  return null;
}

/** Собирает объект опций, передаваемый в `query()` Claude Agent SDK. */
// Вершина сборки: ClaudeRuntimeExecutionOptions + окружение + хуки превращаются в
// один объект опций SDK. Собственные дефолты политики задаются именно здесь
// (acceptEdits для разрешений, ["project"] для источников настроек): намерение
// выполнения должно быть явным, а всё остальное получает безопасный минимум.
export function buildClaudeQueryOptions(
  input: RuntimeRunInput,
  execution: ClaudeRuntimeExecutionOptions,
  logger?: ClaudeOptionsLogger,
): Record<string, unknown> {
  // optionRecord - срез профиля: effort и прочие поля, которых нет в структурированном
  // намерении. Читается один раз, чтобы не гонять toRecord по нескольку раз за вызов.
  const optionRecord = toRecord(input.options);
  // Хуки собираются из живых функций; при пустом наборе buildClaudeHooks вернёт
  // undefined, и ключ hooks в опции не попадёт вообще.
  const hooks = buildClaudeHooks({
    postToolUseHooks: execution.postToolUseHooks,
    subagentStartHooks: execution.subagentStartHooks,
    onToolUse: execution.onToolUse,
    onSubagentStart: execution.onSubagentStart,
  });

  // Два источника системного контекста (промпт рантайма и append профиля) склеиваются
  // до вызова SDK: у query() один systemPrompt, и разбираться с нашими слоями должен
  // адаптер, а не модель.
  const mergedAppend = mergeSystemPromptAppend(input, execution);
  // `settings` передаётся дословно. По умолчанию — задокументированное подавление
  // attribution (пустые commit/pr скрывают футеры). Attribution НЕ нормализуется — пустые
  // строки и есть поддерживаемый механизм подавления.
  // suppressed по умолчанию: в авто-коммитах AIF не нужны «Co-Authored-By»-подобные
  // футеры, а SDK трактует пустые строки именно как подавление attribution.
  const settings = execution.settings ?? { attribution: { commit: "", pr: "" } };
  const resolvedEnvironment = resolveEnvironment(input, execution);
  // Счётчики пишутся один раз при построении опций: дальше окружение уже собрано
  // внутри дочернего процесса, и наблюдать его там гораздо дороже.
  logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      providerId: input.providerId ?? "anthropic",
      forwardedEnvCount: resolvedEnvironment.forwardedCount,
      filteredEnvCount: resolvedEnvironment.filteredCount,
      droppedDisallowedPrefixCount: resolvedEnvironment.droppedDisallowedPrefixKeys.length,
    },
    "[runtime:claude] Built Claude runtime environment from curated allowlist",
  );
  if (resolvedEnvironment.droppedDisallowedPrefixKeys.length > 0) {
    // В предупреждение попадают только первые 10 имён: случайный префикс вроде
    // npm_* мог бы сгенерировать сотни строк лога на одном запуске.
    logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        providerId: input.providerId ?? "anthropic",
        droppedDisallowedPrefixKeys: resolvedEnvironment.droppedDisallowedPrefixKeys.slice(0, 10),
      },
      "WARN [runtime:claude] Dropped disallowed environment prefix keys while building Claude runtime environment",
    );
  }
  // Нормализация effort логируется всегда, а не только при успехе: если значение
  // пропало, вопрос «почему SDK не получил effort» закрывается одной строкой debug.
  const rawEffort = optionRecord?.effort;
  const normalizedEffort = normalizeClaudeEffort(rawEffort, optionRecord ?? undefined);
  const forkSourceSessionId = readForkSourceSessionId(input);
  // Итог нормализации пишется в debug с обоими значениями (вход и выход): при
  // разборе «почему у модели другой режим» видно, что именно профиль прислал.
  logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      providerId: input.providerId ?? "anthropic",
      incomingEffort: rawEffort ?? null,
      normalizedEffort,
    },
    "[runtime:claude] Normalized effort option for Claude query",
  );
  if (rawEffort != null && normalizedEffort == null) {
    // Некорректное значение выбрасывается с предупреждением, а не валит запуск:
    // опечатка в профиле не должна быть разрушительнее самой задачи.
    logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        providerId: input.providerId ?? "anthropic",
        incomingEffort: rawEffort,
      },
      "WARN [runtime:claude] Ignoring invalid Claude effort option",
    );
  }

  return {
    // Паттерн `...(условие ? { ключ: значение } : {})` проходит по всему объекту: SDK
    // различает «ключ не передан» и «ключ передан как undefined», поэтому лишние keys
    // должны отсутствовать физически, а не приходить пустыми.
    ...(execution.abortController ? { abortController: execution.abortController } : {}),
    // cwd - рабочий каталог запускаемой сессии: если задача не задала свой, берётся
    // корень проекта, чтобы относительные пути агента вели в ожидаемое место.
    cwd: input.cwd ?? input.projectRoot,
    // env уже отфильтрован allowlist'ом: здесь просто отдаём собранное, без процесса.
    env: resolvedEnvironment.env,
    // settings передается как есть, включая подавленный attribution: любая нормализация
    // здесь сломала бы контракт, описанный в докблоке ClaudeSdkSettings выше.
    settings,
    // Источники настроек по умолчанию ограничены проектом: конфиг пользователя из
    // системных каталогов не должен незаметно влиять на поведение агента в задаче.
    settingSources: execution.settingSources ?? ["project"],
    // preset claude_code сохраняет встроенное поведение Claude Code, а append только
    // дописывает контекст задачи поверх - не заменяет системный промпт целиком.
    // preset claude_code сохраняет встроенное поведение Claude Code, а append только
    // дописывает контекст задачи поверх - не заменяет системный промпт целиком.
    // Условие `mergedAppend ?` не даёт пустой строке попасть в опции как append.
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(mergedAppend ? { append: mergedAppend } : {}),
    },
    // acceptEdits - минимальный полезный дефолт: агент правит файлы, но останавливается
    // на опасных операциях; понижение до полного обхода возможно только через затвор
    // allowDangerouslySkipPermissions с trust-токеном.
    permissionMode: execution.permissionMode ?? "acceptEdits",
    // Флаг доходит сюда только после двойного затвора в parseExecutionOptions:
    // к моменту сборки он уже подтверждён trust-токеном, и перепроверять токен здесь
    // значило бы держать два источника истины об одном решении.
    ...(execution.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
    // pathToClaudeCodeExecutable передаётся только когда задан: иначе SDK сам ищет
    // бинарник claude в PATH, что и нужно в dev-сценариях.
    ...(execution.pathToClaudeCodeExecutable
      ? { pathToClaudeCodeExecutable: execution.pathToClaudeCodeExecutable }
      : {}),
    // Потоковые частичные сообщения и счётные ограничители передаются только по
    // запросу: у SDK свои дефолты, и отсутствие ключа - лучший способ их получить.
    ...(execution.includePartialMessages ? { includePartialMessages: true } : {}),
    ...(execution.maxTurns != null ? { maxTurns: execution.maxTurns } : {}),
    ...(execution.maxBudgetUsd != null ? { maxBudgetUsd: execution.maxBudgetUsd } : {}),
    // stderr-колбэк - живая функция, поэтому проверяется на наличие, а не на тип:
    // в опции попадает только то, что реально можно вызвать.
    ...(execution.stderr ? { stderr: execution.stderr } : {}),
    // hooks попадают в опции только когда они непустые: пустой объект отключил бы
    // хуки, которые SDK ставит сам, и намеренно отсутствующее поле здесь важнее
    // пустой заготовки.
    ...(hooks ? { hooks } : {}),
    // Имя агента превращается в extraArgs: SDK не знает поля «агент», его передают
    // CLI-аргументом `--agent`, а само определение читает Claude Code.
    ...(execution.agentDefinitionName
      ? { extraArgs: { agent: execution.agentDefinitionName } }
      : {}),
    // Форк приоритетнее обычного resume: forkSourceSessionId означает «начать НОВУЮ
    // сессию из сохранённой» (resume + forkSession), а resume без флага продолжает ту
    // же самую. Тернарный оператор в spread держит все три варианта в одном месте, без дублирования
    // объекта опций.
    ...(forkSourceSessionId
      ? { resume: forkSourceSessionId, forkSession: true }
      : input.resume && input.sessionId
        ? { resume: input.sessionId }
        : {}),
    // Модель и effort передаются только когда заданы: их отсутствие - сигнал SDK
    // использовать собственные дефолты, а не получить model: undefined.
    ...(input.model ? { model: input.model } : {}),
    // effort проходит через normalizeClaudeEffort: сюда доходит уже метка либо null,
    // и null не должен превращаться в ключ со значением null.
    ...(normalizedEffort ? { effort: normalizedEffort } : {}),
  };
}
