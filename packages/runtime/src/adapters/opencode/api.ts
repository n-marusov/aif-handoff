/**
 * HTTP-транспорт OpenCode-адаптера.
 *
 * OpenCode поднимает локальный сервер (`opencode serve`), и вся работа с ним идёт
 * через REST: сессии, сообщения, health-check, список провайдеров с моделями. Здесь
 * собран тонкий клиент к этому API плюс отображение ответов сервера в
 * рантайм-нейтральные типы @aif/runtime.
 *
 * Ключевые инварианты модуля:
 * - Никакой веры в форму ответа. Данные читаются через asRecord/readString: это
 *   недоверенный ввод из сети, поэтому каждый уровень аккуратно сужается до
 *   примитивов, а отсутствующее значение остаётся null, а не подменяется пустой
 *   строкой (Nullable Cast Rule).
 * - Секреты не попадают в логи: options проходят через stripSensitiveOptions, текст
 *   ошибки провайдера - через redactProviderText.
 * - Ошибки не разбираются по тексту: всё уходит в classifyOpenCodeRuntimeError,
 *   который заполняет category/adapterCode/httpStatus.
 */

import type {
  RuntimeConnectionValidationInput,
  RuntimeConnectionValidationResult,
  RuntimeEvent,
  RuntimeModel,
  RuntimeModelListInput,
  RuntimeRunInput,
  RuntimeRunResult,
  RuntimeSession,
  RuntimeSessionEventsInput,
  RuntimeSessionGetInput,
  RuntimeSessionListInput,
} from "../../types.js";
import { getEnv, redactProviderText } from "@aif/shared";
import { Agent, type Dispatcher } from "undici";
import { resolveProxyDispatcher } from "../../proxyEnv.js";
import {
  normalizeModelEffortLevels,
  OPENCODE_MODEL_EFFORT_LEVELS,
  resolveModelEffortOption,
} from "../../modelEffort.js";
import { classifyOpenCodeRuntimeError, OpenCodeRuntimeAdapterError } from "./errors.js";

// Минимальный структурный интерфейс логгера: модуль не зависит от конкретной
// библиотеки логирования, а все методы опциональны - вызов идёт через ?., чтобы
// адаптер работал и с пустым объектом логов.
export interface OpenCodeApiLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

// Дефолты держат адаптер работоспособным без настройки: стандартный порт локального
// `opencode serve` и его штатное basic-auth-имя (пароль задаётся только пользователем).
const DEFAULT_BASE_URL = "http://127.0.0.1:4096";
const DEFAULT_SERVER_USERNAME = "opencode";
// Список запрещённых к логированию ключей options. Это разрешительный фильтр
// вывода, а не часть логики: он никогда не должен влиять на то, что уходит в запрос.
// Набор закрытый и намеренно не расширяется автоматически - каждое новое поле
// с секретом добавляется сюда осознанно.
const SENSITIVE_OPTION_KEYS = new Set([
  "apiKey",
  "apikey",
  "api_key",
  "secret",
  "password",
  "serverPassword",
]);

// Локальная типизация ответа /session. Индексная сигнатура оставлена осознанно:
// сервер добавляет поля от версии к версии, и жёсткая схема ломала бы адаптер при
// обновлении OpenCode. Поля, от которых зависит логика, перечислены явно.
interface OpenCodeSessionResponse {
  id: string;
  title?: string;
  time?: {
    created?: number;
    updated?: number;
  };
  version?: {
    modelID?: string;
    providerID?: string;
  };
  [key: string]: unknown;
}

// undici принимает dispatcher, которого нет в стандартном RequestInit браузерного
// типа. Расширение интерфейса позволяет положить его в объект запроса, не теряя
// типизацию остальных полей.
interface RequestInitWithDispatcher extends RequestInit {
  dispatcher?: Dispatcher;
}

// Долгие прогоны (longRunning) идут минутами, а undici по умолчанию разрывает тело
// по bodyTimeout/headersTimeout. Экземпляр Agent создаётся лениво и переиспользуется:
// один общий пул соединений на все долгие запросы процесса дешевле, чем новый на каждый.
let longRunningOpenCodeDispatcher: Dispatcher | null = null;

// ??= вместо if: инициализация "при первом обращении", и гонок здесь нет - Node
// выполняет этот код в одном потоке.
function getLongRunningOpenCodeDispatcher(): Dispatcher {
  longRunningOpenCodeDispatcher ??= new Agent({
    bodyTimeout: 0,
    headersTimeout: 0,
  });
  return longRunningOpenCodeDispatcher;
}

