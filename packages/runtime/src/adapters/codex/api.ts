/**
 * Транспорт Codex-адаптера поверх HTTP API, совместимого с OpenAI
 * (chat/completions).
 *
 * Зачем нужен отдельный транспорт: SDK и CLI требуют установленного пакета или
 * бинарника и работают только локально, а API-режим позволяет говорить с любым
 * OpenAI-совместимым шлюзом (router.ai, свой vLLM и т.п.) обычным fetch. Плата
 * за такую универсальность - весь протокол приходится реализовывать вручную:
 * сборку тела запроса, разбор SSE-потока, склейку tool_calls и учёт usage.
 *
 * Ключевые инварианты модуля:
 * - ошибки классифицируются структурно. classifyCodexRuntimeError получает
 *   HTTP-статус и метаданные лимитов отдельными аргументами, а текст сообщения
 *   используется только для логов и никогда не разбирается регулярками или
 *   includes для ветвления логики (см. Structured Error Classification Rule
 *   в AGENTS.md). Единственное исключение - isRetryableFetchError, и почему оно
 *   допустимо, объяснено в комментарии у самой функции.
 * - usageReporting этого транспорта честно объявлен как PARTIAL: провайдер
 *   вправе не прислать блок usage, и тогда RuntimeRunResult.usage остаётся
 *   равным null, а не подменяется нулями.
 * - все разборы внешнего JSON идут через asRecord/parseToolCalls, которые
 *   возвращают пустые значения вместо исключения: битый чанк - ожидаемая
 *   ситуация, а не повод уронить весь прогон (Nullable Cast Rule).
 */

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
import { redactProviderText, redactProviderTextForLogs } from "@aif/shared";
import { RuntimeExecutionError, type RuntimeExecutionErrorMetadata } from "../../errors.js";
import { buildRuntimeLimitEvent } from "../../limitEvents.js";
import { buildOpenAiCompatibleLimitSnapshot } from "../../openaiRateLimits.js";
import { withProxyDispatcher } from "../../proxyEnv.js";
// Ретраи и определение таймаутов живут в общем для всех адаптеров модуле: так
// поведение при сетевых сбоях не расходится между транспортами.
import { isRetriableTimeoutError, resolveRetryDelay, sleepMs } from "../../timeouts.js";
// Единая точка превращения сырых ошибок в структурные категории Codex-адаптера.
import { classifyCodexRuntimeError } from "./errors.js";

// Логгер описан структурно, а не через тип из shared: адаптер не должен зависеть
// от конкретной реализации логирования, ему достаточно трёх методов. Все они
// необязательные - вызовы идут через `logger?.warn?.(...)`, поэтому отсутствие
// логгера или отдельного метода не ломает выполнение.
export interface CodexAgentApiLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

// Два ретрая по умолчанию - компромисс: сетевые сбои у внешних шлюзов обычно
// кратковременны, но бесконечные повторы превратили бы зависший провайдер в
// вечно занятую задачу. Значение переопределяется опцией или переменной среды.
const DEFAULT_API_RETRY_COUNT = 2;

// Возвращает именно `Record<string, unknown>`, а не `T`: вызывающий код обязан
// сам проверять поля. Пустой объект вместо null здесь выбран сознательно - так
// безопасная навигация `asRecord(x).foo` не требует промежуточной проверки, а
// отсутствие поля проявится как undefined, который дальше отсекут readString и
// подобные хелперы. Это и есть суть Nullable Cast Rule: nullable не прячем.
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Массивы и числа намеренно не приводятся к строке: протокол присылает строки,
// и молчаливая конверсия чужого мусора в валидное значение скрыла бы ошибку.
// Пустая строка тоже считается отсутствием значения, чтобы не собирать заголовки
// вида `Authorization: Bearer `.
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Три разных входных типа объединены в один alias: резолверы адреса и ключа
// нужны и при прогоне, и при валидации подключения, и при перечислении моделей,
// а поля у этих структур совпадают. Так весь резолвинг живёт в одном месте.
type CodexApiInput = RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput;

// Ключи сравниваются в трёх регистрах и через подчёркивание: пользователи пишут
// опции по-разному, а утечка ключа в лог недопустима ни в одном из вариантов.
const SENSITIVE_OPTION_KEYS = new Set(["apiKey", "apikey", "api_key", "secret", "password"]);

// Опции профиля уходят в логи (см. `options` в runCodexAgentApi), поэтому перед
// записью из них вырезаются секреты. Возвращается undefined как есть, чтобы в
// логе не появился пустой объект там, где опций не было.
function stripSensitiveOptions(
  options: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!options) return options;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!SENSITIVE_OPTION_KEYS.has(key)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

