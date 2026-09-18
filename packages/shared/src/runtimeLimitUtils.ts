// Работа с данными о лимитах рантайма: нормализация, редакция секретов, подписывание
// снимков и безопасное сопоставление ошибок.
//
// Данные о лимитах приходят от внешних провайдеров и содержат служебные поля, среди
// которых бывают ключи, токены, заголовки запросов и адреса. Всё, что покидает процесс
// (логи, UI, журнал аудита), обязано пройти редакцию: входящий поток недоверенный, а
// метаданные провайдера - произвольный JSON.
//
// Защита построена на белых списках: разрешённые ключи перечислены отдельно для каждого
// провайдера, всё остальное отбрасывается по умолчанию. Новый или неизвестный ключ не
// попадёт наружу, даже если его никто явно не запрещал.

import type { RuntimeLimitScope, RuntimeLimitSnapshot, RuntimeLimitWindow } from "./types.js";

// Заглушка, которая остаётся на месте удалённого секрета: пустая строка скрывала бы
// сам факт того, что здесь были данные.
const REDACTED_VALUE = "[REDACTED]";
// Ограничители размера метаданных провайдера. Живут здесь, а не в вызывающем коде,
// потому что применяются и к записи в базу, и к выдаче в UI: неконтролируемый JSON мог
// бы раздуть строку до мегабайтов.
const MAX_PROVIDER_META_BYTES = 4096;
const MAX_PROVIDER_META_DEPTH = 4;
const MAX_PROVIDER_META_OBJECT_KEYS = 24;
const MAX_PROVIDER_META_ARRAY_ITEMS = 24;
const MAX_PROVIDER_META_STRING_LENGTH = 256;

// Ключи сравниваются без учёта регистра и пробелов: провайдеры присылают camelCase,
// snake_case и PascalCase для одних и тех же понятий.
function normalizeMetaKey(value: string): string {
  return value.trim().toLowerCase();
}

// Хелпер превращает объявленный список в множество нормализованных ключей: набор
// собирается один раз при загрузке модуля, чтобы проверка была за постоянное время.
function toNormalizedKeySet(values: ReadonlyArray<string>): ReadonlySet<string> {
  return new Set(values.map((value) => normalizeMetaKey(value)));
}

// Ключи, разрешённые у любого провайдера: идентификаторы и границы окна лимита,
// состояние квоты, метки времени и сводки по моделям. Секретов здесь быть не может.
const GENERIC_ALLOWED_PROVIDER_META_KEYS = toNormalizedKeySet([
  "status",
  "reason",
  "category",
  "providerFamily",
  "providerLabel",
  "quotaSource",
  "limitId",
  "planType",
  "accountId",
  "accountName",
  "accountLabel",
  "accountFingerprint",
  "isUsingOverage",
  "surpassedThreshold",
  "rateLimitType",
  "retryAfterSeconds",
  "resetAt",
  "windowHours",
  "modelUsageSummary",
  "toolUsageSummary",
]);

// Дополнительные ключи по провайдерам. Списки расширяют общий, а не заменяют его:
// значение, разрешённое одному провайдеру, не становится разрешённым остальным.
const PROVIDER_META_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  anthropic: toNormalizedKeySet([
    "providerFamily",
    "providerLabel",
    "quotaSource",
    "planType",
    "accountId",
    "accountName",
    "accountLabel",
    "accountFingerprint",
    "isUsingOverage",
    "surpassedThreshold",
    "rateLimitType",
    "retryAfterSeconds",
    "resetAt",
    "modelUsageSummary",
    "toolUsageSummary",
  ]),
  claude: toNormalizedKeySet([
    "providerFamily",
    "providerLabel",
    "quotaSource",
    "planType",
    "accountId",
    "accountName",
    "accountLabel",
    "accountFingerprint",
    "isUsingOverage",
    "surpassedThreshold",
    "rateLimitType",
    "retryAfterSeconds",
    "resetAt",
    "modelUsageSummary",
    "toolUsageSummary",
  ]),
  openai: toNormalizedKeySet([
    "status",
    "reason",
    "category",
    "retryAfterSeconds",
    "resetAt",
    "rateLimitType",
  ]),
  openrouter: toNormalizedKeySet([
    "status",
    "reason",
    "category",
    "retryAfterSeconds",
    "resetAt",
    "rateLimitType",
  ]),
  codex: toNormalizedKeySet([
    "status",
    "reason",
    "category",
    "retryAfterSeconds",
    "resetAt",
    "rateLimitType",
    "limitId",
    "accountLabel",
    "accountFingerprint",
    "providerLabel",
    "planType",
    "modelUsageSummary",
    "toolUsageSummary",
  ]),
};