// Приведение unknown к объекту для безопасного чтения полей. Функция никогда не
// бросает и не возвращает null - пустой объект позволяет обращаться к свойствам без
// guard'ов. Но защищает это только от скаляров и массивов: значения всё равно
// остаются unknown и читаются через readString.
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Возвращаемый тип | null объявлен явно и это не формальность: пустая строка от
// сервера семантически означает отсутствие значения, а не пустое значение. Потребитель
// обязан обработать null, и TypeScript не даёт об этом забыть.
// trim() здесь же - отсечь пробельные ответы, которые тоже ничего не значат.
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// OpenCode отдаёт время по-разному: числом (секунды или миллисекунды) и строкой.
// Порог 9_999_999_999 отделяет секунды от миллисекунд: любое "сейчас" в миллисекундах
// на порядки больше этой границы, а в секундах - меньше.
// Если значение не распознано, возвращается текущее время: контракт RuntimeSession
// требует строку, и null здесь сломал бы отображение в UI.
function toIso(value: unknown): string {
  if (typeof value === "number") {
    const ms = value > 9_999_999_999 ? value : value * 1000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

// Возвращает новый объект и не мутирует вход: исходные options принадлежат вызывающему
// коду (профилю), и вычеркивание ключей из них было бы незаметным изменением чужого
// состояния. Если options нет, возвращается как есть - undefined остаётся undefined.
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

// Тело ошибки от провайдера может содержать ключи и токены (некоторые шлюзы
// эхом возвращают куски запроса), поэтому перед попаданием в лог или в сообщение
// исключения оно редактируется. Пустое тело заменяется осмысленным fallback-текстом.
function safeProviderErrorMessage(rawText: string, fallbackMessage: string): string {
  const trimmed = rawText.trim();
  return trimmed.length > 0 ? redactProviderText(trimmed) : fallbackMessage;
}

// Приоритет источников: options профиля > переменная окружения > дефолт. Хвостовые
// слэши срезаются, потому что ниже baseUrl склеивается с path руками - без нормализации
// получился бы двойной слэш, а некоторые шлюзы на такое отвечают 404.
function resolveBaseUrl(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): string {
  const options = asRecord((input as RuntimeRunInput).options);
  const baseUrl =
    readString(options.baseUrl) ?? readString(process.env.OPENCODE_BASE_URL) ?? DEFAULT_BASE_URL;
  return baseUrl.replace(/\/+$/, "");
}

// Имя пользователя есть всегда (у basic-auth только пароль необязателен), поэтому
// возвращается обычная строка, а не string | null: проверять нечего.
function resolveServerUsername(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): string {
  const options = asRecord((input as RuntimeRunInput).options);
  return (
    readString(options.serverUsername) ??
    readString(process.env.OPENCODE_SERVER_USERNAME) ??
    DEFAULT_SERVER_USERNAME
  );
}

// Пароль - единственный сигнал, по которому включается basic-auth, поэтому пустое
// значение возвращается как null, а не как пустая строка: ниже проверка идёт на truthy.
function resolveServerPassword(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): string | null {
  const options = asRecord((input as RuntimeRunInput).options);
  return readString(options.serverPassword) ?? readString(process.env.OPENCODE_SERVER_PASSWORD);
}

// Bearer-токен читается из apiKey: профиль не заводит отдельное поле только ради
// другого заголовка. bearerToken оставлен как явная альтернатива для читаемости.
function resolveBearerToken(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): string | null {
  const options = asRecord((input as RuntimeRunInput).options);
  return readString(options.apiKey) ?? readString(options.bearerToken);
}

// Таймаут ищется в двух источниках: явный options.timeoutMs (настройка пользователя) и
// execution.runTimeoutMs (намерение рантайма на весь прогон). Проверки на конечность и
// положительность обязательны: undici со значением <= 0 или NaN ведёт себя неочевидно.
// Math.floor - потому что таймеры хотят целое. 30 секунд - дефолт для обычных запросов.
function resolveRequestTimeoutMs(
  input: RuntimeRunInput | RuntimeConnectionValidationInput,
): number {
  const options = asRecord(input.options);
  const raw = options.timeoutMs;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if ("execution" in input) {
    const exec = (input as RuntimeRunInput).execution;
    if (
      typeof exec?.runTimeoutMs === "number" &&
      Number.isFinite(exec.runTimeoutMs) &&
      exec.runTimeoutMs > 0
    ) {
      return Math.floor(exec.runTimeoutMs);
    }
  }
  return 30_000;
}

// Заголовки приходят из двух мест: options профиля и input.headers, прокинутые
// вызывающим кодом. Оба источника фильтруются по типу: Headers принимает только
// строки, а из JSON-конфига туда легко попадает число или объект.
function mergeHeaderMaps(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): Record<string, string> {
  const merged: Record<string, string> = {};
  const optionsHeaders = asRecord(asRecord((input as RuntimeRunInput).options).headers);
  for (const [key, value] of Object.entries(optionsHeaders)) {
    if (typeof value === "string") merged[key] = value;
  }

  if ("headers" in input && input.headers) {
    for (const [key, value] of Object.entries(input.headers)) {
      if (typeof value === "string") merged[key] = value;
    }
  }

  return merged;
}

// Порядок установки заголовков содержит решение: базовый Content-Type, затем
// авторизация, затем пользовательские заголовки. Так явная настройка в options может
// осознанно переопределить автоматически подставленный заголовок, и это не случайность.
// Basic и Bearer взаимоисключающи по спецификации; при обоих заданных побеждает
// Bearer, потому что он устанавливается вторым.
function buildHeaders(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });

  const password = resolveServerPassword(input);
  if (password) {
    const username = resolveServerUsername(input);
    const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    headers.set("Authorization", `Basic ${encoded}`);
  }

  const bearer = resolveBearerToken(input);
  if (bearer) {
    headers.set("Authorization", `Bearer ${bearer}`);
  }

  const mergedHeaders = mergeHeaderMaps(input);
  for (const [key, value] of Object.entries(mergedHeaders)) {
    headers.set(key, value);
  }

  return headers;
}

