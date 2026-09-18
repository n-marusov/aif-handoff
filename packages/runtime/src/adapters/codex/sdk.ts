/**
 * Codex-транспорт рантайма поверх официального @openai/codex-sdk.
 *
 * SDK работает как «тонкая обёртка» над локальным Codex CLI: конструктор Codex
 * поднимает дочерний процесс, а весь ввод-вывод идёт через типизированный поток
 * ThreadEvent. Поэтому транспорт не трогает сеть и авторизацию напрямую - он
 * только собирает опции, скармливает их SDK и переводит события SDK в
 * канонические RuntimeEvent, которые понимает весь остальной конвейер.
 *
 * Три осознанные опоры модуля:
 * 1) Консервативное окружение. Дочернему процессу передаётся не process.env
 *    целиком, а курируемый allowlist (см. buildCuratedEnv): ключевые переменные
 *    вроде OPENAI_API_KEY нарушают OAuth-сессию `codex login`, поэтому по
 *    умолчанию они вырезаются и возвращаются только при явном opt-in профиля.
 * 2) Детерминированные дефолты разрешений. approvalPolicy/sandboxMode
 *    нормализуются здесь (см. ./permissions.ts), а не в ~/.codex/config.toml
 *    пользователя - иначе поведение задачи зависело бы от хоста.
 * 3) Наблюдаемость лимитов. Во время прогона периодический опрос rollout-файла
 *    сессии (sessions.ts) рождает события runtime:limit с дедупликацией по
 *    подписи снимка, чтобы UI видел расход токенов, не читая файлы на каждом
 *    ивенте.
 *
 * Ошибки SDK-потока не «разбираются по тексту»: каждый сбой заворачивается в
 * CodexRuntimeAdapterError со структурными category/adapterCode (errors.ts), и
 * потребители ветвятся только по этим полям - см. правило проекта о Structured
 * Error Classification.
 */

import {
  Codex,
  type CodexOptions,
  type ThreadOptions,
  type TurnOptions,
  type ThreadEvent,
  type ThreadItem,
  type Usage,
  type ModelReasoningEffort,
} from "@openai/codex-sdk";
import type {
  RuntimeEvent,
  RuntimeExecutionIntent,
  RuntimeRunInput,
  RuntimeRunResult,
  RuntimeUsage,
} from "../../types.js";
import {
  isRetriableTimeoutError,
  resolveRetryDelay,
  sleepMs,
  withStreamTimeouts,
} from "../../timeouts.js";
import { buildRuntimeLimitEvent } from "../../limitEvents.js";
import { classifyCodexRuntimeError } from "./errors.js";
import {
  normalizeCodexApprovalPolicy,
  normalizeCodexSandboxMode,
  warnOnInvalidCodexPermissionOverride,
} from "./permissions.js";
import { getCodexSessionLimitSnapshot } from "./sessions.js";
import { PROXY_ENV_VARS } from "../../proxyEnv.js";
import {
  CODEX_MODEL_EFFORT_LEVELS,
  isModelEffortLevel,
  resolveModelEffortOption,
} from "../../modelEffort.js";

// Минимальный контракт логгера, навязываемый адаптеру: все методы опциональны,
// потому что вызывающий код (api/agent) может передать любой partial-логгер или
// pino-совместимый объект. Все обращения идут через `?.`, поэтому отсутствие
// метода молча допустимо - адаптер не обязан тащить полную реализацию.
export interface CodexSdkLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

// Опрос rollout-файла сессии во время прогона: частота ограничена, иначе на
// длинном стриме снимок лимитов перечитывался бы на каждом событии SDK.
const CODEX_SESSION_LIMIT_POLL_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

