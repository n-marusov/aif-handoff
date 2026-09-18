// Валидация и нормализация переменных окружения.
//
// Это барьер между "сырым" process.env и типизированным кодом: значения приходят
// строками, а падать нужно на старте и с понятным сообщением, а не в середине работы
// задачи. Схема zod описывает все поддерживаемые переменные сразу с приведением типов
// и значениями по умолчанию, поэтому чтение окружения в других модулях сводится к
// getEnv() и не требует ручных проверок.
//
// Новая переменная добавляется здесь, а не читается из process.env напрямую: иначе она
// не попадёт ни в валидацию, ни в документацию конфигурации.

import { z } from "zod";
import { logger } from "./logger.js";
import { AUTO_REVIEW_STRATEGIES } from "./types.js";

const log = logger("env");
// Переменные окружения всегда строки, поэтому "false" и "0" без приведения типа
// оказались бы истинными. Наборы задают все принимаемые текстовые формы.
const BOOLEAN_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const BOOLEAN_FALSE_VALUES = new Set(["0", "false", "no", "off"]);

// Режимы записи журнала активности: sync - писать сразу, batch - копить пачками.
// Константа объявлена отдельно, чтобы её же можно было использовать в z.enum ниже.
const ACTIVITY_LOG_MODES = ["sync", "batch"] as const;

/** Допустимая ширина распараллеливания исполнителей реализации в пределах задачи. */
// Границы экспортируются, потому что те же числа нужны в UI и в тестах: дублировать
// их означало бы рассинхронизировать валидацию и подсказку в интерфейсе.
export const IMPLEMENT_MAX_WORKERS_MIN = 1;
export const IMPLEMENT_MAX_WORKERS_MAX = 10;
export const IMPLEMENT_MAX_WORKERS_DEFAULT = 2;

// Принимает и массив (при программной передаче), и строку с запятыми (из окружения).
// Пустые элементы отбрасываются: значение вида "a,,b," должно дать два модуля, а не четыре.
function parseRuntimeModules(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// Функция повторяет логику parseRuntimeModules. Дублирование оставлено намеренно: у этих
// переменных разный смысл, и общий парсер со временем могли бы "улучшить" так, что
// поведение одного из потребителей изменилось бы незаметно.
function parseCommaSeparatedValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// preprocess переводит известные текстовые формы в boolean, а всё остальное отдаёт
// схеме как есть - тогда z.boolean() честно сообщит об ошибке вместо тихой подстановки.
const booleanEnvSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
    if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
  }
  return value;
}, z.boolean());

// CORS-источник проверяется строго: только схема http(s), хост и необязательный порт.
// Сравнение с parsed.origin отсекает пути, query и завершающий слэш, а звёздочка
// запрещена намеренно - иначе проверка происхождения теряет смысл.
const exactOriginSchema = z.string().transform((value, context) => {
  const trimmed = value.trim().replace(/\/$/, "");
  if (trimmed === "*") {
    context.addIssue({
      code: "custom",
      message: "Wildcard origins are not allowed",
    });
    return z.NEVER;
  }
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.origin !== trimmed ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    ) {
      context.addIssue({
        code: "custom",
        message: "Origin must contain only an http(s) scheme, host, and optional port",
      });
      return z.NEVER;
    }
    return parsed.origin;
  } catch {
    context.addIssue({ code: "custom", message: "Invalid origin URL" });
    return z.NEVER;
  }
});