// Разбор строки модели формата "providerID/modelID". Если слэша нет, modelID остаётся
// как есть, а providerID берётся из options/env - это штатный случай для однословных
// имён. Возвращаются именно undefined, а не пустые строки: тело запроса должно
// содержать только заданные поля, иначе сервер получит providerID: "".
function parseModelSelection(input: RuntimeRunInput): { providerID?: string; modelID?: string } {
  const model = readString(input.model);
  if (!model) return {};

  if (model.includes("/")) {
    const delimiter = model.indexOf("/");
    const providerID = model.slice(0, delimiter).trim();
    const modelID = model.slice(delimiter + 1).trim();
    if (providerID && modelID) {
      return { providerID, modelID };
    }
  }

  const options = asRecord(input.options);
  const providerID =
    readString(options.providerID) ??
    readString(options.defaultProviderID) ??
    readString(process.env.OPENCODE_PROVIDER_ID);

  return {
    providerID: providerID ?? undefined,
    modelID: model,
  };
}

// В ответе части бывают разных типов (text, tool, reasoning...), но наружу нужен
// только текст. Часть без поля type считается текстовой - так обрабатываются
// упрощённые ответы. Непустые куски соединяются двойным переводом строки, чтобы
// сохранить абзацную структуру сообщения, и результат обрезается по краям.
function extractTextFromParts(parts: unknown[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    const record = asRecord(part);
    const type = readString(record.type);
    if (type && type !== "text") continue;
    const text = readString(record.text) ?? readString(record.content);
    if (text) texts.push(text);
  }
  return texts.join("\n\n").trim();
}

// Приведение сырой сессии к RuntimeSession: поля нормализуются на границе модуля,
// чтобы выше по коду никто не занимался разбором формы ответа. Отсутствующие model и
// title становятся null явно, а metadata.raw сохраняет исходник - он не читается
// логикой, но незаменим при разборе неожиданных ответов сервера.
function mapSession(
  session: OpenCodeSessionResponse,
  profileId: string | null | undefined,
  runtimeId: string,
  providerId: string,
): RuntimeSession {
  const modelID = readString(asRecord(session.version).modelID);
  const provider = readString(asRecord(session.version).providerID) ?? providerId;

  return {
    id: session.id,
    runtimeId,
    providerId: provider,
    profileId: profileId ?? null,
    model: modelID ?? null,
    title: readString(session.title),
    createdAt: toIso(asRecord(session.time).created),
    updatedAt: toIso(asRecord(session.time).updated),
    metadata: { raw: session },
  };
}

// Пустое тело - валидный случай (например, ответ без данных), поэтому оно
// превращается в {} без вызова JSON.parse, который на пустой строке бросил бы
// SyntaxError. Каст к T здесь осознанная граница типизации: форма T описывает
// ожидание, но потребители всё равно читают поля через asRecord/readString, то есть
// защищены от расхождения с реальностью.
async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}

/**
 * Центральный помощник: все HTTP-вызовы модуля идут только через него.
 *
 * Смысл единой точки входа - один раз решить четыре сквозные задачи: нормализация URL
 * и заголовков, отмена по таймауту, прокси/долгие соединения и классификация ошибок.
 * Если разнести это по функциям, каждый новый эндпоинт повторял бы те же грабли.
 */
