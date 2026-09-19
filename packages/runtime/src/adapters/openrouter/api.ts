/**
 * HTTP-транспорт адаптера OpenRouter: запросы к /chat/completions и /models.
 *
 * Модуль покрывает два режима работы - обычный ответ и потоковый (SSE). Потоковый режим
 * содержит большую часть логики файла: чанки приходят фрагментами, поэтому строки собираются
 * из буфера по границам "\n", а tool-call'ы приходят дельтами, которые нужно накапливать по
 * индексу вызова, прежде чем превратить в цельные вызовы функций.
 *
 * Отдельное внимание уделено двум неочевидным местам OpenAI-совместимых API:
 * 1) ошибка может прийти при HTTP 200 - либо в поле error верхнего уровня, либо в choices[0].error;
 * 2) usage в стриме передаётся только в финальных чанках, и до этого момента его попросту нет.
 *
 * Все ошибки прогоняются через classifyOpenRouterRuntimeError: наружу уходят структурированные
 * ошибки с category/adapterCode/httpStatus, чтобы выше по стеку не приходилось разбирать текст.
 */

import { redactProviderText, redactProviderTextForLogs } from "@aif/shared";
import type {
  RuntimeConnectionValidationInput,
  RuntimeConnectionValidationResult,
  RuntimeEvent,
  RuntimeLimitSnapshot,
  RuntimeLimitStatus,
  RuntimeModel,
  RuntimeModelListInput,
  RuntimeRunInput,
  RuntimeRunResult,
  RuntimeToolCall,
  RuntimeUsage,
} from "../../types.js";
import { RuntimeExecutionError, type RuntimeExecutionErrorMetadata } from "../../errors.js";
import { buildRuntimeLimitEvent } from "../../limitEvents.js";
import { buildOpenAiCompatibleLimitSnapshot } from "../../openaiRateLimits.js";
import { withProxyDispatcher } from "../../proxyEnv.js";
import {
  normalizeModelEffort,
  normalizeModelEffortLevels,
  OPENROUTER_GATEWAY_MODEL_EFFORT_LEVELS,
  OPENROUTER_MODEL_EFFORT_LEVELS,
  resolveModelEffortOption,
} from "../../modelEffort.js";
import { isRetriableTimeoutError, resolveRetryDelay, sleepMs } from "../../timeouts.js";
import { classifyOpenRouterRuntimeError } from "./errors.js";

// Логгер передаётся снаружи (из адаптера), поэтому все методы опциональны: транспорт не
// должен требовать логирования, иначе его нельзя будет использовать в тестах без заглушки.
export interface OpenRouterApiLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

// База по умолчанию - публичный шлюз OpenRouter; её можно переопределить через опции профиля
// или переменную окружения (см. resolveBaseUrl ниже).
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
// Заголовок X-Title показывается в статистике OpenRouter; значение по умолчанию нужно, чтобы
// запросы не выглядели безымянными.
const DEFAULT_APP_TITLE = "AIF Handoff";
// Повторяются только статусы, означающие временную проблему: 429 - превышен лимит, 503 -
// шлюз/провайдер недоступен. Повторять, например, 400 или 401 бессмысленно: ответ не изменится,
// а время будет потеряно.
const RETRYABLE_STATUS = new Set([429, 503]);
// Три попытки - компромисс: переживаем короткие всплески лимитов, но не держим задачу в
// ожидании слишком долго, ведь сверху действует общий таймаут запуска.
const MAX_RETRY_ATTEMPTS = 3;

// Ключи, которые нельзя писать в логи. Набор намеренно включает разные написания: опции
// приходят из UI-профиля, и поле там могло быть названо любым вариантом из этого списка.
const SENSITIVE_OPTION_KEYS = new Set(["apiKey", "apikey", "api_key", "secret", "password"]);

