/**
 * Иерархия ошибок адаптера Claude — единственное место, где сырые исключения
 * SDK/CLI превращаются в ClaudeRuntimeAdapterError.
 *
 * Ключевое проектное требование (правило Structured Error Classification): ошибка
 * несёт структурированный контекст — category (из RuntimeErrorCategory),
 * adapterCode и httpStatus. Потребители (координатор, API, UI) ветвятся только по
 * этим полям; текст сообщения — для логов и человека, а поиск подстрок в
 * error.message как условие логики запрещён. Поэтому в модуле нет ни одного
 * собственного regexp'а для разбора текста: при недостатке данных вызывается
 * общий classifyByMessageFallback из @aif/runtime, и только он решает, что значит
 * сообщение.
 *
 * Приоритет классификации (сверху вниз, первый сработавший побеждает):
 * 1) ошибка уже ClaudeRuntimeAdapterError — возвращается как есть (идемпотентность:
 *    повторная классификация не портит и не удваивает контекст);
 * 2) limitSnapshot.status = BLOCKED — самый достоверный сигнал лимита: он
 *    вычислен из структурированного события (limit.js), а не угадан по фразе;
 * 3) ошибка уже RuntimeExecutionError из общего слоя — её category известна,
 *    к ней добавляется только адаптерный код;
 * 4) только теперь fallback: HTTP-статус (если есть) -> общий классификатор по
 *    тексту.
 *
 * Наружу всегда уходит ровно один тип ошибки, чтобы ловящий код не разбирал
 * зоопарк исключений: ловить нужно только ClaudeRuntimeAdapterError и смотреть на
 * его поля.
 */

// Импорты отражают разделение обязанностей: категории и классификаторы берутся из
// общего слоя рантайма, а единственная адаптерная зависимость — статус лимита,
// потому что именно его значение (BLOCKED) поднимает классификацию выше текста.
import {
  RuntimeExecutionError,
  type RuntimeExecutionErrorMetadata,
  classifyByHttpStatus,
  classifyByMessageFallback,
  type RuntimeErrorCategory,
} from "../../errors.js";
import { RuntimeLimitStatus } from "../../types.js";

/** Отображает семантическую категорию в специфичный для Claude код адаптера. */
// Постоянная таблица «семантическая категория -> код адаптера». Именно
// Record<RuntimeErrorCategory, string> — исчерпывающий тип: добавить значение в
// enum и не добавить сюда код не получится без ошибки компиляции.
// Сами коды — публичный контракт (UI, тесты, документация провайдеров сопоставляют
// их по именам), поэтому переименование существующего кода — ломающее изменение, а
// новое состояние требует нового кода, а не переиспользования чужого.
const CATEGORY_TO_ADAPTER_CODE: Record<RuntimeErrorCategory, string> = {
  rate_limit: "CLAUDE_USAGE_LIMIT",
  auth: "CLAUDE_AUTH_ERROR",
  timeout: "CLAUDE_QUERY_START_TIMEOUT",
  permission: "CLAUDE_PERMISSION_DENIED",
  stream: "CLAUDE_STREAM_ERROR",
  transport: "CLAUDE_TRANSPORT_ERROR",
  model_not_found: "CLAUDE_MODEL_NOT_FOUND",
  context_length: "CLAUDE_CONTEXT_LENGTH",
  content_filter: "CLAUDE_CONTENT_FILTER",
  unknown: "CLAUDE_RUNTIME_ERROR",
};

// Приведение неизвестного исключения к тексту: SDK нередко бросает не Error, а
// строку/объект, поэтому instanceof-check с фолбэком на String — не
// перестраховка, а необходимость для читаемого лога.
function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Внутренний классификатор с явным приоритетом «структурное раньше текстового».
// HTTP-статус — структурированный факт транспорта (API-путь OpenRouter/Codex),
// и он надёжнее любых слов в сообщении, поэтому первый. Если статуса нет
// (CLI/SDK транспорты), отдаём решение общему fallback-классификатору — здесь
// намеренно нет локальных списков фраз, чтобы правила не расходились между
// адаптерами.
function classify(
  message: string,
  httpStatus?: number,
): { adapterCode: string; category: RuntimeErrorCategory } {
  // Основной сигнал: HTTP status (API-транспорты)
  if (httpStatus !== undefined) {
    const category = classifyByHttpStatus(httpStatus);
    if (category) {
      return { adapterCode: CATEGORY_TO_ADAPTER_CODE[category], category };
    }
  }

  // Резерв: общая классификация по сообщению (CLI/SDK-транспорты)
  // Ветка достижима только без httpStatus — это признак транспорта без HTTP
  // (CLI/SDK). Индексация по таблице безопасна: Record исчерпывающий, и любой
  // возвращённый классификатором category гарантированно имеет свой код.
  const category = classifyByMessageFallback(message);
  return { adapterCode: CATEGORY_TO_ADAPTER_CODE[category], category };
}

// Сборка metadata для новой ошибки. Значения переносятся из уже существующей
// RuntimeExecutionError поимённо (httpStatus, resetAt, retryAfter*, limitSnapshot,
// providerMeta): если не перенести, повторная обёртка обеднеет и, например,
// limitSnapshot пропадёт по пути. httpStatus разрешается каскадом
// «аргумент -> явная metadata -> исходная ошибка» — самый близкий к источнику
// факт сведения имеет приоритет.
function mergeMetadata(
  error: unknown,
  httpStatus?: number,
  // Пустой объект по умолчанию — чтобы вызовы без дополнительных сведений
  // (большинство путей SDK) не были вынуждены передавать {} явно.
  metadata: RuntimeExecutionErrorMetadata = {},
): RuntimeExecutionErrorMetadata {
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

  return {
    ...baseMetadata,
    ...metadata,
    httpStatus: httpStatus ?? metadata.httpStatus ?? baseMetadata.httpStatus,
  };
}