// Narrowing-хелпер для неструктурированных payload'ов: options/hooks/execution у
// задачи приходят из JSON и могут быть чем угодно. Массив - не объект, поэтому
// Array.isArray исключён явно; на входе не-объекта возвращается пустой объект,
// что снимает с вызывающего кода обязательные проверки на null.
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Строгое чтение опциональной строки: пустая строка и строка из пробелов
// считаются отсутствием значения (null), а не валидной опцией. Это ключ к цепочкам
// `readString(a) ?? readString(b) ?? default` - пустая переменная окружения или
// незаполненное поле профиля не должны вытеснять значение из следующего источника.
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Однострочное представление произвольного аргумента инструмента для логов и
// onToolUse: сериализация не должна уронить прогон, поэтому JSON.stringify
// обёрнут в try/catch (циклические ссылки выбрасывают TypeError), а итог
// усекается с многоточием - длинные diff/выводы забивают ленту событий.
function formatToolDetail(value: unknown, maxLength = 200): string {
  if (value == null) return "";

  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

// allowlist переменных окружения для дочернего процесса Codex. Инверсия
// «чёрного списка» сознательна: process.env в CI/dev-шелле содержит секреты
// подрядчика, мусорные npm_*-переменные и locale-наследство, а Codex CLI нужен
// лишь узкий набор: его собственные OPENAI_*/CODEX_* ключи, HOME/PATH для
// поиска config.toml и прокси-переменные для сети в корпоративных средах.
// Новой переменной по умолчанию нет доступа - это цена предсказуемости.
const ALLOWED_ENV_PREFIXES = [
  "OPENAI_",
  "CODEX_",
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
  "FORCE_COLOR",
  "NO_COLOR",
  ...PROXY_ENV_VARS,
];

/**
 * Env-ключи, которые по умолчанию НЕ должны утекать в дочерний процесс Codex SDK.
 * Локальные запуски делегируют авторизацию `codex login` (OAuth); placeholder/посторонние
 * `OPENAI_API_KEY=sk-000` или `OPENAI_BASE_URL` в `.env` иначе вынудили бы SDK
 * идти по API-key авторизации и сломали OAuth-чат. Пробрасываются, только когда
 * API-key авторизация явно включена профилем через `apiKeyEnvVar`.
 */
const BLOCKED_ENV_KEYS = new Set(["OPENAI_API_KEY", "OPENAI_BASE_URL"]);

// Курирование env — единственный слой, который решает, что увидит дочерний
// процесс. Порядок проверок важен: явный apiKeyEnvVar с opt-in обрабатывается до
// BLOCKED_ENV_KEYS, иначе «разрешённый» ключ был бы вырезан собственным блоком.
// Строгая точка: значение ключа из процесса читается один раз здесь, и больше
// нигде в адаптере — решение «пробрасывать ли API-ключ» не может разойтись
// между вызовами.
function buildCuratedEnv(
  apiKeyEnvVar: string,
  executionEnv?: Record<string, string>,
  allowApiKeyEnvVar = false,
): {
  env: Record<string, string>;
  forwardedCount: number;
  filteredCount: number;
  droppedDisallowedPrefixKeys: string[];
} {
  const env: Record<string, string> = {};
  let forwardedCount = 0;
  let filteredCount = 0;
  const droppedDisallowedPrefixKeys = new Set<string>();
  // Учёт пропускается молча: пустое значение — не секрет и не конфигурация.
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    // Явный opt-in профиля (apiKeyEnvVar) имеет приоритет над блоком: профиль сам
    // решил, что это API-key-режим, и тогда ключ обязан дойти до SDK.
    if (key === apiKeyEnvVar && allowApiKeyEnvVar) {
      env[key] = value;
      forwardedCount += 1;
      continue;
    }
    if (BLOCKED_ENV_KEYS.has(key)) {
      filteredCount += 1;
      continue;
    }
    if (
      key === apiKeyEnvVar ||
      ALLOWED_ENV_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix))
    ) {
      env[key] = value;
      forwardedCount += 1;
      // npm_* отдельно собираются в «сброшенные» списки: их генерирует сам npm при
      // запуске скриптов, они не несут смысла для Codex, но их объём маскирует
      // настоящие конфигурационные ключи в диагностиках.
    } else {
      filteredCount += 1;
      if (key.startsWith("npm_")) {
        droppedDisallowedPrefixKeys.add(key);
      }
    }
  }
  // executionEnv (пер-задачные переменные из профиля) накладывается последним и
  // выигрывает у унаследованных: явное намерение вызывающего важнее окружения
  // процесса, но это же значит, что им можно переопределить любой allowlist-ключ.
  Object.assign(env, executionEnv ?? {});
  return {
    env,
    forwardedCount,
    filteredCount,
    droppedDisallowedPrefixKeys: [...droppedDisallowedPrefixKeys],
  };
}

// ---------------------------------------------------------------------------
// Сборщики опций SDK
// ---------------------------------------------------------------------------