// Безопасное сужение unknown -> Record для чтения полей ответа провайдера. Пустой объект вместо
// null позволяет писать `payload.usage` без дополнительных проверок, а массивы и примитивы
// отсекаются: обращение к их полям даёт неожиданные результаты.
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Пустая строка после trim трактуется как отсутствие значения: так удобнее работать с
// переменными окружения, где пустое значение встречается чаще осмысленного. Тип string | null
// заставляет вызывающий код явно обработать случай "значения нет".
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Копия опций без секретов - только для логирования. Исходный объект не мутируется: он
// используется дальше, в том числе при повторной попытке запроса.
function stripSensitiveOptions(
  options: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!options) return options;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    // Проверяется имя ключа, а не значение: секретом может оказаться любое поле, названное
    // apiKey, а перечислить все возможные значения невозможно в принципе.
    if (!SENSITIVE_OPTION_KEYS.has(key)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

// Текст ошибки приходит от провайдера и может содержать ключи или другие чувствительные
// данные. Перед тем как положить его в Error.message (а оттуда - в логи и UI), текст проходит
// редактирование. Пустой ответ заменяется запасной формулировкой: пустое сообщение бесполезно
// при разборе инцидента.
function safeProviderErrorMessage(rawText: string, fallbackMessage: string): string {
  const trimmed = rawText.trim();
  return trimmed.length > 0 ? redactProviderText(trimmed) : fallbackMessage;
}

// ---------------------------------------------------------------------------
// Резолвинг URL / авторизации / заголовков
// ---------------------------------------------------------------------------

// Опции профиля имеют приоритет над переменной окружения: пользователь, задавший baseUrl в
// конкретном профиле, ожидает именно его. Хвостовые слэши срезаются, иначе склейка с путём
// дала бы двойной слэш и потенциальный редирект.
function resolveBaseUrl(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): string {
  const options = asRecord((input as RuntimeRunInput).options);
  const baseUrl =
    readString(options.baseUrl) ?? readString(process.env.OPENROUTER_BASE_URL) ?? DEFAULT_BASE_URL;
  return baseUrl.replace(/\/+$/, "");
}

// Порядок поиска ключа: явно указанная переменная окружения (apiKeyEnvVar) -> ключ прямо в
// опциях профиля -> переменная по умолчанию. Если apiKeyEnvVar задан, остальные источники
// намеренно игнорируются: это способ жёстко зафиксировать, откуда берётся ключ.
function resolveApiKey(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): string | null {
  const options = asRecord((input as RuntimeRunInput).options);
  const configuredApiKeyEnvVar =
    "apiKeyEnvVar" in input
      ? readString((input as RuntimeRunInput & { apiKeyEnvVar?: string }).apiKeyEnvVar)
      : null;
  const apiKeyEnvVar = configuredApiKeyEnvVar ?? readString(options.apiKeyEnvVar);
  return apiKeyEnvVar
    ? readString(process.env[apiKeyEnvVar])
    : (readString(options.apiKey) ?? readString(process.env.OPENROUTER_API_KEY));
}

// HTTP-Referer и X-Title - необязательные заголовки атрибуции OpenRouter. Возвращается строка
// (возможно пустая), потому что заголовок либо ставится целиком, либо не ставится вовсе.
function resolveHttpReferer(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): string {
  const options = asRecord((input as RuntimeRunInput).options);
  return readString(options.httpReferer) ?? readString(process.env.OPENROUTER_HTTP_REFERER) ?? "";
}

// Как и с ключом, приоритет у явной настройки; пустая строка как "не задано" отсекается в
// readString, поэтому ?? здесь безопасен и не пропустит пустое значение.
function resolveAppTitle(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): string {
  const options = asRecord((input as RuntimeRunInput).options);
  return (
    readString(options.appTitle) ??
    readString(process.env.OPENROUTER_APP_TITLE) ??
    DEFAULT_APP_TITLE
  );
}

// Сборка заголовков запроса. Базовая часть обязательна для chat completions; авторизация и
// атрибуция добавляются только при наличии значений, чтобы не отправлять пустые заголовки.
function buildHeaders(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const apiKey = resolveApiKey(input);
  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  const referer = resolveHttpReferer(input);
  if (referer) {
    headers.set("HTTP-Referer", referer);
  }
  const appTitle = resolveAppTitle(input);
  if (appTitle) {
    headers.set("X-Title", appTitle);
  }

  const rawHeaders = {
    ...asRecord(asRecord((input as RuntimeRunInput).options).headers),
    ...("headers" in input ? asRecord((input as RuntimeRunInput).headers) : {}),
  };
  for (const [key, value] of Object.entries(rawHeaders)) {
    // Пользовательские заголовки применяются последними и потому могут переопределить
    // стандартные (например, свой Authorization для прокси). Нестроковые значения
    // пропускаются: Headers принимает только строки, а падать из-за опечатки в конфиге
    // незачем - лучше отправить запрос без этого заголовка.
    if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Сборщики тела запроса
// ---------------------------------------------------------------------------

// Схема сообщения в терминах wire-формата OpenAI: имена полей в snake_case, потому что объект
// уходит в JSON без промежуточного преобразования. Внутренние типы рантайма используют
// camelCase, поэтому перевод делается один раз в buildMessages ниже.
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: RuntimeToolCall[];
}

// Два режима: если вызывающий передал готовую историю сообщений - используем её (так работают
// многошаговые сценарии с tool-call'ами и ответами tool); иначе собираем минимальный диалог из
// системного промпта и одного пользовательского сообщения.
function buildMessages(input: RuntimeRunInput): ChatMessage[] {
  if (input.messages?.length) {
    return input.messages.map(
      (message): ChatMessage => ({
        role: message.role,
        content: message.content ?? null,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}),
      }),
    );
  }

  const messages: ChatMessage[] = [];
  // systemPromptAppend дописывается к системному промпту, а не заменяет его: вызывающий может
  // добавить контекст (например, правила проекта), не теряя базовую инструкцию.
  let systemContent = input.systemPrompt ?? "";
  if (input.execution?.systemPromptAppend) {
    systemContent = systemContent
      ? `${systemContent}\n\n${input.execution.systemPromptAppend}`
      : input.execution.systemPromptAppend;
  }
  if (systemContent) messages.push({ role: "system", content: systemContent });
  messages.push({ role: "user", content: input.prompt });
  return messages;
}

