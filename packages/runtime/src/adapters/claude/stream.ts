/**
 * Нормализация потока Claude Agent SDK в события рантайма.
 *
 * Функция `query()` SDK возвращает async iterable: сообщения приходят по одному, а их
 * «тип» - это значение поля, а не класс. Модуль прогоняет поток через `for await...of`
 * (асинхронный аналог for..of: каждая итерация дожидается следующего сообщения),
 * превращая каждое сообщение в RuntimeEvent и накапливая выходной текст, id сессии и
 * расход токенов.
 *
 * Два правила определяют устройство модуля:
 * - тип сообщения различается проверками typeof/=== по полю `type` - это рукописное
 *   размеченное объединение над недоверенными данными; незнакомые типы молча
 *   игнорируются, и SDK может добавлять новые сообщения, не ломая нас;
 * - ошибки выполнения классифицируются через classifyClaudeResultSubtype: наружу идёт
 *   структурная пара `category`/`adapterCode`, а не текст, и потребители ветвятся по
 *   ней, а не по подстроке сообщения (Structured Error Classification Rule).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
// Импорты разделены по слоям: общие утилиты рантайма (limitEvents, timeouts, toolEvents)
// и локальные модули адаптера (errors, limit, questions, zaiQuota). Зависимость
// направлена внутрь, к общим абстракциям: адаптер знает про общий слой, а не наоборот.
import { RuntimeLimitStatus } from "../../types.js";
import type {
  RuntimeEvent,
  RuntimeLimitSnapshot,
  RuntimeRunInput,
  RuntimeUsage,
} from "../../types.js";
import { buildRuntimeLimitEvent } from "../../limitEvents.js";
import { withStreamTimeouts } from "../../timeouts.js";
import { classifyClaudeResultSubtype } from "./errors.js";
import type { ClaudeOptionsLogger, ClaudeRuntimeExecutionOptions } from "./options.js";
import { buildClaudeQueryOptions } from "./options.js";
import { buildToolUseEvents } from "../../toolEvents.js";
import { normalizeClaudeLimitSnapshot } from "./limit.js";
import { parseClaudeAskUserQuestion } from "./questions.js";
import { resolveClaudeProviderAuth } from "./providerIdentity.js";
import { fetchZaiClaudeQuotaSnapshot } from "./zaiQuota.js";

// ---------------------------------------------------------------------------------
// Типы потока и коды ошибок запуска.
// ---------------------------------------------------------------------------------

// Код ошибки объявлен константой с литеральным типом: и создание ошибки, и её проверка
// используют одно и то же значение, поэтому опечатка в строке не может развести две
// половины механизма.
const QUERY_START_TIMEOUT_CODE = "query_start_timeout";

// Расширение Error полем code - структурированный сигнал: вызывающий код реагирует на
// него, а не на текст (в терминах проектных правил - ветвление по структурированным
// полям, message только для логов).
interface QueryStartTimeoutError extends Error {
  code: typeof QUERY_START_TIMEOUT_CODE;
}

// Форма сообщения SDK - рукописное описание чужого протокола. `type` - обычная строка,
// а не enum: поток принадлежит провайдеру и может расширяться с его стороны. Поля
// помечены `?` там, где их нет у большинства сообщений, а индексная сигнатура держит
// тип открытым для любых дополнительных ключей.
interface ClaudeStreamMessage {
  // Дискриминатор: по нему определяется, что делать с сообщением. Тип - строка, потому
  // что перечень не закрыт и задаётся провайдером.
  type: string;
  // Уточнение внутри типа: init у system, success/error у result.
  subtype?: string;
  // id сессии: приходит в служебных сообщениях и нужен для resume и форка.
  session_id?: string;
  // Финальный текст ответа - только у сообщения типа result.
  result?: string;
  // Сырые данные о лимитах: структура полностью на совести провайдера, поэтому
  // unknown, а не описанный интерфейс - нормализует их отдельный модуль limit.ts.
  rate_limit_info?: unknown;
  // Расход токенов: имена ключей различаются по транспортам, отсюда свободный
  // Record<string, number> и ручная нормализация в normalizeUsage ниже.
  usage?: Record<string, number>;
  // Стоимость запроса в долларах: отдельное поле, а не внутри usage.
  total_cost_usd?: number;
  // Инкрементальный стриминг: вложенные event/delta приходят только у stream_event.
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  // Короткая человекочитаемая подпись в tool_use_summary.
  summary?: string;
  // Индексная сигнатура: сообщение может нести и другие поля, и перечислять их все
  // незачем - иначе каждая версия SDK ломала бы типизацию.
  [key: string]: unknown;
}

// Типизация глобального слота для тестового дублёра: глобальный объект не
// засоряется специальным полем, а описывается только один опциональный ключ.
interface RuntimeGlobalWithQueryMock {
  __AIF_CLAUDE_QUERY_MOCK__?: typeof query;
}

// Накопленный результат одной попытки - то, что затем упаковывается в RuntimeRunResult.
// usage нулевой: поток может не прислать ни одной цифры, и выдумывать нули значило бы
// врать в учёте расходов.
export interface ClaudeQueryAttemptResult {
  // Текст ответа: либо накопленный из стрима, либо финальный из result (что пришло).
  outputText: string;
  // id сессии для возобновления; null - SDK его не прислал (бывает на ранних стадиях).
  sessionId: string | null;
  // Полный список событий прогона: из него строятся активность, история и логи.
  events: RuntimeEvent[];
  // Нормализованный расход или null, если провайдер не отдал ни одной цифры.
  usage: RuntimeUsage | null;
}

// Приведение к числу с дефолтом 0: используется только там, где отсутствие значения
// равнозначно «нулевому количеству» (внутри normalizeUsage).
function toNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

// Имена полей расхода различаются по транспортам и по совместимым прокси: Claude
// присылает snake_case, часть посредников переименовывает в camelCase, а
// OpenAI-образные эндпоинты возвращают prompt/completion. Цепочка `??` - это адаптер к
// трём диалектам сразу, а не перестраховка от одного.
function normalizeUsage(message: ClaudeStreamMessage): RuntimeUsage | null {
  // Дефолт {} позволяет не проверять usage на null в каждом чтении: отсутствующие поля
  // дадут undefined и превратятся в 0 через toNumber - ровно там, где это уместно.
  const usage = message.usage ?? {};
  const inputTokens = toNumber(
    usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens,
  );
  const outputTokens = toNumber(
    usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens,
  );
  // Отсутствующий total считается как сумма частей: лучше вычисленное значение, чем
  // дырка в учёте. Нечисловые значения (например, строка от посредника) дают 0 и затем
  // суммируются с частями - вклад такой метрики всё равно не вводит в заблуждение.
  const totalTokens = toNumber(
    usage.total_tokens ?? usage.totalTokens ?? inputTokens + outputTokens,
  );
  // Стоимость читается отдельным полем, а не из usage: провайдер кладет её на верхнем
  // уровне сообщения, и от диалекта транспорта это имя не зависит.
  const costUsd = toNumber(message.total_cost_usd);

  // Нулевой расход - это отсутствие данных для нас, а не нулевой факт: возвращаем null,
  // чтобы потребитель не рисовал «0 токенов» на сообщении, где учёта вообще не было.
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0 && costUsd === 0) {
    return null;
  }

  return {
    // Возвращается форма RuntimeUsage, а не диалект провайдера: дальше по системе
    // расход живёт в едином виде, независимо от транспорта.
    inputTokens,
    outputTokens,
    totalTokens,
    // Нулевая стоимость записывается как отсутствие (undefined): «0 USD» и «неизвестно» -
    // разные утверждения для учёта.
    costUsd: costUsd > 0 ? costUsd : undefined,
  };
}

// Преобразование снимка лимитов в метаданные ошибки: потребитель исключения получает
// resetAt/retryAfter и полный снимок как есть, а не разбирает текст сообщения на
// регекспах. retryAfterMs считается здесь, чтобы потребителю не нужно было помнить о
// переводе секунд в миллисекунды.
function buildClaudeLimitErrorMetadata(snapshot: RuntimeLimitSnapshot | null) {
  const retryAfterSeconds = snapshot?.retryAfterSeconds ?? null;
  return {
    resetAt: snapshot?.resetAt ?? null,
    retryAfterSeconds,
    retryAfterMs: retryAfterSeconds != null ? retryAfterSeconds * 1000 : null,
    limitSnapshot: snapshot,
    providerMeta: snapshot?.providerMeta ?? null,
  };
}

// Отображение сообщений, у которых есть общий смысл для рантайма. Тип возврата -
// RuntimeEvent | null: «нечего сообщить» - это норма, а не ошибка, поэтому простой null,
// а не исключения или Result-обёртка.
function toRuntimeEvent(message: ClaudeStreamMessage): RuntimeEvent | null {
  if (message.type === "result") {
    // Тег события собирается шаблоном result:<subtype>: потребителю достаточно сравнить
    // префикс/точное значение, чтобы отличить успех от любого вида отказа, не разбирая
    // текст сообщения. level выбирается здесь же: успех - info, остальное - error.
    return {
      type: `result:${message.subtype ?? "unknown"}`,
      timestamp: new Date().toISOString(),
      level: message.subtype === "success" ? "info" : "error",
      message:
        message.subtype === "success"
          ? "Query completed"
          : `Query ended with subtype ${message.subtype ?? "unknown"}`,
      // Сырой subtype сохраняется в data: тег события содержит готовую строку для UI, а
      // точное значение нужно тем, кто анализирует историю прогонов.
      data: { subtype: message.subtype ?? null },
    };
  }

  if (message.type === "system" && message.subtype === "init") {
    // Инициализация несёт session_id: переводим её в событие уровня debug, а само поле
    // читается ещё раз в processMessage (событие - для UI, локальная переменная - для
    // resume). Тип session_id проверяется через typeof: поле объявлено строкой, но
    // приходит из чужого JSON.
    return {
      type: "system:init",
      timestamp: new Date().toISOString(),
      level: "debug",
      message: "Runtime session initialized",
      // sessionId приводится к строке или null явно: событие должно иметь предсказуемую
      // форму, даже если SDK пришлёт число или вовсе не пришлёт поле.
      data: { sessionId: typeof message.session_id === "string" ? message.session_id : null },
    };
  }

  if (message.type === "tool_use_summary" && typeof message.summary === "string") {
    // Проверка typeof, а не только типа сообщения: наличие summary не гарантировано
    // протоколом, а message - недоверенные данные; без неё в событие уехал бы undefined.
    return {
      type: "tool:summary",
      timestamp: new Date().toISOString(),
      level: "info",
      message: message.summary,
    };
  }

  return null;
}

// Извлечение текстовой дельты из инкрементального потока. Проверка на каждом уровне
// вложенности: структура event.delta.text принадлежит протоколу SDK, и любая из её
// частей может отсутствовать на не-стриминговом сообщении. Возврат "" (а не null)
// означает «нечего добавлять», и вызывающий проверяет его как строку по truthiness.
function extractStreamingText(message: ClaudeStreamMessage): string {
  // Каскад ранних выходов вместо вложенных if: каждый уровень структуры проверяется
  // отдельным условием, и читать такую защиту проще, чем следить за скобками.
  if (message.type !== "stream_event") return "";
  if (message.event?.type !== "content_block_delta") return "";
  if (message.event?.delta?.type !== "text_delta") return "";
  // Последний typeof-барьер: к этому месту структура уже проверена, но тип самого поля
  // всё ещё чужой - контракт на текст обещает строка, а приходит недоверенный JSON.
  return typeof message.event.delta.text === "string" ? message.event.delta.text : "";
}

// Один блок сообщения ассистента: описаны только поля, нужные для сборки событий об
// инструментах (тип, имя, id и вход).
interface AssistantContentItem {
  type?: string;
  name?: string;
  id?: string;
  input?: unknown;
}

// Массив content в сообщении ассистента полиморфен (текст, tool_use, ...): фильтр с
// предикатом оставляет только блоки с type === "tool_use", после чего проверяется имя -
// блок без имени не может стать осмысленным событием. Касты к записи здесь только
// расширяют тип для чтения полей недоверенного payload'а: каждое следующее значение
// проходит рантайм-проверку, ни один null не «глушится» без проверки.
function extractAssistantToolUses(message: ClaudeStreamMessage): AssistantContentItem[] {
  if (message.type !== "assistant") return [];
  // Каст к записи нужен потому, что поле message не объявлено в ClaudeStreamMessage;
  // фактическая форма проверяется следующим условием, поэтому каст ничего не «глушит».
  const rawMessage = (message as Record<string, unknown>).message;
  if (!rawMessage || typeof rawMessage !== "object") return [];
  const content = (rawMessage as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return (
    content
      .filter((item): item is AssistantContentItem => {
        if (!item || typeof item !== "object") return false;
        return (item as { type?: string }).type === "tool_use";
      })
      // Имя проверяется отдельно от типа блока: tool_use без имени нельзя превратить в
      // осмысленное событие, и такие блоки не должны доходить до цикла обработки.
      .filter((item) => typeof item.name === "string")
  );
}

// Фабрика типизированной ошибки: текст нужен логам, а поле `code` - управлению.
// Именно так выглядит требование проекта «классифицировать по структуре, а не по
// подстроке» в исполнении: одно место создаёт код, другое - по нему ветвится.
export function makeQueryStartTimeoutError(timeoutMs: number): QueryStartTimeoutError {
  const error = new Error(
    `query_start_timeout: runtime produced no output within ${timeoutMs}ms`,
  ) as QueryStartTimeoutError;
  error.code = QUERY_START_TIMEOUT_CODE;
  return error;
}

// Функция-страж (type guard, запись `error is QueryStartTimeoutError`): внутри if,
// который её вызывает, TypeScript сужает unknown до типизированной ошибки, и доступ
// к `error.code` не требует кастов. Boolean(...) оборачивает всё выражение, потому что
// конъюнкция возвращает не строгий boolean, а тип правого операнда.
export function isQueryStartTimeoutError(error: unknown): error is QueryStartTimeoutError {
  return Boolean(
    error &&
    typeof error === "object" &&
    // Оператор `in` - рантайм-проверка наличия поля: только после неё чтение code через
    // суженный тип корректно, даже если это чужой объект из чужого модуля.
    "code" in error &&
    (error as { code?: string }).code === QUERY_START_TIMEOUT_CODE,
  );
}

// Подмена `query` для тестов: вместо протягивания стаба через всю цепочку вызовов
// оставлен один шов на глобале процесса, активный только при NODE_ENV=test. В
// продакшене ветка недостижима, и наружу отдаётся импортированная функция.
function resolveQueryImplementation(): typeof query {
  if (process.env.NODE_ENV === "test") {
    const runtimeGlobal = globalThis as RuntimeGlobalWithQueryMock;
    // Стаб кладется тестом до вызова функции: подмена через globalThis позволяет не
    // протягивать зависимость через весь стек вызовов ради одного теста.
    if (typeof runtimeGlobal.__AIF_CLAUDE_QUERY_MOCK__ === "function") {
      return runtimeGlobal.__AIF_CLAUDE_QUERY_MOCK__;
    }
  }
  return query;
}

/** Выполняет одну попытку запроса Claude Agent SDK, считывая асинхронный поток. */
// Единица ретрая для верхнего слоя (run.ts): одна попытка - один вызов query().
// Функция либо отдаёт накопленный результат, либо бросает классифицированную ошибку;
// промежуточного состояния между попытками она не хранит - это забота вызывающего.
export async function runClaudeQueryAttempt(
  input: RuntimeRunInput,
  execution: ClaudeRuntimeExecutionOptions,
  logger?: ClaudeOptionsLogger,
): Promise<ClaudeQueryAttemptResult> {
  // Идентичность и токен резолвятся до запроса: identity влияет на нормализацию квот
  // (она уезжает в limit.ts и в providerMeta), а сам токен понадобится позже для
  // опроса мониторинга Z.AI. Значения читаются из input.options через typeof-проверки -
  // это те же недоверенные данные профиля.
  const { identity: providerIdentity, authToken } = resolveClaudeProviderAuth({
    providerId: input.providerId ?? "anthropic",
    transport: input.transport ?? "sdk",
    baseUrl: typeof input.options?.baseUrl === "string" ? input.options.baseUrl : null,
    apiKeyEnvVar:
      typeof input.options?.apiKeyEnvVar === "string" ? input.options.apiKeyEnvVar : null,
    apiKey: typeof input.options?.apiKey === "string" ? input.options.apiKey : null,
  });
  // Опции собираются отдельным модулем (options.ts): здесь остаётся только исполнение -
  // разделение позволяет тестировать сборку опций без запуска потока.
  const options = buildClaudeQueryOptions(input, execution, logger);
  // query() возвращает асинхронный генератор, а не массив сообщений: заранее неизвестно,
  // сколько их будет, поэтому поток читается по мере поступления, а не целиком.
  const queryImpl = resolveQueryImplementation();
  const stream = queryImpl({ prompt: input.prompt, options });

  // Итератор запрашивается у потока явно: withStreamTimeouts гоняет каждый next() с
  // таймером, поэтому ему нужен именно итератор, а не iterable.
  const rawIterator = stream[Symbol.asyncIterator]();

  // Оборачиваем общими утилитами таймаутов: таймаут старта и общий таймаут выполнения.
  const abort = execution.abortController ?? new AbortController();
  // Два независимых таймаута: start - ожидание первого вывода (детект зависания),
  // run - общий потолок длительности потока. Аборт срабатывает по любому из них: отмена
  // контроллера заставляет SDK штатно завершить query, а не бросать процесс.
  const iterator = withStreamTimeouts(
    rawIterator,
    {
      startTimeoutMs: execution.queryStartTimeoutMs,
      runTimeoutMs: execution.runTimeoutMs,
    },
    abort,
  );

  // Аккумуляторы состояния попытки. sessionId может появиться до цикла (возобновление
  // сохранённой сессии) или во время него (сообщение init перезапишет значение).
  // terminalErrorSubtype/terminalErrorDetail: терминальная ошибка без текстовой детали
  // не бросается сразу - даём потоку досказать остаток и бросаем после цикла.
  let sessionId: string | null = input.sessionId ?? null;
  let outputText = "";
  let usage: RuntimeUsage | null = null;
  // События копятся в массиве за весь прогон: наружу при ошибке уходит исключение с
  // метаданными, а не половина истории - потребитель либо получает всё, либо ничего.
  const events: RuntimeEvent[] = [];
  // Последний увиденный снимок лимитов живёт дольше обработки одного сообщения: он
  // нужен и для событий, и для метаданных возможной терминальной ошибки.
  let latestLimitSnapshot: RuntimeLimitSnapshot | null = null;
  let terminalErrorSubtype: string | null = null;
  let terminalErrorDetail: string | null = null;

  // Обработчик одного сообщения - замыкание над аккумуляторами выше. Проверка в начале -
  // входная точка работы с недоверенными данными: объект без поля `type` нельзя
  // разметить по типу, поэтому пропускаем его без исключений.
  const processMessage = (rawMessage: unknown) => {
    if (!rawMessage || typeof rawMessage !== "object" || !("type" in rawMessage)) return;
    const message = rawMessage as ClaudeStreamMessage;

    const runtimeEvent = toRuntimeEvent(message);
    if (runtimeEvent) {
      // Двойной канал доставки: events копятся для результата и истории, а onEvent
      // отдаёт то же событие живьём (WebSocket в UI). Объект передается по ссылке,
      // поэтому потребители не должны его мутировать.
      events.push(runtimeEvent);
      execution.onEvent?.(runtimeEvent);
    }

    if (message.type === "rate_limit_event") {
      // Событие квоты от Anthropic: сырой payload сначала нормализуется в снимок
      // (limit.ts), и только потом попадает в events - структура события и схема БД
      // едины для любого источника квот, включая Z.AI.
      const snapshot = normalizeClaudeLimitSnapshot({
        info: message.rate_limit_info,
        runtimeId: input.runtimeId,
        providerId: input.providerId ?? "anthropic",
        profileId: input.profileId ?? null,
        checkedAt: new Date().toISOString(),
        providerIdentity,
      });

      if (!snapshot) {
        // В событии не было пригодных чисел: пишем warn и пропускаем, не срывая запуск -
        // квота это побочный канал, и его сбой не должен отменять уже начатую работу.
        logger?.warn?.(
          {
            runtimeId: input.runtimeId,
            providerId: input.providerId ?? "anthropic",
            profileId: input.profileId ?? null,
          },
          "Dropped Claude rate_limit_event because it did not contain usable limit metadata",
        );
        return;
      }

      latestLimitSnapshot = snapshot;
      // Снимок превращается в событие через общий конструктор: формат лимит-события
      // не должен зависеть от того, кто его создал - SDK или мониторинг провайдера.
      const limitEvent = buildRuntimeLimitEvent(snapshot, "rate_limit_event");
      // Лимит-событие идёт тем же двойным каналом, что и остальные: и в накопленный
      // список, и живьём.
      events.push(limitEvent);
      execution.onEvent?.(limitEvent);
      logger?.debug?.(
        {
          runtimeId: input.runtimeId,
          providerId: snapshot.providerId,
          profileId: snapshot.profileId ?? null,
          status: snapshot.status,
          precision: snapshot.precision,
          source: snapshot.source,
          resetAt: snapshot.resetAt ?? null,
        },
        "Translated Claude rate_limit_event into runtime limit snapshot",
      );
      if (snapshot.status === RuntimeLimitStatus.BLOCKED) {
        // Исчерпание лимита - исключение, а не событие: продолжать бессмысленно.
        // Ошибка несёт структурированные метаданные (category, resetAt, retryAfter),
        // поэтому верхний слой планирует повтор, не разбирая текст.
        throw classifyClaudeResultSubtype(
          "rate_limit",
          "Claude runtime reported a blocked limit state",
          buildClaudeLimitErrorMetadata(snapshot),
        );
      }
      return;
    }

    if (message.type === "system" && message.subtype === "init" && message.session_id) {
      // Повторное чтение session_id: toRuntimeEvent только превращает сообщение в событие,
      // а сама строка нужна для результата и для последующего resume.
      sessionId = message.session_id;
      return;
    }

    const toolUses = extractAssistantToolUses(message);
    if (toolUses.length > 0) {
      // Одно время на все события одного сообщения: UI сортирует по нему, и разнобой
      // в миллисекундах внутри одной пачки выглядел бы как разные шаги.
      const nowIso = new Date().toISOString();
      for (const item of toolUses) {
        const toolName = item.name as string;
        // `as string` подкреплён фильтром в extractAssistantToolUses: элемент без
        // строкового name до цикла не доходит, поэтому каст не снимает nullable
        // с произвольного значения.
        const toolUseId = typeof item.id === "string" ? item.id : null;
        const toolUseEvents = buildToolUseEvents({
          toolName,
          toolUseId,
          input: item.input,
          timestamp: nowIso,
          // Вопрос пользователю и вызов инструмента - одно и то же сообщение SDK, но
          // два разных события: парсер вопроса читает тот же input и решает, добавлять
          // ли событие-вопрос.
          questionPayload: parseClaudeAskUserQuestion(toolName, toolUseId, item.input),
        });
        // Один блок tool_use может дать несколько событий - обход циклом вместо
        // специального случая на вызывающей стороне.
        for (const event of toolUseEvents) {
          events.push(event);
          execution.onEvent?.(event);
        }
      }
    }

    const streamedText = extractStreamingText(message);
    if (streamedText) {
      // Дельта дописывается в outputText и одновременно уходит debug-событием: текст
      // переживёт любой терминальный исход, а UI получает его в реальном времени.
      outputText += streamedText;
      const streamEvent: RuntimeEvent = {
        type: "stream:text",
        timestamp: new Date().toISOString(),
        // Уровень debug: дельты - самый шумный поток событий, и в обычном режиме их
        // незачем показывать в логе, но UI подписан на них для живого вывода.
        level: "debug",
        message: streamedText,
        data: { text: streamedText },
      };
      events.push(streamEvent);
      execution.onEvent?.(streamEvent);
      // После дельты в stream_event нет ничего полезного: дальнейшие проверки типов -
      // только трата времени на каждом токене ответа.
      return;
    }

    if (message.type !== "result") return;

    // "result" - терминатор потока: он несёт расход и либо финальный текст, либо
    // причину ошибки. Всё, что пришло раньше, уже осело в событиях.
    usage = normalizeUsage(message);
    // У не-result сообщений поля result нет; typeof-проверка нужна, потому что тип
    // объявлен строкой, а приходит чужая структура, где поле может быть чем угодно.
    const directResult = typeof message.result === "string" ? message.result : "";
    if (message.subtype !== "success") {
      terminalErrorSubtype = message.subtype ?? "unknown";
      // Заглушка subtype тоже становится ошибкой: поток не может закончиться успешно
      // без подтверждения успеха, и молчание тут опаснее ложной ошибки.
      terminalErrorDetail = directResult || null;
      if (directResult) {
        throw classifyClaudeResultSubtype(
          terminalErrorSubtype,
          directResult,
          buildClaudeLimitErrorMetadata(latestLimitSnapshot),
        );
      }
      return;
    }

    if (!outputText && directResult) {
      // Финальный текст из result перекрывает накопленный стриминг только если стриминг
      // ничего не добавил: иначе ответ удвоился бы у клиента, запросившего
      // includePartialMessages.
      outputText = directResult;
    }
  };

  for await (const value of iterator) {
    // for await...of - асинхронная итерация: тело дожидается каждого нового сообщения,
    // а цикл заканчивается, когда SDK закрывает поток (после result) или когда сработал
    // таймаут/аборт из withStreamTimeouts.
    processMessage(value);
  }

  if (providerIdentity.quotaSource === "zai_monitor" && authToken) {
    // У Z.AI семейства события SDK о квоте ничего не говорят, поэтому после прогона
    // запрашивается живой снимок с монитор-эндпоинта (см. ./zaiQuota.ts). Условие
    // включает источник квот из identity, а не догадку по baseUrl - решение о канале
    // принято один раз в providerIdentity.ts.
    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        providerId: input.providerId ?? "anthropic",
        profileId: input.profileId ?? null,
        quotaAuthEnvVar: providerIdentity.apiKeyEnvVar,
        providerFamily: providerIdentity.providerFamily,
      },
      "Refreshing Z.AI coding quota snapshot with resolved Claude auth identity",
    );
    try {
      // Дозапрос идёт синхронно после цикла: SDK-поток уже закрыт, и никакого
      // параллелизма с query нет - снимок гарантированно «после» выполнения.
      const providerSnapshot = await fetchZaiClaudeQuotaSnapshot({
        runtimeId: input.runtimeId,
        providerId: input.providerId ?? "anthropic",
        profileId: input.profileId ?? null,
        identity: providerIdentity,
        authToken,
        logger,
      });
      if (providerSnapshot) {
        latestLimitSnapshot = providerSnapshot;
        // Снимок провайдера замещает собой последний SDK-снимок: источник свежее и
        // достовернее, а в метаданные ошибки (если она будет) попадёт именно он.
        const providerLimitEvent = buildRuntimeLimitEvent(providerSnapshot, "zai_monitor");
        events.push(providerLimitEvent);
        execution.onEvent?.(providerLimitEvent);
      }
    } catch (error) {
      // Канал квот не влияет на результат прогона: неудачный дозапрос после успешного
      // завершения - только предупреждение, иначе пользователь терял бы готовый ответ
      // из-за недоступности диагностического эндпоинта.
      logger?.warn?.(
        {
          runtimeId: input.runtimeId,
          providerId: input.providerId ?? "anthropic",
          profileId: input.profileId ?? null,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to refresh Z.AI coding quota snapshot after Claude runtime run",
      );
    }
  }

  if (terminalErrorSubtype) {
    // «Медленная» терминальная ошибка (зафиксированная без текстовой детали) бросается
    // после завершения потока: к этому моменту поглощены все поздние сообщения, и в
    // метаданные попадает самый свежий снимок лимитов.
    // buildClaudeLimitErrorMetadata превращает снимок в resetAt/retryAfter - клиенту
    // не нужно самому выцепливать эти данные из текста исключения.
    throw classifyClaudeResultSubtype(
      terminalErrorSubtype,
      terminalErrorDetail,
      buildClaudeLimitErrorMetadata(latestLimitSnapshot),
    );
  }

  // Возврат - всегда ровно четыре поля: накопленный текст (может быть пустым),
  // последний известный sessionId, полный список событий и расход (или null).
  return { outputText, sessionId, events, usage };
}
