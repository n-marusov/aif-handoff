import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { logger } from "@aif/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpEnv } from "./env.js";
import { RateLimiter } from "./middleware/rateLimit.js";
import type { ToolContext } from "./tools/index.js";
import { register as registerListTasks } from "./tools/listTasks.js";
import { register as registerGetTask } from "./tools/getTask.js";
import { register as registerSearchTasks } from "./tools/searchTasks.js";
import { register as registerListProjects } from "./tools/listProjects.js";
import { register as registerCreateTask } from "./tools/createTask.js";
import { register as registerUpdateTask } from "./tools/updateTask.js";
import { register as registerSyncStatus } from "./tools/syncStatus.js";
import { register as registerPushPlan } from "./tools/pushPlan.js";
import { register as registerAnnotatePlan } from "./tools/annotatePlan.js";

const log = logger("mcp");

/**
 * Собирает общий контекст инструментов (ограничитель частоты) один раз при запуске.
 *
 * В HTTP-режиме на каждый запрос создаётся новый {@link McpServer}, но каждый
 * запрос обязан делить этот контекст: {@link RateLimiter} хранит stateful-корзины
 * токенов в памяти, поэтому пересоздание на каждый запрос сбрасывало бы корзины
 * и молча отключало лимитирование частоты.
 */
export function createToolContext(env: McpEnv): ToolContext {
  const rateLimiter = new RateLimiter(
    { rpm: env.rateLimitReadRpm, burst: env.rateLimitReadBurst },
    { rpm: env.rateLimitWriteRpm, burst: env.rateLimitWriteBurst },
  );

  log.debug(
    {
      read: { rpm: env.rateLimitReadRpm, burst: env.rateLimitReadBurst },
      write: { rpm: env.rateLimitWriteRpm, burst: env.rateLimitWriteBurst },
    },
    "Shared tool context created",
  );

  return { rateLimiter };
}

/**
 * Создаёт {@link McpServer} и регистрирует все инструменты в общем контексте.
 * Дёшево вызывать — безопасно создавать новый на запрос в stateless HTTP-режиме.
 */
export function createMcpServer(context: ToolContext): McpServer {
  const server = new McpServer(
    {
      name: "handoff-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Регистрация инструментов только для чтения
  registerListTasks(server, context);
  registerGetTask(server, context);
  registerSearchTasks(server, context);
  registerListProjects(server, context);

  // Регистрация инструментов записи
  registerCreateTask(server, context);
  registerUpdateTask(server, context);
  registerSyncStatus(server, context);
  registerPushPlan(server, context);
  registerAnnotatePlan(server, context);

  return server;
}

type McpDispatcher = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function bearerToken(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}

function tokensMatch(candidate: string | null, configured: string): boolean {
  if (!candidate) return false;
  const candidateBuffer = Buffer.from(candidate, "utf8");
  const configuredBuffer = Buffer.from(configured, "utf8");
  return (
    candidateBuffer.length === configuredBuffer.length &&
    timingSafeEqual(candidateBuffer, configuredBuffer)
  );
}

/**
 * Собирает Node-обработчик HTTP-запросов. Открыт (вместе с фабриками выше) для
 * тестов, чтобы маршрутизацию и связывание транспорта можно было проверять
 * без привязки порта и без импорта точки входа (`index.ts` сам запускает `main()` при импорте).
 *
 * Маршрутизация (`/health`, `/mcp`, 404) общая; поведение `/mcp` выбирается
 * ОДИН РАЗ, при сборке обработчика, по `env.httpMultiSession`:
 *  - `true`  → stateless server/transport на каждый запрос (несколько клиентов
 *              подключаются параллельно — см. {@link createStatelessMcpDispatcher}).
 *  - `false` → legacy один общий stateful-транспорт, сохраняющий прежнее
 *              поведение (см. {@link createSingleSessionMcpDispatcher}).
 */
export function createMcpHttpHandler(env: McpEnv, context: ToolContext) {
  const handleMcp = env.httpMultiSession
    ? createStatelessMcpDispatcher(context)
    : createSingleSessionMcpDispatcher(context);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://localhost:${env.httpPort}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (url.pathname === "/mcp") {
      const token = bearerToken(
        Array.isArray(req.headers.authorization)
          ? req.headers.authorization[0]
          : req.headers.authorization,
      );
      if (!env.authToken || !tokensMatch(token, env.authToken)) {
        log.warn(
          { method: req.method, path: url.pathname },
          "Rejected unauthorized MCP HTTP request",
        );
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
        });
        res.end(
          JSON.stringify({
            error: "Unauthorized",
            code: "mcp_authentication_required",
          }),
        );
        return;
      }
      log.debug({ method: req.method, path: url.pathname }, "Authorized MCP HTTP request");
      await handleMcp(req, res);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  };
}