// Тело запроса собирается от общего к частному: обязательные поля, затем опциональные блоки.
// stream влияет на формат ответа, поэтому приходит аргументом, а не берётся из input -
// повторная попытка может отправить тот же запуск в другом режиме.
function buildRequestBody(input: RuntimeRunInput, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: buildMessages(input),
    stream,
  };
  if (input.tools?.length) body.tools = input.tools;
  if (input.toolChoice) body.tool_choice = input.toolChoice;

  // Структурированный вывод запрашивается через json_schema со strict: true - провайдер
  // обязан вернуть JSON, соответствующий схеме, поэтому вызывающему не нужен "ремонт" ответа.
  if (input.execution?.outputSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: true,
        schema: input.execution.outputSchema,
      },
    };
  }

  const options = asRecord(input.options);
  // reasoning.effort - необязательное поле: пустое значение настроек означает "не вмешиваться
  // в поведение провайдера по умолчанию", поэтому блок добавляется только при валидном уровне.
  const effort = resolveModelEffortOption(options, "effort", OPENROUTER_MODEL_EFFORT_LEVELS);
  if (effort) {
    body.reasoning = { effort };
  }

  return body;
}

// Разбор tool_calls из нестримингового ответа. Вход - недоверенный JSON, поэтому каждый
// уровень проверяется вручную, а невалидные элементы отбрасываются: одна битая запись не
// должна ломать весь ответ модели и лишать вызывающего корректных вызовов рядом.
function parseToolCalls(value: unknown): RuntimeToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((call): RuntimeToolCall[] => {
    if (!call || typeof call !== "object") return [];
    const record = call as Record<string, unknown>;
    const fn = record.function;
    if (!fn || typeof fn !== "object") return [];
    const functionRecord = fn as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof functionRecord.name !== "string") return [];
    return [
      {
        id: record.id,
        type: "function",
        function: {
          name: functionRecord.name,
          // arguments должен быть строкой JSON (таково требование протокола). Если провайдер
          // прислал не строку, подставляется пустой JSON-объект: парсер на стороне исполнителя
          // иначе упадёт на пустой строке.
          arguments: typeof functionRecord.arguments === "string" ? functionRecord.arguments : "{}",
        },
      },
    ];
  });
}

// Накопитель одного tool-call'а в стриме. id и name обычно приходят в первом чанке, а
// arguments докапливаются по кусочкам строки; готовый вызов собирается только в конце потока,
// потому что до этого момента JSON аргументов может быть синтаксически неполным.
type StreamingToolCallSlot = {
  id: string;
  name: string;
  arguments: string;
};

// Дельта tool-call'а привязана к позиции (index), а не к id: id может прийти позже или не
// прийти вовсе. Поэтому слоты хранятся в Map<number, ...> - так чанки разных вызовов не
// перемешиваются, даже если приходят вперемешку или с пропусками.
function collectStreamingToolCallDelta(
  slots: Map<number, StreamingToolCallSlot>,
  rawToolCalls: unknown,
): void {
  if (!Array.isArray(rawToolCalls)) return;
  for (const raw of rawToolCalls) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const index = typeof record.index === "number" ? record.index : null;
    if (index == null) continue;
    // Слот создаётся при первом упоминании индекса: провайдер не обязан присылать все поля сразу.
    const current = slots.get(index) ?? { id: "", name: "", arguments: "" };
    if (typeof record.id === "string") current.id = record.id;
    const fn = record.function;
    if (fn && typeof fn === "object") {
      const functionRecord = fn as Record<string, unknown>;
      if (typeof functionRecord.name === "string") current.name = functionRecord.name;
      // Строковые поля перезаписываются, а arguments дописываются: протокол передаёт их именно
      // инкрементально, поэтому "+=" здесь - требование формата, а не деталь реализации.
      if (typeof functionRecord.arguments === "string") {
        current.arguments += functionRecord.arguments;
      }
    }
    slots.set(index, current);
  }
}

// Итоговая сборка вызовов. Сортировка по index возвращает исходный порядок, который мог быть
// нарушен разбиением на чанки; записи без id или имени отбрасываются - вызвать функцию без
// имени невозможно, а id нужен, чтобы потом отправить результат tool-сообщением.
function finalizeStreamingToolCalls(slots: Map<number, StreamingToolCallSlot>): RuntimeToolCall[] {
  return [...slots.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, slot]): RuntimeToolCall[] => {
      if (!slot.id || !slot.name) return [];
      return [
        {
          id: slot.id,
          type: "function",
          function: {
            name: slot.name,
            // Функция без аргументов должна получить валидный JSON, а не пустую строку: иначе
            // JSON.parse на стороне исполнителя бросит исключение на ровном месте.
            arguments: slot.arguments || "{}",
          },
        },
      ];
    });
}