// Явный чёрный список. Механизмом защиты он не является (её обеспечивает белый
// список), но нужен для читаемости и тестов: видно, какие ключи считаются
// принципиально недопустимыми - заголовки, тела запросов, стектрейсы, токены.
const FORBIDDEN_PROVIDER_META_KEYS = toNormalizedKeySet([
  "headers",
  "header",
  "body",
  "raw",
  "response",
  "request",
  "payload",
  "stderr",
  "stdout",
  "stack",
  "trace",
  "traceback",
  "dump",
  "diagnostics",
  "debug",
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "apiKey",
  "api_key",
  "secret",
  "secret_token",
  "password",
  "credentials",
]);

// Данные аккаунта, которые нельзя отдавать наружу: они позволяют связать лимиты с
// конкретной учётной записью. Внутри процесса они нужны, при экспозиции - нет.
const EXTERNAL_PROVIDER_META_KEYS = toNormalizedKeySet([
  "accountId",
  "accountName",
  "accountLabel",
  "accountFingerprint",
]);

// Шаблоны известных форматов секретов: ключи OpenAI, токены GitHub, ключи Google и
// AWS, Slack, JWT, заголовок Bearer. Выражения намеренно широкие - лучше удалить
// лишнее, чем пропустить настоящий ключ.
const SECRET_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_\-]{6,}\b/gi,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b/gi,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi,
  /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
  /\bya29\.[0-9A-Za-z._\-]+\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox(?:a|b|p|o|r|s)-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\bbearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
];

// Контактные данные: почта и ссылки. В логах они полезны (по ссылке можно найти
// запрос), наружу их отдавать не нужно, поэтому применяются только при строгой редакции.
const CONTACT_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\bhttps?:\/\/[^\s"']+/gi,
];

// Ключи, значение которых считается секретом независимо от формата: имя ключа важнее
// содержимого, потому что токен бывает произвольной строкой без узнаваемого префикса.
const SENSITIVE_VALUE_KEYS = [
  "access[_-]?token",
  "refresh[_-]?token",
  "client[_-]?secret",
  "id[_-]?token",
  "secret(?:[_-]?token)?",
  "api[_-]?key",
  "authorization",
  "password",
  "token",
] as const;

// Выражение находит пару ключ-значение в тексте (в том числе внутри сериализованного
// JSON) и заменяет только значение, оставляя имя ключа - так структура лога остаётся
// читаемой. Три группы соответствуют двойным кавычкам, одинарным и значению без них.
const SENSITIVE_VALUE_KEY_PATTERN = new RegExp(
  `((?:"|')?(?:${SENSITIVE_VALUE_KEYS.join("|")})(?:"|')?\\s*[:=]\\s*)(?:"([^"]*)"|'([^']*)'|([^\\s,"'{}\\]]+))`,
  "gi",
);

// Строгий набор: и секреты, и контактные данные. Применяется там, где текст покидает
// процесс или сохраняется в пользовательских данных.
const STRICT_TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  ...SECRET_VALUE_PATTERNS,
  ...CONTACT_VALUE_PATTERNS,
];

// Схема допустимой формы метаданных: массив или объект с белым списком ключей и
// вложенными правилами. Структура описана декларативно, поэтому проверка обходится без
// ручного разбора на каждого провайдера.
type ProviderMetaSchema =
  | {
      kind: "array";
      item: ProviderMetaSchema | null;
    }
  | {
      kind: "object";
      allowedKeys: ReadonlySet<string>;
      nested?: Record<string, ProviderMetaSchema>;
    };

// Ключи схемы приводятся к тому же виду, что и ключи данных, иначе вложенное правило
// не нашлось бы из-за разницы в регистре.
function normalizeSchemaRecord(
  values: Record<string, ProviderMetaSchema>,
): Record<string, ProviderMetaSchema> {
  const normalized: Record<string, ProviderMetaSchema> = {};
  for (const [key, value] of Object.entries(values)) {
    normalized[normalizeMetaKey(key)] = value;
  }
  return normalized;
}

const MODEL_USAGE_ITEM_SCHEMA: ProviderMetaSchema = {
  kind: "object",
  allowedKeys: toNormalizedKeySet(["modelName", "totalTokens"]),
};

const TOOL_USAGE_ITEM_SCHEMA: ProviderMetaSchema = {
  kind: "object",
  allowedKeys: toNormalizedKeySet(["toolName", "totalCount"]),
};