// Провайдер может вернуть в теле ошибки что угодно, включая ключи и заголовки,
// поэтому текст не логируется как есть, а проходит через redactProviderText.
// Fallback нужен на случай пустого тела: сообщение всё равно должно быть.
function safeProviderErrorMessage(rawText: string, fallbackMessage: string): string {
  const trimmed = rawText.trim();
  return trimmed.length > 0 ? redactProviderText(trimmed) : fallbackMessage;
}

// Разрешение имени переменной окружения с ключом. Приоритет: явное поле входа ->
// option профиля -> OPENAI_API_KEY как дефолт для OpenAI-совместимых шлюзов.
// `in input` используется как проверка наличия поля в union-типе: TypeScript не
// позволит обратиться к input.apiKeyEnvVar, если поля нет в текущей ветке.
function resolveApiKeyEnvVar(input: CodexApiInput): string {
  const options = asRecord(input.options);
  const topLevelApiKeyEnvVar = "apiKeyEnvVar" in input ? readString(input.apiKeyEnvVar) : null;
  return topLevelApiKeyEnvVar ?? readString(options.apiKeyEnvVar) ?? "OPENAI_API_KEY";
}

// Базовый URL обязателен: без него API-транспорт бессмысленен, поэтому здесь
// единственное место, где резолвер бросает - и бросает уже классифицированную
// ошибку, а не голый Error. Хвостовые слеши срезаются, потому что пути ниже
// склеиваются через `${baseUrl}/chat/completions`: без нормализации получилось бы
// двойное `//` в URL.
function resolveBaseUrl(input: CodexApiInput): string {
  const options = asRecord(input.options);
  const baseUrl =
    ("baseUrl" in input ? readString(input.baseUrl) : null) ??
    readString(options.agentApiBaseUrl) ??
    readString(options.baseUrl) ??
    readString(process.env.OPENAI_BASE_URL);
  if (!baseUrl) {
    throw classifyCodexRuntimeError("Codex API transport requires baseUrl or OPENAI_BASE_URL");
  }
  return baseUrl.replace(/\/+$/, "");
}

// Ключ может отсутствовать легально (локальный шлюз без авторизации), поэтому
// возвращается `string | null`, а не исключение. Последний в цепочке - всегда
// OPENAI_API_KEY: он же служит fallback, если имя переменной не задано.
function resolveApiKey(input: CodexApiInput): string | null {
  const options = asRecord(input.options);
  const apiKeyEnvVar = resolveApiKeyEnvVar(input);
  return (
    ("apiKey" in input ? readString(input.apiKey) : null) ??
    readString(options.apiKey) ??
    readString(process.env[apiKeyEnvVar]) ??
    readString(process.env.OPENAI_API_KEY)
  );
}

// Пользовательские заголовки мержатся в два слоя: сначала из options профиля,
// затем из поля headers входа - вложенный объект входа перекрывает профиль.
// Не-строковые значения отбрасываются: Headers.set упал бы на объекте,
// а падать из-за элемента конфигурации незачем. Используется Headers, а не
// литерал объекта, чтобы получить регистронезависимый set и корректный merge.
function buildHeaders(input: CodexApiInput): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const apiKey = resolveApiKey(input);
  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }

  const rawHeaders = {
    ...asRecord(asRecord(input.options).headers),
    ...("headers" in input ? asRecord(input.headers) : {}),
  };
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  return headers;
}

// Число повторов читается из опций (number или строка) либо из окружения.
// Любое невалидное значение (NaN, отрицательное, мусор) откатывается к дефолту:
// битая конфигурация не должна отключать ретраи незаметно для пользователя.
// Math.floor отсекает дробные значения - счётчик итераций обязан быть целым.
function resolveApiRetryCount(input: RuntimeRunInput): number {
  const options = asRecord(input.options);
  const fromOptions = options.apiRetryCount;
  const fromEnv = process.env.CODEX_API_RETRY_COUNT;
  const raw =
    typeof fromOptions === "number"
      ? fromOptions
      : typeof fromOptions === "string"
        ? Number.parseInt(fromOptions, 10)
        : fromEnv
          ? Number.parseInt(fromEnv, 10)
          : DEFAULT_API_RETRY_COUNT;

  if (!Number.isFinite(raw) || raw < 0) {
    return DEFAULT_API_RETRY_COUNT;
  }
  return Math.floor(raw);
}

// Повторяются только 5xx: это серверные сбои, у которых есть шанс пройти со второй
// попытки. 4xx (кроме 429, обрабатываемого отдельно через лимиты) означают ошибку
// запроса или ключа - повторять её бессмысленно и дорого.
function isRetryableStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