// Приведение usage к внутреннему типу. OpenRouter использует имена в стиле OpenAI
// (prompt_tokens/completion_tokens), но встречаются и camelCase-варианты, поэтому поддержаны
// оба. Возврат null (а не нулевой структуры) означает "провайдер не сообщил расход": контракт
// адаптера требует именно RuntimeUsage | null, чтобы в UI нельзя было случайно показать нули
// как настоящие данные.
function normalizeUsage(usage: unknown): RuntimeUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const parsed = usage as Record<string, unknown>;
  const inputTokens = (parsed.prompt_tokens as number) ?? (parsed.inputTokens as number) ?? 0;
  const outputTokens = (parsed.completion_tokens as number) ?? (parsed.outputTokens as number) ?? 0;
  // Отсутствующие счётчики трактуются как нули только потому, что total выводится из двух
  // частей; если провайдер вообще не прислал usage, функция вышла раньше по проверке выше.
  const totalTokens =
    (parsed.total_tokens as number) ?? (parsed.totalTokens as number) ?? inputTokens + outputTokens;
  // Стоимость есть только у агрегаторов вроде OpenRouter, которые знают цену запроса;
  // остальные адаптеры это поле не заполняют, поэтому costUsd остаётся undefined, когда
  // данных нет, - и это отличается от "стоимость равна нулю".
  const costUsd =
    typeof parsed.cost === "number"
      ? parsed.cost
      : typeof parsed.costUsd === "number"
        ? parsed.costUsd
        : undefined;
  return { inputTokens, outputTokens, totalTokens, costUsd };
}

// Небольшая обёртка над setTimeout - чтобы вызывающий код читался как последовательность
// шагов, а не как работа с колбэками.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Заголовок Retry-After допускает две формы: число секунд или HTTP-дату. Поддержаны обе,
// причём отрицательные и невалидные значения отсекаются: нулевая или отрицательная задержка
// превратила бы повтор в busy-loop и добила бы провайдера запросами.
function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  // Сначала пробуем самую частую форму - число секунд: именно её OpenRouter использует на практике.
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000);
  }
  const atMs = Date.parse(value);
  // Если это не число - осталась дата; из неё считаем остаток до текущего момента.
  if (!Number.isFinite(atMs)) return null;
  return Math.max(0, atMs - Date.now());
}

function getBackoffMs(attempt: number): number {
  // Линейный backoff - компромисс между быстрым повтором и нагрузкой на шлюз. Он используется
  // только когда провайдер не прислал Retry-After: серверная подсказка всегда точнее.
  // 1.5 с, 3.0 с для повторов #1 и #2
  return 1_500 * attempt;
}