const PROVIDER_META_NESTED_SCHEMAS: Record<string, ProviderMetaSchema> = normalizeSchemaRecord({
  modelUsageSummary: {
    kind: "object",
    allowedKeys: toNormalizedKeySet([
      "granularity",
      "sampledAt",
      "totalModelCallCount",
      "totalTokensUsage",
      "topModels",
      "windowHours",
    ]),
    nested: normalizeSchemaRecord({
      topModels: {
        kind: "array",
        item: MODEL_USAGE_ITEM_SCHEMA,
      },
    }),
  },
  toolUsageSummary: {
    kind: "object",
    allowedKeys: toNormalizedKeySet([
      "granularity",
      "sampledAt",
      "totalNetworkSearchCount",
      "totalWebReadMcpCount",
      "totalZreadMcpCount",
      "totalSearchMcpCount",
      "tools",
      "windowHours",
    ]),
    nested: normalizeSchemaRecord({
      tools: {
        kind: "array",
        item: TOOL_USAGE_ITEM_SCHEMA,
      },
    }),
  },
});

// Любой новый ключ из allow-list, которому нужно сохранить вложенную структуру
// объектов/массивов, обязан зарегистрировать здесь схему. Неизвестные вложенные контейнеры
// намеренно сворачиваются в непрозрачную JSON-строку с цензурой против утечки нагрузок провайдера.

// Значения из внешних источников проверяются на конечность: NaN и Infinity не должны
// попадать в арифметику процентов и лимитов.
function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Некорректная метка времени превращается в null, а не в NaN: вызывающий код должен
// различать "времени нет" и "время непонятное".
function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Размер считается в байтах, а не в символах: кириллица и эмодзи занимают больше
// одного байта, и посимвольный лимит не защитил бы от раздувания строки.
function estimateUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

// Идентификаторы провайдеров приходят в разном регистре из разных источников, поэтому
// сравнение всегда идёт по нормализованному виду.
function normalizeProviderId(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

interface RedactProviderTextOptions {
  redactEmailsAndUrls?: boolean;
}

interface RedactProviderTextWithPatternsOptions {
  maxLength?: number | null;
}

// Порядок замен важен: сначала обнуляются значения по именам ключей, и только потом
// применяются шаблоны форматов. Иначе секрет в поле с неочевидным именем остался бы,
// не совпав ни с одним шаблоном.
function redactProviderTextWithPatterns(
  raw: string,
  patterns: ReadonlyArray<RegExp>,
  options: RedactProviderTextWithPatternsOptions = {},
): string {
  let redacted = raw;
  redacted = redacted.replace(
    SENSITIVE_VALUE_KEY_PATTERN,
    (_match, prefix: string, doubleQuoted: string, singleQuoted: string, bare: string) => {
      if (typeof doubleQuoted === "string") {
        return `${prefix}"${REDACTED_VALUE}"`;
      }
      if (typeof singleQuoted === "string") {
        return `${prefix}'${REDACTED_VALUE}'`;
      }
      if (typeof bare === "string") {
        return `${prefix}${REDACTED_VALUE}`;
      }
      return `${prefix}${REDACTED_VALUE}`;
    },
  );
  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, REDACTED_VALUE);
  }
  // Обрезка выполняется в самом конце: сначала текст редактируется целиком, иначе
  // секрет за границей лимита остался бы в неприкосновенном виде.
  const maxLength =
    options.maxLength === undefined ? MAX_PROVIDER_META_STRING_LENGTH : options.maxLength;
  if (maxLength != null && redacted.length > maxLength) {
    return `${redacted.slice(0, maxLength)}...`;
  }
  return redacted;
}

// Строгий вариант редакции: применяется ко всему, что отдаётся клиенту или сохраняется
// в пользовательских данных. Выбор между строгим и мягким уровнем - это решение о том,
// куда идёт текст, поэтому он вынесен в явный параметр.
/**
 * Строгая цензура текста провайдера, безопасная для клиента.
 * Использовать для всего, что возвращается клиентам или сохраняется
 * в видимых пользователю полезных нагрузках.
 */
export function redactProviderText(raw: string, options: RedactProviderTextOptions = {}): string {
  const patterns =
    options.redactEmailsAndUrls === false ? SECRET_VALUE_PATTERNS : STRICT_TOKEN_PATTERNS;
  return redactProviderTextWithPatterns(raw, patterns);
}

/**
 * Цензура текста провайдера для логов.
 * Использовать в серверных логах и диагностике, где URL и e-mail ещё полезны,
 * но секреты по-прежнему нужно вымарывать.
 */
