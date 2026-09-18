/**
 * Разрешение runtime-профиля: цепочка task -> project -> system -> env fallback.
 *
 * Этот модуль превращает «сырые» куски конфигурации (строки из БД, переменные
 * окружения, ручные override'ы вызова) в один целостный ResolvedRuntimeProfile,
 * с которым уже работает реестр и адаптер. Файл не обращается к БД и не трогает
 * адаптеры: на входе — данные, на выходе — структура или исключение. Чистая функция
 * разрешения означает, что api, agent и mcp процессы получают идентичный результат
 * для идентичных входов, и «у меня в терминале работает иначе» исключено по построению.
 *
 * Два инварианта, вокруг которых построен весь файл:
 * 1) Явное всегда побеждает выведенное: profile.baseUrl > env.*_BASE_URL > null.
 *    Порядок цепочек `??` в resolveRuntimeProfile — и есть документация приоритетов.
 * 2) Ничего опасного не угадывается молча: неизвестный transport или невалидное
 *    имя env-переменной дают WARN в лог и предсказуемый fallback, а не исключение,
 *    потому что конфиг мог устареть, а задача должна остаться выполняемой.
 *
 * Здесь же живут валидация resolved-профиля (validateResolvedRuntimeProfile —
 * предупреждения для UI) и redact-проекция (redactResolvedRuntimeProfile —
 * безопасный для логов слепок без секретов).
 */

// Две формы импорта — не придирка стиля: RuntimeTransport нужен ЗНАЧЕНИЕМ
// (сравниваем transport === RuntimeTransport.API — члены enum'а живут в рантайме),
// а RuntimeWorkflowSpec — только как тип, и `import type` стирается компилятором
// в ноль: ни одного лишнего модуля в графе загрузок.
import { RuntimeResolutionError, RuntimeValidationError } from "./errors.js";
import { isRuntimeTransport, RuntimeTransport } from "./types.js";
import type { RuntimeWorkflowSpec } from "./workflowSpec.js";

// Structural typing («утиная типизация», проверенная компилятором): resolution.ts
// не знает про drizzle-сущность runtime_profiles — любой объект с этими полями
// принимается. Благодаря этому модуль не тянет @aif/data и работает и в браузере,
// и в тонких тестах, и в MCP-процессе, где нет БД-слоя. Поля опциональны с `| null`,
// потому что такие же «широкие» значения реально приходят из БД и UI-форм.
export interface RuntimeProfileLike {
  // id может отсутствовать: форма создания профиля в UI работает с ещё несохранённой
  // записью, а разрешателю id нужен только для логов и поля profileId результата.
  id?: string | null;
  // name — только отображение в UI; разрешатель его не читает вообще.
  name?: string;
  // Единственные обязательные поля — «кто исполняет» и «кто платит». Всё остальное
  // разрешатель способен достать из ENV/инференса; без этой пары он бессилен.
  runtimeId: string;
  providerId: string;
  // transport намеренно широкая string, а не union: значение пришло из JSON/БД и
  // ещё не прошло проверку. Разрешатель сам решает, что с ним делать (ниже, в
  // resolveConfiguredTransport), и ложный тип «уже валидно» здесь только вредил бы.
  transport?: string | null;
  baseUrl?: string | null;
  // apiKeyEnvVar здесь — ИМЯ переменной (например MY_COMPANY_LLM_KEY), не ключ.
  // Профиль никогда не хранит секрет в БД — только ссылку на источник значения.
  apiKeyEnvVar?: string | null;
  defaultModel?: string | null;
  // headers/options — произвольные слои: первые уходят в HTTP-запросы API-транспортов,
  // вторые — в настройки конкретного адаптера (cli-путь, effort, temperature...).
  // Тип options намеренно unknown-значения: схема принадлежит адаптеру, не хранилищу.
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  enabled?: boolean;
  // enabled отсутствует (undefined) трактуется как «включён»: колонка появилась
  // позже профилей, и старые строки БД не должны считаться выключенными из-за NULL.
}