// Один сигнал отмены из двух источников: таймаут на весь запуск и внешний abort от вызывающего.
// AbortSignal.any объединяет их так, что срабатывание любого прерывает запрос, при этом исходные
// контроллеры не мутируются - вызывающий сохраняет над ними полный контроль.
function buildRunTimeoutSignal(input: RuntimeRunInput): AbortSignal | undefined {
  const runMs = input.execution?.runTimeoutMs;
  const externalAbort = input.execution?.abortController;

  const signals: AbortSignal[] = [];
  if (typeof runMs === "number" && Number.isFinite(runMs) && runMs > 0) {
    signals.push(AbortSignal.timeout(Math.floor(runMs)));
  }
  if (externalAbort) {
    signals.push(externalAbort.signal);
  }

  if (signals.length === 0) return undefined;
  // Одиночный сигнал отдаётся как есть: лишняя обёртка ничего не даёт, только запутывает логи.
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

// Таймаут AbortSignal.timeout приходит как DOMException с именем TimeoutError; это отличается от
// внешней отмены (AbortError) и обрабатывается по-разному: первый - повод для ретрая, вторая -
// осознанное решение вызывающего, и повторять запрос в этом случае нельзя.
function isAbortTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

// Признак того, что провайдер прислал метаданные о лимитах. Нужен для диагностики: если снапшот
// не собрался, а заголовки были, в лог уйдёт предупреждение - иначе потеря данных о лимитах
// осталась бы незамеченной и искать причину пришлось бы по коду.
function hasOpenAiRateLimitHints(headers: Headers): boolean {
  return [
    "retry-after",
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
  ].some((name) => headers.has(name));
}

// Снапшот лимитов строится общим OpenAI-совместимым парсером: OpenRouter отдаёт заголовки
// x-ratelimit-* в том же формате. statusOverride нужен, чтобы пометить блокировку по 429
// независимо от того, что удалось вычитать из заголовков.
function buildOpenRouterLimitSnapshot(
  input: RuntimeRunInput,
  headers: Headers,
  statusOverride?: RuntimeLimitStatus,
): RuntimeLimitSnapshot | null {
  return buildOpenAiCompatibleLimitSnapshot(headers, {
    providerId: input.providerId ?? "openrouter",
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    statusOverride,
  });
}

// Метаданные ошибки лимита: выше по стеку по retryAfterSeconds планируют повтор, а snapshot
// используется для индикации в UI. retryAfterMs считается здесь из секунд, чтобы потребителю не
// приходилось повторять арифметику и ошибаться в единицах измерения.
function buildLimitErrorMetadata(
  snapshot: RuntimeLimitSnapshot | null,
  httpStatus?: number,
): RuntimeExecutionErrorMetadata {
  const retryAfterSeconds = snapshot?.retryAfterSeconds ?? null;
  return {
    httpStatus,
    resetAt: snapshot?.resetAt ?? null,
    retryAfterSeconds,
    retryAfterMs: retryAfterSeconds != null ? retryAfterSeconds * 1000 : null,
    limitSnapshot: snapshot,
    providerMeta: snapshot?.providerMeta ?? null,
  };
}

// Снапшот публикуется двумя путями: попадает в итоговый список events (чтобы его увидели даже
// те, кто не подписался на поток) и сразу отправляется в onEvent - стриминговому потребителю
// важно узнать про лимит немедленно, а не в самом конце запроса.
function emitLimitSnapshotEvent(
  input: RuntimeRunInput,
  events: RuntimeEvent[],
  snapshot: RuntimeLimitSnapshot | null,
  logger?: OpenRouterApiLogger,
): void {
  // Событие может не построиться (например, заголовков не было): это не ошибка, а нормальный
  // случай, поэтому функция молча выходит.
  if (!snapshot) return;

  const event = buildRuntimeLimitEvent(snapshot);
  events.push(event);
  input.execution?.onEvent?.(event);
  logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      providerId: snapshot.providerId,
      profileId: snapshot.profileId ?? null,
      status: snapshot.status,
      precision: snapshot.precision,
      source: snapshot.source,
      primaryScope: snapshot.primaryScope ?? null,
      resetAt: snapshot.resetAt ?? null,
    },
    "Translated OpenAI-compatible rate-limit headers into runtime limit snapshot",
  );
}

// Единая точка отправки POST /chat/completions с повторами - используется и обычным, и
// потоковым режимом. Важно: повторы действуют только на этапе получения статуса. В потоковом
// режиме тело читается уже после выхода из этой функции, поэтому повтор безопасен: ни одного
// токена ответа к этому моменту ещё не получено.
async function postChatCompletionsWithRetry(
  input: RuntimeRunInput,
  url: string,
  stream: boolean,
  logger?: OpenRouterApiLogger,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    // withProxyDispatcher прозрачно подставляет HTTP(S)_PROXY, если он задан в окружении:
    // транспорт не должен знать, есть ли прокси в конкретном развёртывании.
    const response = await fetch(
      url,
      withProxyDispatcher(url, {
        method: "POST",
        headers: buildHeaders(input),
        body: JSON.stringify(buildRequestBody(input, stream)),
        ...(signal ? { signal } : {}),
      }),
    );

    // Решение о повторе принимается только по структуре ответа (статус + номер попытки), без
    // разбора тела: тело ещё не прочитано, а делать выводы по тексту ошибки запрещено правилами
    // проекта - текст предназначен для человека, а не для ветвления логики.
    const isRetryable = RETRYABLE_STATUS.has(response.status);
    const hasAttemptsLeft = attempt < MAX_RETRY_ATTEMPTS;
    if (!isRetryable || !hasAttemptsLeft) {
      return response;
    }

    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
    const backoffMs = retryAfterMs ?? getBackoffMs(attempt);
    // Тело неуспешного ответа нужно прочитать до повтора: в одних реализациях fetch это освобождает
    // соединение, в других текст просто теряется. Заодно он попадёт в лог в отредактированном виде.
    const rawText = await response.text();

    // Причина повтора логируется с превью ответа: без этого инциденты с лимитами невозможно
    // разобрать постфактум, а провайдеры не всегда дают различимый статус.
    logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        model: input.model ?? null,
        status: response.status,
        attempt,
        nextAttempt: attempt + 1,
        retryAfterMs: backoffMs,
        retryAfterHeader: retryAfterHeader ?? null,
        errorPreview: redactProviderTextForLogs(rawText).slice(0, 240),
      },
      `OpenRouter returned retryable status ${response.status}, retrying request`,
    );

    // Ожидание до следующей попытки: блокирует только этот запуск и не влияет на другие задачи,
    // которые координатор ведёт параллельно.
    await sleep(backoffMs);
  }

  // Цикл либо возвращает ответ, либо бросает classifyOpenRouterRuntimeError; сюда управление
  // попадает только при ошибке в его логике.
  throw new Error("Unreachable: retry loop exhausted");
}