// В логах ссылки и почта помогают разбирать инциденты, поэтому здесь они сохраняются.
// Отличие от redactProviderText задаётся одним флагом, чтобы поведение не разъезжалось.
export function redactProviderTextForLogs(raw: string): string {
  return redactProviderText(raw, { redactEmailsAndUrls: false });
}

// Контейнер неизвестной формы приводится к JSON-строке и редактируется как текст. Это
// последний рубеж: даже неопознанная структура не уйдёт наружу без проверки.
// Несериализуемое значение (например, циклическая ссылка) помечается отдельной заглушкой.
function sanitizeOpaqueProviderMetaContainer(value: unknown): string {
  try {
    return redactProviderTextWithPatterns(JSON.stringify(value), STRICT_TOKEN_PATTERNS, {
      maxLength: null,
    });
  } catch {
    return "[UNSERIALIZABLE_PROVIDER_META]";
  }
}

// Обход значения по описанной схеме. Работают два правила: ключи вне белого списка
// отбрасываются, а структура ограничивается по глубине, числу ключей и элементов
// массива. Превышение лимита - не ошибка: значение усекается и помечается флагом, чтобы
// потребитель знал о неполноте данных.
function sanitizeStructuredProviderMetaValue(
  value: unknown,
  schema: ProviderMetaSchema,
  depth: number,
): unknown {
  if (schema.kind === "array") {
    if (!Array.isArray(value)) {
      return null;
    }

    const sanitized: unknown[] = [];
    // Ограничение длины массива не даёт метаданным стать способом передать произвольно
    // большой объём данных.
    for (const item of value.slice(0, MAX_PROVIDER_META_ARRAY_ITEMS)) {
      sanitized.push(
        schema.item ? sanitizeStructuredProviderMetaValue(item, schema.item, depth + 1) : null,
      );
    }
    if (value.length > MAX_PROVIDER_META_ARRAY_ITEMS) {
      sanitized.push("[TRUNCATED_ARRAY]");
    }
    return sanitized;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const sanitizedObject: Record<string, unknown> = {};
  for (const [key, nestedValue] of entries.slice(0, MAX_PROVIDER_META_OBJECT_KEYS)) {
    const normalizedKey = normalizeMetaKey(key);
    // Двойная проверка: ключ должен быть и в белом списке схемы, и не в чёрном списке.
    // Белый список - основной механизм, чёрный - страховка на случай ошибки в схеме.
    if (!schema.allowedKeys.has(normalizedKey)) {
      continue;
    }
    if (FORBIDDEN_PROVIDER_META_KEYS.has(normalizedKey)) {
      continue;
    }

    const nestedSchema = schema.nested?.[normalizedKey] ?? null;
    sanitizedObject[key] = sanitizeProviderMetaValue(nestedValue, depth + 1, nestedSchema);
  }
  if (entries.length > MAX_PROVIDER_META_OBJECT_KEYS) {
    // Флаг вместо молчаливого усечения: интерфейс должен иметь возможность сообщить,
    // что метаданные показаны не полностью.
    sanitizedObject._truncated = true;
  }
  return Object.keys(sanitizedObject).length > 0 ? sanitizedObject : null;
}

// Диспетчер по типу значения. Строки всегда проходят редакцию, числа проверяются на
// конечность, а контейнеры без описанной схемы уходят в "непрозрачный" режим: они
// превращаются в строку и редактируются как текст.
function sanitizeProviderMetaValue(
  value: unknown,
  depth: number,
  schema: ProviderMetaSchema | null = null,
): unknown {
  // Ограничение глубины защищает от специально подготовленных вложенных структур:
  // без него обход был бы неограниченным.
  if (depth > MAX_PROVIDER_META_DEPTH) {
    return "[TRUNCATED_DEPTH]";
  }

  if (typeof value === "string") {
    return redactProviderText(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean" || value == null) {
    return value;
  }
  if (schema) {
    return sanitizeStructuredProviderMetaValue(value, schema, depth);
  }
  if (Array.isArray(value)) {
    return sanitizeOpaqueProviderMetaContainer(value);
  }
  if (typeof value === "object") {
    return sanitizeOpaqueProviderMetaContainer(value);
  }
  return String(value);
}

// Ключи сортируются рекурсивно, потому что JSON-сериализация зависит от порядка полей.
// Без этого одна и та же по смыслу структура давала бы разные подписи, и система
// считала бы данные изменившимися.
function stableSortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableSortObjectKeys(item));
  }
  if (value && typeof value === "object") {
    const sortedEntries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableSortObjectKeys(nested)] as const);
    return Object.fromEntries(sortedEntries);
  }
  return value;
}