/**
 * Контекст: классификация причины сетевой ошибки намеренно опирается на текст.
 *
 * Совпадение по строке здесь намеренное: нативный `fetch` Node бросает
 * `TypeError("fetch failed")` без структурированной причины и без HTTP status.
 * Сетевые ошибки (ECONNRESET, ECONNREFUSED) существуют только
 * в тексте сообщения. Альтернативы нет.
 *
 * Важное уточнение к правило Structured Error Classification: запрет на разбор
 * `error.message` относится к контрольной логике адаптера (решение, что делать с
 * уже полученным ответом провайдера). Здесь же платформа не оставляет выбора:
 * undici отдаёт один TypeError без полей. Поэтому строки ищутся только для
 * решения "повторить запрос или пробросить ошибку" и никогда - для выбора
 * категории RuntimeErrorCategory: категорию всё равно ставит
 * classifyCodexRuntimeError.
 */
function isRetryableFetchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return (
    lowered.includes("fetch failed") ||
    lowered.includes("network") ||
    lowered.includes("econnreset") ||
    lowered.includes("econnrefused") ||
    lowered.includes("timed out") ||
    lowered.includes("etimedout")
  );
}

// Линейный рост задержки (150, 300, 450 мс) выбран вместо экспоненты: при
// не более чем паре попыток экспоненциальный backoff ничего не даёт, зато
// усложняет предсказуемость тестов. Jitter отсутствует по той же причине.
function retryBackoffMs(attempt: number): number {
  return 150 * (attempt + 1);
}

// Promise-обёртка над setTimeout: цикл ретраев и внешний код должны уметь
// `await sleep(...)`. Таймер не отвязан через unref намеренно - здесь мы реально
// ждём его срабатывания, а не защищаемся от удержания event loop.
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetries(
  input: RuntimeRunInput,
  url: string,
  init: RequestInit,
  logger: CodexAgentApiLogger | undefined,
  requestType: "non-stream" | "stream",
): Promise<Response> {
  const maxRetries = resolveApiRetryCount(input);

  // `for (;;)` с ручным continue: число попыток проверяется внутри, потому что
  // лимит ретраев разный для сетевых ошибок и ретрабельных статусов, и обе
  // ветки должны возвращать/пробрасывать результат до выхода из цикла.
  for (let attempt = 0; ; attempt += 1) {
    try {
      // withProxyDispatcher подмешивает агент с учётом переменных окружения
      // прокси: без него fetch игнорирует HTTP_PROXY/HTTPS_PROXY.
      const response = await fetch(url, withProxyDispatcher(url, init));
      // Успешный с точки зрения HTTP ответ возвращается как есть, и уже
      // вызывающий решает, ошибка это или нет: ретраить 4xx здесь нельзя.
      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        const delayMs = retryBackoffMs(attempt);
        logger?.warn?.(
          {
            runtimeId: input.runtimeId,
            status: response.status,
            attempt: attempt + 1,
            maxRetries,
            delayMs,
            requestType,
          },
          "OpenAI API returned retryable status, retrying",
        );
        await sleep(delayMs);
        continue;
      }
      return response;
    } catch (error) {
      // Тело ответа с ретраебельным статусом уже прочитано? Нет: сюда попадает
      // только сбой на уровне транспорта, когда Response вообще не получен,
      // поэтому тело не нужно сливать перед повтором (утечки соединения нет).
      if (attempt < maxRetries && isRetryableFetchError(error)) {
        const delayMs = retryBackoffMs(attempt);
        logger?.warn?.(
          {
            runtimeId: input.runtimeId,
            error: error instanceof Error ? error.message : String(error),
            attempt: attempt + 1,
            maxRetries,
            delayMs,
            requestType,
          },
          "OpenAI API request failed with retryable transport error, retrying",
        );
        await sleep(delayMs);
        continue;
      }
      // Неретраебельный сбой или исчерпанные попытки: пробрасываем как есть,
      // обёртку в структурную ошибку сделает вызвавший код.
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Сообщения и тело запроса (формат OpenAI Chat Completions)
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: RuntimeToolCall[];
}

// Формат чата OpenAI требует роль у каждого сообщения, поэтому внутренние
// сообщения рантайма маппятся один-в-один. `content: null` допустим протоколом
// (сообщение ассистента, состоящее только из tool_calls), но tool_call_id и
// tool_calls добавляются только при наличии - пустые поля API может отвергнуть.
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
  let systemContent = input.systemPrompt ?? "";
  // systemPromptAppend склеивается через двойной перевод строки, а не заменяет
  // системный промпт: это добавка к базовой инструкции профиля, не подмена.
  if (input.execution?.systemPromptAppend) {
    systemContent = systemContent
      ? `${systemContent}\n\n${input.execution.systemPromptAppend}`
      : input.execution.systemPromptAppend;
  }
  // Пустой системный промпт не отправляется вовсе: часть шлюзов отвергает
  // сообщение с пустым content, а часть реагирует на него странно.
  if (systemContent) messages.push({ role: "system", content: systemContent });
  messages.push({ role: "user", content: input.prompt });
  return messages;
}

