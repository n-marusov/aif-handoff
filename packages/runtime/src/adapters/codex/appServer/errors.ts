/**
 * Классификация ошибок codex app-server.
 *
 * Ошибки приходят из двух принципиально разных источников: JSON-RPC-ответ с полем error
 * (там есть числовой code) и произвольное значение, брошенное выше по стеку. Задача модуля -
 * привести оба вида к одной структуре RuntimeErrorCategory + adapterCode, чтобы вызывающий
 * код ветвился по полям, а не по тексту сообщения (правило проекта: классификация только
 * через структурированные признаки, никогда через .includes()/regex по error.message).
 *
 * Порядок приоритетов важен: явная category из payload перебивает HTTP-статус, а HTTP-статус -
 * строковый код вида "AUTH". Чем ближе признак к источнику ошибки, тем меньше шансов, что он
 * проставлен эвристикой вышестоящего слоя.
 */

import {
  classifyByHttpStatus,
  type RuntimeErrorCategory,
  type RuntimeExecutionErrorMetadata,
} from "../../../errors.js";
import { CodexRuntimeAdapterError, classifyCodexRuntimeError } from "../errors.js";
import { JsonlRpcResponseError } from "./jsonlRpcClient.js";

// Обратный маппинг нужен для случая, когда категория уже известна, а adapterCode - нет:
// наружу всегда отдаём оба поля, чтобы потребитель мог логировать стабильный машиночитаемый
// идентификатор, не зависящий от формулировки сообщения.
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

// Значение категории может прийти из недоверенного JSON, поэтому принадлежность закрытому
// списку проверяется через Set: это единственный способ сузить string до enum без `as`.
const RUNTIME_ERROR_CATEGORIES = new Set<RuntimeErrorCategory>([
  "rate_limit",
  "auth",
  "timeout",
  "permission",
  "stream",
  "transport",
  "model_not_found",
  "context_length",
  "content_filter",
  "unknown",
]);

// Таблица покрывает и верхнеуровневые коды из HTTP-слоя, и варианты CodexErrorInfo (они
// приходят в camelCase и нормализуются в UPPER_SNAKE перед поиском).
// Отсутствие кода в таблице не является ошибкой - классификатор идёт дальше по цепочке.
const STRUCTURED_CODE_TO_CATEGORY: Record<string, RuntimeErrorCategory> = {
  AUTH: "auth",
  UNAUTHORIZED: "auth",
  USAGE_LIMIT_EXCEEDED: "rate_limit",
  SERVER_OVERLOADED: "rate_limit",
  PERMISSION_DENIED: "permission",
  RATE_LIMIT: "rate_limit",
  TIMEOUT: "timeout",
  MODEL_NOT_FOUND: "model_not_found",
  CONTEXT_LENGTH_EXCEEDED: "context_length",
  CONTEXT_WINDOW_EXCEEDED: "context_length",
  CONTENT_FILTER: "content_filter",
  TRANSPORT_ERROR: "transport",
  STREAM_ERROR: "stream",
  HTTP_CONNECTION_FAILED: "transport",
  RESPONSE_STREAM_CONNECTION_FAILED: "stream",
  RESPONSE_STREAM_DISCONNECTED: "stream",
  BAD_REQUEST: "transport",
  INTERNAL_SERVER_ERROR: "transport",
  SANDBOX_ERROR: "permission",
};

// Промежуточный снимок: всё, что удалось вытащить из payload ошибки.
// Каждое поле явно допускает null, потому что payload недоверенный и любое из значений
// может отсутствовать. Скрывать null через приведение типа здесь нельзя (правило проекта).
interface CodexAppServerErrorInfo {
  category: RuntimeErrorCategory | null;
  adapterCode: string | null;
  structuredCode: string | null;
  httpStatusCode: number | null;
  providerMeta: Record<string, unknown> | null;
}