// Контракт переменных окружения, которые понимает разрешатель: перечисленные поля —
// это документация на «известные» системе env-имена. Индексная сигнатура [key: string]
// внизу оставляет свободу читать любые другие переменные (apiKeyEnvVar из профиля
// может называться как угодно).
export interface RuntimeResolutionEnv {
  // Ключ и токен — пара альтернатив: первый для прямого API-доступа, второй для
  // proxy-развёртываний с делегированным auth. Порядок приоритета в них зашит
  // ниже (API_KEY -> AUTH_TOKEN -> дефолт), поэтому здесь просто объявление.
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_MODEL?: string;
  // OPENAI_* — общий namespace для всех OpenAI-совместимых endpoint'ов, включая
  // ветку codex: у неё свои правила (см. ниже), но переменные общие исторически.
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
  OPENROUTER_MODEL?: string;
  // CODEX_BASE_URL переопределяет только локальные транспорты Codex (см. инференс),
  // а CODEX_CLI_PATH — путь к бинарнику: нужен, когда codex не в PATH (Docker, Nix).
  // Это единственные env-переменные не-секреты в списке — они не уходят в логи.
  CODEX_BASE_URL?: string;
  CODEX_CLI_PATH?: string;
  // Индексная сигнатура заставляет ВСЕ перечисленные поля быть совместимыми с
  // string | undefined — нельзя объявить ANTHROPIC_MODEL: number. Это же даёт
  // свободу читать env["ЧТО-УГОДНО"] без каста, но ценой потери точности значений:
  // опечатка в имени ключа вернёт undefined, а не ошибку компиляции.
  [key: string]: string | undefined;
}