// Тело запроса собирается по мере наличия полей: у OpenAI-совместимых шлюзов
// разная степень строгости, и отправка `tools: []` или `tool_choice: undefined`
// легко превращается в 400. Поэтому опциональные поля добавляются условно.
function buildRequestBody(input: RuntimeRunInput, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: buildMessages(input),
    stream,
  };
  if (input.tools?.length) body.tools = input.tools;
  if (input.toolChoice) body.tool_choice = input.toolChoice;

  // Структурированный вывод запрашивается через response_format, а не текстовой
  // инструкцией в промпте: `strict: true` заставляет провайдера гарантировать
  // схему, а имя "response" должно совпадать с тем, что ожидает исполнитель.
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

  return body;
}

// Разбор tool_calls из не-стримингового ответа. На каждом шаге проверяется и
// объект, и его тип: форма ответа не гарантирована (провайдер может вложить
// null, число, строку). Битая запись не роняет весь разбор и не выбрасывается
// молча в остальных случаях - flatMap отсеивает только невалидные элементы.
function parseToolCalls(value: unknown): RuntimeToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((call): RuntimeToolCall[] => {
    if (!call || typeof call !== "object") return [];
    const record = call as Record<string, unknown>;
    const fn = record.function;
    // Без id и имени вызов бесполезен: runtime.toolCalls несёт готовые к
    // исполнению вызовы, а не черновики.
    if (!fn || typeof fn !== "object" || typeof record.id !== "string") return [];
    const functionRecord = fn as Record<string, unknown>;
    if (typeof functionRecord.name !== "string") return [];
    return [
      {
        id: record.id,
        type: "function",
        function: {
          name: functionRecord.name,
          // arguments - это всегда строка JSON внутри строки. Если провайдер
          // прислал что-то другое, безопаснее отдать пустой объект, чем текст,
          // который сломает JSON.parse у исполнителя инструмента.
          arguments: typeof functionRecord.arguments === "string" ? functionRecord.arguments : "{}",
        },
      },
    ];
  });
}

// Слот собираемого вызова инструмента в стриме. OpenAI шлёт вызов частями,
// ключом служит index из протокола, а не id: id может прийти только в одном из
// чанков, поэтому слот сначала создаётся пустым и заполняется по мере данных.
type StreamingToolCallSlot = { id: string; name: string; arguments: string };
// Дельта чанка накапливается в слоты: id и name перезаписываются (они приходят
// целиком), а arguments склеивается через `+=` - именно так протокол передаёт
// длинный JSON аргументов по кускам. Слоты вне Map не теряются при отсутствии
// index: такой чанк просто игнорируется, потому что склеить его не с чем.
function collectStreamingToolCallDelta(
  slots: Map<number, StreamingToolCallSlot>,
  raw: unknown,
): void {
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.index !== "number") continue;
    const slot = slots.get(record.index) ?? { id: "", name: "", arguments: "" };
    if (typeof record.id === "string") slot.id = record.id;
    if (record.function && typeof record.function === "object") {
      const fn = record.function as Record<string, unknown>;
      if (typeof fn.name === "string") slot.name = fn.name;
      if (typeof fn.arguments === "string") slot.arguments += fn.arguments;
    }
    slots.set(record.index, slot);
  }
}
// Слоты сортируются по index: Map хранит порядок вставки, а не тот, в котором
// провайдер прислал index'ы, а параллельные вызовы должны прийти в объявленном
// порядке. Слот без id или name отбрасывается: недособранный вызов исполнять
// нельзя, и лучше потерять его, чем передать исполнителю фиктивное имя.
function finalizeStreamingToolCalls(slots: Map<number, StreamingToolCallSlot>): RuntimeToolCall[] {
  return [...slots.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, slot]): RuntimeToolCall[] =>
      slot.id && slot.name
        ? [
            {
              id: slot.id,
              type: "function",
              function: { name: slot.name, arguments: slot.arguments || "{}" },
            },
          ]
        : [],
    );
}

// Приведение usage к RuntimeUsage. Возвращается `RuntimeUsage | null`, и null тут
// не декоративный: провайдер вправе не прислать блок usage вообще, и тогда
// вызывающий код обязан увидеть честный null, а не нулевые токены - иначе
// агрегированная статистика по задачам начнёт врать (Nullable Cast Rule).
// Читаются оба набора имён: snake_case из протокола OpenAI и camelCase,
// который используют некоторые шлюзы.
function normalizeUsage(usage: unknown): RuntimeUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const parsed = usage as Record<string, unknown>;
  const inputTokens = (parsed.prompt_tokens as number) ?? (parsed.inputTokens as number) ?? 0;
  const outputTokens = (parsed.completion_tokens as number) ?? (parsed.outputTokens as number) ?? 0;
  const totalTokens =
    (parsed.total_tokens as number) ?? (parsed.totalTokens as number) ?? inputTokens + outputTokens;
  // Стоимость необязательна и остаётся undefined, если провайдер её не прислал:
  // нулём обозначать "бесплатно" было бы ложью.
  const costUsd =
    typeof parsed.cost === "number"
      ? parsed.cost
      : typeof parsed.costUsd === "number"
        ? parsed.costUsd
        : undefined;
  return { inputTokens, outputTokens, totalTokens, costUsd };
}

