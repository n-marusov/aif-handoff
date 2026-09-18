/**
 * Сессии (threads) codex app-server.
 *
 * Здесь живёт «одноразовый» сценарий: под каждый запрос списка или чтения диалогов
 * поднимается отдельный дочерний процесс codex app-server, выполняется handshake,
 * делается ровно один RPC-вызов, после чего процесс гарантированно гасится в finally.
 * Такой дизайн дороже постоянного соединения, но не оставляет висящих процессов
 * и не требует разделять состояние между запросами API.
 *
 * Список сессий кэшируется на секунду: UI опрашивает его часто, а сам вызов порождает
 * процесс и сетевой обмен, поэтому короткий TTL убирает дублирующиеся запуски.
 */

import {
  RuntimeTransport,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeSessionEventsInput,
  type RuntimeSessionGetInput,
  type RuntimeSessionListInput,
} from "../../../types.js";
import { CodexAppServerClient } from "./client.js";
import { JsonlRpcClient } from "./jsonlRpcClient.js";
import { spawnCodexAppServerProcess, terminateCodexAppServerProcess } from "./process.js";
import type { Thread } from "./generated/v2/Thread.js";
import type { ThreadItem } from "./generated/v2/ThreadItem.js";
import type { UserInput } from "./generated/v2/UserInput.js";

// Минимальный контракт логгера: достаточно pino-совместимого объекта.
// Все методы необязательные, поэтому вызовы идут через ?. и в тестах логгер можно не передавать.
export interface CodexAppServerSessionLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

// Таймаут по умолчанию для служебных RPC: discovery-запросы короткие,
// и если сервер не ответил за 8 секунд, ждать дальше бессмысленно.
const DEFAULT_SESSION_REQUEST_TIMEOUT_MS = 8_000;
// TTL намеренно крошечный: он гасит только «дребезг» из нескольких компонентов UI,
// но не превращает кэш в источник устаревших данных.
const SESSION_LIST_CACHE_TTL_MS = 1_000;
// Жёсткий предел размера кэша: ключи включают projectRoot и options, то есть
// в долгоживущем процессе их число растёт без ограничений без вытеснения.
const SESSION_LIST_CACHE_MAX_ENTRIES = 32;

// expiresAt - абсолютное время (Date.now()), а не продолжительность: сравнивать
// с текущим моментом на каждом чтении дешевле, чем пересчитывать момент создания.
interface SessionListCacheEntry {
  expiresAt: number;
  sessions: RuntimeSession[];
}

// Кэш живёт на уровне модуля, то есть общий для всех вызовов процесса.
// Ключ строится так, чтобы не смешивать разные проекты, профили и наборы опций.
const sessionListCache = new Map<string, SessionListCacheEntry>();

export async function listCodexAppServerSessions(
  input: RuntimeSessionListInput,
  logger?: CodexAppServerSessionLogger,
): Promise<RuntimeSession[]> {
  const cacheKey = buildSessionListCacheKey(input);
  const cached = readSessionListCache(cacheKey);
  if (cached) {
    // Попадание в кэш логируется: без этой записи непонятно, почему discovery
    // «не сходил» в codex, и кэш-хит легко принять за сломанный вызов.
    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: RuntimeTransport.APP_SERVER,
      },
      "DEBUG [runtime:codex] Reusing cached Codex app-server session discovery result",
    );
    return cached;
  }

  const sessions = await withAppServerSessionClient(input, logger, async (client) => {
    // Параметры заданы целиком, включая null-поля: протокол различает «не передано»
    // и «передано пустое значение», поэтому все фильтры выключены осознанно.
    const result = await client.listThreads({
      limit: input.limit ?? 50,
      cursor: null,
      cwd: input.projectRoot ?? null,
      archived: false,
      sortKey: "updated_at",
      sourceKinds: null,
      modelProviders: null,
      searchTerm: null,
    });

    // Маппинг идёт внутри callback: клиент и процесс живут только в этом блоке
    // и будут закрыты в finally, поэтому результат нужно «материализовать» до выхода.
    return result.data.map((thread) => mapThreadToRuntimeSession(thread, input));
  });
  writeSessionListCache(cacheKey, sessions);
  // В кэш и наружу отдаются клоны: иначе вызывающий мог бы мутировать объекты,
  // которые увидит следующий запрос.
  return cloneSessions(sessions);
}