// Окно приводится к фиксированному набору полей: undefined превращается в null,
// отсутствующие числа - тоже в null. Иначе подпись зависела бы от того, какие поля
// заполнил конкретный провайдер, а не от содержимого.
function normalizeWindowForSignature(window: RuntimeLimitWindow): Record<string, unknown> {
  return {
    scope: window.scope,
    name: window.name ?? null,
    unit: window.unit ?? null,
    limit: toFiniteNumber(window.limit),
    remaining: toFiniteNumber(window.remaining),
    used: toFiniteNumber(window.used),
    percentUsed: toFiniteNumber(window.percentUsed),
    percentRemaining: toFiniteNumber(window.percentRemaining),
    resetAt: window.resetAt ?? null,
    retryAfterSeconds: toFiniteNumber(window.retryAfterSeconds),
    warningThreshold: toFiniteNumber(window.warningThreshold),
  };
}

// Строковый ключ сортировки окон. Порядок окон у разных провайдеров произвольный,
// поэтому перед подписыванием он нормализуется: перестановка тех же окон не должна
// выглядеть как изменение лимитов.
function windowSortKey(window: Record<string, unknown>): string {
  return [
    String(window.scope ?? ""),
    String(window.name ?? ""),
    String(window.unit ?? ""),
    String(window.limit ?? ""),
    String(window.remaining ?? ""),
    String(window.used ?? ""),
    String(window.percentRemaining ?? ""),
    String(window.resetAt ?? ""),
    String(window.retryAfterSeconds ?? ""),
  ].join("|");
}

// Выбор главного окна лимита: сначала окно с явно указанной областью (primaryScope),
// затем - по правилам ниже.
function choosePrimaryWindow(snapshot: RuntimeLimitSnapshot): RuntimeLimitWindow | null {
  if (!snapshot.windows.length) return null;
  if (snapshot.primaryScope) {
    const scoped = snapshot.windows.find((window) => window.scope === snapshot.primaryScope);
    if (scoped) return scoped;
  }
  return (
    snapshot.windows.find(
      (window) =>
        window.resetAt != null ||
        isFiniteNonNegative(window.retryAfterSeconds) ||
        toFiniteNumber(window.percentRemaining) != null,
    ) ?? snapshot.windows[0]!
  );
}

// Источник подсказки важен для доверия к данным: значение из снимка лимитов точнее,
// чем вычисленное из задержки повтора.
export type RuntimeLimitFutureHintSource =
  | "snapshot_reset_at"
  | "snapshot_retry_after"
  | "window_reset_at"
  | "window_retry_after"
  | "none";

export interface RuntimeLimitFutureHint {
  source: RuntimeLimitFutureHintSource;
  resetAt: string | null;
  retryAfterSeconds: number | null;
  resetAtMs: number | null;
  isFuture: boolean;
  windowScope: RuntimeLimitScope | null;
}

// Промежуточное представление кандидата: источник, время и область окна. Нужно, чтобы
// разные источники времени можно было сравнивать между собой единообразно.
interface HintCandidate {
  source: RuntimeLimitFutureHintSource;
  resetAt: string | null;
  retryAfterSeconds: number | null;
  windowScope: RuntimeLimitScope | null;
}

// Кандидат подсказки, построенный из времени сброса окна. Если времени нет или он
// непригоден, возвращается null, и подсказка строится из других источников.
function candidateFromResetAt(
  source: RuntimeLimitFutureHintSource,
  resetAt: string | null | undefined,
  windowScope: RuntimeLimitScope | null,
): HintCandidate | null {
  if (!resetAt) return null;
  return {
    source,
    resetAt,
    retryAfterSeconds: null,
    windowScope,
  };
}

// Кандидат подсказки из retryAfterSeconds: провайдер сообщает не момент сброса, а
// задержку до него, поэтому время вычисляется от текущего момента.
function candidateFromRetryAfter(
  source: RuntimeLimitFutureHintSource,
  retryAfterSeconds: number | null | undefined,
  windowScope: RuntimeLimitScope | null,
  nowMs: number,
): HintCandidate | null {
  if (!isFiniteNonNegative(retryAfterSeconds)) return null;
  return {
    source,
    resetAt: new Date(nowMs + retryAfterSeconds * 1000).toISOString(),
    retryAfterSeconds,
    windowScope,
  };
}