// ---------------------------------------------------------------------------
// Хелперы сигналов таймаута
// ---------------------------------------------------------------------------

// Один сигнал для двух независимых ограничений: собственного таймаута прогона и
// внешнего abortController (отмена из UI/координатора). AbortSignal.any склеивает
// их так, что срабатывание любого прерывает запрос, а по ошибке потом можно
// отличить таймаут от внешней отмены. Если ограничений нет, сигнал не создаётся
// вовсе - fetch с undefined ведёт себя как обычно, лишний объект не нужен.
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
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

// AbortSignal.timeout даёт именно DOMException с name=TimeoutError, поэтому
// проверяется класс и имя, а не текст сообщения. AbortError (внешняя отмена)
// сюда не попадает по тому же признаку - его обрабатывает отдельная ветка.
function isAbortTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

// Проверка нужна для диагностики: если заголовки лимитов есть, а нормализовать
// их не удалось, это сигнал о несовместимом шлюзе, и в лог уходит warn. Сам
// список заголовков фиксирован протоколом OpenAI - смотреть все заголовки
// подряд было бы дороже и шумнее.
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

// Обёртка над общим билдером снапшота лимитов: все адаптеры с OpenAI-совместимыми
// заголовками ходят через один код, чтобы UI видел одинаковые поля.
// statusOverride="blocked" ставится при HTTP 429 - важен сам факт блокировки,
// а не то, какие именно числа пришли в заголовках.
function buildCodexLimitSnapshot(
  input: RuntimeRunInput,
  headers: Headers,
  statusOverride?: RuntimeLimitStatus,
): RuntimeLimitSnapshot | null {
  return buildOpenAiCompatibleLimitSnapshot(headers, {
    providerId: input.providerId ?? "openai",
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    statusOverride,
  });
}

// Метаданные ошибки собираются в одном месте и полностью из уже нормализованного
// снапшота: никакого повторного разбора заголовков на пути обработки ошибки.
// retryAfterMs выводится из секунд, потому что координатору удобнее работать
// с миллисекундами, а протокол отдаёт секунды. Отсутствующие значения - null,
// а не 0: "неизвестно" и "ноль секунд" - разные вещи.
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

// Снапшот лимитов доставляется двумя путями одновременно: копится в массив
// events (чтобы вернуться в RuntimeRunResult) и сразу отдаётся в
// execution.onEvent - живо подписчики (UI, WebSocket) узнают о лимитах раньше,
// чем прогон завершится. Отсутствие снапшота - нормальная ситуация, поэтому
// ранний return без событий.
function emitLimitSnapshotEvent(
  input: RuntimeRunInput,
  events: RuntimeEvent[],
  snapshot: RuntimeLimitSnapshot | null,
  logger?: CodexAgentApiLogger,
): void {
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

// ---------------------------------------------------------------------------
// Безпотоковый запуск (OpenAI Chat Completions)
// ---------------------------------------------------------------------------

export async function runCodexAgentApi(
  input: RuntimeRunInput,
  logger?: CodexAgentApiLogger,
): Promise<RuntimeRunResult> {
  const baseUrl = resolveBaseUrl(input);
  const url = `${baseUrl}/chat/completions`;

  // Логируется старт до сети: если fetch завenv, по логу видно, с каким URL и
  // моделью шёл запрос. stripSensitiveOptions гарантирует, что ключ не попадёт
  // в лог вместе с остальными опциями.
  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "api",
      url,
      model: input.model ?? null,
      runTimeoutMs: input.execution?.runTimeoutMs ?? null,
      options: stripSensitiveOptions(asRecord(input.options)),
    },
    "Starting OpenAI API run",
  );

  try {
    const signal = buildRunTimeoutSignal(input);
    const response = await fetchWithRetries(
      input,
      url,
      {
        method: "POST",
        headers: buildHeaders(input),
        body: JSON.stringify(buildRequestBody(input, false)),
        ...(signal ? { signal } : {}),
      },
      logger,
      "non-stream",
    );

    const rawText = await response.text();
    // Снапшот строится до проверки response.ok: заголовки лимитов полезны даже
    // на ошибочном ответе, и именно они объясняют причину 429.
    const limitSnapshot = buildCodexLimitSnapshot(
      input,
      response.headers,
      response.status === 429 ? "blocked" : undefined,
    );
    // Если заголовки выглядели как rate limit, но снапшот не получился,
    // пишем warn: иначе пользователь будет видеть пустую панель лимитов и не
    // поймёт, что адаптер не смог распознать конкретный формат шлюза.
    if (!limitSnapshot && hasOpenAiRateLimitHints(response.headers)) {
      logger?.warn?.(
        {
          runtimeId: input.runtimeId,
          providerId: input.providerId ?? "openai",
          profileId: input.profileId ?? null,
          status: response.status,
        },
        "Dropped OpenAI-compatible rate-limit metadata because it could not be normalized",
      );
    }

    if (!response.ok) {
      // Ошибка уходит одной строкой с тремя частями структурного контекста:
      // статус для различения 4xx/5xx и метаданные лимитов для расчёта паузы.
      return Promise.reject(
        classifyCodexRuntimeError(
          new Error(safeProviderErrorMessage(rawText, "Codex API request failed")),
          response.status,
          buildLimitErrorMetadata(limitSnapshot, response.status),
        ),
      );
    }

    // Парсим тело вручную, а не через response.json(): нужно сначала проверить
    // пустоту. Чанк с пустым телом - не ошибка: у части шлюзов это нормальный
    // ответ, который ниже превратится в пустой outputText.
    const payload = rawText.trim().length > 0 ? JSON.parse(rawText) : {};
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    const message = choice?.message;
    // Содержимое может быть null (ответ только из tool_calls) - тогда пустая
    // строка, чтобы тип outputText всегда оставался string.
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
      "OpenAI API run completed",
    );

    // events попадает в результат только при наличии элементов: пустой массив
    // вынуждал бы потребителей проверять длину, а отсутствие поля читается как
    // "событий не было". sessionId и finishReason остаются null - они не всегда
    // есть в ответе, и это осмысленное значение, а не ошибка.
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
    // Таймаут проверяется первым и переводится в отдельную категорию "timeout":
    // для координатора это решаемое состояние (можно повторить), в отличие от
    // прочих сбоев. Остальные ошибки отдаются общему классификатору.
    if (isAbortTimeoutError(error)) {
      throw new RuntimeExecutionError(
        `Run timeout: Codex API request exceeded ${input.execution?.runTimeoutMs}ms limit`,
        error,
        "timeout",
      );
    }
    throw classifyCodexRuntimeError(error);
  }
}