// Опциональные методы (`debug?`) — логгер тут минимальнее, чем в registry: разрешение
// ничего не ломает и не чинит, ему достаточно информировать. Все вызовы идут через
// `logger?.warn?.()` — цепочка optional chaining, прощающая и отсутствие логгера,
// и отсутствие отдельного метода в его частичной реализации.
export interface RuntimeResolutionLogger {
  // info опционален, но не используется в этом модуле: разрешение — технический путь,
  // в нём нет событий уровня «пользователю полезно знать».debug/warn — рабочий минимум.
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

// Вход разрешателя — «коалиция» источников: profile (уже выбранный вызывающим
// слоем по цепочке task->project->system), env, override'ы конкретного вызова.
// source — свободная строка метки («task:abc», «system», «chat») для диагностики:
// в warn-логах видно, чьё разрешение сфолбэчило. suppressModelFallback нужен для
// разведки без модели: проверить соединение без подставленной модели, чтобы провайдер
// сам ответил дефолтом.
export interface ResolveRuntimeProfileInput {
  // Метка источника для логов и для поля результата: одна строка вида "task:<uuid>"
  // или "system" позволяет по warn-логам восстановить, КАКОЕ разрешение сфолбэчило.
  source: string;
  // Уже выбранный слой цепочки (task->project->system) или null, когда слоёв нет.
  // Разрешатель не ищет профили — он их только дополняет; выбор остаётся за caller.
  profile: RuntimeProfileLike | null;
  env?: RuntimeResolutionEnv;
  // workflow прикреплён к профилю как метка: разрешатель его не читает и не
  // валидирует — просто переносит в результат, чтобы потребители (реестр, session
  // reuse) видели, для какого шага пайплайна всё это закручено.
  workflow?: RuntimeWorkflowSpec;
  modelOverride?: string | null;
  // высший приоритет в цепочке моделей — ручной выбор на конкретный запуск
  // (UI-переключатель модели) перебивает и профиль, и ENV: пользователь кликнул —
  // система обязана выполнить, а не «предпочесть настройки».
  /** lightModel адаптера — резерв между profile.defaultModel и выводом из env. */
  lightModelFallback?: string | null;
  suppressModelFallback?: boolean;
  runtimeOptionsOverride?: Record<string, unknown> | null;
  // идентификаторы последнего шанса: используются, когда profile == null вообще (нет
  // сохранённого профиля — системный режим). Существование этой пары — причина, по
  // которой разрешатель не требует профиль обязательно: «без профиля» — штатный
  // случай нового проекта, а не ошибка конфигурации.
  fallbackRuntimeId?: string;
  fallbackProviderId?: string;
  allowDisabled?: boolean;
  // logger опционален: разрешение живёт и в процессах без логгера (скрипты, тесты),
  // и отсутствие его не должна менять поведение — только наблюдаемость.
  logger?: RuntimeResolutionLogger;
}

// Результат — полностью конкретный профиль: никаких undefined/пустых строк внутри,
// все отсутствующие значения приведены к null или {}. Такой «канонический вывод»
// снимает с адаптеров обязанность повторять нормализацию: получили профиль — используйте
// как есть. headers/options всегда объекты, а не null: перебор ключей без null-проверок.
export interface ResolvedRuntimeProfile {
  // Каждое поле здесь — финальное решение по своей ветке конфигурации; в отличие от
  // RuntimeProfileLike, ни одно поле не опционально: разрешатель обязан конкретизировать.
  source: string;
  profileId: string | null;
  runtimeId: string;
  providerId: string;
  transport: RuntimeTransport;
  baseUrl: string | null;
  apiKeyEnvVar: string | null;
  // apiKey — единственное поле результата, которому запрещено попадать в любые
  // периферийные логи/ответы; все точки вывода обязаны идти через redact-проекцию.
  apiKey: string | null;
  model: string | null;
  headers: Record<string, string>;
  options: Record<string, unknown>;
  // workflow — единственное поле-«пожиток» (pass-through): разрешатель его не
  // нормализует, он нужен только downstream-потребителям (session reuse в workflowSpec).
  workflow?: RuntimeWorkflowSpec;
}

// Нормализация строк — фундамент всего файла: пустая строка, строка из пробелов и
// не-строка превращаются в null. Без этого `??` в цепочках приоритета выбирало бы
// "" как «значение задано», и дальше по системе поехали бы пустые baseUrl и transport.
// Почему string | null, а не optional-поле: явный null различает «проверили и не
// нашли» с «не проверяли», а undefined ещё и «поля нет в объекте». Для цепочек `??`
// это не косметика: normalizeString — единственный допуск, что «пустое = нет».
function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Регулярка поднята в const модуля: компиляция паттерна дорога, а вызов идёт на
// каждый разбор профиля — держать её внутри функции значило бы пересоздавать объект
// RegExp на каждый вызов.
const ENV_VAR_NAME_REGEX = /^[A-Za-z0-9_.-]+$/;

// Разрешённый алфавит имени env-переменной — это защита от инъекции: имя приходит
// из UI/БД и потом используется для доступа к process.env и записи в конфиг-файлы
// рантаймов. Всё, что не проходит (переносы строки, пробелы, кавычки, $()), отсекается
// здесь, а не в момент, когда оно уже попало в shell или TOML.
// Заметьте: `.` и `-` разрешены (легальны в именах ENV), а `=` — нет: оно означало
// бы попытку протащить имя со значением целиком.
// `value is string` — type predicate: после true TypeScript сужает тип аргумента,
// и вызывающий код может присваивать результат в string-поле без кастов.
// Функция экспортируется, а не живёт приватно в isValidEnvVarName: та же проверка
// нужна слоям api/data при сохранении профилей — ловить мусор надо на входе в БД,
// а не только при чтении. Дедупликация правила важнее инкапсуляции.
// Проверка по trimmed, но предикат сужает ИСХОДНОЕ значение — это безопасно только
// потому, что все вызовы идут после normalizeString (значение уже без пробелов).
// Не следует звать функцию с сырой строкой в новых местах без этой гарантии.
export function isValidEnvVarName(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return ENV_VAR_NAME_REGEX.test(trimmed);
}

// Имя env-переменной с ключом выводится из личности рантайма, а не хранится в
// профиле: для дефолтного случая это снимает тонну конфигурации (профиль может вообще
// не упоминать ключ), а порядок проверок ANTHROPIC_API_KEY -> ANTHROPIC_AUTH_TOKEN
// отражает реальную иерархию: явный ключ важнее дефолтного auth-токена.
// Ветвящиеся return'ы без early-exit-валидаций — это таблица решений, а не алгоритм:
// читается линейно и расширяется одной строкой на нового вендора.
function inferDefaultApiKeyEnvVar(
  runtimeId: string,
  providerId: string,
  env: RuntimeResolutionEnv,
): string {
  const runtime = runtimeId.toLowerCase();
  const provider = providerId.toLowerCase();

  // Сравнение идёт по обоим полям (runtime || provider), потому что профиль может
  // называть реализацию иначе, чем вендор: claude-адаптер над anthropic-аккаунтом
  // и «просто anthropic» без указания runtime — обе ветки должны ловиться.
  if (runtime === "claude" || provider === "anthropic") {
    if (normalizeString(env.ANTHROPIC_API_KEY)) return "ANTHROPIC_API_KEY";
    if (normalizeString(env.ANTHROPIC_AUTH_TOKEN)) return "ANTHROPIC_AUTH_TOKEN";
    return "ANTHROPIC_API_KEY";
  }
  if (runtime === "openrouter" || provider === "openrouter") {
    return "OPENROUTER_API_KEY";
  }
  // Финальный return OPENAI_API_KEY — не «для OpenAI», а дефолт по умолчанию для
  // всего OpenAI-совместимого: любой self-hosted шлюз говорит на этом диалекте,
  // и угадать для него другое имя было бы хуже, чем отдать нейтральное.
  return "OPENAI_API_KEY";
}

// baseUrl выводится отдельно от ключа, хотя «кажется что из той же таблицы»: у
// разных транспортов одна и та же пара (runtime, provider) даёт разные baseUrl-политики
// (см. ветку codex), поэтому transport здесь — полноценный аргумент решения.
function inferDefaultBaseUrl(
  runtimeId: string,
  providerId: string,
  env: RuntimeResolutionEnv,
  transport: RuntimeTransport,
): string | null {
  const runtime = runtimeId.toLowerCase();
  const provider = providerId.toLowerCase();

  if (runtime === "claude" || provider === "anthropic") {
    // Никакого hardcoded-дефолта: Anthropic SDK знает свой адрес сам, и подменять
    // его строкой здесь — значит создать вторую точку правды, которая разойдётся
    // с первой при первой же смене домена вендора.
    return normalizeString(env.ANTHROPIC_BASE_URL);
  }

  if (runtime === "openrouter" || provider === "openrouter") {
    // Единственный вендор с захардкоженным fallback-URL: openrouter.ai публичный
    // SaaS, его адрес — часть контракта, а не секрет настройки. Все остальные
    // baseUrl из ENV: нет значения — нет и дефолта (пусть провайдерская библиотека
    // сама решает, это её территория ответственности).
    return normalizeString(env.OPENROUTER_BASE_URL) ?? "https://openrouter.ai/api/v1";
  }

  // Локальные транспорты Codex (sdk/cli/app-server) не должны молча наследовать
  // OPENAI_BASE_URL: сессия `codex login` на OAuth обязана идти в собственный
  // бэкенд Codex, если profile baseUrl или CODEX_BASE_URL явно не согласны.
  if (runtime === "codex" && transport !== RuntimeTransport.API) {
    return normalizeString(env.CODEX_BASE_URL);
  }

  return normalizeString(env.OPENAI_BASE_URL);
}

// Каждый рантайм стартует с транспортом, который у него «главный по жизни»:
// Codex — CLI (нативный режим с OAuth-входами), OpenRouter — только API (нет
// локального бинарника), всё остальное — SDK. Здесь решается только дефолт, когда
// профиль молчит; явный выбор профиля обрабатывается ниже в resolveConfiguredTransport.
function inferDefaultTransport(runtimeId: string): RuntimeTransport {
  if (runtimeId.toLowerCase() === "codex") return RuntimeTransport.CLI;
  if (runtimeId.toLowerCase() === "openrouter") return RuntimeTransport.API;
  return RuntimeTransport.SDK;
}

// Транспорт — единственное поле профиля, которое может оказаться «вредным» значением
// (опечатка, устаревший enum из дампа БД), и именно здесь решается, что с этим делать:
// вместо падения — WARN + предсказуемый inferred-default. Иерархия решений:
// пустое -> default; легаси-алиас -> нормализация; валидное -> оно; мусор -> default.
// Именно здесь «agentapi» из старых конфигов доезжает до нового enum'а без миграции БД.
function resolveConfiguredTransport(input: {
  source: string;
  profileId: string | null;
  runtimeId: string;
  rawTransport: string | null;
  logger?: RuntimeResolutionLogger;
}): RuntimeTransport {
  const fallback = inferDefaultTransport(input.runtimeId);
  if (!input.rawTransport) {
    return fallback;
  }

  // Легаси-алиас логируется всегда, но НЕ ломает запуск: старый профиль продолжит
  // работать, а лог-запись даёт сигнал «пора мигрировать данные», не создавая
  // аварий. Обратная совместимость важнее чистоты enum'а.
  if (input.rawTransport === "agentapi") {
    // Аргумент warn-лога — снимок «до/после» нормализации: по этим строкам видно,
    // сколько ещё профилей живёт на легаси-алиасе, и когда миграцию можно закрывать.
    input.logger?.warn?.(
      {
        source: input.source,
        profileId: input.profileId,
        runtimeId: input.runtimeId,
        legacyTransport: input.rawTransport,
        normalizedTransport: RuntimeTransport.API,
      },
      "Legacy transport alias detected; normalizing to api",
    );
    return RuntimeTransport.API;
  }

  if (isRuntimeTransport(input.rawTransport)) {
    // Type guard сузил строку до union RuntimeTransport — дальше можно сравнивать
    // с членами enum'а без кастов и без страха опечатки в строковом литерале.
    // Единственный транспорт, явно подтверждаемый debug-логом: app-server —
    // экспериментальный режим Codex, и «дожил ли он до продакшн-запуска» важно
    // видеть в следе разрешения, тогда как обычный sdk/cli не интересны никому.
    if (input.rawTransport === RuntimeTransport.APP_SERVER) {
      input.logger?.debug?.(
        {
          source: input.source,
          profileId: input.profileId,
          runtimeId: input.runtimeId,
          transport: input.rawTransport,
          explicit: true,
        },
        "Explicit app-server transport resolved from runtime profile",
      );
    }
    return input.rawTransport;
  }

  // debug для штатного явного выбора, warn для аномалии — стандартная градация
  // этого модуля: логи разрешателя читают пачками, и шуметь на норме недопустимо.
  input.logger?.warn?.(
    {
      source: input.source,
      profileId: input.profileId,
      runtimeId: input.runtimeId,
      unknownTransport: input.rawTransport,
      fallbackTransport: fallback,
    },
    "Unknown transport value detected; falling back to inferred runtime transport",
  );
  return fallback;
}

// Дефолтной модели нет ни у одного вендора: в отличие от ключа и URL, модель —
// вопрос вкуса и бюджета, а не подключения. Здесь только чтение env; право решать
// «какая модель всё-таки» осталось за цепочкой приоритетов в resolveRuntimeProfile.
// Возвращает null (не строку-заглушку): потребитель обязан отличать «не задано» от «задано».
function inferDefaultModel(
  runtimeId: string,
  providerId: string,
  env: RuntimeResolutionEnv,
): string | null {
  const runtime = runtimeId.toLowerCase();
  const provider = providerId.toLowerCase();

  if (runtime === "claude" || provider === "anthropic") {
    return normalizeString(env.ANTHROPIC_MODEL);
  }

  if (runtime === "codex" || provider === "openai") {
    return normalizeString(env.OPENAI_MODEL);
  }

  if (runtime === "openrouter" || provider === "openrouter") {
    return normalizeString(env.OPENROUTER_MODEL);
  }

  return null;
}

// Тривиальная обёртка, но она нужна как единственная точка, где «имя переменной»
// превращается в «значение секрета». Динамический доступ env[envVarName] — тот самый
// случай, когда ключ приходит из данных, а не из кода; нормализация внутри гарантирует,
// что пустая переменная станет null, а не «успешным» пустым ключом.
function resolveApiKey(envVarName: string, env: RuntimeResolutionEnv): string | null {
  return normalizeString(env[envVarName]);
}

// Поверхностное слияние двух слоёв options: override перекрывает base по верхнему
// уровню ключей (вложенные объекты не мержатся рекурсивно — это сознательная простота:
// профиль либо задаёт подсложцеликом, либо не задаёт). `{...(x ?? {})}` защищает от
// null/undefined справа, чтобы spread не бросал TypeError на пустом слое.
function mergeRuntimeOptions(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

// Транспортные «доопции» — то, что нельзя вывести из env напрямую в generic-механизм.
// Сравнение `options.codexCliPath == null` (нестрогое) принципиально: пользовательская
// опция не должна перетираться env-дефолтом, даже если она явно выставлена в null.
// Возврат нового объекта (spread) вместо мутации — тот же канон чистоты, что и в реестре.
function applyTransportDefaults(
  transport: RuntimeTransport,
  options: Record<string, unknown>,
  env: RuntimeResolutionEnv,
): Record<string, unknown> {
  if (transport === RuntimeTransport.CLI) {
    const codexCliPath = normalizeString(env.CODEX_CLI_PATH);
    if (codexCliPath && options.codexCliPath == null) {
      return { ...options, codexCliPath };
    }
  }

  return options;
}

// Вершина модуля: единственный экспорт-разрешитель, через который проходит каждый
// запуск. Читается сверху вниз как приоритетная цепочка: profile > override > env >
// inference. Два исключения из «явное всегда побеждает»: disabled-профиль и пустой
// runtimeId/providerId — они бросают, потому что продолжать нечем в принципе.
export function resolveRuntimeProfile(input: ResolveRuntimeProfileInput): ResolvedRuntimeProfile {
  // process.env подставляется по умолчанию, но параметр env позволяет позвать
  // чистую функцию в тесте без подмены глобалов — стандартный приём testability
  // для кода, который обязан читать окружение.
  // process.env передаётся как RuntimeResolutionEnv через структурный cast: Node
  // типизирует его своим ProcessEnv, но индексная сигнатура env-интерфейса делает
  // приведение безопасным — оба описывают одно и то же: строки или undefined.
  const env = input.env ?? (process.env as RuntimeResolutionEnv);
  const profile = input.profile;

  // Профиль сюда уже пришёл выбранным: цепочка task -> project -> system решена
  // вызывающим слоем (он знает про БД). Разрешатель видит только финального кандидата
  // и может лишь отказаться (throw) или дополнить его inference-значениями из ENV.
  const runtimeId = normalizeString(profile?.runtimeId) ?? normalizeString(input.fallbackRuntimeId);
  const providerId =
    normalizeString(profile?.providerId) ?? normalizeString(input.fallbackProviderId);

  // Единственная точка, где «нет рантайма» превращается в ошибку. Именно здесь,
  // а не в реестре: реестр не знает, должен ли был существовать fallback.
  // Ошибки здесь двух сортов, и это не педантизм: RuntimeResolutionError — «нечем
  // разрешать» (нет ни профиля, ни fallback — caller ошибся в конфигурации), а
  // RuntimeValidationError — «данные есть, но запрещены» (выключенный профиль).
  // Мониторинг и UI ветвятся по типу, а не по тексту сообщения.
  if (!runtimeId || !providerId) {
    throw new RuntimeResolutionError(
      "Unable to resolve runtime profile: runtimeId/providerId are missing",
    );
  }

  // Отключённый профиль — ошибка, а не «игнорируем»: человек выключил его руками,
  // и тихо разрешить такой профиль означало бы предать это намерение. allowDisabled
  // — исключение для аудит-сценариев (показать, что было настроено до отключения).
  if (profile?.enabled === false && !input.allowDisabled) {
    throw new RuntimeValidationError(`Runtime profile "${profile.id ?? "unknown"}" is disabled`);
  }

  // Сырое имя транспорта нормализуется здесь, а канонизируется в resolveConfiguredTransport:
  // пустые строки из UI-форм и БД-дампов превращаются в null ДО всяких сравнений —
  // дальше работает только канонический набор значений.
  const rawTransport = normalizeString(profile?.transport);
  // С первого же поля включается паттерн «валидация с предупреждением»: transport
  // никогда не остаётся undefined — худший исход это inferred-default. Контракт
  // ResolvedRuntimeProfile обязывает: у потребителя всегда есть конкретный транспорт.
  const transport = resolveConfiguredTransport({
    source: input.source,
    profileId: normalizeString(profile?.id),
    runtimeId,
    rawTransport,
    logger: input.logger,
  });
  // Развязка имени переменной и значения секрета: здесь работаем только с ИМЕНАМИ,
  // сам ключ читается одной строкой ниже и живёт только в локальной переменной apiKey.
  // Разделение нужно логированию и UI: они могут показывать apiKeyEnvVar, не видя секрета.
  const explicitApiKeyEnvVar = normalizeString(profile?.apiKeyEnvVar);
  const defaultApiKeyEnvVar = inferDefaultApiKeyEnvVar(runtimeId, providerId, env);
  // Локальные транспорты Codex по умолчанию используют `codex login` / OAuth. Они не
  // должны молча подхватывать внешнюю OPENAI_API_KEY — только явный profile
  // apiKeyEnvVar переводит локальный Codex-запуск на авторизацию по API-ключу.
  const isCodexLocalTransport =
    runtimeId.toLowerCase() === "codex" && transport !== RuntimeTransport.API;
  // (Local Codex transports default to `codex login` / OAuth auth...) — по-русски:
  // тернарник читается как «локальный Codex без явного env-var -> apiKeyEnvVar = null».
  // null здесь — не «не нашли», а «не ищем принципиально»: иначе ambient OPENAI_API_KEY
  // тихо подмешался бы в OAuth-сессию, и пользователь получил бы неожиданный billing.
  let apiKeyEnvVar: string | null =
    isCodexLocalTransport && !explicitApiKeyEnvVar ? null : defaultApiKeyEnvVar;
  if (explicitApiKeyEnvVar) {
    // Ветка «валидное имя из конфига» и «валидируем прежде чем доверять»: невалидное
    // имя не бросается, а шуршит в warn и уступает inference — профиль может быть
    // частично битым, и разрешение обязано выжать из него рабочий максимум.
    if (isValidEnvVarName(explicitApiKeyEnvVar)) {
      apiKeyEnvVar = explicitApiKeyEnvVar;
    } else {
      // Ветка «пользователь ввёл мусор в поле имени переменной»: ругань в warn,
      // но apiKeyEnvVar остаётся inference-дефолтом — разрешение продолжается,
      // не бросая. Исключение бросалось бы только на полном отсутствии идентификаторов.
      input.logger?.warn?.(
        {
          source: input.source,
          profileId: normalizeString(profile?.id),
          runtimeId,
          providerId,
          invalidApiKeyEnvVar: explicitApiKeyEnvVar,
          fallbackApiKeyEnvVar: defaultApiKeyEnvVar,
        },
        "Invalid apiKeyEnvVar detected; falling back to inferred default env var",
      );
    }
  }
  let apiKey = apiKeyEnvVar ? resolveApiKey(apiKeyEnvVar, env) : null;
  // Второй шанс (fallback-ветка): если пользователь назвал собственную env-переменную,
  // но она пуста, пробуем каноническое имя вендора. Условие apiKeyEnvVar !==
  // defaultApiKeyEnvVar гарантирует, что мы не читаем ту же переменную дважды,
  // а !isCodexLocalTransport сохраняет в силе правило «локальный Codex живёт на OAuth».
  if (
    !apiKey &&
    explicitApiKeyEnvVar &&
    apiKeyEnvVar !== defaultApiKeyEnvVar &&
    !isCodexLocalTransport
  ) {
    const fallbackApiKey = resolveApiKey(defaultApiKeyEnvVar, env);
    if (fallbackApiKey) {
      // Разыменование секретов здесь — единственный путь, где канонический ключ
      // может «подстраховать» пустой именованный. Лог при этом содержит только
      // ИМЕНА переменных — секрет в него не попадает даже косвенно.
      input.logger?.warn?.(
        {
          source: input.source,
          profileId: normalizeString(profile?.id),
          runtimeId,
          providerId,
          missingApiKeyEnvVar: apiKeyEnvVar,
          fallbackApiKeyEnvVar: defaultApiKeyEnvVar,
        },
        "Configured apiKeyEnvVar is not set; falling back to inferred default env var",
      );
      // Обе переменные меняются парой (имя И значение): если обновить только apiKey,
      // в результат попадёт противоречие «ключ из X, но подписан именем Y» — и
      // диагностика потом пойдёт по ложному следу.
      apiKeyEnvVar = defaultApiKeyEnvVar;
      apiKey = fallbackApiKey;
    }
  }
  // baseUrl: профиль -> env-инференс -> null. В отличие от ключа, здесь нет «второго
  // шанса» и warn'а: пустой baseUrl для многих транспортов — норма (SDK сам знает
  // адрес вендора), и поднимать шум на норме значило бы обесценить будущие реальные warn'и.
  const baseUrl =
    normalizeString(profile?.baseUrl) ?? inferDefaultBaseUrl(runtimeId, providerId, env, transport);
  // Модель — самая длинная цепочка приоритетов в файле, и её порядок — часть продукта:
  // явный override вызова > настройка профиля > «лёгкая» модель адаптера (lightModel,
  // для черновых прогонов) > env-инференс. suppressModelFallback — аварийный выключатель
  // всей цепочки для connection-validation: проверка «жив ли провайдер» идёт без модели,
  // и падать из-за подставленной model было бы ложной тревогой.
  const model =
    input.suppressModelFallback === true
      ? null
      : (normalizeString(input.modelOverride) ??
        normalizeString(profile?.defaultModel) ??
        normalizeString(input.lightModelFallback) ??
        inferDefaultModel(runtimeId, providerId, env));
  // headers: пустой объект вместо undefined — та же канонизация результата, что и
  // в ResolvedRuntimeProfile: потребитель делает Object.entries(headers) без guards.
  const headers = profile?.headers ?? {};
  // Слияние options: профиль — база, override вызова — поверх. Порядок слоёв здесь
  // совпадает с общей философией файла: чем ближе к конкретному запуску, тем сильнее.
  const mergedOptions = mergeRuntimeOptions(profile?.options, input.runtimeOptionsOverride);
  // Слой транспортовых доопций применяется последним: он может заполнить дырку
  // (путь к CLI из ENV), но не перекрывает уже выбранное — приоритет user > env > default.
  const options = applyTransportDefaults(transport, mergedOptions, env);

  // Объект-результат собирается одним литералом (а не по полям через let): компилятор
  // проверяет полноту ResolvedRuntimeProfile, и «забытое поле» невозможно — если
  // контракт вырастет, это место станет красным, а не тихим undefined.
  const resolved: ResolvedRuntimeProfile = {
    source: input.source,
    // profileId может остаться null даже при успехе: системный режим работает без
    // сохранённого профиля. Это единственное поле результата с таким правом —
    // именно потому, что оно не влияет на исполнение, только на учёт и логи.
    profileId: normalizeString(profile?.id),
    runtimeId,
    providerId,
    transport,
    baseUrl,
    apiKeyEnvVar,
    apiKey,
    model,
    headers,
    options,
    workflow: input.workflow,
  };

  // Разрешение НЕ вызывает validateResolvedRuntimeProfile: валидация — отдельная
  // дверь, которую дергают только там, где ей место (health-check, UI). Зацикливать
  // их означало бы навязать каждому запуску политику «предупреждать», хотя часть
  // consumers предупреждения игнорирует осознанно.
  input.logger?.debug?.(
    {
      source: input.source,
      profileId: resolved.profileId,
      runtimeId: resolved.runtimeId,
      providerId: resolved.providerId,
      transport: resolved.transport,
      hasBaseUrl: Boolean(resolved.baseUrl),
      // hasApiKey вместо значения: лог разрешателя — первое место, где секрет мог бы
      // утечь; контракт «никогда не логируем ключ» начинается с этих Boolean(...).
      // Тот же принцип у optionKeys/redact — наружу уходят имена, не содержимое.
      hasApiKey: Boolean(resolved.apiKey),
      model: resolved.model,
      suppressModelFallback: input.suppressModelFallback === true,
      optionKeys: Object.keys(resolved.options),
    },
    "Resolved runtime profile",
  );

  // Единственный выход функции — новый объект: входные profile/env не мутируются,
  // поэтому одно и то же окружение разрешения можно безопасно переиспользовать
  // между несколькими прогонами (параллельные задачи, тесты).
  return resolved;
}

export interface RuntimeValidationResult {
  ok: boolean;
  message: string;
  warnings: string[];
}

// Пред-полётная проверка уже resolved-профиля — для endpoint'ов «проверить соединение»
// и для UI-подсказок. Ключевое решение: это warnings, а не ошибки — разрешение
// намеренно терпит неполноту (см. инвариант 2 в шапке), и валидатор лишь называет
// вещи, которые почти наверняка сломают запуск. ok==true не гарантирует успех,
// ok==false — почти гарантирует; потребители показывают список, но не блокируют.
export function validateResolvedRuntimeProfile(
  resolved: ResolvedRuntimeProfile,
): RuntimeValidationResult {
  const warnings: string[] = [];

  // API-транспорт требует и ключ, и base URL
  // Ветки валидации зеркалят инференс: transport == API — минимальный набор,
  // без которого HTTP-клиент физически не может обратиться к вендору.
  if (resolved.transport === RuntimeTransport.API) {
    if (!resolved.apiKey) {
      warnings.push(
        `Missing API key env var ${resolved.apiKeyEnvVar ?? "unknown"} for runtime "${resolved.runtimeId}" (API transport)`,
      );
    }
    // agentApiBaseUrl — запасной источник адреса для специфичных сборок (агентский
    // API-слой сам строит URL); если он задан, требовать baseUrl сверху некорректно.
    if (!resolved.baseUrl && typeof resolved.options.agentApiBaseUrl !== "string") {
      warnings.push("API transport requires a base URL (set profile baseUrl or OPENAI_BASE_URL)");
    }
  }

  // CLI-транспорт требует путь к CLI
  // CLI и app-server требуют один и тот же бинарник (app-server — тот же Codex CLI
  // в режиме JSON-RPC сервера), поэтому проверка одна на двоих, а текст предупреждения
  // различается — пользователю важно, какой именно режим у него выбран.
  if (
    (resolved.transport === RuntimeTransport.CLI ||
      resolved.transport === RuntimeTransport.APP_SERVER) &&
    typeof resolved.options.codexCliPath !== "string"
  ) {
    // Проверка по типу, а не по truthiness: путь "/nonexistent/codex" пройдёт её и
    // станет проблемой запуска (с внятной ошибкой spawn), а вот undefined/пустая
    // строка — это ещё конфигурация, и предупредить о ней дёшево и правильно.
    warnings.push(
      `${
        resolved.transport === RuntimeTransport.APP_SERVER ? "app-server" : "CLI"
      } transport is selected but codexCliPath is missing`,
    );
  }

  // SDK-транспорт — API-ключ необязателен (SDK поверх CLI ведут авторизацию своим login-потоком)
  // Отсутствие ветки SDK здесь — осознанно: он может быть без ключа (OAuth-сессия
  // `codex login` / `claude login`), и требовать что-либо было бы неправдой.

  const ok = warnings.length === 0;
  // message — короткий статус для подписи в UI; детали всегда в массиве warnings,
  // который потребитель рендерит списком. Держать и то и другое нужно: одно для
  // бейджа «OK/проблемы», второе — чтобы человек понял, ЧТО именно починить.
  return {
    ok,
    message: ok ? "Runtime profile validation passed" : "Runtime profile validation has warnings",
    warnings,
  };
}

// Анти-утечка как отдельная функция: любой лог/HTTP-ответ/WS-событие с профилем
// обязан проходить через эту проекцию. Правила простые: значения секретов наружу
// не уходят вообще (только hasApiKey), а headers/options раскрывают только ИМЕНА
// ключей — названия самих переменных нечувствительны, а содержимое чувствительно.
// Отдельный экспорт нужен потому, что «красивый лог» пишется рукой быстрее, чем
// «безопасный» — здесь безопасный вариант уже собран и остаётся его только позвать.
export function redactResolvedRuntimeProfile(
  resolved: ResolvedRuntimeProfile,
): Record<string, unknown> {
  return {
    source: resolved.source,
    profileId: resolved.profileId,
    runtimeId: resolved.runtimeId,
    providerId: resolved.providerId,
    transport: resolved.transport,
    baseUrl: resolved.baseUrl,
    apiKeyEnvVar: resolved.apiKeyEnvVar,
    hasApiKey: Boolean(resolved.apiKey),
    model: resolved.model,
    headers: Object.keys(resolved.headers),
    // имена заголовков наружу, значения — нет: сам факт наличия Authorization-
    // заголовка безвреден, а его значение — готовый угон сессии.
    optionKeys: Object.keys(resolved.options),
    // workflowKind через optional chaining и null-фолбэк: сериализуемый проекция
    // не может содержать undefined — JSON от него избавляется молча, и consumer'ы
    // получали бы «пропавшее поле» вместо явного null.
    workflowKind: resolved.workflow?.workflowKind ?? null,
  };
}