// Выбор окна, которое уже нарушило порог. Точный режим проверяется отдельно:
// приблизительные оценки лимитов не годятся для решения о предупреждении.
export function selectViolatedWindowForExactThreshold(
  snapshot: RuntimeLimitSnapshot | null | undefined,
  thresholdOverride?: number | null,
  nowMs = Date.now(),
): RuntimeLimitWindow | null {
  if (!snapshot || snapshot.precision !== "exact") return null;

  const fallbackThreshold = toFiniteNumber(thresholdOverride ?? snapshot.warningThreshold);
  const violated = snapshot.windows.filter((window) => {
    const percentRemaining = toFiniteNumber(window.percentRemaining);
    const threshold = toFiniteNumber(window.warningThreshold ?? fallbackThreshold);
    return percentRemaining != null && threshold != null && percentRemaining <= threshold;
  });

  if (violated.length === 0) {
    return null;
  }

  const score = (window: RuntimeLimitWindow): number => {
    // Окно без срока сброса получает минимальный приоритет: о нём известно меньше всего.
    const resetAtMs = parseTimestampMs(window.resetAt);
    if (resetAtMs != null) return resetAtMs;
    if (isFiniteNonNegative(window.retryAfterSeconds)) {
      return nowMs + window.retryAfterSeconds * 1000;
    }
    return Number.NEGATIVE_INFINITY;
  };

  return violated.reduce(
    // Побеждает окно с ближайшим сроком сброса: пользователю важнее то, что скоро
    // восстановится. При равных сроках выбирается окно с меньшим остатком.
    (best, candidate) => {
      if (!best) return candidate;
      const bestScore = score(best);
      const candidateScore = score(candidate);
      if (candidateScore > bestScore) return candidate;
      if (candidateScore < bestScore) return best;

      const bestRemaining = toFiniteNumber(best.percentRemaining) ?? Number.POSITIVE_INFINITY;
      const candidateRemaining =
        toFiniteNumber(candidate.percentRemaining) ?? Number.POSITIVE_INFINITY;
      return candidateRemaining < bestRemaining ? candidate : best;
    },
    null as RuntimeLimitWindow | null,
  );
}

// Подсказка о будущем сбросе лимита: когда и в каком окне он произойдёт. Источник
// указывает, откуда взято время (снимок, окно или retryAfterSeconds), чтобы вызывающий
// код мог отличить точные данные от оценки.
export function resolveRuntimeLimitFutureHint(
  snapshot: RuntimeLimitSnapshot | null | undefined,
  input: {
    nowMs?: number;
    preferredWindow?: RuntimeLimitWindow | null;
    windowFirst?: boolean;
  } = {},
): RuntimeLimitFutureHint {
  const nowMs = input.nowMs ?? Date.now();
  if (!snapshot) {
    return {
      source: "none",
      resetAt: null,
      retryAfterSeconds: null,
      resetAtMs: null,
      isFuture: false,
      windowScope: null,
    };
  }

  const preferredWindow = input.preferredWindow ?? choosePrimaryWindow(snapshot);
  const windowScope = preferredWindow?.scope ?? null;

  const snapshotCandidates = [
    candidateFromResetAt("snapshot_reset_at", snapshot.resetAt, null),
    candidateFromRetryAfter("snapshot_retry_after", snapshot.retryAfterSeconds, null, nowMs),
  ];
  const windowCandidates = [
    candidateFromResetAt("window_reset_at", preferredWindow?.resetAt, windowScope),
    candidateFromRetryAfter(
      "window_retry_after",
      preferredWindow?.retryAfterSeconds,
      windowScope,
      nowMs,
    ),
  ];

  const preferWindowHints = input.windowFirst ?? input.preferredWindow != null;
  const ordered = (
    preferWindowHints
      ? [...windowCandidates, ...snapshotCandidates]
      : [...snapshotCandidates, ...windowCandidates]
  ).filter((candidate): candidate is HintCandidate => candidate != null);

  const normalizedCandidates = ordered.map((candidate) => ({
    ...candidate,
    resetAtMs: parseTimestampMs(candidate.resetAt),
  }));

  const selected =
    normalizedCandidates.find(
      (candidate) => candidate.resetAtMs != null && candidate.resetAtMs > nowMs,
    ) ?? normalizedCandidates.find((candidate) => candidate.resetAtMs != null);
  if (!selected) {
    return {
      source: "none",
      resetAt: null,
      retryAfterSeconds: null,
      resetAtMs: null,
      isFuture: false,
      windowScope: null,
    };
  }

  return {
    source: selected.source,
    resetAt: selected.resetAt,
    retryAfterSeconds: selected.retryAfterSeconds,
    resetAtMs: selected.resetAtMs,
    isFuture: selected.resetAtMs != null && selected.resetAtMs > nowMs,
    windowScope: selected.windowScope,
  };
}