// ---------------------------------------------------------------------------
// Потоковый запуск (SSE, OpenAI Chat Completions)
// ---------------------------------------------------------------------------

// Одна попытка стримингового прогона. Отделена от публичной обёртки ниже,
// потому что при стартовом таймауте попытка повторяется целиком - обёртка не
// должна знать деталей чтения потока, а попытка - логики ретраев.
async function runCodexStreamingAttempt(
  input: RuntimeRunInput,
  logger?: CodexAgentApiLogger,
): Promise<RuntimeRunResult> {
  const baseUrl = resolveBaseUrl(input);
  const url = `${baseUrl}/chat/completions`;
  // Таймаут-сигнал создаётся один раз и живёт весь запрос, включая чтение тела:
  // он же прерывает зависший поток, если провайдер замолчал на середине.
  const signal = buildRunTimeoutSignal(input);

  const response = await fetchWithRetries(
    input,
    url,
    {
      method: "POST",
      headers: buildHeaders(input),
      body: JSON.stringify(buildRequestBody(input, true)),
      ...(signal ? { signal } : {}),
    },
    logger,
    "stream",
  );

  const limitSnapshot = buildCodexLimitSnapshot(
    input,
    response.headers,
    response.status === 429 ? "blocked" : undefined,
  );
  if (!limitSnapshot && hasOpenAiRateLimitHints(response.headers)) {
    logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        providerId: input.providerId ?? "openai",
        profileId: input.profileId ?? null,
        status: response.status,
      },
      "Dropped OpenAI-compatible rate-limit metadata because it could not be normalized",
    );
  }

  if (!response.ok) {
    // На ошибке тело дописывается вручную: в стриминговом режиме нам важно
    // достать текст ошибки провайдера, а он не всегда кладёт его в заголовки.
    const rawText = await response.text();
    throw classifyCodexRuntimeError(
      new Error(safeProviderErrorMessage(rawText, "Codex API streaming request failed")),
      response.status,
      buildLimitErrorMetadata(limitSnapshot, response.status),
    );
  }

  // Отсутствие body - отдельная ошибка без HTTP-статуса: запрос прошёл, а
  // читать нечего. Метаданные лимитов всё равно передаются дальше, чтобы
  // координатор мог учесть уже полученные заголовки.
  if (!response.body) {
    throw classifyCodexRuntimeError(
      new Error("OpenAI API streaming response has no body"),
      undefined,
      buildLimitErrorMetadata(limitSnapshot),
    );
  }

  let outputText = "";
  let sessionId: string | null = null;
  // usage начинается с null и обновляется по мере чанков: рантайм честно
  // сообщает "данных ещё нет", а не нули. Это прямо связано с обещанием
  // usageReporting=PARTIAL в описании адаптера.
  let usage: RuntimeUsage | null = null;
  let finishReason: string | null = null;
  const toolCallSlots = new Map<number, StreamingToolCallSlot>();
  const events: RuntimeEvent[] = [];
  emitLimitSnapshotEvent(input, events, limitSnapshot, logger);

  // Ручное чтение потока вместо for await по reader: нужен контроль над
  // декодированием и буфером незавершённой строки между чанками (см. ниже).
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstChunkReceived = false;

  // Start timeout — ловим зависший поток после установки соединения
  // Отдельный таймаут именно на первый чанк: соединение может установиться
  // успешно, но провайдер так и не начнёт генерацию. runTimeoutMs здесь не
  // поможет - он про весь прогон целиком, который может быть долгим легально.
  const startMs = input.execution?.startTimeoutMs;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let startTimedOut = false;

  // При срабатывании таймер не бросает, а отменяет reader: бросить из setTimeout
  // нельзя (это отдельный тик event loop). Флаг startTimedOut превратится
  // в ошибку уже после выхода из цикла, что позволяет отлично обработать finally.
  if (typeof startMs === "number" && Number.isFinite(startMs) && startMs > 0) {
    startTimer = setTimeout(() => {
      startTimedOut = true;
      // cancel() возвращает промис; ловить его отказ незачем - поток уже мёртв.
      reader.cancel().catch(() => {});
    }, startMs);
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // Таймер старта снимается на первом же чанке: дальше прогресс контролирует
      // общий runTimeoutMs, а затянувшийся стрим легален.
      if (!firstChunkReceived) {
        firstChunkReceived = true;
        if (startTimer) {
          clearTimeout(startTimer);
          startTimer = null;
        }
      }

      // `stream: true` обязателен: многобайтовые UTF-8 символы могут разорваться
      // между чанками, и без этого декодер испортил бы кириллицу в ответе.
      buffer += decoder.decode(value, { stream: true });
      // Последний элемент после split может быть неполной строкой - отправляем
      // его обратно в буфер до следующего чанка. Без этого JSON.parse ловил бы
      // обрезанные куски SSE на каждом сетевом пакете.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        // Пустые строки - разделители событий; строки, начинающиеся с ":",
        // по спецификации SSE являются комментариями (keep-alive).
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (!trimmed.startsWith("data: ")) continue;

        // Длина "data: " равна шести символам - отрезаем ровно её.
        const data = trimmed.slice(6);
        // [DONE] - маркер конца потока у OpenAI, а не JSON.
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          // id берём только из первого чанка: дальше он повторяется, и лишние
          // присваивания не нужны. sessionId остаётся null, если провайдер его
          // вообще не прислал - это валидное состояние.
          if (!sessionId && parsed.id) {
            sessionId = parsed.id;
          }

          const delta = parsed.choices?.[0]?.delta;
          const choiceFinishReason = parsed.choices?.[0]?.finish_reason;
          // finish_reason приходит один раз, в последнем содержательном чанке;
          // пустая строка или null не должны перезатирать уже полученное значение.
          if (typeof choiceFinishReason === "string") finishReason = choiceFinishReason;
          if (delta?.content) {
            outputText += delta.content;
            // Событие текста отправляется и в массив, и сразу подписчику:
            // первый нужен для истории прогона, второй - для живого UI.
            const event: RuntimeEvent = {
              type: "stream:text",
              timestamp: new Date().toISOString(),
              message: delta.content,
            };
            events.push(event);
            input.execution?.onEvent?.(event);
          }

          // tool_calls в стриме приходят частями - собираются в слоты (см. выше).
          collectStreamingToolCallDelta(toolCallSlots, delta?.tool_calls);

          // В OpenAI-совместимых API usage появляется либо в отдельном финальном
          // чанке, либо с флагом stream_options.include_usage. Каждое новое
          // непустое значение заменяет предыдущее (последнее - самое полное).
          if (parsed.usage) {
            usage = normalizeUsage(parsed.usage);
          }
        } catch {
          // Битая строка не должна ронять весь прогон: стрим уже дал
          // пользователю часть ответа. Текст строки логируется только в
          // редактированном виде и обрезанным - в чанке может быть что угодно.
          logger?.debug?.(
            { runtimeId: input.runtimeId, rawLine: redactProviderTextForLogs(trimmed) },
            "Failed to parse SSE chunk, skipping",
          );
        }
      }
    }
  } finally {
    // Таймер обязательно снимается в finally: ветка с успешным чтением его уже
    // очистила, а вот ветка с ошибкой или отменой - нет. lock освобождается
    // там же: reader больше не нужен ни в одном сценарии.
    if (startTimer) clearTimeout(startTimer);
    reader.releaseLock();
  }

  if (startTimedOut) {
    // Ошибка строится после цикла, а не в таймере: сообщение содержит исходный
    // лимит, метаданные лимитов и категорию "timeout". Флаг __timeoutRetriable__
    // выставляется вручную, потому что таймаут старта - единственная timeout-
    // ошибка, которую адаптер разрешает повторить (isRetriableTimeoutError).
    const err = new RuntimeExecutionError(
      `Start timeout: Codex API streaming produced no data within ${startMs}ms`,
      undefined,
      "timeout",
      buildLimitErrorMetadata(limitSnapshot),
    );
    (err as unknown as Record<string, unknown>).__timeoutRetriable__ = true;
    throw err;
  }

  logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      outputLength: outputText.length,
      eventCount: events.length,
    },
    "OpenAI API streaming run completed",
  );

  const toolCalls = finalizeStreamingToolCalls(toolCallSlots);
  // raw здесь - синтетическая сводка, а не исходный ответ: в стриме единого
  // JSON-тела нет, а потребителям полезно знать число событий и сам факт стрима.
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