async function requestJson<T>(
  input: RuntimeRunInput | RuntimeConnectionValidationInput | RuntimeModelListInput,
  options: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
    timeoutMs?: number;
    longRunning?: boolean;
    logger?: OpenCodeApiLogger;
    logMessage?: string;
  },
): Promise<T> {
  const baseUrl = resolveBaseUrl(input);
  // Путь всегда задаётся вызывающим кодом начиная со слэша, а baseUrl уже
  // нормализован без хвостового слэша - иначе получился бы // в середине URL.
  const url = `${baseUrl}${options.path}`;
  // options.timeoutMs исключён из контракта: таймаут берётся из данных запуска,
  // чтобы значение было единым для всех запросов одного прогона.
  const timeoutMs = options.timeoutMs ?? resolveRequestTimeoutMs(input as RuntimeRunInput);

  // Лог пишется до обращения к сети: если запрос упадёт или зависнет, в логе уже есть
  // метод, путь и урезанные options - этого достаточно, чтобы восстановить контекст.
  options.logger?.debug?.(
    {
      runtimeId: (input as RuntimeRunInput).runtimeId ?? null,
      method: options.method,
      path: options.path,
      timeoutMs,
      baseUrl,
      options: stripSensitiveOptions(asRecord((input as RuntimeRunInput).options)),
    },
    options.logMessage ?? "OpenCode request",
  );

  // AbortController - переносимый способ отменить fetch: undici подчиняется signal и
  // рвёт соединение, когда таймер выстрелит. Без этого зависший сервер остановил бы
  // воркер навсегда.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestInit: RequestInitWithDispatcher = {
      method: options.method,
      headers: buildHeaders(input),
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    };
    const useLongRunningDispatcher =
      options.longRunning && getEnv().AIF_RUNTIME_OPENCODE_LONG_RUNNING_DISPATCHER_ENABLED;
    // Прокси имеет приоритет: если в окружении настроен прокси, трафик обязан идти
    // через него, и подмена диспетчера ради долгого соединения его бы обошла. Флаги
    // таймаутов передаются и в прокси-диспетчер, чтобы долгий запрос не оборвался уже
    // на его стороне.
    const proxyDispatcher = resolveProxyDispatcher(
      url,
      process.env,
      useLongRunningDispatcher ? { bodyTimeout: 0, headersTimeout: 0 } : {},
    );
    // Разветвление намеренно трёхветочное: прокси -> долгий диспетчер -> дефолт undici.
    // Промежуточного "прокси И долгий" нет, поэтому комбинация флагов разрешается здесь,
    // а не обнаруживается потом в рантайме.
    if (proxyDispatcher) {
      requestInit.dispatcher = proxyDispatcher;
    } else if (useLongRunningDispatcher) {
      requestInit.dispatcher = getLongRunningOpenCodeDispatcher();
    }

    const response = await fetch(url, requestInit);

    if (!response.ok) {
      // Тело читается только на ошибке: успешный ответ парсится отдельно из потока,
      // и лишний буфер в память здесь не нужен. Текст проходит редактирование и
      // уходит в сообщение ошибки, а статус - в классификатор как главный сигнал.
      const bodyText = await response.text();
      throw classifyOpenCodeRuntimeError(
        new Error(safeProviderErrorMessage(bodyText, `OpenCode request failed at ${options.path}`)),
        response.status,
      );
    }

    return parseJsonResponse<T>(response);
  } catch (error) {
    // Идемпотентность: уже классифицированная ошибка (например, сформированная выше
    // из текста тела) не переклассифицируется - иначе httpStatus был бы потерян.
    if (error instanceof OpenCodeRuntimeAdapterError) throw error;
    // fetch отдаёт ошибку отмены как DOMException с именем AbortError - это и есть
    // таймаут, поэтому в сообщение подставляется известное значение timeoutMs.
    if (error instanceof DOMException && error.name === "AbortError") {
      throw classifyOpenCodeRuntimeError(
        new Error(`OpenCode request timed out after ${timeoutMs}ms at ${options.path}`),
      );
    }
    throw classifyOpenCodeRuntimeError(error);
  } finally {
    // Таймер снимается всегда, в том числе при успехе: иначе он удерживал бы event loop,
    // и процесс (например, воркер агента) не смог бы завершиться после работы.
    clearTimeout(timeout);
  }
}