export async function getCodexAppServerSession(
  input: RuntimeSessionGetInput,
  logger?: CodexAppServerSessionLogger,
): Promise<RuntimeSession | null> {
  // Отсутствие диалога - не ошибка: если RPC вернёт пустой thread, отдаём null.
  // includeTurns: false - нужен только статус, тяжёлая история сообщений не читается.
  return await withAppServerSessionClient(input, logger, async (client) => {
    const result = await client.readThread({
      threadId: input.sessionId,
      includeTurns: false,
    });
    return mapThreadToRuntimeSession(result.thread, input);
  });
}

export async function listCodexAppServerSessionEvents(
  input: RuntimeSessionEventsInput,
  logger?: CodexAppServerSessionLogger,
): Promise<RuntimeEvent[]> {
  // Здесь, наоборот, includeTurns: true - история и есть цель вызова.
  return await withAppServerSessionClient(input, logger, async (client) => {
    const result = await client.readThread({
      threadId: input.sessionId,
      includeTurns: true,
    });
    const events = threadToRuntimeEvents(result.thread);
    // Ограничение применяется к концу списка (slice(-limit)): интересны последние
    // события, а не первые - история может быть длинной.
    return input.limit ? events.slice(-input.limit) : events;
  });
}

// Общая обёртка жизненного цикла: поднять процесс, подключить транспорт, выполнить
// переданную операцию и гарантированно всё погасить. Без неё каждый публичный метод
// повторял бы один и тот же try/finally и рисковал потерять дочерний процесс при ошибке.
async function withAppServerSessionClient<T>(
  input: RuntimeSessionListInput | RuntimeSessionGetInput,
  logger: CodexAppServerSessionLogger | undefined,
  run: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const requestTimeoutMs = resolveSessionRequestTimeout(input);
  // Process, транспорт и фасад собираются вручную и по порядку: один процесс -
  // один JsonlRpcClient, поверх него один CodexAppServerClient.
  const launch = spawnCodexAppServerProcess({
    input: {
      runtimeId: input.runtimeId,
      profileId: input.profileId ?? null,
      transport: RuntimeTransport.APP_SERVER,
      projectRoot: input.projectRoot,
      options: input.options ?? {},
    },
    logger,
  });
  const rpcClient = new JsonlRpcClient(launch.process, {
    // Таймаут и транспорт передаются внутрь явно: корреляция ответов и дедлайны -
    // ответственность транспорта, а не фасада.
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    transport: RuntimeTransport.APP_SERVER,
    requestTimeoutMs,
    logger,
  });
  const client = new CodexAppServerClient(rpcClient, {
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    transport: RuntimeTransport.APP_SERVER,
    requestTimeoutMs,
    logger,
  });

  try {
    // Свой clientInfo: по нему в логах сервера видно, что сессию поднял именно
    // discovery-сценарий, а не основной запуск агента.
    await client.initialize({
      clientInfo: {
        name: "aif-runtime-codex-session-discovery",
        title: "AIF Runtime Codex Session Discovery",
        version: "1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    return await run(client);
  } finally {
    // finally, а не catch: закрыть соединение и дождаться смерти процесса нужно
    // и при успехе, и при исключении. terminate умеет эскалировать до kill.
    client.close("session discovery finished");
    await terminateCodexAppServerProcess(launch, logger);
  }
}

// Таймаут можно переопределить через options, но только положительным числом:
// ноль, отрицательное значение или NaN означали бы «ждать вечно» и превратили бы
// зависшее рукопожатие в неубиваемый процесс.
function resolveSessionRequestTimeout(
  input: RuntimeSessionListInput | RuntimeSessionGetInput,
): number {
  const optionTimeout = readNumber(asRecord(input.options)?.appServerRequestTimeoutMs);
  return optionTimeout && optionTimeout > 0
    ? Math.floor(optionTimeout)
    : DEFAULT_SESSION_REQUEST_TIMEOUT_MS;
}

function readSessionListCache(cacheKey: string): RuntimeSession[] | null {
  const entry = sessionListCache.get(cacheKey);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    // Ленивое истечение: просроченная запись удаляется при чтении, отдельного
    // таймера-чистильщика нет - он бы держал event loop ради TTL в секунду.
    sessionListCache.delete(cacheKey);
    return null;
  }
  return cloneSessions(entry.sessions);
}

function writeSessionListCache(cacheKey: string, sessions: RuntimeSession[]): void {
  // Простое FIFO-вытеснение по порядку вставки: Map хранит ключи в порядке добавления,
  // поэтому keys().next() даёт самый старый. Полноценный LRU требовал бы обновления
  // порядка при каждом чтении и здесь избыточен.
  if (sessionListCache.size >= SESSION_LIST_CACHE_MAX_ENTRIES) {
    const oldestKey = sessionListCache.keys().next().value;
    if (oldestKey) {
      sessionListCache.delete(oldestKey);
    }
  }
  sessionListCache.set(cacheKey, {
    expiresAt: Date.now() + SESSION_LIST_CACHE_TTL_MS,
    // Кэшируем копию: исходный массив может быть возвращён вызывающему и мутирован им.
    sessions: cloneSessions(sessions),
  });
}

function cloneSessions(sessions: RuntimeSession[]): RuntimeSession[] {
  // Поверхностный клон плюс отдельная копия metadata: вложенный raw-объект thread
  // намеренно остаётся общим, он read-only и его глубокое копирование дорого.
  return sessions.map((session) => ({
    ...session,
    metadata: session.metadata ? { ...session.metadata } : undefined,
  }));
}

function buildSessionListCacheKey(input: RuntimeSessionListInput): string {
  // Ключ собирается из всех входов, влияющих на результат: поле, не попавшее в ключ,
  // заставит два разных запроса получать чужой ответ.
  return stableStringify({
    runtimeId: input.runtimeId,
    providerId: input.providerId ?? null,
    profileId: input.profileId ?? null,
    projectRoot: input.projectRoot ?? null,
    transport: input.transport ?? RuntimeTransport.APP_SERVER,
    limit: input.limit ?? 50,
    options: asRecord(input.options) ?? {},
  });
}

// Рекурсивная сериализация с сортировкой ключей - мини-версия JSON.stringify
// с детерминированным порядком: порядок свойств в options не должен менять ключ кэша,
// иначе кэш будет промахиваться на ровном месте. Порядок элементов массива значим и сохраняется.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function mapThreadToRuntimeSession(
  thread: Thread,
  input: RuntimeSessionListInput | RuntimeSessionGetInput,
): RuntimeSession {
  // Доменная модель codex (Thread) переводится в нейтральный RuntimeSession:
  // остальной код не должен знать о протоколе app-server.
  return {
    id: thread.id,
    runtimeId: input.runtimeId,
    // Приоритет источников: явный вход, затем сам диалог, и только в конце
    // жёсткий "openai". Так корректный провайдер не теряется по пути.
    providerId: input.providerId ?? thread.modelProvider ?? "openai",
    profileId: input.profileId ?? null,
    // title: имя диалога необязательно, поэтому fallback идёт на обрезанный preview.
    title: thread.name ?? truncateTitle(thread.preview) ?? null,
    createdAt: toIsoFromSeconds(thread.createdAt),
    updatedAt: toIsoFromSeconds(thread.updatedAt),
    metadata: {
      // raw сохраняется целиком: он нужен для отладки и для полей,
      // которых пока нет в RuntimeSession.
      cwd: thread.cwd,
      source: thread.source,
      status: thread.status,
      raw: thread,
    },
  };
}

function threadToRuntimeEvents(thread: Thread): RuntimeEvent[] {
  // Все события получают одну временную метку - момент последнего обновления диалога.
  // Точного времени per-turn в Thread нет, и равномерная метка честнее выдуманной.
  const timestamp = toIsoFromSeconds(thread.updatedAt);
  const events: RuntimeEvent[] = [];

  for (const turn of thread.turns) {
    for (const item of turn.items) {
      const event = threadItemToRuntimeEvent(item, timestamp);
      // Служебные элементы (рассуждения, вызовы инструментов) отбрасываются
      // на уровне преобразования через null, а не отдельной проверкой здесь.
      if (event) {
        events.push(event);
      }
    }
  }

  return events;
}

// Преобразование возвращает null для всего, что не является репликой человека
// или финальным ответом агента: интерфейсу сессии нужен только диалог.
function threadItemToRuntimeEvent(item: ThreadItem, timestamp: string): RuntimeEvent | null {
  if (item.type === "userMessage") {
    // Пустой текст после рендера означает, что в сообщении не было ни одного
    // полезного блока - показывать такое событие нечего.
    const message = renderUserInput(item.content);
    if (!message) {
      return null;
    }
    return {
      type: "session-message",
      timestamp,
      level: "info",
      message,
      data: {
        role: "user",
        id: item.id,
      },
    };
  }

  if (item.type === "agentMessage") {
    // phase отличает промежуточные рассуждения от финального ответа:
    // в историю сессии попадает только final_answer.
    if (item.phase && item.phase !== "final_answer") {
      return null;
    }
    // Проверка идёт до trim: строка из одних пробелов тоже не несёт смысла.
    if (!item.text.trim()) {
      return null;
    }
    return {
      type: "session-message",
      timestamp,
      level: "info",
      message: item.text,
      data: {
        role: "assistant",
        id: item.id,
      },
    };
  }

  return null;
}

// Пользовательский ввод - массив блоков (текст, картинки, скиллы, упоминания).
// Собираем их в один текст, разделяя пустой строкой: так вложения и текст
// не слипаются в нечитаемую строку.
function renderUserInput(content: UserInput[]): string {
  return (
    content
      .map((entry) => {
        switch (entry.type) {
          case "text":
            return entry.text;
          case "image":
            return `[image: ${entry.url}]`;
          case "localImage":
            return `[image: ${entry.path}]`;
          case "skill":
            return `[$${entry.name}](${entry.path})`;
          case "mention":
            return `[@${entry.name}](${entry.path})`;
          default:
            // Неизвестные типы блоков отбрасываются, а не рендерятся как "[object Object]":
            // сервер может добавить новый тип, и старый клиент не должен на нём падать.
            return "";
        }
      })
      // Пустые блоки фильтруются после рендера: обработчик "image" без url
      // дал бы строку "[image: undefined]".
      .filter((part) => part.trim().length > 0)
      .join("\n\n")
      .trim()
  );
}

function toIsoFromSeconds(value: number): string {
  // Протокол отдаёт время в секундах Unix, а RuntimeEvent требует ISO-строку.
  // Невалидное число не должно ронять отображение, поэтому fallback - текущее время.
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function truncateTitle(value: string | null | undefined): string | null {
  // Пустое или пробельное значение трактуется как отсутствие заголовка,
  // чтобы вызывающий код мог спокойно использовать оператор ??.
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
}

// Отсекаем массивы и примитивы: options приходят извне и могут быть чем угодно,
// а соглашение проекта требует честный | null вместо приведения типа.
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// typeof сам по себе пропустил бы NaN и Infinity, поэтому проверяется и конечность:
// как таймаут такое значение непригодно.
function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
