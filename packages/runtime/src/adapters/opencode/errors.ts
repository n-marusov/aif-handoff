/**
 * Классификация ошибок OpenCode-адаптера.
 *
 * Модуль превращает произвольный сбой (HTTP-ответ, обрыв fetch, брошенный Error) в
 * типизированный OpenCodeRuntimeAdapterError со структурными полями category,
 * adapterCode и httpStatus. Правило проекта - потребитель ветвится только по этим
 * полям и никогда не разбирает текст сообщения: формулировки меняются от версии к
 * версии, а структура - часть контракта между адаптером и вызывающим кодом.
 *
 * Порядок классификации выбран осознанно: сначала HTTP-статус (самый надёжный сигнал
 * API-транспорта), затем специфичные для OpenCode шаблоны сессии и лишь в конце -
 * общий текстовый fallback. Так менее надёжные эвристики не перебивают точные данные.
 */

import {
  RuntimeExecutionError,
  type RuntimeExecutionErrorMetadata,
  classifyByHttpStatus,
  classifyByMessageFallback,
  type RuntimeErrorCategory,
} from "../../errors.js";

/** Специфичные для OpenCode session-паттерны без соответствия в общих категориях. */
// Отсутствие сессии - не общая категория рантайма, а частный случай OpenCode:
// вызывающий код (getOpenCodeSession) превращает его в null вместо исключения, поэтому
// шаблон проверяется отдельным adapterCode, а не подмешивается в общую таблицу.
// Сравнение идёт по обоим словам сразу (every) - одного "not found" недостаточно,
// иначе под шаблон попал бы любой 404 по другому ресурсу.
const SESSION_PATTERNS = ["session", "not found"];

/** Отображает семантическую категорию в специфичный для OpenCode код адаптера. */
// Record<RuntimeErrorCategory, string> - намеренный барьер: компилятор потребует
// запись для каждой категории, поэтому новая категория в shared-ошибках не сможет
// появиться незамеченной, а adapterCode останется стабильным для логов и метрик.
const CATEGORY_TO_ADAPTER_CODE: Record<RuntimeErrorCategory, string> = {
  rate_limit: "OPENCODE_RATE_LIMIT",
  auth: "OPENCODE_AUTH_ERROR",
  timeout: "OPENCODE_TIMEOUT",
  permission: "OPENCODE_PERMISSION_DENIED",
  stream: "OPENCODE_STREAM_ERROR",
  transport: "OPENCODE_TRANSPORT_ERROR",
  model_not_found: "OPENCODE_MODEL_ERROR",
  context_length: "OPENCODE_CONTEXT_LENGTH",
  content_filter: "OPENCODE_CONTENT_FILTER",
  unknown: "OPENCODE_RUNTIME_ERROR",
};

// Бросить в JS можно что угодно - не только Error. String() гарантирует, что дальше по
// коду всегда есть текст для классификации и логов, даже если прилетела строка или объект.
function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Чистая функция: она возвращает пару { adapterCode, category }, а не готовую ошибку,
// потому что решение оборачивать принимает вызывающий, а сам разбор должен остаться
// тестируемым без создания экземпляров исключений. httpStatus опционален: он есть
// только там, где успел сформироваться HTTP-ответ.
function classify(
  message: string,
  httpStatus?: number,
): { adapterCode: string; category: RuntimeErrorCategory } {
  // Статус - самый надёжный сигнал: он приходит из response.status и не зависит от
  // того, как сервер сформулировал тело. Поэтому он всегда проверяется первым.
  // Основной сигнал: HTTP status (API-транспорт)
  if (httpStatus !== undefined) {
    const category = classifyByHttpStatus(httpStatus);
    if (category) {
      return { adapterCode: CATEGORY_TO_ADAPTER_CODE[category], category };
    }
  }

  // Текст приводится к нижнему регистру один раз: шаблоны ниже регистронезависимы,
  // а повторные toLowerCase() на каждом сравнении были бы лишней работой.
  const lowered = message.toLowerCase();

  // Специфично для OpenCode: сессия не найдена
  // Проверяется до общего fallback: "session not found" иначе осело бы в category
  // unknown или в transport, и вызывающий код потерял бы возможность отличить
  // "сессии больше нет" от "до сервера не достучались".
  if (SESSION_PATTERNS.every((pattern) => lowered.includes(pattern))) {
    return { adapterCode: "OPENCODE_SESSION_ERROR", category: "unknown" };
  }

  // Резерв: общая классификация по сообщению
  // Последний рубеж: разбор текста общими правилами shared-слоя. Сюда попадают только
  // ошибки без статуса и без опознанных шаблонов - то есть заведомо ненадёжный случай,
  // где лучше приблизительная категория, чем совсем никакой.
  const category = classifyByMessageFallback(message);
  return { adapterCode: CATEGORY_TO_ADAPTER_CODE[category], category };
}