// Сессия создаётся пустой (POST /session), а промпт уйдёт отдельным сообщением. Заголовок
// обрезается до 80 символов: OpenCode использует его в списках UI, и полный промпт
// превратился бы там в гигантскую строку.
export async function createOpenCodeSession(
  input: RuntimeRunInput,
  logger?: OpenCodeApiLogger,
): Promise<RuntimeSession> {
  const payload = await requestJson<OpenCodeSessionResponse>(input, {
    method: "POST",
    path: "/session",
    body: {
      title: input.prompt.slice(0, 80),
    },
    logger,
    logMessage: "Creating OpenCode session",
  });

  return mapSession(payload, input.profileId, input.runtimeId, input.providerId ?? "opencode");
}

/**
 * Полный цикл одного запуска по HTTP-транспорту.
 *
 * Шаги выстроены в порядке, при котором минимум работы делается до подтверждённого
 * существования сессии: получить/создать сессию, собрать тело сообщения из запроса,
 * отправить его и превратить ответ в RuntimeRunResult. Запрос выполняется как
 * longRunning - ход модели может идти минутами.
 */
export async function runOpenCodeApi(
  input: RuntimeRunInput,
  logger?: OpenCodeApiLogger,
): Promise<RuntimeRunResult> {
  // runtimeId/providerId нормализуются один раз: дальше по функции они используются и в
  // запросах, и в маппинге сессий, и расхождение между ними дало бы неверный providerId
  // в RuntimeSession.
  const runtimeId = input.runtimeId;
  const providerId = input.providerId ?? "opencode";

  logger?.info?.(
    {
      runtimeId,
      profileId: input.profileId ?? null,
      transport: "api",
      sessionId: input.sessionId ?? null,
      baseUrl: resolveBaseUrl(input),
      model: input.model ?? null,
      options: stripSensitiveOptions(asRecord(input.options)),
    },
    "OpenCode run started",
  );

  // При заданном sessionId сначала пытаемся получить существующую сессию: это продолжение
  // диалога, и сервер должен видеть всю историю, а не только новое сообщение.
  const session = input.sessionId
    ? await getOpenCodeSession(
        {
          runtimeId,
          providerId,
          profileId: input.profileId,
          projectRoot: input.projectRoot,
          sessionId: input.sessionId,
          options: input.options,
          headers: input.headers,
        },
        logger,
      )
    : await createOpenCodeSession(input, logger);

  // getOpenCodeSession возвращает null, когда сессии уже нет (её удалили или сервер был
  // перезапущен без сохранения состояния). Здесь это не ошибка, а повод начать новую
  // сессию: запуск задачи важнее сохранения идентификатора.
  const activeSession = session ?? (await createOpenCodeSession(input, logger));
  const modelSelection = parseModelSelection(input);
  // Тело собирается по частям: обязателен только parts с текстом промпта, а модель,
  // системный промпт и схема вывода добавляются, только если реально заданы. Так мы не
  // отправляем серверу поля со значением undefined и не переопределяем его дефолты.
  const body: Record<string, unknown> = {
    parts: [{ type: "text", text: input.prompt }],
  };

  if (modelSelection.modelID) {
    // providerID может быть undefined для модели без слэша и без настроек - сервер
    // подберёт провайдера сам, поэтому поле не подменяется пустой строкой.
    body.model = {
      providerID: modelSelection.providerID,
      modelID: modelSelection.modelID,
    };
  }

  if (input.systemPrompt) {
    // Базовый системный промпт идёт отдельным полем: OpenCode принимает произвольную
    // строку, а не массив блоков, как некоторые другие API.
    body.system = input.systemPrompt;
  }

  if (input.execution?.systemPromptAppend) {
    // Дополнение не перетирает базовый промпт, а приклеивается к нему через пустую
    // строку: вызывающий код может передать оба, и терять ни одно из них нельзя.
    body.system = body.system
      ? `${String(body.system)}\n\n${input.execution.systemPromptAppend}`
      : input.execution.systemPromptAppend;
  }

  if (input.execution?.outputSchema) {
    // Структурированный вывод передаётся серверу как json_schema: разбор ответа
    // остаётся его заботой, а имя "response" фиксирует единственную ожидаемую схему.
    body.outputFormat = {
      type: "json_schema",
      name: "response",
      schema: input.execution.outputSchema,
    };
  }

  // Уровень reasoning передаётся, только если он есть в белом списке уровней OpenCode: тип
  // из модели нормализован выше, а произвольная строка привела бы к ошибке сервера.
  const options = asRecord(input.options);
  const effort = resolveModelEffortOption(options, "reasoningEffort", OPENCODE_MODEL_EFFORT_LEVELS);
  if (effort) {
    body.reasoningEffort = effort;
  }

  // Паритет bypassPermissions: OpenCode резолвит `agent` в пользовательский
  // настроенный дефолт (или во встроенный агент `build`). Когда вызывающий
  // просит обход разрешений, форсируем `build`, чтобы пользовательский
  // ограничительный дефолт (например, `plan`) не блокировал правки. Разрешения
  // "ask" по отдельным инструментам (.env*, external_directory, doom_loop) по-прежнему
  // исполняются на сервере — настоящий паритет требовал бы отвечать на
  // события /session/:id/permissions/:permissionID поверх SSE.
  // Русское пояснение сути: запрос на обход разрешений не отключает проверки сервера, он
  // лишь снимает ограничение, навязанное дефолтным агентом профиля. Полный паритет с
  // другими рантаймами потребовал бы интерактивного ответа на события разрешений.
  if (input.execution?.bypassPermissions) {
    body.agent = "build";
  }

  // longRunning: true - этот запрос возвращается только после завершения хода модели,
  // то есть может висеть минутами. Сессия в пути кодируется целиком: идентификатор
  // приходит извне и может содержать символы, недопустимые в URL.
  const messagePayload = await requestJson<{ info?: unknown; parts?: unknown[] }>(input, {
    method: "POST",
    path: `/session/${encodeURIComponent(activeSession.id)}/message`,
    body,
    longRunning: true,
    logger,
    logMessage: "Posting OpenCode session message",
  });

  // Array.isArray - та же защита от неожиданной формы ответа: если сервер вернул не
  // массив, работаем как с пустым результатом, а не падаем на parts.length.
  const parts = Array.isArray(messagePayload.parts) ? messagePayload.parts : [];
  const outputText = extractTextFromParts(parts);
  // Событие формируется всегда, но отправляется только при непустом тексте: пустое
  // сообщение не несёт информации, а подписчики восприняли бы его как ответ агента.
  const event: RuntimeEvent = {
    type: "stream:text",
    timestamp: new Date().toISOString(),
    message: outputText,
    data: {
      sessionId: activeSession.id,
      partCount: parts.length,
    },
  };

  if (outputText.length > 0 && input.execution?.onEvent) {
    // Проверка onEvent через && - коллбек необязателен, а лишний вызов в try не нужен:
    // адаптер просто не отдаёт событие, если никто его не ждёт.
    input.execution.onEvent(event);
  }

  logger?.info?.(
    {
      runtimeId,
      profileId: input.profileId ?? null,
      sessionId: activeSession.id,
      outputLength: outputText.length,
      eventSent: outputText.length > 0 && Boolean(input.execution?.onEvent),
    },
    "OpenCode run completed",
  );

  return {
    outputText,
    sessionId: activeSession.id,
    session: activeSession,
    // Массив событий повторяет ту же логику, что и вызов onEvent: пустой вывод -
    // пустая история.
    events: outputText.length > 0 ? [event] : [],
    // usage: null согласован с capabilities.usageReporting = NONE: сервер не отдаёт
    // счётчики токенов, и подстановка нулей выдала бы отсутствие данных за нулевой расход.
    usage: null,
    // Сырой ответ сохраняется целиком: он не читается логикой адаптера, но нужен для
    // отладки и на случай, если выше по стеку понадобятся нестандартные поля.
    raw: messagePayload,
  };
}

