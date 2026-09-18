/**
 * Классификация ошибок Codex в структурные категории RuntimeErrorCategory.
 *
 * Ключевое требование проекта: никакая логика выше по стеку не должна угадывать тип ошибки
 * по тексту сообщения. Поэтому здесь мы один раз разбираем сырую ошибку (HTTP-статус, текст,
 * уже готовый RuntimeExecutionError) и возвращаем CodexRuntimeAdapterError с полями
 * category и adapterCode. Дальше вызывающий код ветвится по этим полям — например, решает,
 * делать ли retry или показывать ошибку пользователю.
 *
 * Порядок проверок важен: сначала статус (он надёжнее текста), затем специфичные для Codex
 * шаблоны, и только в конце — общий текстовый fallback.
 */

import {
  RuntimeExecutionError,
  type RuntimeExecutionErrorMetadata,
  classifyByHttpStatus,
  classifyByMessageFallback,
  type RuntimeErrorCategory,
} from "../../errors.js";

/** Специфичные для Codex CLI-паттерны без соответствия в общих категориях. */
// Паттерны CLI-транспорта: их нет в общих категориях, потому что это особенности локального
// запуска бинарника, а не семантика ошибки провайдера модели.
const CLI_NOT_FOUND_PATTERNS = ["enoent", "not recognized", "no such file"];
// "Потерянная" сессия Codex — отдельный случай: диалог в CLI начинался заново, надо
// пересоздавать тред, а не повторять тот же запрос.
const THREAD_PATTERNS = [
  "thread not found",
  "session not found",
  "no such session",
  "invalid thread",
];

/** Отображает семантическую категорию в специфичный для Codex код адаптера. */
// Record по RuntimeErrorCategory даёт compile-time гарантию полноты: если в общий enum
// добавят новую категорию, TypeScript заставит дописать код и здесь.
const CATEGORY_TO_ADAPTER_CODE: Record<RuntimeErrorCategory, string> = {
  rate_limit: "CODEX_RATE_LIMIT",
  auth: "CODEX_AUTH_ERROR",
  timeout: "CODEX_TIMEOUT",
  permission: "CODEX_PERMISSION_DENIED",
  stream: "CODEX_STREAM_ERROR",
  transport: "CODEX_TRANSPORT_ERROR",
  model_not_found: "CODEX_MODEL_NOT_FOUND",
  context_length: "CODEX_CONTEXT_LENGTH",
  content_filter: "CODEX_CONTENT_FILTER",
  unknown: "CODEX_RUNTIME_ERROR",
};

// messageFromUnknown нужен, потому что в catch попадает unknown: это может быть и Error,
// и строка, и объект от SDK. String() даёт безопасное представление для логов.
function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Ядро классификации: возвращает пару (категория, adapterCode), не создавая ошибку.
// Такое разделение позволяет переиспользовать логику в classifyCodexRuntimeError.
function classify(
  message: string,
  httpStatus?: number,
): { adapterCode: string; category: RuntimeErrorCategory } {
  // Основной сигнал: HTTP status (API-транспорт)
  // Статус — самый надёжный сигнал: 429, 401, 408 однозначны и не зависят от формулировок
  // провайдера. Поэтому сначала пробуем его, а к тексту обращаемся только если статуса нет.
  if (httpStatus !== undefined) {
    const category = classifyByHttpStatus(httpStatus);
    if (category) {
      return { adapterCode: CATEGORY_TO_ADAPTER_CODE[category], category };
    }
  }

  // Приводим к нижнему регистру один раз: все паттерны ниже записаны в lowercase,
  // а сравнивать регистронезависимо на каждой итерации было бы дороже.
  const lowered = message.toLowerCase();

  // Специфично для Codex: thread/session не найден (проверяем раньше CLI-паттернов)
  // Проверка идёт раньше CLI-паттернов намеренно: сообщение про потерянный тред может
  // содержать и "no such file", и тогда мы получили бы менее точный CLI_NOT_FOUND.
  if (THREAD_PATTERNS.some((p) => lowered.includes(p))) {
    return { adapterCode: "CODEX_THREAD_NOT_FOUND", category: "unknown" };
  }

  // Специфично для Codex: CLI не найден (в общих категориях аналога нет)
  if (CLI_NOT_FOUND_PATTERNS.some((p) => lowered.includes(p))) {
    return { adapterCode: "CODEX_CLI_NOT_FOUND", category: "unknown" };
  }

  // Резерв: общая классификация по сообщению
  // Последний рубеж — общий классификатор из @aif/runtime: он вернёт хотя бы unknown,
  // поэтому функция всегда даёт валидную категорию и не бросает исключение.
  const category = classifyByMessageFallback(message);
  return { adapterCode: CATEGORY_TO_ADAPTER_CODE[category], category };
}