// Единая схема всех переменных окружения приложения. optional() означает, что переменная
// необязательна (обычно у рантайм-провайдеров); default() задаёт безопасное значение,
// при котором приложение работает без дополнительной настройки.
const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_AUTH_TOKEN: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  CODEX_CLI_PATH: z.string().optional(),
  HTTP_PROXY: z.string().optional(),
  HTTPS_PROXY: z.string().optional(),
  ALL_PROXY: z.string().optional(),
  NO_PROXY: z.string().optional(),
  http_proxy: z.string().optional(),
  https_proxy: z.string().optional(),
  all_proxy: z.string().optional(),
  no_proxy: z.string().optional(),
  AIF_RUNTIME_MODULES: z.preprocess(parseRuntimeModules, z.array(z.string())).default([]),
  AIF_DEFAULT_RUNTIME_ID: z.string().default("claude"),
  AIF_DEFAULT_PROVIDER_ID: z.string().default("anthropic"),
  PORT: z.coerce.number().default(3009),
  POLL_INTERVAL_MS: z.coerce.number().default(30000),
  AGENT_STAGE_STALE_TIMEOUT_MS: z.coerce.number().default(90 * 60 * 1000),
  AGENT_STAGE_STALE_MAX_RETRY: z.coerce.number().default(3),
  AGENT_STAGE_RUN_TIMEOUT_MS: z.coerce.number().default(60 * 60 * 1000),
  AGENT_ACTIVITY_SILENCE_MS: z.coerce.number().default(5 * 60 * 1000),
  AGENT_MAX_TOOL_CALLS_PER_STAGE: z.coerce.number().default(500),
  AGENT_LOOP_READ_ONLY_BURST: z.coerce.number().default(20),
  AGENT_QUERY_START_TIMEOUT_MS: z.coerce.number().default(60 * 1000),
  AGENT_QUERY_START_RETRY_DELAY_MS: z.coerce.number().default(1000),
  AGENT_FIRST_ACTIVITY_TIMEOUT_MS: z.coerce.number().default(60 * 1000),
  // Таймаут внутреннего обращения публикации к API. Обработчик публикации в API
  // выполняет несколько последовательных запросов к GitLab/GitHub (по 30 с
  // с учётом повторов), поэтому клиентский таймаут 30 с прерывал бы вызов до ответа.
  AGENT_GIT_PUBLISH_TIMEOUT_MS: z.coerce.number().default(120 * 1000),
  API_RUNTIME_START_TIMEOUT_MS: z.coerce.number().default(60 * 1000),
  API_RUNTIME_RUN_TIMEOUT_MS: z.coerce.number().default(120 * 1000),
  DATABASE_URL: z.string().default("./data/aif.sqlite"),
  // Здесь допускается "*", а exactOriginSchema применяется там, где нужен строгий список
  // источников: по умолчанию приложение открыто, а ужесточение - выбор развёртывания.
  CORS_ORIGIN: z.string().default("*"),
  // Включение режима участников переводит приложение на аутентификацию и роли.
  // По умолчанию выключено, чтобы уже работающие развёртывания не сломались.
  PARTICIPANTS_MODE_ENABLED: booleanEnvSchema.default(false),
  PARTICIPANT_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(31_536_000)
    .default(7 * 24 * 60 * 60),
  PARTICIPANT_SESSION_COOKIE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .default("aif_participant_session"),
  PARTICIPANT_SESSION_COOKIE_SECURE: booleanEnvSchema.default(false),
  PARTICIPANT_LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),
  PARTICIPANT_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000).default(10),
  PARTICIPANT_ALLOWED_ORIGINS: z
    .preprocess(parseCommaSeparatedValues, z.array(exactOriginSchema).min(1))
    .default(["http://localhost:5180"]),
  API_BASE_URL: z.string().default("http://localhost:3009"),
  AGENT_QUERY_AUDIT_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(true),
  // Токен внутреннего канала оповещений между API и агентом. Необязателен при локальном
  // запуске, но обязателен для развёртываний, доступных извне.
  INTERNAL_BROADCAST_TOKEN: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("debug"),
  ACTIVITY_LOG_MODE: z
    .preprocess((value) => {
      if (typeof value !== "string") return "sync";
      const normalized = value.trim().toLowerCase();
      if (!(ACTIVITY_LOG_MODES as readonly string[]).includes(normalized)) {
        log.warn(
          { value, fallback: "sync" },
          "Invalid ACTIVITY_LOG_MODE value, falling back to sync",
        );
        return "sync";
      }
      return normalized;
    }, z.enum(ACTIVITY_LOG_MODES))
    .default("sync"),
  ACTIVITY_LOG_BATCH_SIZE: z.coerce.number().min(1).default(20),
  ACTIVITY_LOG_BATCH_MAX_AGE_MS: z.coerce.number().min(100).default(5000),
  ACTIVITY_LOG_QUEUE_LIMIT: z.coerce.number().min(1).default(500),
  // Соглашение об именах: флаги возможностей оканчиваются на _ENABLED, и все они по
  // умолчанию выключены. Новая возможность включается явно, поэтому обновление
  // приложения не меняет поведение уже работающего развёртывания.
  AGENT_WAKE_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(true),
  AGENT_BYPASS_PERMISSIONS: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(true),
  COORDINATOR_MAX_CONCURRENT_TASKS: z.coerce.number().min(1).max(100).default(12),
  COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT: z.coerce.number().min(1).max(10).default(3),
  COORDINATOR_MAX_CONCURRENT_PROJECTS: z.coerce.number().min(1).max(10).default(4),
  AGENT_CHAT_MAX_TURNS: z.coerce.number().min(1).default(50),
  AGENT_MAX_REVIEW_ITERATIONS: z.coerce.number().min(1).default(3),
  AGENT_AUTO_REVIEW_STRATEGY: z.enum(AUTO_REVIEW_STRATEGIES).default("full_re_review"),
  AGENT_USE_SUBAGENTS: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(false),
  AIF_USAGE_LIMITS_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(false),
  AIF_STAGE_RUNTIME_PIN_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(false),
  AIF_RUNTIME_MODEL_EFFORT_DISCOVERY_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(false),
  AIF_API_NODE_SERVER_V2_WEBSOCKET_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(false),
  AIF_WARMUP_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(false),
  AIF_QA_PIPELINE_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(false),
  AIF_TASK_WORKTREES_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(false),
  // Корневой каталог рабочих деревьев задач, привязанных к ветке. Без значения
  // агент использует `<dirname(projectRoot)>/.worktrees`. Развёртывания с отдельным
  // томом для worktree указывают здесь путь к этому тому (например, /home/www/.worktrees).
  AIF_WORKTREE_ROOT: z.string().min(1).max(4096).optional(),
  // Ограниченная ширина распараллеливания исполнителей внутри задачи. Контейнер
  // ограничен по CPU/памяти (cpus: 2 / memory: 1G), поэтому значения вне диапазона
  // откатываются к значению по умолчанию с WARN вместо падения валидации окружения.
  AIF_IMPLEMENT_MAX_WORKERS: z
    .preprocess((value) => {
      // Пустое значение трактуется как "не задано", а не как ошибка: контейнер может
      // передать переменную без значения.
      if (value === undefined || value === null || value === "") {
        return IMPLEMENT_MAX_WORKERS_DEFAULT;
      }
      const parsed = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
      if (
        !Number.isInteger(parsed) ||
        parsed < IMPLEMENT_MAX_WORKERS_MIN ||
        parsed > IMPLEMENT_MAX_WORKERS_MAX
      ) {
        // Значение вне диапазона не считается фатальной ошибкой: контейнер ограничен по
        // ресурсам, и предсказуемый откат к умолчанию лучше отказа стартовать вообще.
        log.warn(
          {
            value,
            fallback: IMPLEMENT_MAX_WORKERS_DEFAULT,
            min: IMPLEMENT_MAX_WORKERS_MIN,
            max: IMPLEMENT_MAX_WORKERS_MAX,
          },
          "Invalid AIF_IMPLEMENT_MAX_WORKERS value, falling back to default",
        );
        return IMPLEMENT_MAX_WORKERS_DEFAULT;
      }
      return parsed;
    }, z.number().int().min(IMPLEMENT_MAX_WORKERS_MIN).max(IMPLEMENT_MAX_WORKERS_MAX))
    .default(IMPLEMENT_MAX_WORKERS_DEFAULT),
  // Ниже повторяется та же логика приведения boolean, что и в booleanEnvSchema.
  // Исторически эти флаги разбирались до появления общей схемы; функционально они
  // эквивалентны, поэтому значение можно задавать как "1"/"true"/"yes"/"on".
  AIF_AGENT_AUTO_QUEUE_COMMIT_GATE_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(false),
  AIF_GITHUB_ISSUE_PR_ENABLED: booleanEnvSchema.default(false),
  GIT_PROVIDER: z.enum(["github", "gitlab"]).default("github"),
  AIF_GITLAB_ISSUE_MR_ENABLED: booleanEnvSchema.default(false),
  // Гейт план-ревью: когда включён, задачи, связанные с issue в VCS, замирают в
  // plan_review после публикации PR/MR только с планом и начинают
  // реализацию лишь после ручного одобрения в VCS. По умолчанию выключен, чтобы
  // существующим развёртываниям сохранился прежний поток авто-реализации.
  AIF_PLAN_REVIEW_PR_ENABLED: booleanEnvSchema.default(false),
  AIF_GITLAB_BASE_URL: z.string().default("https://gitlab.com/api/v4"),
  // Bootstrap runtime-профиля: при старте API автоматически заводит глобальный
  // runtime-профиль (и опционально общесистемные значения по умолчанию) из окружения.
  // Выключен по умолчанию, чтобы существующие установки (например, Codex OAuth login) не сменили поведение.
  AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED: booleanEnvSchema.default(false),
  AIF_BOOTSTRAP_RUNTIME_PROFILE_NAME: z.string().min(1).max(200).default("Bootstrap (Codex CLI)"),
  AIF_BOOTSTRAP_RUNTIME_ID: z.string().min(1).max(100).default("codex"),
  AIF_BOOTSTRAP_PROVIDER_ID: z.string().min(1).max(100).default("openai"),
  AIF_BOOTSTRAP_TRANSPORT: z.string().min(1).max(100).default("cli"),
  AIF_BOOTSTRAP_BASE_URL: z.string().max(1000).optional(),
  AIF_BOOTSTRAP_API_KEY_ENV_VAR: z.string().min(1).max(100).default("OPENAI_API_KEY"),
  AIF_BOOTSTRAP_DEFAULT_MODEL: z.string().max(200).optional(),
  AIF_BOOTSTRAP_SET_DEFAULTS: booleanEnvSchema.default(true),
  AIF_BOOTSTRAP_FORCE_UPDATE: booleanEnvSchema.default(false),
  // Git-идентичность для коммитов агента (атрибуция боту). Когда заданы оба
  // значения, агент применяет их как глобальные git user.name/user.email, чтобы
  // коммиты сабагентов относились на аккаунт бота.
  AIF_GIT_BOT_NAME: z.string().min(1).max(200).optional(),
  AIF_GIT_BOT_EMAIL: z.string().min(1).max(320).optional(),
  AIF_RUNTIME_SESSION_FORK_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(false),
  AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(false),
  AIF_RUNTIME_OPENCODE_LONG_RUNNING_DISPATCHER_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(false),
  AIF_ENABLE_CODEX_LOGIN_PROXY: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
        if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(false),
  AIF_CODEX_LOGIN_BROKER_PORT: z.coerce.number().default(3010),
  AGENT_INTERNAL_URL: z.string().default("http://agent:3010"),
  AIF_NOTIFICATIONS_PROJECT_NAMES_ENABLED: booleanEnvSchema.default(false),
  TELEGRAM_BOT_API_URL: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_USER_ID: z.string().optional(),
});