export function classifyCodexAppServerError(
  error: unknown,
  metadata: RuntimeExecutionErrorMetadata = {},
): CodexRuntimeAdapterError {
  // Идемпотентность: повторная классификация уже классифицированной ошибки не должна
  // заворачивать её в новую обёртку - иначе теряется исходный stack и множатся слои cause.
  if (error instanceof CodexRuntimeAdapterError) {
    return error;
  }

  const info = extractCodexAppServerErrorInfo(error);
  // Fallback-цепочка от самого надёжного признака к самому слабому: явная категория,
  // затем HTTP-статус (если это действительно число), затем строковый код, и лишь
  // в самом конце - "unknown".
  const category =
    info.category ??
    (typeof info.httpStatusCode === "number" ? classifyByHttpStatus(info.httpStatusCode) : null) ??
    (info.structuredCode ? STRUCTURED_CODE_TO_CATEGORY[info.structuredCode] : null) ??
    "unknown";

  // Найден хотя бы один структурированный признак - собираем "богатую" ошибку:
  // сохраняем исходное значение для диагностики и прокидываем httpStatus/providerMeta.
  // adapterCode берём из payload, а если его там нет - синтезируем из категории.
  if (
    info.category ||
    info.adapterCode ||
    info.structuredCode ||
    typeof info.httpStatusCode === "number"
  ) {
    const adapterCode = info.adapterCode ?? CATEGORY_TO_ADAPTER_CODE[category];
    const message = messageFromUnknown(error);
    return new CodexRuntimeAdapterError(message, adapterCode, category, error, {
      ...metadata,
      adapterCode,
      httpStatus: info.httpStatusCode ?? metadata.httpStatus,
      providerMeta: info.providerMeta ?? metadata.providerMeta ?? null,
    });
  }

  // Признаков нет вовсе - отдаём решение общему классификатору Codex: он умеет разбирать
  // transport/exit-code ошибки, которые не несут JSON-RPC-данных.
  return classifyCodexRuntimeError(error, metadata.httpStatus, metadata);
}

export function extractCodexAppServerErrorInfo(error: unknown): CodexAppServerErrorInfo {
  // JsonlRpcResponseError несёт исходный объект ответа в rpcData, поэтому для него смотрим
  // внутрь JSON-RPC error, а для обычных объектов - на их собственные поля.
  const fromJsonlError = error instanceof JsonlRpcResponseError ? asRecord(error.rpcData) : null;
  const fromDirectError = error && typeof error === "object" ? asRecord(error) : null;
  // codexErrorInfo встречается на двух уровнях: внутри JSON-RPC data и прямо на ошибке,
  // а сам по себе он может быть как строкой-вариантом, так и объектом-обёрткой.
  const rawCodexInfo = fromJsonlError?.codexErrorInfo ?? fromDirectError?.codexErrorInfo ?? null;
  const fromCodexInfo = asRecord(rawCodexInfo);
  const codexInfoDetails = readCodexErrorInfoDetails(fromCodexInfo?.codexErrorInfo ?? rawCodexInfo);
  // providerMeta - это "сырой" payload для логов; пустой объект бесполезен и только
  // засоряет диагностику, поэтому в таком случае отдаём null.
  const providerMeta =
    fromJsonlError ??
    (fromDirectError && Object.keys(fromDirectError).length > 0 ? fromDirectError : null);

  // Явная категория ищется в нескольких местах: вложенный codexErrorInfo, сам payload и
  // альтернативное имя errorCategory. readCategory отбросит всё, что не входит в enum.
  const category =
    readCategory(
      fromCodexInfo?.category ??
        fromJsonlError?.category ??
        fromDirectError?.category ??
        fromJsonlError?.errorCategory ??
        fromDirectError?.errorCategory,
    ) ?? codexInfoDetails.category;
  // adapterCode и code часто дублируют друг друга у разных версий протокола,
  // поэтому пробуем оба поля, а отбраковкой пустых значений занимается readString.
  const adapterCode = readString(
    fromCodexInfo?.adapterCode ??
      fromJsonlError?.adapterCode ??
      fromDirectError?.adapterCode ??
      fromJsonlError?.code ??
      fromDirectError?.code,
  );
  // structuredCode намеренно НЕ включает fromJsonlError.code: там лежит числовой
  // JSON-RPC код, а не строковый идентификатор варианта.
  const structuredCode = readString(
    fromCodexInfo?.code ??
      fromJsonlError?.codexCode ??
      fromDirectError?.codexCode ??
      codexInfoDetails.structuredCode,
  );
  // Числовой HTTP-статус приходит под двумя именами в каждом из трёх источников, плюс
  // может лежать внутри варианта CodexErrorInfo - отсюда такая длинная цепочка ??.
  const httpStatusCode = readNumber(
    fromCodexInfo?.httpStatusCode ??
      fromCodexInfo?.httpStatus ??
      fromJsonlError?.httpStatusCode ??
      fromJsonlError?.httpStatus ??
      fromDirectError?.httpStatusCode ??
      fromDirectError?.httpStatus ??
      codexInfoDetails.httpStatusCode,
  );

  return {
    category,
    adapterCode,
    structuredCode,
    httpStatusCode,
    providerMeta,
  };
}