// Ошибка уровня «этот ран упал, вот почему»: adapterCode живёт отдельным
// readonly-полем рядом с category, чтобы потребителю не разбирать вложенную
// metadata. super() получает adapterCode и в metadata — так он не теряется при
// сериализации/логировании в общем слое, который про конкретный адаптер не знает.
// name переопределяется для читаемых стеков: "ClaudeRuntimeAdapterError" в логе
// сразу говорит, какой адаптер виноват.
export class ClaudeRuntimeAdapterError extends RuntimeExecutionError {
  public readonly adapterCode: string;

  constructor(
    message: string,
    adapterCode: string,
    category: RuntimeErrorCategory,
    cause?: unknown,
    metadata: RuntimeExecutionErrorMetadata = {},
  ) {
    // adapterCode кладётся и в metadata: общий слой сериализует metadata, не зная
    // про поля конкретного адаптера, и так код не теряется ни в логах, ни в API.
    super(message, cause, category, { ...metadata, adapterCode });
    this.name = "ClaudeRuntimeAdapterError";
    this.adapterCode = adapterCode;
  }
}

// Публичная точка входа модуля. Не бросает сама — только строит ошибку, которую
// вызывающий код решит выбросить или передать дальше. Принимает исходную ошибку
// как unknown (так поступит любой SDK), возможный HTTP-статус и дополнительную
// metadata от транспорта; cause сохраняется внутри, чтобы не потерять оригинал.
export function classifyClaudeRuntimeError(
  error: unknown,
  // Необязательный статус: транспорты поверх HTTP (Codex/OpenRouter proxy)
  // передают его сюда, SDK/CLI — нет; отсутствие и есть «нет структурной зацепки».
  httpStatus?: number,
  metadata: RuntimeExecutionErrorMetadata = {},
): ClaudeRuntimeAdapterError {
  if (error instanceof ClaudeRuntimeAdapterError) {
    // Идемпотентность важнее «единообразия»: ошибка уже снабжена полным
    // контекстом, и повторная обёртка могла бы только ухудшить (перезаписать
    // adapterCode менее точным из своего пути).
    return error;
  }
  const message = messageFromUnknown(error);
  const mergedMetadata = mergeMetadata(error, httpStatus, metadata);
  // Лимит с BLOCKED — единственный случай, когда классификация поднимается выше
  // текста и даже выше готовой категории: снапшот лимита пришёл из SDK как
  // структурированное событие, и он авторитетнее любой формулировки ошибки.
  // Без этой ветки rate-limit выглядел бы как «unknown» и ломал бы ретраи.
  if (mergedMetadata.limitSnapshot?.status === RuntimeLimitStatus.BLOCKED) {
    return new ClaudeRuntimeAdapterError(
      message,
      CATEGORY_TO_ADAPTER_CODE.rate_limit,
      "rate_limit",
      error,
      mergedMetadata,
    );
  }

  if (error instanceof RuntimeExecutionError) {
    // Категория уже установлена общим слоем — заново угадывать её по тексту
    // было бы регрессом точности. Работа этой ветки — лишь добавить адаптерный
    // код, соответствующий уже известной категории.
    return new ClaudeRuntimeAdapterError(
      message,
      CATEGORY_TO_ADAPTER_CODE[error.category],
      error.category,
      error,
      mergedMetadata,
    );
  }

  // Последний рубеж: ни класса, ни снапшота, ни категории — остаётся только
  // текст сообщения плюс возможный HTTP-статус. Классификацию делает общий слой
  // (см. classify выше), а результат всё равно оборачивается в наш тип.
  const { adapterCode, category } = classify(message, mergedMetadata.httpStatus);
  // Неизвестный случай тоже обогащается, а не выбрасывается как есть: исходная
  // ошибка уходит в cause, а category/adapterCode дают потребителю стабильную
  // точку ветвления.
  return new ClaudeRuntimeAdapterError(message, adapterCode, category, error, mergedMetadata);
}

// Detail из SDK subtype'а приводится к компактному виду перед включением в
// сообщение: эта строка попадёт в логи и UI, а необъятный дамп ответа в тексте
// ошибки мешает и читать, и хранить. 240 символов — компромисс между «видно
// причину» и «не раздувает сообщение»; суть ошибки обычно в первых строках,
// поэтому срезается хвост, а не голова.
function normalizeDetail(detail: string | null | undefined): string | null {
  if (typeof detail !== "string") return null;
  const normalized = detail.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 240 ? `${normalized.slice(0, 240)}...` : normalized;
}

// Мост для случая, когда SDK вернул result-субтип ошибки ("error_during_execution"
// и т.п.), но объекта Error нет вовсе — есть только строка субтипа. Собираем из
// него сообщение и отдаём в тот же classifyClaudeRuntimeError, чтобы наружу ушёл
// обычный структурированный тип, а не строковый суррогат.
export function classifyClaudeResultSubtype(
  subtype: string,
  detail?: string | null,
  metadata: RuntimeExecutionErrorMetadata = {},
): ClaudeRuntimeAdapterError {
  const normalizedDetail = normalizeDetail(detail);
  // База сообщения стабильна и начинается с «Claude query failed: <subtype>»: по
  // ней в логах видно и источник (Claude), и машинный subtype, даже если detail
  // окажется пустым.
  const base = `Claude query failed: ${subtype}`;
  const message = normalizedDetail ? `${base}: ${normalizedDetail}` : base;
  return classifyClaudeRuntimeError(message, metadata.httpStatus, metadata);
}