// Публичная обёртка стриминга. Здесь живёт только политика повторов: стартовый
// таймаут повторяется один раз с задержкой из профиля, а прогонный таймаут и всё
// остальное уходит наверх. Повтор делается только для стартового таймаута:
// поток, успевший отдать часть текста, повторять нельзя - пользователь уже видел
// ответ, и второй прогон породил бы дубликат.
export async function runCodexAgentApiStreaming(
  input: RuntimeRunInput,
  logger?: CodexAgentApiLogger,
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
    "Starting OpenAI API streaming run",
  );

  try {
    return await runCodexStreamingAttempt(input, logger);
  } catch (error) {
    // Структурная проверка (isRetriableTimeoutError) вместо разбора сообщения:
    // флаг __timeoutRetriable__ - единственный признак, что повторы разрешены.
    if (isRetriableTimeoutError(error)) {
      const retryDelayMs = resolveRetryDelay(input.execution ?? {});
      logger?.warn?.(
        { runtimeId: input.runtimeId, retryDelayMs },
        "Codex API streaming start timeout, retrying once after delay",
      );
      await sleepMs(retryDelayMs);
      // Вторая (и последняя) попытка - без try: её ошибка уходит напрямую
      // наверх, рекурсия и счётчик повторов здесь не нужны.
      return runCodexStreamingAttempt(input, logger);
    }
    // Отличается от стартового таймаута: прогон уже шёл дольше допустимого,
    // повторять его бессмысленно и дорого.
    if (isAbortTimeoutError(error)) {
      throw new RuntimeExecutionError(
        `Run timeout: Codex API streaming request exceeded ${input.execution?.runTimeoutMs}ms limit`,
        error,
        "timeout",
      );
    }
    throw classifyCodexRuntimeError(error);
  }
}