// ---------------------------------------------------------------------------
// Безпотоковый запуск
// ---------------------------------------------------------------------------

// Нестриминговый запуск: ответ приходит целиком и разбирается как обычный JSON. Используется,
// когда вызывающий не передал onEvent и стриминг ему не нужен.
export async function runOpenRouterApi(
  input: RuntimeRunInput,
  logger?: OpenRouterApiLogger,
): Promise<RuntimeRunResult> {
  const baseUrl = resolveBaseUrl(input);
  const url = `${baseUrl}/chat/completions`;
  const signal = buildRunTimeoutSignal(input);

  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "api",
      url,
      model: input.model ?? null,
      runTimeoutMs: input.execution?.runTimeoutMs ?? null,
      options: stripSensitiveOptions(asRecord(input.options)),
    },
    "Starting OpenRouter API run",
  );

  try {
    const response = await postChatCompletionsWithRetry(input, url, false, logger, signal);

    const rawText = await response.text();
    // Порядок разбора важен: сначала снимаем метаданные лимитов из заголовков, и только потом
    // решаем, успешен ли ответ. Так информация о лимитах не теряется даже на ошибочном статусе.
    const limitSnapshot = buildOpenRouterLimitSnapshot(
      input,
      response.headers,
      response.status === 429 ? "blocked" : undefined,
    );
    if (!limitSnapshot && hasOpenAiRateLimitHints(response.headers)) {
      logger?.warn?.(
        {
          runtimeId: input.runtimeId,
          providerId: input.providerId ?? "openrouter",
          profileId: input.profileId ?? null,
          status: response.status,
        },
        "Dropped OpenAI-compatible rate-limit metadata because it could not be normalized",
      );
    }

    // Ошибка прогоняется через классификатор вместе с httpStatus и метаданными лимитов:
    // потребитель получит структурированную причину, а не просто "request failed".
    if (!response.ok) {
      return Promise.reject(
        classifyOpenRouterRuntimeError(
          new Error(safeProviderErrorMessage(rawText, "OpenRouter request failed")),
          response.status,
          buildLimitErrorMetadata(limitSnapshot, response.status),
        ),
      );
    }

    const payload = rawText.trim().length > 0 ? JSON.parse(rawText) : {};

    // Проверка ошибки верхнего уровня (ошибка провайдера при HTTP 200 до commit)
    const topError = payload.error;
    if (topError && typeof topError === "object") {
      const errMsg =
        typeof topError.message === "string"
          ? topError.message
          : "OpenRouter returned an error in non-streaming response";
      return Promise.reject(
        classifyOpenRouterRuntimeError(
          new Error(safeProviderErrorMessage(errMsg, "OpenRouter request failed")),
          undefined,
          buildLimitErrorMetadata(limitSnapshot),
        ),
      );
    }

    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;

    // Проверка ошибки per-choice (ошибка провайдера при HTTP 200 после commit)
    const choiceError = choice?.error;
    if (choiceError && typeof choiceError === "object") {
      const errMsg =
        typeof choiceError.message === "string"
          ? choiceError.message
          : "OpenRouter per-choice error in non-streaming response";
      logger?.warn?.(
        { runtimeId: input.runtimeId, choiceError },
        "OpenRouter per-choice error in non-streaming response",
      );
      return Promise.reject(
        classifyOpenRouterRuntimeError(
          new Error(safeProviderErrorMessage(errMsg, "OpenRouter per-choice error")),
          undefined,
          buildLimitErrorMetadata(limitSnapshot),
        ),
      );
    }

    const message = choice?.message;
    const outputText = typeof message?.content === "string" ? message.content : "";
    const toolCalls = parseToolCalls(message?.tool_calls);
    const events: RuntimeEvent[] = [];
    emitLimitSnapshotEvent(input, events, limitSnapshot, logger);

    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        hasOutput: outputText.length > 0,
        usage: payload.usage ?? null,
      },
      "OpenRouter API run completed",
    );

    return {
      outputText,
      sessionId: payload.id ?? null,
      usage: normalizeUsage(payload.usage),
      ...(events.length > 0 ? { events } : {}),
      toolCalls,
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      raw: payload,
    };
  } catch (error) {
    if (isAbortTimeoutError(error)) {
      throw new RuntimeExecutionError(
        `Run timeout: OpenRouter API request exceeded ${input.execution?.runTimeoutMs}ms limit`,
        error,
        "timeout",
      );
    }
    throw classifyOpenRouterRuntimeError(error);
  }
}

// ---------------------------------------------------------------------------
// Потоковый запуск (SSE)
// ---------------------------------------------------------------------------