/**
 * Мультисессионный транспорт (opt-in через `AIF_MCP_HTTP_MULTI_SESSION_ENABLED`).
 *
 * {@link StreamableHTTPServerTransport} без `sessionIdGenerator` обслуживает
 * ровно ОДИН запрос, поэтому на каждый POST создаётся свежая пара server + transport.
 * Так каждый клиент (каждое окно Claude Code) инициализируется независимо, а не
 * сталкивается на одной общей stateful-сессии (вторая получала -32600
 * "Server already initialized"). События server->client не проходят через этот
 * транспорт — они публикуются через broadcast-эндпоинт API — поэтому
 * отслеживание сессий не требуется.
 *
 * Stateless-путь работает только как запрос/ответ: принимает `POST` и отклоняет
 * остальные методы кодом `405`. Клиент SDK после инициализации открывает
 * необязательный `GET /mcp` SSE-поток и трактует `405` как «сервер не предлагает
 * SSE»; отказ от GET не держит простой server/transport на каждого подключённого
 * клиента ради событий, которые через этот транспорт не публикуются вовсе.
 */
function createStatelessMcpDispatcher(context: ToolContext): McpDispatcher {
  return async (req, res) => {
    log.debug({ method: req.method, mode: "multi-session" }, "MCP request received");

    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end("Method Not Allowed");
      return;
    }

    const server = createMcpServer(context);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      log.debug("MCP request closed — tearing down per-request server/transport");
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error) },
        "MCP request handling failed",
      );
      respondInternalError(res);
    }
  };
}

/**
 * Legacy односессионный транспорт (по умолчанию, флаг выключен).
 *
 * ОДИН server + ОДИН stateful-транспорт, общие на весь процесс, подключаемые
 * один раз (лениво) на первом запросе. Это сохраняет поведение до мультисессий:
 * `initialize` второго клиента по-прежнему возвращает -32600 "Server already
 * initialized". Оставлено за `AIF_MCP_HTTP_MULTI_SESSION_ENABLED`, чтобы включение
 * параллельных клиентов было явным, осознанным развёртыванием, а не
 * безусловной сменой внешнего контракта MCP-транспорта.
 */
function createSingleSessionMcpDispatcher(context: ToolContext): McpDispatcher {
  const server = createMcpServer(context);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  let connected: Promise<void> | null = null;

  return async (req, res) => {
    log.debug({ method: req.method, mode: "single-session" }, "MCP request received");
    try {
      connected ??= server.connect(transport);
      await connected;
      await transport.handleRequest(req, res);
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error) },
        "MCP request handling failed",
      );
      respondInternalError(res);
    }
  };
}

/** Отправляет JSON-RPC-ответ с внутренней ошибкой, если заголовки ещё не отправлены. */
function respondInternalError(res: ServerResponse): void {
  if (res.headersSent) return;
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: null,
    }),
  );
}

export { loadMcpEnv } from "./env.js";
export { RateLimiter } from "./middleware/rateLimit.js";
export { toMcpError, rateLimitError, validationError } from "./middleware/errorHandler.js";
export type { ToolContext, ToolRegistrar } from "./tools/index.js";