export async function listOpenCodeSessions(
  input: RuntimeSessionListInput,
  logger?: OpenCodeApiLogger,
): Promise<RuntimeSession[]> {
  const payload = await requestJson<OpenCodeSessionResponse[]>(
    {
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      profileId: input.profileId,
      options: input.options,
      headers: input.headers,
    },
    {
      method: "GET",
      path: "/session",
      logger,
      logMessage: "Listing OpenCode sessions",
    },
  );

  // Array.isArray: сервер отвечает массивом сессий, но контракт не гарантирован на 100%,
  // поэтому неожиданная форма превращается в пустой список, а не в исключение.
  const sessions = (Array.isArray(payload) ? payload : []).map((session) =>
    mapSession(session, input.profileId, input.runtimeId, input.providerId ?? "opencode"),
  );

  // limit применяется после маппинга: серверного параметра пагинации в этом эндпоинте нет,
  // а вызывающий код всё равно ждёт не больше limit записей.
  return input.limit ? sessions.slice(0, input.limit) : sessions;
}

// Отсутствие сессии - штатная ситуация для вызывающего кода, а не сбой, поэтому функция
// возвращает RuntimeSession | null и гасит именно те ошибки, которые означают "сессии нет".
// Решение принимается по структуре (adapterCode/httpStatus), а не по тексту ответа.
export async function getOpenCodeSession(
  input: RuntimeSessionGetInput,
  logger?: OpenCodeApiLogger,
): Promise<RuntimeSession | null> {
  try {
    const payload = await requestJson<OpenCodeSessionResponse>(
      {
        runtimeId: input.runtimeId,
        providerId: input.providerId,
        profileId: input.profileId,
        options: input.options,
        headers: input.headers,
      },
      {
        method: "GET",
        path: `/session/${encodeURIComponent(input.sessionId)}`,
        logger,
        logMessage: "Getting OpenCode session",
      },
    );

    if (!payload?.id) {
      // Пустой ответ без id - это тоже "сессии нет": мапить нечего и создавать
      // фиктивную запись нельзя.
      return null;
    }

    return mapSession(payload, input.profileId, input.runtimeId, input.providerId ?? "opencode");
  } catch (error) {
    // Классификация нужна, чтобы отличить отсутствие сессии от реального сбоя: только
    // структурированные признаки позволяют принять такое решение, текст ответа здесь
    // ни при чём.
    const classified =
      error instanceof OpenCodeRuntimeAdapterError ? error : classifyOpenCodeRuntimeError(error);
    // Ошибки конкретной сессии или HTTP 404 на /session/:id трактуем как session-not-found
    // Два признака вместо одного: адаптерный код покрывает случай "session not found"
    // из тела ответа, а 404 - случай, когда сервер даже не счёл нужным описать причину.
    const isSessionNotFound =
      classified.adapterCode === "OPENCODE_SESSION_ERROR" || classified.httpStatus === 404;
    if (isSessionNotFound) {
      // Логируем уровнем warn: для вызывающего это норма, но в логе должно быть видно,
      // почему сессия была пересоздана.
      logger?.warn?.(
        {
          runtimeId: input.runtimeId,
          sessionId: input.sessionId,
          error: classified.message,
        },
        "OpenCode session not found",
      );
      return null;
    }
    throw classified;
  }
}