// Переклассификация уже типизированной ошибки не должна терять её структурированные
// поля: resetAt, retryAfter* и limitSnapshot читает retry-логика, и обнуление этих
// данных ослепило бы её. Приоритет намеренно такой: поля исходной ошибки -> явные
// metadata аргумента -> явный httpStatus аргумента (как самый свежий сигнал).
function mergeMetadata(
  error: unknown,
  httpStatus?: number,
  metadata: RuntimeExecutionErrorMetadata = {},
): RuntimeExecutionErrorMetadata {
  // Снимаем контекст с исходной ошибки, только если она нашего типа: у постороннего
  // Error таких полей просто нет, и выдумывать их не нужно.
  const baseMetadata: RuntimeExecutionErrorMetadata =
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

  // Порядок спредов задаёт приоритет: явный httpStatus из аргумента перекрывает и
  // metadata, и поле исходной ошибки. Отдельная запись нужна, потому что статус может
  // прийти двумя путями одновременно, и разрешить конфликт должна одна внятная строка.
  return {
    ...baseMetadata,
    ...metadata,
    httpStatus: httpStatus ?? metadata.httpStatus ?? baseMetadata.httpStatus,
  };
}

// Наследование от RuntimeExecutionError, а не от базового Error:
// shared-слой умеет отличать ошибки рантаймов от прочих, а вложенный cause сохраняет
// исходный сбой для отладки, тогда как наружу виден уже нормализованный контракт.
export class OpenCodeRuntimeAdapterError extends RuntimeExecutionError {
  public readonly adapterCode: string;
  public readonly httpStatus?: number;

  constructor(
    message: string,
    adapterCode: string,
    category: RuntimeErrorCategory,
    cause?: unknown,
    metadata: RuntimeExecutionErrorMetadata = {},
  ) {
    // adapterCode прокидывается в metadata: он нужен и в сериализованном виде (логи,
    // ответы API), и как публичное поле класса - поэтому дублируется осознанно.
    super(message, cause, category, { ...metadata, adapterCode });
    // Своё имя класса вместо "Error": при сериализации ошибки в лог видно автора сбоя.
    this.name = "OpenCodeRuntimeAdapterError";
    this.adapterCode = adapterCode;
    // httpStatus опционален: сбой может случиться до получения ответа сервера
    // (обрыв сети, таймаут), и тогда статуса просто не существует.
    this.httpStatus = metadata.httpStatus;
  }
}

/**
 * Единая точка входа: любой сбой, вылетевший из HTTP-клиента, проходит здесь.
 *
 * Гарантия контракта - функция всегда возвращает OpenCodeRuntimeAdapterError:
 * вызывающему коду не нужно проверять тип и пересобирать ошибку вручную, поэтому
 * наверх из адаптера не просачиваются сырые Error и чужие категории.
 * metadata принимается со значением по умолчанию: большинство вызовов передаёт
 * только ошибку, и лишний {} в каждой точке вызова был бы шумом.
 */
export function classifyOpenCodeRuntimeError(
  error: unknown,
  httpStatus?: number,
  metadata: RuntimeExecutionErrorMetadata = {},
): OpenCodeRuntimeAdapterError {
  // Идемпотентность: уже классифицированная ошибка возвращается как есть. Без этой
  // проверки повторная обёртка обросла бы вложенными cause и перетёрла бы adapterCode
  // вышестоящей ошибки.
  if (error instanceof OpenCodeRuntimeAdapterError) {
    return error;
  }
  // Текст извлекается сразу и один раз: он нужен для сообщения новой ошибки и для
  // классификации, но решения по нему дальше не принимаются - только по структуре.
  const message = messageFromUnknown(error);
  const mergedMetadata = mergeMetadata(error, httpStatus, metadata);

  // Ошибка другого адаптера или общего слоя: категорию наследуем (она уже осмыслена),
  // но код переводим в пространство имён OpenCode - потребитель не должен угадывать,
  // чей это сбой, по префиксу строки.
  if (error instanceof RuntimeExecutionError) {
    return new OpenCodeRuntimeAdapterError(
      message,
      CATEGORY_TO_ADAPTER_CODE[error.category],
      error.category,
      error,
      mergedMetadata,
    );
  }

  // Обычный случай: неопознанный сбой - классифицируем с нуля по статусу и тексту.
  const { adapterCode, category } = classify(message, mergedMetadata.httpStatus);
  return new OpenCodeRuntimeAdapterError(message, adapterCode, category, error, mergedMetadata);
}