// Тип окружения выводится из схемы: добавили переменную в схему - она сразу доступна
// в типах, и разойтись они не могут.
export type Env = z.infer<typeof envSchema>;

// Кэш проверенного окружения на процесс.
let _env: Env | null = null;

// Предупреждения, а не ошибки: приложение продолжает работать, но конфигурация выглядит
// подозрительно - обычно это недонастроенный прокси или забытый ключ. Здесь же ловится
// дублирование модулей рантайма, которое иначе проявилось бы повторной загрузкой
// одного и того же адаптера.
function warnOnRuntimeDefaults(env: Env): void {
  if (env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
    log.warn(
      { hasAnthropicBaseUrl: true, hasAnthropicApiKey: false, hasAnthropicAuthToken: false },
      "ANTHROPIC_BASE_URL is configured without ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN",
    );
  }

  if (env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_MODEL) {
    log.warn(
      { hasAnthropicBaseUrl: true, hasAnthropicModel: false },
      "ANTHROPIC_BASE_URL is configured without ANTHROPIC_MODEL; set it if your proxy requires explicit model",
    );
  }

  if (env.OPENAI_BASE_URL && !env.OPENAI_API_KEY) {
    log.warn(
      { hasOpenAiBaseUrl: true, hasOpenAiApiKey: false },
      "OPENAI_BASE_URL is configured without OPENAI_API_KEY",
    );
  }

  const deduplicatedModules = [...new Set(env.AIF_RUNTIME_MODULES)];
  if (deduplicatedModules.length !== env.AIF_RUNTIME_MODULES.length) {
    log.warn(
      {
        configuredCount: env.AIF_RUNTIME_MODULES.length,
        deduplicatedCount: deduplicatedModules.length,
      },
      "AIF_RUNTIME_MODULES contains duplicate entries",
    );
  }
}