export function sanitizeProviderMeta(
  providerId: string | null | undefined,
  providerMeta: unknown,
): Record<string, unknown> | null {
  if (!providerMeta || typeof providerMeta !== "object" || Array.isArray(providerMeta)) {
    return null;
  }

  const normalizedProviderId = normalizeProviderId(providerId);
  const providerAllowlist = PROVIDER_META_ALLOWLIST[normalizedProviderId] ?? new Set<string>();
  const allowedKeys = new Set<string>([
    ...GENERIC_ALLOWED_PROVIDER_META_KEYS,
    ...providerAllowlist,
  ]);

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(providerMeta as Record<string, unknown>)) {
    const normalizedKey = normalizeMetaKey(key);
    if (!allowedKeys.has(normalizedKey)) {
      continue;
    }
    if (FORBIDDEN_PROVIDER_META_KEYS.has(normalizedKey)) {
      continue;
    }
    sanitized[key] = sanitizeProviderMetaValue(
      value,
      0,
      PROVIDER_META_NESTED_SCHEMAS[normalizedKey] ?? null,
    );
  }

  if (Object.keys(sanitized).length === 0) {
    return null;
  }

  const serialized = JSON.stringify(stableSortObjectKeys(sanitized));
  if (estimateUtf8Bytes(serialized) > MAX_PROVIDER_META_BYTES) {
    return {
      _truncated: true,
      status:
        typeof (sanitized.status as unknown) === "string"
          ? sanitized.status
          : "provider_meta_truncated",
    };
  }

  return sanitized;
}

// Снимок нормализуется прогоном метаданных через санитизацию. Остальные поля не
// трогаются: за их корректность отвечает адаптер рантайма.
export function normalizeRuntimeLimitSnapshot(
  snapshot: RuntimeLimitSnapshot,
): RuntimeLimitSnapshot {
  return {
    ...snapshot,
    providerMeta: sanitizeProviderMeta(snapshot.providerId, snapshot.providerMeta ?? null),
  };
}

// Уровни экспозиции. internal и runtime_profile остаются в доверенном контуре, а task и
// chat - это данные, попадающие в интерфейс, поэтому из них вырезаются идентификаторы
// аккаунта.
export type RuntimeLimitSnapshotExposure = "internal" | "task" | "chat" | "runtime_profile";