export async function listOpenCodeSessionEvents(
  input: RuntimeSessionEventsInput,
  logger?: OpenCodeApiLogger,
): Promise<RuntimeEvent[]> {
  const payload = await requestJson<Array<{ info?: Record<string, unknown>; parts?: unknown[] }>>(
    {
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      profileId: input.profileId,
      options: input.options,
      headers: input.headers,
    },
    {
      method: "GET",
      path: `/session/${encodeURIComponent(input.sessionId)}/message${
        input.limit ? `?limit=${input.limit}` : ""
      }`,
      logger,
      logMessage: "Listing OpenCode session messages",
    },
  );

  // Каждое сообщение сессии состоит из info (метаданные) и parts (содержимое), но
  // сообщения без текста пропускаются: они не несут смысла для истории чата.
  const events: RuntimeEvent[] = [];
  for (const message of Array.isArray(payload) ? payload : []) {
    const info = asRecord(message.info);
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const text = extractTextFromParts(parts);
    if (!text) continue;

    events.push({
      type: "session-message",
      // toIso подстрахует от нестандартного формата времени в info.time.
      timestamp: toIso(info.time),
      level: "info",
      message: text,
      data: {
        // undefined вместо null в data - так поле просто не попадает в сериализацию,
        // а UI не показывает пустую строку как значение.
        id: readString(info.id) ?? undefined,
        // Дефолт assistant выбран потому, что эндпоинт возвращает ход модели; роль
        // пользователя сервер заполняет явно, если сообщение его.
        role: readString(info.role) ?? "assistant",
      },
    });
  }

  return events;
}

// Валидация соединения - лёгкий health-check, а не пробный запуск модели: он должен
// отрабатывать быстро и не тратить токены. Негативный ответ сервера превращается в
// ok: false с объяснением - это результат проверки, а не исключение.
export async function validateOpenCodeApiConnection(
  input: RuntimeConnectionValidationInput,
): Promise<RuntimeConnectionValidationResult> {
  try {
    const payload = await requestJson<{ healthy?: boolean; version?: string }>(input, {
      method: "GET",
      path: "/global/health",
      logMessage: "Validating OpenCode API connection",
    });

    if (!payload.healthy) {
      return {
        ok: false,
        message: "OpenCode health check failed",
      };
    }

    return {
      ok: true,
      // Версия показывается в UI: она помогает понять, с каким сервером работал профиль,
      // когда что-то ведёт себя не так, как ожидалось. "unknown" вместо догадок.
      message: `OpenCode API connection validated (version: ${payload.version ?? "unknown"})`,
    };
  } catch (error) {
    // Сетевые сбои и неверные креды классифицируются как обычно, чтобы UI получил
    // структурную категорию (auth, transport и т.п.), а не сырое сообщение fetch.
    throw classifyOpenCodeRuntimeError(error);
  }
}

