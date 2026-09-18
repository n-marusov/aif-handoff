/**
 * Классификация ошибок OpenRouter в структурные категории рантайма.
 *
 * Зачем отдельный модуль: решения о ретраях, показе подсказок и разборе инцидентов
 * принимаются выше по стеку по машинно-читаемым полям - category, adapterCode, httpStatus.
 * Текст сообщения пишется для человека и никогда не парсится, поэтому логика ветвления
 * обязана опираться на категорию, а не на подстроки в message.
 *
 * Источники информации упорядочены по надёжности: HTTP-статус (у OpenRouter нет CLI, только
 * HTTP API, значит статус доступен почти всегда) -> уже структурированная ошибка рантайма ->
 * текстовый fallback для неклассифицированных случаев вроде сетевых сбоев.
 */

import {
  RuntimeExecutionError,
  type RuntimeExecutionErrorMetadata,
  classifyByHttpStatus,
  classifyByMessageFallback,
  type RuntimeErrorCategory,
} from "../../errors.js";

// Таблица "категория рантайма -> код адаптера OpenRouter". Категория общая для всех
// провайдеров, а код нужен, чтобы в логах и в UI было видно, что ответил именно OpenRouter.
// Тип Record<RuntimeErrorCategory, string> держит таблицу полной: добавили новую категорию в
// enum - компилятор сразу потребует дописать строку маппинга, и код адаптера не потеряется.
/** Отображает семантическую категорию в специфичный для OpenRouter код адаптера. */
const CATEGORY_TO_ADAPTER_CODE: Record<RuntimeErrorCategory, string> = {
  rate_limit: "OPENROUTER_RATE_LIMIT",
  auth: "OPENROUTER_AUTH_ERROR",
  timeout: "OPENROUTER_TIMEOUT",
  permission: "OPENROUTER_PERMISSION_DENIED",
  stream: "OPENROUTER_STREAM_ERROR",
  transport: "OPENROUTER_TRANSPORT_ERROR",
  model_not_found: "OPENROUTER_MODEL_NOT_FOUND",
  context_length: "OPENROUTER_CONTEXT_LENGTH",
  content_filter: "OPENROUTER_CONTENT_FILTER",
  unknown: "OPENROUTER_RUNTIME_ERROR",
};

// Error может прийти чем угодно: строкой, объектом из сторонней библиотеки или вообще
// примитивом. Классификатор не должен падать на таком входе, поэтому приведение к строке
// выполняется безопасно и централизованно, а не в каждом месте вызова.
function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Главная точка входа классификации. Возвращает пару "категория + код адаптера", чтобы
// вызывающий не собирал её сам и не разъезжался с маппингом выше.
function classify(
  message: string,
  httpStatus?: number,
): { adapterCode: string; category: RuntimeErrorCategory } {
  // Основной сигнал: HTTP status (API-транспорт — единственный транспорт OpenRouter)
  // Приоритет у HTTP-статуса: 429 останется rate_limit, даже если в теле написано что-то
  // другое. Статус - структурированный признак, текст им не является.
  if (httpStatus !== undefined) {
    const category = classifyByHttpStatus(httpStatus);
    if (category) {
      return { adapterCode: CATEGORY_TO_ADAPTER_CODE[category], category };
    }
    // Статус может быть незнакомым (например, 418): classifyByHttpStatus вернёт null, и мы
    // спокойно спускаемся к текстовой эвристике ниже - это не ошибка, а ожидаемая ветка.
  }

  // Резерв: общая классификация по сообщению
  // Текст здесь - последний доступный источник, а не способ ветвления в бизнес-логике:
  // результат всё равно превращается в структурную категорию, по которой и принимают решения.
  const category = classifyByMessageFallback(message);
  return { adapterCode: CATEGORY_TO_ADAPTER_CODE[category], category };
}