// Перенос метаданных с исходной ошибки на новую. Без этого шага терялись бы httpStatus,
// retryAfter и снимок лимитов — именно по ним выше решают про retry.
function mergeMetadata(
  error: unknown,
  httpStatus?: number,
  metadata: RuntimeExecutionErrorMetadata = {},
): RuntimeExecutionErrorMetadata {
  const baseMetadata: RuntimeExecutionErrorMetadata =
    // Метаданные берём только у своей иерархии ошибок: у произвольного Error их просто нет.
    error instanceof RuntimeExecutionError
      ? {
          httpStatus: error.httpStatus,
          resetAt: error.resetAt,
          retryAfterMs: error.retryAfterMs,
          retryAfterSeconds: error.retryAfterSeconds,
          limitSnapshot: error.limitSnapshot,
          providerMeta: error.providerMeta,
        }
      : {};

  return {
    ...baseMetadata,
    ...metadata,
    // Явный приоритет для httpStatus: аргумент вызова > переданные метаданные > унаследованное.
    // ?? сохраняет смысл каждого уровня (0/undefined не затирают более точное значение).
    httpStatus: httpStatus ?? metadata.httpStatus ?? baseMetadata.httpStatus,
  };
}

// Ошибка адаптера Codex. Наследуем RuntimeExecutionError, чтобы внешний код мог ловить
// как общий тип адаптера, так и конкретику Codex, не привязываясь к строкам сообщений.
export class CodexRuntimeAdapterError extends RuntimeExecutionError {
  public readonly adapterCode: string;

  constructor(
    message: string,
    adapterCode: string,
    category: RuntimeErrorCategory,
    cause?: unknown,
    metadata: RuntimeExecutionErrorMetadata = {},
  ) {
    super(message, cause, category, { ...metadata, adapterCode });
    // name переопределяется вручную: без этого в логах и стектрейсах останется
    // имя базового класса, что затрудняет поиск источника ошибки.
    this.name = "CodexRuntimeAdapterError";
    this.adapterCode = adapterCode;
  }
}

// Публичная точка входа классификации. Идемпотентна: уже классифицированную ошибку
// возвращает как есть, чтобы при повторных обёртываниях не терять исходный adapterCode.
export function classifyCodexRuntimeError(
  error: unknown,
  httpStatus?: number,
  metadata: RuntimeExecutionErrorMetadata = {},
): CodexRuntimeAdapterError {
  if (error instanceof CodexRuntimeAdapterError) {
    return error;
  }
  const message = messageFromUnknown(error);
  // Метаданные объединяем до ветвлений: они нужны во всех сценариях.
  const mergedMetadata = mergeMetadata(error, httpStatus, metadata);

  // Если ошибка пришла из общего runtime-слоя, категория уже известна — доверяем ей
  // и лишь дописываем код Codex. Так мы не перетираем более точный вывод вышестоящего слоя.
  if (error instanceof RuntimeExecutionError) {
    return new CodexRuntimeAdapterError(
      message,
      CATEGORY_TO_ADAPTER_CODE[error.category],
      error.category,
      error,
      mergedMetadata,
    );
  }

  const { adapterCode, category } = classify(message, mergedMetadata.httpStatus);
  return new CodexRuntimeAdapterError(message, adapterCode, category, error, mergedMetadata);
}
