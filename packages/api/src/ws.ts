/**
 * WebSocket-хаб API: аутентификация подключения, реестр клиентов и рассылка
 * событий.
 *
 * Почему модуль устроен именно так:
 * - Подписки адресные: клиент получает clientId при открытии и может принимать
 *   события точечно (sendToClient), тогда как broadcast уходит всем.
 * - Один сокет лежит в нескольких структурах: clients, clientMap,
 *   socketToClientId и socketIdentity. Это не избыточность ради удобства:
 *   библиотека ws не позволяет вешать произвольные поля на объект сокета, а по
 *   картам удаление выполняется за O(1). Поэтому removeClient обязан чистить
 *   все структуры, иначе остаются висячие ссылки на закрытые сокеты.
 * - Аутентификация проверяется один раз при upgrade, а не на каждом сообщении:
 *   сообщения от клиента в эту сторону почти не идут, а identity хранится в
 *   карте и перепроверяется периодически.
 * - Сессия может быть отозвана в любой момент (logout, смена пароля или роли),
 *   поэтому перед рассылкой вызывается disconnectInvalidWebSocketSessions:
 *   иначе отозванный участник продолжал бы получать данные по живому сокету.
 * - При выключенном PARTICIPANTS_MODE_ENABLED сокеты анонимны и проверки
 *   пропускаются: локальная разработка не должна требовать логина.
 */
import type { Context, Env, Hono } from "hono";
import { upgradeWebSocket as upgradeNodeServerV2WebSocket } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { WsEvent } from "@aif/shared";
import { getEnv, logger } from "@aif/shared";
import { isParticipantSessionActive, resolveParticipantSession } from "@aif/data";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { createLegacyWebSocketBridge } from "./legacyWebSocket.js";
import { participantRequestOriginIsAllowed } from "./middleware/csrf.js";

const log = logger("ws");

// Реестр живых сокетов. clients нужен для рассылки, остальные карты - для
// адресных операций и очистки; все изменения проходят через removeClient.
let clients: Set<WebSocket> = new Set();
const clientMap: Map<string, WebSocket> = new Map();
const socketToClientId: Map<WebSocket, string> = new Map();
const socketIdentity: Map<WebSocket, WebSocketIdentity> = new Map();

// Снимок сессии на момент upgrade: expiresAt хранится строкой ISO, чтобы
// сравнение с now.toISOString() оставалось лексикографическим.
export interface WebSocketIdentity {
  participantId: string | null;
  sessionId: string | null;
  expiresAt: string | null;
}

export type WebSocketAuthorization =
  | { ok: true; identity: WebSocketIdentity }
  | {
      ok: false;
      status: 401 | 403 | 500;
      code: "authentication_required" | "invalid_origin" | "auth_store_error";
      error: string;
    };

// Разбор заголовка Cookie вручную: в upgrade-запросе нет готового разбора, а
// тянуть зависимость ради одного значения не оправдано. Пустое значение
// превращается в null, чтобы вызывающий код не различал "" и отсутствие куки.
function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    if (key !== name) continue;
    const value = item.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

// Fail closed: любая ошибка хранилища сессий запрещает подключение, а не
// пропускает его. Проверка Origin идет до чтения куки, потому что чужой сайт
// может инициировать upgrade и браузер приложит к нему куки пользователя.
export function authorizeWebSocketRequest(c: Context): WebSocketAuthorization {
  const env = getEnv();
  if (!env.PARTICIPANTS_MODE_ENABLED) {
    return {
      ok: true,
      identity: { participantId: null, sessionId: null, expiresAt: null },
    };
  }

  if (
    !participantRequestOriginIsAllowed({
      origin: c.req.header("origin"),
      allowedOrigins: env.PARTICIPANT_ALLOWED_ORIGINS,
    })
  ) {
    log.warn({ path: c.req.path }, "Rejected WebSocket request origin");
    return {
      ok: false,
      status: 403,
      code: "invalid_origin",
      error: "Invalid WebSocket origin",
    };
  }

  const token = cookieValue(c.req.header("cookie"), env.PARTICIPANT_SESSION_COOKIE_NAME);
  if (!token) {
    log.warn({ path: c.req.path }, "Rejected unauthenticated WebSocket request");
    return {
      ok: false,
      status: 401,
      code: "authentication_required",
      error: "Authentication required",
    };
  }
  try {
    const session = resolveParticipantSession(token);
    if (!session) {
      log.warn({ path: c.req.path }, "Rejected inactive WebSocket session");
      return {
        ok: false,
        status: 401,
        code: "authentication_required",
        error: "Authentication required",
      };
    }
    log.debug(
      {
        participantId: session.participant.id,
        sessionId: session.id,
      },
      "Authorized WebSocket request",
    );
    return {
      ok: true,
      identity: {
        participantId: session.participant.id,
        sessionId: session.id,
        expiresAt: session.expiresAt,
      },
    };
  } catch (error) {
    log.error({ error }, "WebSocket authentication store failed");
    return {
      ok: false,
      status: 500,
      code: "auth_store_error",
      error: "Authentication service unavailable",
    };
  }
}