// Метаданные ошибки нельзя терять при переупаковке: выше по стеку по retryAfterSeconds и
// resetAt планируют повтор, а limitSnapshot показывается в UI. Если исходная ошибка уже была
// RuntimeExecutionError, её структурированные поля переносятся в новую ошибку.
function mergeMetadata(
  error: unknown,
  httpStatus?: number,
  metadata: RuntimeExecutionErrorMetadata = {},
): RuntimeExecutionErrorMetadata {
  const baseMetadata: RuntimeExecutionErrorMetadata =
    error instanceof RuntimeExecutionError
      ? {
          // Поля перечислены поимённо, а не развёрнуты через spread: так видно, что именно
          // считается частью контракта ошибки, и случайное поле не утечёт наружу.
          httpStatus: error.httpStatus,
          resetAt: error.resetAt,
          retryAfterMs: error.retryAfterMs,
          retryAfterSeconds: error.retryAfterSeconds,
          limitSnapshot: error.limitSnapshot,
          providerMeta: error.providerMeta,
        }
      : {};

  // Порядок слияния: сначала унаследованное, затем явно переданное вызывающим. Так
  // вызывающий может уточнить метаданные, но не может случайно стереть их целиком.
  return {
    ...baseMetadata,
    ...metadata,
    // httpStatus ищется по цепочке: явный аргумент -> metadata -> исходная ошибка. Любой
    // источник может быть пуст, а статус нужен классификатору для выбора категории.
    httpStatus: httpStatus ?? metadata.httpStatus ?? baseMetadata.httpStatus,
  };
}

// Собственный тип ошибки адаптера. adapterCode лежит и в публичном readonly-поле, и в
// metadata, чтобы потребитель мог читать его напрямую, не разбирая вложенный объект.
// Имя задаётся строкой явно - при минификации оно иначе потерялось бы в стектрейсах.
export class OpenRouterRuntimeAdapterError extends RuntimeExecutionError {
  public readonly adapterCode: string;

  constructor(
    message: string,
    adapterCode: string,
    category: RuntimeErrorCategory,
    cause?: unknown,
    metadata: RuntimeExecutionErrorMetadata = {},
  ) {
    // metadata разворачивается первой, а adapterCode перекрывает её: код адаптера обязан
    // соответствовать типу ошибки, а не тому, что случайно передал вызывающий.
    super(message, cause, category, { ...metadata, adapterCode });
    this.name = "OpenRouterRuntimeAdapterError";
    this.adapterCode = adapterCode;
  }
}

// Единая точка классификации: принимает что угодно (Error, строку, объект из библиотеки) и
// всегда возвращает типизированную ошибку адаптера, поэтому вызывающему не нужно ничего
// проверять самостоятельно - контракт держит эту функция.
export function classifyOpenRouterRuntimeError(
  error: unknown,
  httpStatus?: number,
  metadata: RuntimeExecutionErrorMetadata = {},
): OpenRouterRuntimeAdapterError {
  // Идемпотентность: уже классифицированная ошибка возвращается как есть. Иначе каждый слой,
  // через который проходит ошибка, заворачивал бы её в новый экземпляр и стек рос бы бесконечно.
  if (error instanceof OpenRouterRuntimeAdapterError) {
    return error;
  }
  // Текст нужен и для сообщения новой ошибки, и для fallback-классификации ниже.
  const message = messageFromUnknown(error);
  const mergedMetadata = mergeMetadata(error, httpStatus, metadata);

  // Ошибка рантайма с известной категорией не переклассифицируется: доверяем ей и только
  // помечаем кодом OpenRouter, чтобы категория не "съезжала" при повторной обработке.
  if (error instanceof RuntimeExecutionError) {
    return new OpenRouterRuntimeAdapterError(
      message,
      CATEGORY_TO_ADAPTER_CODE[error.category],
      error.category,
      error,
      mergedMetadata,
    );
  }

  // Последний путь: классификация с нуля по структурированным признакам (httpStatus) с
  // текстовым fallback внутри. cause сохраняется, чтобы не потерять исходный стек.
  const { adapterCode, category } = classify(message, mergedMetadata.httpStatus);
  return new OpenRouterRuntimeAdapterError(message, adapterCode, category, error, mergedMetadata);
}