function readCodexErrorInfoDetails(value: unknown): {
  category: RuntimeErrorCategory | null;
  structuredCode: string | null;
  httpStatusCode: number | null;
} {
  // Разбор CodexErrorInfo: строковый вариант ("Auth") или односмысловой объект
  // { auth: { httpStatusCode } }. Имя варианта нормализуем в UPPER_SNAKE, чтобы искать
  // в общей таблице STRUCTURED_CODE_TO_CATEGORY.
  const variant = readCodexErrorInfoVariant(value);
  if (!variant) {
    return { category: null, structuredCode: null, httpStatusCode: null };
  }
  const structuredCode = camelToUpperSnake(variant.name);
  return {
    category: STRUCTURED_CODE_TO_CATEGORY[structuredCode] ?? null,
    structuredCode,
    httpStatusCode: variant.httpStatusCode,
  };
}

function readCodexErrorInfoVariant(value: unknown): {
  name: string;
  httpStatusCode: number | null;
} | null {
  // Возвращаем null, а не бросаем: отсутствие варианта - нормальная ситуация,
  // вызывающий код просто продолжит fallback-цепочку.
  const stringValue = readString(value);
  // Строковая форма: сама строка уже является именем варианта.
  if (stringValue) {
    return { name: stringValue, httpStatusCode: null };
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  // Объектная форма: интересует ровно первая пара ключ-значение, потому что
  // CodexErrorInfo - это enum-подобный union с единственным активным полем.
  const [name, detail] = Object.entries(record)[0] ?? [];
  if (!name) {
    return null;
  }
  return {
    name,
    // detail тоже недоверенный: asRecord вернёт null для примитива или массива,
    // поэтому обращение к полю идёт через ?. и не падает на реальных данных.
    httpStatusCode: readNumber(asRecord(detail)?.httpStatusCode),
  };
}

// "ResponseStreamDisconnected" -> "RESPONSE_STREAM_DISCONNECTED": подчёркивание
// вставляется на границе строчной (или цифры) и заглавной буквы.
function camelToUpperSnake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

// Отсекаем null, массивы и примитивы: дальше по коду читаются поля, а строка или массив
// дали бы бессмысленные undefined вместо честного null.
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Пустые и пробельные строки приводим к null: для классификатора они неотличимы
// от отсутствующего поля.
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// number проверяется вместе с Number.isFinite: NaN и Infinity прошли бы проверку typeof,
// но как HTTP-статус или код они бессмысленны.
function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readCategory(value: unknown): RuntimeErrorCategory | null {
  if (typeof value !== "string") {
    return null;
  }
  // Приведение через `as` здесь допустимо ровно потому, что следующая строка проверяет
  // значение по Set: не-член перечисления не просочится наружу.
  const normalized = value.trim() as RuntimeErrorCategory;
  return RUNTIME_ERROR_CATEGORIES.has(normalized) ? normalized : null;
}

// Текст нужен только для логов и человекочитаемого сообщения: ветвиться по нему
// правилами проекта запрещено. String(error) - последний рубеж для бросков не-Error.
function messageFromUnknown(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}