// Хендлеры upgrade приходят с оберткой; наружу нужен именно экземпляр ws,
// потому что в картах реестра ключом лежит он.
function getRawWebSocket(ws: unknown): WebSocket | null {
  if (!ws || typeof ws !== "object") return null;
  const candidate = (ws as { raw?: unknown }).raw;
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as WebSocket;
}

export interface WebSocketSetup {
  injectWebSocket?: (server: ServerType) => void;
  webSocketServer?: WebSocketServer;
}

// Единственная точка удаления клиента: если чистить карты по месту, легко
// забыть одну из них и оставить утечку ссылок на закрытый сокет.
function removeClient(raw: WebSocket): void {
  const clientId = socketToClientId.get(raw);
  clients.delete(raw);
  socketIdentity.delete(raw);
  if (clientId) {
    clientMap.delete(clientId);
    socketToClientId.delete(raw);
  }
}

function createWebSocketEvents(identity: WebSocketIdentity) {
  return {
    onOpen(_event: Event, ws: unknown) {
      const raw = getRawWebSocket(ws);
      if (!raw) return;
      // clientId генерируется на сервере, а не принимается от клиента: иначе
      // клиент мог бы подменить идентификатор и читать чужие события.
      const clientId = randomUUID();
      clients.add(raw);
      clientMap.set(clientId, raw);
      socketToClientId.set(raw, clientId);
      socketIdentity.set(raw, identity);
      log.debug(
        {
          clientId,
          participantId: identity.participantId,
          sessionId: identity.sessionId,
          clientCount: clients.size,
        },
        "WebSocket client connected",
      );
      raw.send(
        JSON.stringify({
          type: "ws:connected",
          payload: { clientId, participantId: identity.participantId },
        }),
      );
    },
    onClose(_event: Event, ws: unknown) {
      const raw = getRawWebSocket(ws);
      if (!raw) return;
      const clientId = socketToClientId.get(raw);
      const participantId = socketIdentity.get(raw)?.participantId ?? null;
      removeClient(raw);
      log.debug(
        { clientId, participantId, clientCount: clients.size },
        "WebSocket client disconnected",
      );
    },
    onError(error: Event) {
      log.error({ error }, "WebSocket error");
    },
  };
}

export function setupWebSocket<E extends Env>(
  app: Hono<E>,
  nodeServerV2Enabled = false,
): WebSocketSetup {
  // WeakMap привязывает результат авторизации к конкретному запросу upgrade:
  // хендлер onOpen не получает Context, и передать identity иначе нечем.
  // WeakMap не держит запрос живым после завершения handshake.
  const authorizedRequests = new WeakMap<Request, WebSocketIdentity>();
  const authorizeUpgrade = async (c: Context, next: () => Promise<void>) => {
    const authorization = authorizeWebSocketRequest(c);
    if (!authorization.ok) {
      return c.json({ error: authorization.error, code: authorization.code }, authorization.status);
    }
    authorizedRequests.set(c.req.raw, authorization.identity);
    await next();
  };
  const eventsForRequest = (c: Context) =>
    createWebSocketEvents(
      authorizedRequests.get(c.req.raw) ?? {
        participantId: null,
        sessionId: null,
        expiresAt: null,
      },
    );

  if (nodeServerV2Enabled) {
    // Ветка для нового node-server: сервер сам управляет upgrade, поэтому
    // noServer и внешний inject не нужны.
    const webSocketServer = new WebSocketServer({ noServer: true });
    app.get("/ws", authorizeUpgrade, upgradeNodeServerV2WebSocket(eventsForRequest));
    return { webSocketServer };
  }

  // Легаси-путь требует ручного injectWebSocket в HTTP-сервер: иначе upgrade
  // до сокета не доходит.
  const legacyBridge = createLegacyWebSocketBridge(app);
  app.get(
    "/ws",
    authorizeUpgrade,
    legacyBridge.upgradeWebSocket(eventsForRequest, {
      onError(error) {
        log.error({ error }, "Legacy WebSocket handler error");
      },
    }),
  );

  return { injectWebSocket: legacyBridge.injectWebSocket };
}