// Доверенные уровни возвращаются как есть; для остальных удаляются ключи внешних данных
// аккаунта. Пустой результат превращается в null, чтобы интерфейс не показывал пустую
// секцию метаданных.
function sanitizeProviderMetaForExposure(
  providerMeta: Record<string, unknown> | null | undefined,
  exposure: RuntimeLimitSnapshotExposure,
): Record<string, unknown> | null {
  if (!providerMeta) {
    return null;
  }
  if (exposure === "internal" || exposure === "runtime_profile") {
    return providerMeta;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(providerMeta)) {
    if (EXTERNAL_PROVIDER_META_KEYS.has(normalizeMetaKey(key))) {
      continue;
    }
    sanitized[key] = value;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

// Композиция: сначала общая санитизация, затем фильтрация по уровню экспозиции. Порядок
// важен - редакция секретов выполняется до того, как данные попадут в UI.
export function sanitizeRuntimeLimitSnapshotForExposure(
  snapshot: RuntimeLimitSnapshot,
  exposure: RuntimeLimitSnapshotExposure = "internal",
): RuntimeLimitSnapshot {
  const normalizedSnapshot = normalizeRuntimeLimitSnapshot(snapshot);
  return {
    ...normalizedSnapshot,
    providerMeta: sanitizeProviderMetaForExposure(
      normalizedSnapshot.providerMeta ?? null,
      exposure,
    ),
  };
}

// Подпись снимка для сравнения версий. Смысл - обнаружить содержательное изменение:
// если подпись не изменилась, потребителей можно не уведомлять. Поэтому перед
// сериализацией окна сортируются, а ключи объектов упорядочиваются: порядок не является
// частью смысла данных.
export function buildRuntimeLimitSignature(snapshot: RuntimeLimitSnapshot): string {
  const normalizedSnapshot = sanitizeRuntimeLimitSnapshotForExposure(snapshot, "internal");
  const normalizedWindows = normalizedSnapshot.windows
    .map((window) => normalizeWindowForSignature(window))
    .sort((left, right) => windowSortKey(left).localeCompare(windowSortKey(right)));

  const normalized = {
    source: normalizedSnapshot.source,
    status: normalizedSnapshot.status,
    precision: normalizedSnapshot.precision,
    providerId: normalizedSnapshot.providerId,
    runtimeId: normalizedSnapshot.runtimeId ?? null,
    profileId: normalizedSnapshot.profileId ?? null,
    primaryScope: normalizedSnapshot.primaryScope ?? null,
    resetAt: normalizedSnapshot.resetAt ?? null,
    retryAfterSeconds: toFiniteNumber(normalizedSnapshot.retryAfterSeconds),
    warningThreshold: toFiniteNumber(normalizedSnapshot.warningThreshold),
    windows: normalizedWindows,
    providerMeta: normalizedSnapshot.providerMeta ?? null,
  };

  return JSON.stringify(stableSortObjectKeys(normalized));
}

// Безопасное представление ошибки рантайма для клиента.
//
// Наружу отдаётся фиксированный набор сообщений и кодов, а не текст ошибки провайдера:
// исходное сообщение может содержать ключи, адреса и внутренние детали запроса.
// Категория берётся из структурированного поля ошибки, а не из разбора текста: строки
// меняются вместе с провайдером, и такая логика ломалась бы при каждом обновлении.
export type SafeRuntimeErrorCategory =
  | "rate_limit"
  | "auth"
  | "timeout"
  | "permission"
  | "stream"
  | "transport"
  | "model_not_found"
  | "context_length"
  | "content_filter"
  | "unknown";

// Разбор структурированной ошибки на безопасные поля. Признак isRuntimeError отделяет
// ошибки, пришедшие от рантайма, от всего остального: для прочих нельзя утверждать, что
// причина в лимитах или настройках рантайма.
export interface SafeRuntimeErrorReason {
  reason: string;
  category: SafeRuntimeErrorCategory;
  code: string;
  isRuntimeError: boolean;
}

// Неизвестная или отсутствующая категория сводится к "unknown": список закрытый, и
// значение извне не должно расширять его само по себе.
function safeRuntimeCategory(value: unknown): SafeRuntimeErrorCategory {
  if (typeof value !== "string") return "unknown";
  switch (value) {
    case "rate_limit":
    case "auth":
    case "timeout":
    case "permission":
    case "stream":
    case "transport":
    case "model_not_found":
    case "context_length":
    case "content_filter":
      return value;
    default:
      return "unknown";
  }
}

// Отображение категории в код и текст, показываемые пользователю. Все сообщения
// намеренно обезличены и не содержат деталей запроса.
export function mapSafeRuntimeErrorReason(error: unknown): SafeRuntimeErrorReason {
  const category = safeRuntimeCategory(
    error && typeof error === "object" ? (error as { category?: unknown }).category : null,
  );
  const isRuntimeError = category !== "unknown";

  switch (category) {
    case "rate_limit":
      return {
        reason: "Runtime usage limit reached.",
        category,
        code: "RUNTIME_RATE_LIMIT",
        isRuntimeError,
      };
    case "auth":
      return {
        reason: "Runtime authentication failed.",
        category,
        code: "RUNTIME_AUTH_FAILED",
        isRuntimeError,
      };
    case "timeout":
      return {
        reason: "Runtime request timed out.",
        category,
        code: "RUNTIME_TIMEOUT",
        isRuntimeError,
      };
    case "permission":
      return {
        reason: "Runtime permissions blocked this task.",
        category,
        code: "RUNTIME_PERMISSION_BLOCKED",
        isRuntimeError,
      };
    case "stream":
      return {
        reason: "Runtime stream failed.",
        category,
        code: "RUNTIME_STREAM_FAILED",
        isRuntimeError,
      };
    case "transport":
      return {
        reason: "Provider temporarily unavailable.",
        category,
        code: "RUNTIME_PROVIDER_UNAVAILABLE",
        isRuntimeError,
      };
    case "model_not_found":
      return {
        reason: "Configured model was not found for the selected runtime.",
        category,
        code: "RUNTIME_MODEL_NOT_FOUND",
        isRuntimeError,
      };
    case "context_length":
      return {
        reason: "Request exceeded the model context limit.",
        category,
        code: "RUNTIME_CONTEXT_LENGTH_EXCEEDED",
        isRuntimeError,
      };
    case "content_filter":
      return {
        reason: "Request blocked by provider content policy.",
        category,
        code: "RUNTIME_CONTENT_FILTERED",
        isRuntimeError,
      };
    default:
      // Категория "unknown" сохраняется намеренно: потребитель должен видеть, что
      // классифицировать ошибку не удалось, а не принимать её за ошибку рантайма.
      return {
        reason: "Runtime request failed.",
        category: "unknown",
        code: "RUNTIME_UNKNOWN_ERROR",
        isRuntimeError: false,
      };
  }
}