// Кэширующий доступ к проверенному окружению. Кэш обязателен: схема разбирает сотни
// переменных, а окружение процесса считается неизменным после старта.
export function getEnv(): Env {
  if (_env) return _env;

  // safeParse вместо parse: нужны сразу все ошибки в структурированном виде, чтобы
  // сообщение о неудаче было понятным без чтения стека.
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.flatten().fieldErrors;
    log.fatal({ errors: formatted }, "Environment validation failed");
    throw new Error(`Environment validation failed: ${JSON.stringify(formatted)}`);
  }

  // Кэш заполняется только после успешной проверки: неудачный разбор не должен
  // оставлять частично валидное окружение.
  _env = result.data;
  warnOnRuntimeDefaults(_env);
  log.debug({ port: _env.PORT, dbUrl: _env.DATABASE_URL }, "Environment loaded");
  log.info(
    {
      runtimeModulesCount: _env.AIF_RUNTIME_MODULES.length,
      hasAnthropicBaseUrl: Boolean(_env.ANTHROPIC_BASE_URL),
      hasAnthropicModel: Boolean(_env.ANTHROPIC_MODEL),
      hasOpenAiBaseUrl: Boolean(_env.OPENAI_BASE_URL),
      hasCodexCliPath: Boolean(_env.CODEX_CLI_PATH),
    },
    "Runtime environment defaults resolved",
  );
  log.info({ mode: _env.ACTIVITY_LOG_MODE }, "Activity logging mode selected");
  log.debug(
    {
      mode: _env.ACTIVITY_LOG_MODE,
      batchSize: _env.ACTIVITY_LOG_BATCH_SIZE,
      maxAgeMs: _env.ACTIVITY_LOG_BATCH_MAX_AGE_MS,
      queueLimit: _env.ACTIVITY_LOG_QUEUE_LIMIT,
    },
    "Resolved activity-log config",
  );
  return _env;
}

/** Проверяет окружение без кэширования — удобно для тестов */
// Отличие от getEnv: разбирается переданный объект (или текущее окружение), результат
// не кэшируется, поэтому функция годится для проверки произвольных наборов в тестах.
export function validateEnv(env: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(env);
}

/**
 * Сбрасывает кэш окружения, чтобы следующий `getEnv()` заново разобрал `process.env`.
 * Предназначен для тестов, переключающих флаги возможностей во время выполнения, —
 * никогда не вызывайте его в рабочем коде, где окружение считают стабильной константой.
 */
export function resetEnvCache(): void {
  // Сброс кэша нужен тестам, которые включают и выключают флаги по ходу выполнения.
  // В рабочем коде окружение считается постоянным, поэтому такой вызов был бы ошибкой.
  _env = null;
}