// Приводит один элемент /config/providers к списку RuntimeModel.
// Форма models у разных версий сервера различается: это может быть массив описаний или
// словарь "modelID -> описание". Обе формы сводятся к парам [fallbackID, value], после
// чего остаётся один путь обработки - так ветвление не расползается по функции.
function extractModelsFromProvider(provider: unknown): RuntimeModel[] {
  const record = asRecord(provider);
  const providerID = readString(record.id) ?? readString(record.providerID) ?? "opencode";
  const modelsValue = record.models;
  const modelEntries: Array<[string | null, unknown]> = Array.isArray(modelsValue)
    ? modelsValue.map((model) => [null, model])
    : Object.entries(asRecord(modelsValue));

  const models: RuntimeModel[] = [];
  for (const [fallbackModelID, model] of modelEntries) {
    // Строковая форма - это просто имя модели без описания: метаданных нет, но модель
    // всё равно должна попасть в список, иначе селект окажется неполным.
    if (typeof model === "string") {
      const modelID = fallbackModelID ?? readString(model);
      if (!modelID) continue;
      models.push({
        id: `${providerID}/${modelID}`,
        label: `${providerID}/${modelID}`,
        supportsStreaming: true,
      });
      continue;
    }

    const modelRecord = asRecord(model);
    // ID ищется по трём источникам: явное поле, альтернативное имя, ключ словаря.
    // Модель без опознанного id пропускается: безымянную запись нельзя ни выбрать,
    // ни запустить.
    const modelID =
      readString(modelRecord.id) ?? readString(modelRecord.modelID) ?? fallbackModelID;
    if (!modelID) continue;

    const metadata: Record<string, unknown> = {
      providerID,
      modelID,
    };
    // variants описывают варианты модели; для UI важна не их структура, а то, какие
    // уровни reasoning они реально поддерживают. Выключенный вариант (disabled: true)
    // не должен попадать в набор - он недоступен для выбора.
    const variants = asRecord(modelRecord.variants);
    const supportedEffortLevels = normalizeModelEffortLevels(
      Object.values(variants).map((variant) => {
        const variantRecord = asRecord(variant);
        return variantRecord.disabled === true ? null : variantRecord.reasoningEffort;
      }),
    );
    if (supportedEffortLevels) {
      metadata.supportsEffort = true;
      metadata.supportedEffortLevels = supportedEffortLevels;
    } else {
      // Если вариантов с уровнями нет, остаётся грубый флаг capabilities.reasoning:
      // он не перечисляет уровни, но честно говорит, поддерживается ли reasoning вообще.
      const reasoningCapability = asRecord(modelRecord.capabilities).reasoning;
      if (typeof reasoningCapability === "boolean") {
        metadata.supportsEffort = reasoningCapability;
      }
    }

    models.push({
      // id склеивается из провайдера и модели: именно в таком виде OpenCode ждёт
      // модель в запросе, поэтому UI должен показывать и возвращать то же значение.
      id: `${providerID}/${modelID}`,
      label: readString(modelRecord.name) ?? `${providerID}/${modelID}`,
      supportsStreaming: true,
      metadata,
    });
  }

  return models;
}

// Провайдеры читаются из /config/providers: это единственный источник правды о том,
// какие модели реально настроены на сервере. Форма ответа разбирается защитно, а сбой
// классифицируется, чтобы вызывающий код мог отличить недоступный сервер от пустого
// списка моделей (см. fallback в index.ts).
export async function listOpenCodeApiModels(
  input: RuntimeConnectionValidationInput | RuntimeModelListInput,
): Promise<RuntimeModel[]> {
  try {
    const payload = await requestJson<{ providers?: unknown[] }>(
      {
        runtimeId: input.runtimeId,
        providerId: input.providerId,
        profileId: input.profileId,
        options: (input as RuntimeConnectionValidationInput).options,
      },
      {
        method: "GET",
        path: "/config/providers",
        logMessage: "Listing OpenCode models",
      },
    );

    // flatMap выпрямляет список провайдеров в плоский список моделей: выше по стеку
    // провайдерская группировка не нужна, каждая модель самодостаточна.
    const providers = Array.isArray(payload.providers) ? payload.providers : [];
    const models = providers.flatMap((provider) => extractModelsFromProvider(provider));

    return models;
  } catch (error) {
    throw classifyOpenCodeRuntimeError(error);
  }
}