// ---------------------------------------------------------------------------
// Валидация соединения
// ---------------------------------------------------------------------------

// Проверка подключения бьёт в GET /models - самый дешёвый способ убедиться,
// что baseUrl достижим и ключ принят. Ретраев нет намеренно: это интерактивное
// действие в UI, где важен быстрый ответ, а не устойчивость к сетевым сбоям.
// Любая ошибка транспорта превращается в структурную через классификатор.
export async function validateCodexAgentApiConnection(
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
        message: `OpenAI API health check failed with status ${response.status}`,
      };
    }
    return {
      ok: true,
      message: "OpenAI API connection validated",
    };
  } catch (error) {
    throw classifyCodexRuntimeError(error);
  }
}

// ---------------------------------------------------------------------------
// Discovery моделей
// ---------------------------------------------------------------------------

export async function listCodexAgentApiModels(
  input: RuntimeConnectionValidationInput | RuntimeModelListInput,
): Promise<RuntimeModel[]> {
  // Сужение типа к одному варианту union: наборы полей у валидации и
  // перечисления моделей совместимы, а приводить каждый вызов отдельно - шум.
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
        classifyCodexRuntimeError(
          new Error(safeProviderErrorMessage(rawText, "Codex API model listing failed")),
          response.status,
        ),
      );
    }
    const payload = (await response.json()) as {
      data?: Array<{
        id: string;
        name?: string;
        owned_by?: string;
      }>;
    };
    // `?? []` вместо прямого обращения: ответ без data - валидный, просто пустой
    // список моделей. label падает на id, если человекочитаемого имени нет.
    const models = payload.data ?? [];
    return models.map((model) => ({
      id: model.id,
      label: model.name ?? model.id,
      // Протокол chat/completions всегда поддерживает stream, поэтому true
      // без всяких проверок - это свойство самого транспорта, не провайдера.
      supportsStreaming: true,
      metadata: { owned_by: model.owned_by },
    }));
  } catch (error) {
    // Сюда попадают и ошибки fetch, и падение response.json() на не-JSON теле:
    // классификатор сам разберёт, что это за сбой.
    throw classifyCodexRuntimeError(error);
  }
}