// Сборка CodexOptions — «корня» всего SDK-подключения: env + способ авторизации
// + путь к CLI + config-overrides. Всё читается из input.options (профиль рантайма)
// с фолбэком в переменные окружения, причём профиль всегда выигрывает: он —
// явное решение оператора, а окружение — лишь удобное наследование.
function buildCodexOptions(input: RuntimeRunInput, logger?: CodexSdkLogger): CodexOptions {
  const options = asRecord(input.options);
  const execution = input.execution;
  // allowApiKeyEnvVar выводится из явности apiKeyEnvVar, а не из его значения:
  // «профиль назвал переменную» и «система случайно содержит OPENAI_API_KEY» —
  // принципиально разные сигналы, и второй не должен включать API-key-авторизацию.
  const explicitApiKeyEnvVar = readString(options.apiKeyEnvVar);
  const apiKeyEnvVar = explicitApiKeyEnvVar ?? "OPENAI_API_KEY";
  const curatedEnv = buildCuratedEnv(
    apiKeyEnvVar,
    execution?.environment,
    Boolean(explicitApiKeyEnvVar),
  );
  logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      transport: "sdk",
      forwardedEnvCount: curatedEnv.forwardedCount,
      filteredEnvCount: curatedEnv.filteredCount,
      droppedDisallowedPrefixCount: curatedEnv.droppedDisallowedPrefixKeys.length,
    },
    "[runtime:codex] Built Codex SDK environment from curated allowlist",
  );
  // Отдельный warn только для «странного» случая (сброшены npm_*-префиксы):
  // штатная фильтрация сотен переменных — норма, и тонуть в ней каждое
  // соединение не должна. Срез до 10 ключей защищает лог от разрастания.
  if (curatedEnv.droppedDisallowedPrefixKeys.length > 0) {
    logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        transport: "sdk",
        droppedDisallowedPrefixKeys: curatedEnv.droppedDisallowedPrefixKeys.slice(0, 10),
      },
      "WARN [runtime:codex] Dropped disallowed environment prefix keys while building Codex SDK environment",
    );
  }

  const codexOpts: CodexOptions = {
    env: curatedEnv.env,
  };

  // API-ключ — передаётся только если явно задан опциями профиля или настроенным
  // apiKeyEnvVar. Иначе SDK делегирует авторизацию CLI, который сам ведёт
  // учётные данные через `codex login`, как Claude SDK использует `claude /login`.
  // Внешний OPENAI_API_KEY намеренно игнорируется, чтобы placeholder-ключ не
  // перехватил OAuth-сессию.
  // Ключ передаётся SDK только когда он реально найден; отсутствие ключа —
  // полноценный сценарий (OAuth через codex login), поэтому ветка else тут не
  // ошибка, а норма. readString уже отфильтровал пустые строки-заглушки.
  const apiKey =
    readString(options.apiKey) ??
    (explicitApiKeyEnvVar ? readString(process.env[apiKeyEnvVar]) : null);
  if (apiKey) {
    codexOpts.apiKey = apiKey;
  }

  // Override base URL. OPENAI_BASE_URL намеренно не выводится здесь:
  // Codex-запуски SDK на OAuth должны использовать собственный бэкенд Codex, если
  // profile baseUrl или CODEX_BASE_URL явно не выбирают другой эндпоинт.
  // Фоллбэк именно в CODEX_BASE_URL, а не в OPENAI_BASE_URL: последний живёт в
  // .env ради других инструментов OpenAI-экосистемы, и его молчаливое отражение
  // здесь перенаправило бы OAuth-сессию (вместе с токенами) на чужой endpoint.
  // Смена backend'а — осознанное решение профиля (options.baseUrl), не побочный
  // эффект окружения.
  const baseUrl = readString(options.baseUrl) ?? readString(process.env.CODEX_BASE_URL);
  if (baseUrl) {
    codexOpts.baseUrl = baseUrl;
  }

  // Переопределение пути CLI
  // Цепочка фолбэков с литералом "codex" в конце: без пути SDK не сможет поднять
  // дочерний процесс, и «codex в PATH» — единственная честная глобальная
  // догадка. Пустая строка в CODEX_CLI_PATH не сломает её: readString вернёт
  // null, и цепочка провалится к дефолту, а не к битому пути.
  codexOpts.codexPathOverride =
    readString(options.codexCliPath) ?? readString(process.env.CODEX_CLI_PATH) ?? "codex";

  // Config-overrides Codex CLI — каст ради CodexConfigObject (нелокальный рекурсивный тип)
  // asRecord здесь гарантирует non-null object (пустой объект вместо null при
  // мусорном входе), поэтому каст не «срезает» nullable — он лишь примиряет
  // структурный тип с рекурсивным CodexConfigObject, который SDK не экспортирует.
  const configOverride = asRecord(options.codexConfig);
  if (Object.keys(configOverride).length > 0) {
    codexOpts.config = configOverride as CodexOptions["config"];
  }

  return codexOpts;
}