async function runOpenRouterStreamingAttempt(
  input: RuntimeRunInput,
  logger?: OpenRouterApiLogger,
): Promise<RuntimeRunResult> {
  const baseUrl = resolveBaseUrl(input);
  const url = `${baseUrl}/chat/completions`;
  const signal = buildRunTimeoutSignal(input);

  const response = await postChatCompletionsWithRetry(input, url, true, logger, signal);
  const limitSnapshot = buildOpenRouterLimitSnapshot(
    input,
    response.headers,
    response.status === 429 ? "blocked" : undefined,
  );
  if (!limitSnapshot && hasOpenAiRateLimitHints(response.headers)) {
    logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        providerId: input.providerId ?? "openrouter",
        profileId: input.profileId ?? null,
        status: response.status,
      },
      "Dropped OpenAI-compatible rate-limit metadata because it could not be normalized",
    );
  }

  if (!response.ok) {
    const rawText = await response.text();
    throw classifyOpenRouterRuntimeError(
      new Error(safeProviderErrorMessage(rawText, "OpenRouter streaming request failed")),
      response.status,
      buildLimitErrorMetadata(limitSnapshot, response.status),
    );
  }

  if (!response.body) {
    throw classifyOpenRouterRuntimeError(
      new Error("OpenRouter streaming response has no body"),
      undefined,
      buildLimitErrorMetadata(limitSnapshot),
    );
  }

  let outputText = "";
  let sessionId: string | null = null;
  let usage: RuntimeUsage | null = null;
  let finishReason: string | null = null;
  const toolCallSlots = new Map<number, StreamingToolCallSlot>();
  const events: RuntimeEvent[] = [];
  emitLimitSnapshotEvent(input, events, limitSnapshot, logger);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstChunkReceived = false;

  // Start timeout — ловим зависший поток после установки соединения
  const startMs = input.execution?.startTimeoutMs;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let startTimedOut = false;

  if (typeof startMs === "number" && Number.isFinite(startMs) && startMs > 0) {
    startTimer = setTimeout(() => {
      startTimedOut = true;
      reader.cancel().catch(() => {});
    }, startMs);
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!firstChunkReceived) {
        firstChunkReceived = true;
        if (startTimer) {
          clearTimeout(startTimer);
          startTimer = null;
        }
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (!trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          if (!sessionId && parsed.id) {
            sessionId = parsed.id;
          }

          // Проверка события ошибки верхнего уровня в середине потока
          if (parsed.error && typeof parsed.error === "object") {
            const errMsg =
              typeof parsed.error.message === "string"
                ? parsed.error.message
                : "OpenRouter mid-stream error";
            finishReason = "error";
            toolCallSlots.clear();
            logger?.warn?.(
              { runtimeId: input.runtimeId, midStreamError: parsed.error },
              "OpenRouter mid-stream error detected in SSE event",
            );
            continue;
          }

          const delta = parsed.choices?.[0]?.delta;
          const choiceFinishReason = parsed.choices?.[0]?.finish_reason;
          if (typeof choiceFinishReason === "string") {
            finishReason = choiceFinishReason;
          }

          // Проверка per-choice ошибки в SSE
          const sseChoiceError = parsed.choices?.[0]?.error;
          if (sseChoiceError && typeof sseChoiceError === "object") {
            const errMsg =
              typeof sseChoiceError.message === "string"
                ? sseChoiceError.message
                : "OpenRouter per-choice stream error";
            finishReason = "error";
            toolCallSlots.clear();
            logger?.warn?.(
              { runtimeId: input.runtimeId, sseChoiceError },
              "OpenRouter per-choice error detected in SSE event",
            );
            continue;
          }

          // После пометки об ошибке контент больше не накапливаем
          if (finishReason === "error") {
            toolCallSlots.clear();
            continue;
          }

          if (delta?.content) {
            outputText += delta.content;
            const event: RuntimeEvent = {
              type: "stream:text",
              timestamp: new Date().toISOString(),
              message: delta.content,
            };
            events.push(event);
            input.execution?.onEvent?.(event);
          }

          collectStreamingToolCallDelta(toolCallSlots, delta?.tool_calls);

          if (parsed.usage) {
            usage = normalizeUsage(parsed.usage);
          }
        } catch {
          logger?.debug?.(
            { runtimeId: input.runtimeId, rawLine: redactProviderTextForLogs(trimmed) },
            "Failed to parse SSE chunk, skipping",
          );
        }
      }
    }
  } finally {
    if (startTimer) clearTimeout(startTimer);
    reader.releaseLock();
  }

  if (startTimedOut) {
    const err = new RuntimeExecutionError(
      `Start timeout: OpenRouter streaming produced no data within ${startMs}ms`,
      undefined,
      "timeout",
      buildLimitErrorMetadata(limitSnapshot),
    );
    (err as unknown as Record<string, unknown>).__timeoutRetriable__ = true;
    throw err;
  }

  const toolCalls = finalizeStreamingToolCalls(toolCallSlots);

  return {
    outputText,
    sessionId,
    usage,
    events,
    toolCalls,
    finishReason,
    raw: { streaming: true, eventCount: events.length },
  };
}