// Перед адресной отправкой прогоняем проверку сессий: клиент мог быть отозван
// между сообщениями, и отправка в такой сокет раскрывает данные зря.
export function sendToClient(clientId: string, event: WsEvent): boolean {
  disconnectInvalidWebSocketSessions();
  const client = clientMap.get(clientId);
  if (!client || client.readyState !== client.OPEN) {
    log.debug({ clientId, event: event.type }, "sendToClient: client not found or not open");
    return false;
  }
  client.send(JSON.stringify(event));
  log.debug({ clientId, event: event.type }, "Sent WS event to client");
  return true;
}

export function broadcast(event: WsEvent): void {
  // Отзыв сессии адресный: рассылать его всем бессмысленно, а конкретному
  // участнику мало отправить событие - сокет нужно закрыть.
  if (event.type === "auth:session_revoked") {
    const payload = event.payload as { participantId?: unknown };
    if (typeof payload.participantId === "string") {
      const disconnected = disconnectParticipantWebSockets(payload.participantId);
      log.info(
        { event: event.type, participantId: payload.participantId, disconnected },
        "Delivered participant-targeted WS event",
      );
      return;
    }
  }
  disconnectInvalidWebSocketSessions();
  const data = JSON.stringify(event);
  let sent = 0;
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(data);
      sent++;
    }
  }
  log.info(
    { event: event.type, clientsSent: sent, clientsTotal: clients.size },
    "Broadcast WS event",
  );
}

export function getConnectedWebSocketClientCount(): number {
  return clients.size;
}

export function disconnectParticipantWebSockets(participantId: string): number {
  let disconnected = 0;
  for (const client of [...clients]) {
    if (socketIdentity.get(client)?.participantId !== participantId) continue;
    removeClient(client);
    client.terminate();
    disconnected += 1;
  }
  if (disconnected > 0) {
    log.info({ participantId, disconnected }, "Disconnected participant WebSocket sessions");
  }
  return disconnected;
}

export function disconnectInvalidWebSocketSessions(now = new Date()): number {
  let disconnected = 0;
  for (const client of [...clients]) {
    const identity = socketIdentity.get(client);
    if (!identity?.sessionId) continue;
    let active = false;
    try {
      // Двойная проверка: дешевое сравнение строк отсекает истекшие сессии без
      // обращения к базе, а запрос к базе ловит отозванные досрочно.
      active =
        Boolean(identity.expiresAt && identity.expiresAt > now.toISOString()) &&
        isParticipantSessionActive(identity.sessionId, now);
    } catch (error) {
      log.error(
        {
          error,
          participantId: identity.participantId,
          sessionId: identity.sessionId,
        },
        "WebSocket session validation failed",
      );
    }
    if (active) continue;
    removeClient(client);
    client.terminate();
    disconnected += 1;
  }
  if (disconnected > 0) {
    log.info({ disconnected }, "Disconnected invalid WebSocket sessions");
  }
  return disconnected;
}

// Периодический свип: событие об отзыве сессии может не дойти, например при
// рестарте API, поэтому истекшие сокеты закрываются по таймеру. unref
// позволяет процессу завершиться, не дожидаясь этого интервала.
setInterval(() => {
  disconnectInvalidWebSocketSessions();
}, 30_000).unref();

/**
 * Принудительно закрывает все открытые WebSocket-соединения.
 * Используется при штатной остановке, чтобы HTTP-сервер мог завершиться
 * без ожидания долгоживущих клиентов WS.
 */
export function closeAllWebSocketClients(): void {
  const count = clients.size;
  for (const client of clients) {
    try {
      client.terminate();
    } catch {
      // Завершение best-effort: сокет мог быть уже частично закрыт.
    }
  }
  // Чистим все структуры реестра до завершения процесса: иначе осиротевшие
  // записи попадут в отчеты и метрики на выходе.
  clients.clear();
  clientMap.clear();
  socketToClientId.clear();
  socketIdentity.clear();
  if (count > 0) {
    log.info({ closed: count }, "Terminated all WebSocket clients on shutdown");
  }
}