// ThreadOptions — настройки одной сессии (ветки разговора) внутри Codex: рабочая
// директория, модель, разрешения. hooks — второй, более старый источник значений:
// API-слой исторически прокидывал сюда разрешения вместо profile options, и
// адаптер продолжает это принимать (options выигрывает при конфликте).
function buildThreadOptions(input: RuntimeRunInput, logger?: CodexSdkLogger): ThreadOptions {
  const cwd = input.cwd ?? input.projectRoot;
  const options = asRecord(input.options);
  const execution = input.execution;
  const hooks = asRecord(execution?.hooks);

  const threadOpts: ThreadOptions = {};

  if (cwd) {
    threadOpts.workingDirectory = cwd;
  }

  // Модель из input или профиля
  if (input.model) {
    threadOpts.model = input.model;
  }

  // Эффективные approval policy и sandbox mode с трёхслойным приоритетом:
  // явные опции профиля > дефолты bypass (при execution.bypassPermissions=true) >
  // стабильные не-bypass дефолты.
  //
  // Не-bypass дефолты (`on-request` + `workspace-write`) держат поведение
  // стабильным на всех хостах независимо от ~/.codex/config.toml пользователя. До
  // рефакторинга bypass-permissions эти дефолты задавала Codex-специфичная
  // фабрика хуков в слое api; теперь логика внутри адаптера, и api/agent/runtime
  // видят один контракт.
  // Разрешения нормализуются, а не валидируются броском: опечатка в профиле не
  // должна ронять прогон — значение уходит в null, логгируется warn, и дальше
  // срабатывает безопасный дефолт. Потеря на строгости компенсируется тем, что
  // источник значения виден в warn-логе (warnOnInvalidCodexPermissionOverride).
  const rawApprovalOption = readString(options.approvalPolicy);
  const rawApprovalHook = readString(hooks.approvalPolicy);
  const explicitApproval = rawApprovalOption ?? rawApprovalHook;
  const normalizedApproval = normalizeCodexApprovalPolicy(explicitApproval);
  warnOnInvalidCodexPermissionOverride({
    logger,
    runtimeId: input.runtimeId,
    transport: "sdk",
    field: "approvalPolicy",
    source: rawApprovalOption ? "options" : "hooks",
    rawValue: explicitApproval,
    normalizedValue: normalizedApproval,
  });
  if (normalizedApproval) {
    threadOpts.approvalPolicy = normalizedApproval;
  } else if (execution?.bypassPermissions) {
    threadOpts.approvalPolicy = "never";
  } else {
    threadOpts.approvalPolicy = "on-request";
  }

  // Пропуск проверки git-репозитория, если явно запрошен
  // Строгое === true (а не truthy): значение может прийти из JSON как строка
  // "true"/"false", и случайная строка не должна молча отключать проверку репозитория.
  if (options.skipGitRepoCheck === true || hooks.skipGitRepoCheck === true) {
    threadOpts.skipGitRepoCheck = true;
  }

  // Зеркало approval-ветки с тем же контрактом: без нормализованного значения
  // дефолт зависит от bypassPermissions. sandbox — не «вежливый совет», а реальный
  // ОС-уровень изоляции дочернего процесса, поэтому danger-full-access включается
  // только по явному флагу байпаса, никогда — по умолчанию.
  const rawSandboxOption = readString(options.sandboxMode);
  const rawSandboxHook = readString(hooks.sandboxMode);
  const explicitSandbox = rawSandboxOption ?? rawSandboxHook;
  const normalizedSandbox = normalizeCodexSandboxMode(explicitSandbox);
  warnOnInvalidCodexPermissionOverride({
    logger,
    runtimeId: input.runtimeId,
    transport: "sdk",
    field: "sandboxMode",
    source: rawSandboxOption ? "options" : "hooks",
    rawValue: explicitSandbox,
    normalizedValue: normalizedSandbox,
  });
  if (normalizedSandbox) {
    threadOpts.sandboxMode = normalizedSandbox;
  } else if (execution?.bypassPermissions) {
    threadOpts.sandboxMode = "danger-full-access";
  } else {
    threadOpts.sandboxMode = "workspace-write";
  }

  // Проверяется именно typeof === "boolean", а не truthiness: явный false —
  // осознанный запрет сети, и его нельзя смешивать с «не задано» (тогда решение
  // остаётся за самим CLI). Если схлопнуть в `options.networkAccessEnabled ?? ...`,
  // ложь из options провалилась бы к hooks и была бы случайно переопределена.
  const networkAccessEnabled =
    typeof options.networkAccessEnabled === "boolean"
      ? options.networkAccessEnabled
      : typeof hooks.networkAccessEnabled === "boolean"
        ? hooks.networkAccessEnabled
        : null;
  if (typeof networkAccessEnabled === "boolean") {
    threadOpts.networkAccessEnabled = networkAccessEnabled;
  }

  // Уровень reasoning-effort
  // Если options не задал effort, собирается гибрид: поля из options + значение
  // из hooks. Это нужно потому, что resolveModelEffortOption принимает один
  // объект-источник, а приоритет «options выше hooks» нужно сохранить.
  const effortOptions =
    options.modelReasoningEffort == null
      ? { ...options, modelReasoningEffort: hooks.modelReasoningEffort }
      : options;
  const effort = resolveModelEffortOption(
    effortOptions,
    "modelReasoningEffort",
    CODEX_MODEL_EFFORT_LEVELS,
  );
  // Ветка Reflect.set — осознанный escape hatch: свежие уровни effort (например
  // новые значения из обновлённого CLI) могут отсутствовать в union-типе
  // ModelReasoningEffort, зашитом в .d.ts SDK. На уровне протокола это просто
  // строка, поэтому неизвестный, но валидный уровень проходит в рантайме без
  // падения компиляции — вместо того чтобы каждый раз патчить зависимости.
  if (isModelEffortLevel<ModelReasoningEffort>(effort, CODEX_MODEL_EFFORT_LEVELS)) {
    threadOpts.modelReasoningEffort = effort;
  } else if (effort) {
    Reflect.set(threadOpts, "modelReasoningEffort", effort);
  }

  // Кто победил в четырёхслойной цепочке приоритетов (options > hooks > bypass >
  // default) — иначе невоспроизводимо: при жалобе «агент пишет вне workspace»
  // диагностика начинается с того, откуда прилетело значение sandbox.
  logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      transport: "sdk",
      approvalPolicy: threadOpts.approvalPolicy ?? null,
      sandboxMode: threadOpts.sandboxMode ?? null,
      approvalSource:
        rawApprovalOption != null
          ? "options"
          : rawApprovalHook != null
            ? "hooks"
            : execution?.bypassPermissions
              ? "bypass-default"
              : "default",
      sandboxSource:
        rawSandboxOption != null
          ? "options"
          : rawSandboxHook != null
            ? "hooks"
            : execution?.bypassPermissions
              ? "bypass-default"
              : "default",
      bypassPermissions: execution?.bypassPermissions === true,
    },
    "Resolved Codex SDK approval and sandbox settings",
  );

  return threadOpts;
}