export async function runOpenRouterApiStreaming(
  input: RuntimeRunInput,
  logger?: OpenRouterApiLogger,
): Promise<RuntimeRunResult> {
  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "api",
      model: input.model ?? null,
      streaming: true,
      startTimeoutMs: input.execution?.startTimeoutMs ?? null,
      runTimeoutMs: input.execution?.runTimeoutMs ?? null,
    },
    "Starting OpenRouter API streaming run",
  );

  try {
    return await runOpenRouterStreamingAttempt(input, logger);
  } catch (error) {
    if (isRetriableTimeoutError(error)) {
      const retryDelayMs = resolveRetryDelay(input.execution ?? {});
      logger?.warn?.(
        { runtimeId: input.runtimeId, retryDelayMs },
        "OpenRouter streaming start timeout, retrying once after delay",
      );
      await sleepMs(retryDelayMs);
      return runOpenRouterStreamingAttempt(input, logger);
    }
    if (isAbortTimeoutError(error)) {
      throw new RuntimeExecutionError(
        `Run timeout: OpenRouter streaming request exceeded ${input.execution?.runTimeoutMs}ms limit`,
        error,
        "timeout",
      );
    }
    throw classifyOpenRouterRuntimeError(error);
  }
}

// ---------------------------------------------------------------------------
// Проверка соединения
// ---------------------------------------------------------------------------

export async function validateOpenRouterApiConnection(
  input: RuntimeConnectionValidationInput,
): Promise<RuntimeConnectionValidationResult> {
  const baseUrl = resolveBaseUrl(input);
  const url = `${baseUrl}/models`;

  try {
    const response = await fetch(
      url,
      withProxyDispatcher(url, {
        method: "GET",
        headers: buildHeaders(input),
      }),
    );
    if (!response.ok) {
      return {
        ok: false,
        message: `OpenRouter health check failed with status ${response.status}`,
      };
    }
    return {
      ok: true,
      message: "OpenRouter API connection validated",
    };
  } catch (error) {
    throw classifyOpenRouterRuntimeError(error);
  }
}

// ---------------------------------------------------------------------------
// Discovery моделей
// ---------------------------------------------------------------------------

export async function listOpenRouterApiModels(
  input: RuntimeConnectionValidationInput | RuntimeModelListInput,
  logger?: OpenRouterApiLogger,
): Promise<RuntimeModel[]> {
  const inputWithOptions = input as RuntimeConnectionValidationInput;
  const baseUrl = resolveBaseUrl(inputWithOptions);
  const url = `${baseUrl}/models`;

  try {
    const response = await fetch(
      url,
      withProxyDispatcher(url, {
        method: "GET",
        headers: buildHeaders(inputWithOptions),
      }),
    );
    if (!response.ok) {
      const rawText = await response.text();
      return Promise.reject(
        classifyOpenRouterRuntimeError(
          new Error(safeProviderErrorMessage(rawText, "OpenRouter model listing failed")),
          response.status,
        ),
      );
    }
    const payload = (await response.json()) as {
      data?: Array<{
        id: string;
        name?: string;
        context_length?: number;
        pricing?: { prompt?: string; completion?: string };
        reasoning?: unknown;
      }>;
    };
    const models = payload.data ?? [];
    return models.map((model) => {
      const metadata: Record<string, unknown> = {
        contextLength: model.context_length,
        pricing: model.pricing,
      };
      const reasoning = asRecord(model.reasoning);
      const supportedEffortLevels = normalizeModelEffortLevels(reasoning.supported_efforts);
      if (supportedEffortLevels) {
        metadata.supportsEffort = true;
        metadata.supportedEffortLevels = supportedEffortLevels;
      } else if (Array.isArray(reasoning.supported_efforts)) {
        metadata.supportsEffort = false;
      } else if (reasoning.supported_efforts === null) {
        metadata.supportsEffort = true;
        metadata.supportedEffortLevels = [...OPENROUTER_GATEWAY_MODEL_EFFORT_LEVELS];
        logger?.debug?.(
          {
            runtimeId: input.runtimeId,
            model: model.id,
            supportedEffortLevels: OPENROUTER_GATEWAY_MODEL_EFFORT_LEVELS,
          },
          "Expanded unrestricted reasoning effort metadata",
        );
      }
      const defaultEffort = normalizeModelEffort(reasoning.default_effort);
      if (defaultEffort) {
        metadata.supportsEffort = true;
        metadata.defaultEffort = defaultEffort;
      }

      return {
        id: model.id,
        label: model.name ?? model.id,
        supportsStreaming: true,
        metadata,
      };
    });
  } catch (error) {
    throw classifyOpenRouterRuntimeError(error);
  }
}