// TurnOptions — настройки одного хода (запроса), в отличие от thread-настроек
// всей сессии. outputSchema включает структурированный ответ (JSON-Schema), а
// signal пробрасывает отмену: без него abort() вызывающего не прервал бы активный
// ход, и задача «висела» бы до естественного завершения.
function buildTurnOptions(execution?: RuntimeExecutionIntent): TurnOptions {
  const turnOpts: TurnOptions = {};

  if (execution?.outputSchema && typeof execution.outputSchema === "object") {
    turnOpts.outputSchema = execution.outputSchema;
  }

  if (execution?.abortController) {
    turnOpts.signal = execution.abortController.signal;
  }

  return turnOpts;
}

// ---------------------------------------------------------------------------
// Нормализация usage
// ---------------------------------------------------------------------------

// Единая форма учёта для всех транспортов Codex: SDK отдаёт snake_case с null'
// полями, потребители ждут camelCase с числами. Нулевой результат — не «ноль
// израсходовано», а «метрик нет»: их не за чем нести в UI, где нули выглядят как
// реальные показания счётчика.
function normalizeUsage(usage: Usage | null): RuntimeUsage | null {
  if (!usage) return null;

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  // total считается как сумма, а не берётся из total_tokens провайдера: у Codex
  // reasoning-токены учтены внутри output, и чужая «итоговая» цифра могла бы
  // расходиться с суммой видимых полей — лучше честная арифметика, чем магия.
  const totalTokens = inputTokens + outputTokens;

  if (inputTokens === 0 && outputTokens === 0) return null;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

// ---------------------------------------------------------------------------
// Маппинг item → RuntimeEvent / колбэк
// ---------------------------------------------------------------------------

// Инструменты Codex — типизированные item'ы (команда, правка файла, MCP-вызов),
// а не «tool_use»-блоки как у Claude. Здесь они приводятся к привычному формату
// (имя + краткая деталь), чтобы UI рисовал один список инструментов для всех
// рантаймов. Возвращаемый null — сигнал «это не инструмент», а не ошибка.
function itemToToolUseSummary(item: ThreadItem): { toolName: string; detail: string } | null {
  switch (item.type) {
    case "command_execution":
      return { toolName: "Bash", detail: formatToolDetail(item.command) };
    case "file_change":
      return {
        toolName: "FileChange",
        detail: formatToolDetail(item.changes.map((c) => `${c.kind} ${c.path}`).join(", ")),
      };
    // Префикс MCP: в имени остаётся сервер — у разных серверов бывают
    // одноимённые инструменты, и без него события слились бы в один вызов.
    case "mcp_tool_call":
      return {
        toolName: `MCP:${item.server}/${item.tool}`,
        detail: formatToolDetail(item.arguments),
      };
    case "web_search":
      return { toolName: "WebSearch", detail: formatToolDetail(item.query) };
    default:
      return null;
  }
}

// Переводчик потока ThreadEvent в канонический RuntimeEvent — точка, где
// специфика Codex перестаёт быть заметна остальной системе. Возвращаемый null
// означает «это событие нас не интересует» (item.started и т.п.), а не ошибку:
// стрим намеренно фильтруется, иначе потребители утонули бы в промежуточных
// состояниях каждого item.
function threadEventToRuntimeEvent(event: ThreadEvent): RuntimeEvent | null {
  const now = new Date().toISOString();

  switch (event.type) {
    case "thread.started":
      return {
        type: "system:init",
        timestamp: now,
        level: "debug",
        message: "Codex thread started",
        data: { threadId: event.thread_id },
      };

    case "turn.started":
      return {
        type: "turn:started",
        timestamp: now,
        level: "debug",
        message: "Turn started",
      };

    // turn.completed трактуется как result:success: в Codex-модели завершённый
    // ход = успешный ответ; фатальные сбои приходят отдельным turn.failed ниже.
    case "turn.completed":
      return {
        type: "result:success",
        timestamp: now,
        level: "info",
        message: "Turn completed",
        data: {
          inputTokens: event.usage?.input_tokens ?? 0,
          outputTokens: event.usage?.output_tokens ?? 0,
        },
      };

    case "turn.failed":
      return {
        type: "result:error",
        timestamp: now,
        level: "error",
        message: event.error?.message ?? "Turn failed",
      };

    // usage здесь плоский (inputTokens/outputTokens), тогда как итоговый
    // RuntimeRunResult.usage проходит normalizeUsage: событие — для живого
    // наблюдения, result.usage — для отчётности, и дублировать трансформации
    // в двух местах дороже, чем держать их разными.
    case "item.completed": {
      const item = event.item;
      if (item.type === "agent_message") {
        return {
          type: "stream:text",
          timestamp: now,
          level: "debug",
          message: item.text,
          data: { text: item.text },
        };
      }
      if (item.type === "reasoning") {
        return {
          type: "reasoning",
          timestamp: now,
          level: "debug",
          message: item.text,
        };
      }
      const summary = itemToToolUseSummary(item);
      if (summary) {
        return {
          type: "tool:summary",
          timestamp: now,
          level: "info",
          message: `${summary.toolName}: ${summary.detail}`,
          data: { toolName: summary.toolName },
        };
      }
      return null;
    }

    case "error":
      return {
        type: "error",
        timestamp: now,
        level: "error",
        message: event.message,
      };

    // default-ветка — не ленивость, а контракт: SDK добавит новые типы событий,
    // и неизвестные должны тихо игнорироваться, а не ронять прогон: частичная
    // потеря стрима лучше полной остановки работы из-за незнакомой строки.
    default:
      return null;
  }
}

// Дедуп по «подписи» снимка: JSON-канонизация всего snapshot'а, а не сравнение
// отдельных полей — лимиты меняются пакетно, и подписывать надо состояние целиком.
// Сравнение именно по содержимому, а не по времени: второй вызов с тем же
// снимком не должен плодить повторные события в ленте.
function hasRuntimeLimitSnapshotSignature(
  events: RuntimeEvent[] | null | undefined,
  signature: string,
): boolean {
  return (
    events?.some((event) => {
      if (event.type !== "runtime:limit") {
        return false;
      }
      return JSON.stringify(event.data?.snapshot ?? null) === signature;
    }) ?? false
  );
}

// Финальная страховка: гарантирует, что в events итогового результата лёг
// актуальный снимок лимитов, даже если потоковый наблюдатель его не поймал
// (например, sessionId стал известен только после выхода из цикла). Функция
// чистая: вместо мутации возвращает новый result, чтобы вызывающий мог
// безопасно работать с предыдущей ссылкой на объект.
async function appendCodexSessionLimitEvent(input: RuntimeRunInput, result: RuntimeRunResult) {
  // Снимок читается из rollout-файла сессии на диске — без sessionId искать негде,
  // поэтому отсутствие идентификатора означает «лимитов не видно», а не «лимитов
  // нет».
  const sessionId = result.sessionId ?? null;
  if (!sessionId) {
    return result;
  }

  const snapshot = await getCodexSessionLimitSnapshot({
    sessionId,
    runtimeId: input.runtimeId,
    providerId: input.providerId ?? "openai",
    profileId: input.profileId ?? null,
  });
  if (!snapshot) {
    return result;
  }

  const signature = JSON.stringify(snapshot);
  if (hasRuntimeLimitSnapshotSignature(result.events, signature)) {
    return result;
  }

  const limitEvent = buildRuntimeLimitEvent(snapshot, "token_count");
  const nextEvents = [...(result.events ?? []), limitEvent];
  input.execution?.onEvent?.(limitEvent);

  return {
    ...result,
    events: nextEvents,
  };
}

// Состояние потокового наблюдателя живёт в рамках одного прогона (создаётся в
// runCodexSdkAttempt): «уже отправляли этот снимок» — факт одной сессии, а не
// процесса; разделение по прогонам исключает перенос устаревших подписей.
interface CodexSessionLimitObserverState {
  lastCheckedAtMs: number;
  lastSignature: string | null;
}

// Потоковый наблюдатель лимитов: в отличие от append-страховки, он мутит
// runtimeEvents на месте и уведомляет onEvent — цель «показать расход токенов
// живьём», а не обогатить финальный результат. Параметр-объект, а не
// позиционные аргументы: полей много, половина опциональна, и на месте вызова
// важна читаемость.
async function maybeEmitCodexSessionLimitEvent(input: {
  runtimeInput: RuntimeRunInput;
  sessionId: string | null;
  runtimeEvents: RuntimeEvent[];
  observerState: CodexSessionLimitObserverState;
  logger?: CodexSdkLogger;
  force?: boolean;
}): Promise<void> {
  const sessionId = input.sessionId;
  if (!sessionId) {
    return;
  }

  // Троттлинг по «последняя проверка была» (а не «первая»): условие > 0 оставляет
  // первый вызов непроверенным — событие уходит сразу, как только появились данные,
  // а уже затем включается интервал. force используется в финальной точке прогона,
  // где ожидание интервала бессмысленно — стрим уже закрыт.
  const nowMs = Date.now();
  if (
    input.force !== true &&
    input.observerState.lastCheckedAtMs > 0 &&
    nowMs - input.observerState.lastCheckedAtMs < CODEX_SESSION_LIMIT_POLL_INTERVAL_MS
  ) {
    return;
  }
  input.observerState.lastCheckedAtMs = nowMs;

  const snapshot = await getCodexSessionLimitSnapshot({
    sessionId,
    runtimeId: input.runtimeInput.runtimeId,
    providerId: input.runtimeInput.providerId ?? "openai",
    profileId: input.runtimeInput.profileId ?? null,
  });
  if (!snapshot) {
    return;
  }

  const signature = JSON.stringify(snapshot);
  if (input.observerState.lastSignature === signature) {
    return;
  }
  input.observerState.lastSignature = signature;

  const limitEvent = buildRuntimeLimitEvent(snapshot, "token_count");
  input.runtimeEvents.push(limitEvent);
  input.runtimeInput.execution?.onEvent?.(limitEvent);
  input.logger?.debug?.(
    {
      runtimeId: input.runtimeInput.runtimeId,
      transport: "sdk",
      sessionId,
      status: snapshot.status,
      checkedAt: snapshot.checkedAt,
    },
    "Observed Codex session token_count rate limits during SDK run",
  );
}

// ---------------------------------------------------------------------------
// Основное исполнение через SDK
// ---------------------------------------------------------------------------

// Одна попытка исполнения без retry-логики — она намеренно отделена от
// runCodexSdk: ретраить можно только «не стартнувший» прогон, а это решение
// знает только обёртка сверху, где виден тип ошибки.
async function runCodexSdkAttempt(
  input: RuntimeRunInput,
  logger?: CodexSdkLogger,
): Promise<RuntimeRunResult> {
  const codexOpts = buildCodexOptions(input, logger);
  const threadOpts = buildThreadOptions(input, logger);
  const turnOpts = buildTurnOptions(input.execution);
  const execution = input.execution;

  const codex = new Codex(codexOpts);

  // Резюме против новой ветки: resumeThread перестраивает историю из rollout-
  // файла на диске, поэтому sessionId должен существовать — без него молча
  // стартует новая ветка (проверка через && обеим условиям), и вызывающий не
  // получит неожиданного «продолжения пустоты».
  const thread =
    input.resume && input.sessionId
      ? codex.resumeThread(input.sessionId, threadOpts)
      : codex.startThread(threadOpts);

  // У Codex SDK нет отдельного слота system prompt в ThreadOptions/TurnOptions,
  // поэтому `execution.systemPromptAppend` (в API-транспорте — настоящее системное
  // сообщение) пристыковывается к пользовательскому промпту. Так инъекция
  // языковой директивы реестра работает на всех Codex-транспортах — см.
  // packages/runtime/src/registry.ts.
  const systemAppend = execution?.systemPromptAppend?.trim();
  const composedPrompt = systemAppend ? `${systemAppend}\n\n${input.prompt}` : input.prompt;

  const { events } = await thread.runStreamed(composedPrompt, turnOpts);

  // Оборачивает поток событий общими утилитами таймаутов
  // Явный вызов Symbol.asyncIterator: withStreamTimeouts забирает итератор в
  // единоличное потребление. Асинхронный итератор Codex — однопроходный, и
  // «случайно» обойти его дважды (for await по events и по обёртке) нельзя —
  // второй потребитель получил бы пустой стрим.
  // Фолбэк AbortController обязателен: утилиты таймаутов сами прерывают стрим,
  // и без собственного контроллера они не смогли бы закрыть зависший поток.
  const abort = execution?.abortController ?? new AbortController();
  const wrappedEvents = withStreamTimeouts(
    events[Symbol.asyncIterator](),
    {
      startTimeoutMs: execution?.startTimeoutMs,
      runTimeoutMs: execution?.runTimeoutMs,
    },
    abort,
  );

  // outputText копится из завершённых agent_message: Codex не отдаёт дельты
  // (в отличие от API-транспорта), поэтому склейка идёт блоками через пустую
  // строку — так многошаговый ответ остаётся читаемым Markdown'ом.
  let outputText = "";
  let sessionId: string | null = null;
  let usage: RuntimeUsage | null = null;
  const runtimeEvents: RuntimeEvent[] = [];
  const limitObserverState: CodexSessionLimitObserverState = {
    lastCheckedAtMs: 0,
    lastSignature: null,
  };

  for await (const event of wrappedEvents) {
    // Извлекает thread ID из первого события
    if (event.type === "thread.started") {
      sessionId = event.thread_id;
    }

    // Извлекает usage из завершения тёрна
    if (event.type === "turn.completed") {
      usage = normalizeUsage(event.usage);
    }

    // хода разворачивается в брошенное исключение, а не в event: так
    // ошибка попадает в единый catch обёртки runCodexSdk, где решают «ретраить или
    // нет». classifyCodexRuntimeError обогащает её структурными category/adapterCode.
    // Обработка фатальных ошибок
    if (event.type === "turn.failed") {
      throw classifyCodexRuntimeError(event.error?.message ?? "Codex turn failed");
    }

    // Сбор выходного текста из завершённых сообщений агента
    if (event.type === "item.completed" && event.item.type === "agent_message") {
      if (outputText) outputText += "\n\n";
      outputText += event.item.text;
    }

    // Вызов onToolUse для item'ов-инструментов
    if (event.type === "item.completed") {
      const toolSummary = itemToToolUseSummary(event.item);
      if (toolSummary) {
        execution?.onToolUse?.(toolSummary.toolName, toolSummary.detail);
      }
    }

    // Маппинг в события runtime и уведомление
    const runtimeEvent = threadEventToRuntimeEvent(event);
    if (runtimeEvent) {
      runtimeEvents.push(runtimeEvent);
      execution?.onEvent?.(runtimeEvent);
    }

    // Вызов на каждом событии бесплатен: троттлинг и дедуп живут внутри
    // наблюдателя, а здесь важен лишь факт «стрим ещё идёт».
    await maybeEmitCodexSessionLimitEvent({
      runtimeInput: input,
      sessionId,
      runtimeEvents,
      observerState: limitObserverState,
      logger,
    });
  }

  // При resume событие thread.started может не прийти, и тогда sessionId есть
  // только у самого объекта thread — фоллбэк закрывает этот пробел, иначе
  // лимит-снимок и последующее resume были бы невозможны.
  // Резерв: thread.id заполняется после старта первого тёрна
  if (!sessionId) {
    sessionId = thread.id ?? null;
  }

  // Финальная точка: force-проверка наблюдателя (свежий снимок в runtimeEvents)
  // плюс append-страховка на уровне результата. Двойной контроль не дублирует
  // работу: вторая ступень сверяет подпись и ничего не добавляет, если первая
  // уже всё выдала.
  await maybeEmitCodexSessionLimitEvent({
    runtimeInput: input,
    sessionId,
    runtimeEvents,
    observerState: limitObserverState,
    logger,
    force: true,
  });

  const result: RuntimeRunResult = {
    outputText,
    sessionId,
    usage,
    events: runtimeEvents,
  };

  return appendCodexSessionLimitEvent(input, result);
}

// Публичная точка входа sdk-транспорта: одна попытка прогона плюс ровно один
// retry. Повтор разрешён только для ретриабельного start-timeout (стрим не начал
// отдавать события) — это почти всегда холодный старт дочернего процесса или
// гонка за сетевое соединение, где повтор дёшев. Ошибки же после начала работы
// не ретраятся: вторая попытка удвоила бы побочные эффекты (правки файлов, комманды).
export async function runCodexSdk(
  input: RuntimeRunInput,
  logger?: CodexSdkLogger,
): Promise<RuntimeRunResult> {
  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "sdk",
      resume: Boolean(input.resume && input.sessionId),
      model: input.model ?? null,
      startTimeoutMs: input.execution?.startTimeoutMs ?? null,
      runTimeoutMs: input.execution?.runTimeoutMs ?? null,
    },
    "Starting Codex SDK run",
  );

  try {
    const result = await runCodexSdkAttempt(input, logger);
    logger?.info?.(
      {
        runtimeId: input.runtimeId,
        transport: "sdk",
        sessionId: result.sessionId,
        outputLength: result.outputText?.length ?? 0,
        eventCount: result.events?.length ?? 0,
        hasUsage: Boolean(result.usage),
      },
      "Codex SDK run completed",
    );
    return result;
  } catch (error) {
    // Классификация идёт по структурированным полям (category + служебный флаг), а
    // не по тексту сообщения — см. правило проекта о запрете строкового матчинга.
    // Задержка resolveRetryDelay разводит повторные попытки по времени, чтобы не
    // долбить уставший backend сразу после отбоя.
    if (isRetriableTimeoutError(error)) {
      const retryDelayMs = resolveRetryDelay(input.execution ?? {});
      logger?.warn?.(
        { runtimeId: input.runtimeId, retryDelayMs },
        "Codex SDK start timeout, retrying once after delay",
      );
      await sleepMs(retryDelayMs);
      return runCodexSdkAttempt(input, logger);
    }
    throw error;
  }
}
