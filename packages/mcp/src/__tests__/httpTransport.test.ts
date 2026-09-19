import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTestDb } from "@aif/data/db";

// Готовим in-memory тестовую БД до импорта сервера (тулзы попадают в БД
// через @aif/data → @aif/data/db getDb).
const testDb = { current: createTestDb() };
vi.mock("@aif/data/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/data/db")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

// Мокируем env, чтобы избежать валидации общего окружения.
vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => ({
      API_BASE_URL: "http://localhost:3009",
      DATABASE_URL: ":memory:",
      PORT: 3009,
    }),
  };
});

// Импортируем обработчик из server.ts — НЕ из index.ts, который сам запускает main().
const { createMcpHttpHandler, createToolContext } = await import("../server.js");

const env = {
  apiUrl: "http://localhost:3009",
  transport: "http" as const,
  httpPort: 0,
  rateLimitReadRpm: 120,
  rateLimitWriteRpm: 30,
  rateLimitReadBurst: 10,
  rateLimitWriteBurst: 5,
  // В основном наборе проверяем opt-in путь stateless-мультисессий.
  httpMultiSession: true,
  participantsModeEnabled: false,
  authToken: "dedicated-mcp-token",
};

/** POST произвольного JSON-RPC-сообщения с заголовками, которые требует SDK (иначе 406). */
function postRpc(
  port: number,
  body: Record<string, unknown>,
  authToken: string | null = env.authToken,
): Promise<Response> {
  return fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // SDK вернёт 406, если клиент не принимает ОБА типа содержимого.
      Accept: "application/json, text/event-stream",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** POST JSON-RPC-запроса `initialize`. */
function initialize(port: number, authToken: string | null = env.authToken): Promise<Response> {
  return postRpc(
    port,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
    },
    authToken,
  );
}

/** Читает JSON-RPC-полезную нагрузку из ответа JSON или SSE (`data:`). */
async function readJsonRpc(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return text ? (JSON.parse(text) as Record<string, unknown>) : null;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (payload) return JSON.parse(payload) as Record<string, unknown>;
    }
  }
  return null;
}

describe("MCP HTTP transport — multi-session (opt-in)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const context = createToolContext(env);
    server = createServer(createMcpHttpHandler(env, context));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves /health for Docker healthchecks", async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("requires a bearer token even when Participants Mode is disabled", async () => {
    const response = await initialize(port, null);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "mcp_authentication_required" });
  });

  it("lets two independent clients initialize without -32600", async () => {
    // Ключевая регрессия: при одном общем stateful-транспорте второй
    // initialize возвращал -32600 "Server already initialized". Stateless
    // транспорты на каждый запрос дают каждому клиенту инициализироваться независимо.
    const res1 = await initialize(port);
    const body1 = await readJsonRpc(res1);
    const res2 = await initialize(port);
    const body2 = await readJsonRpc(res2);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect((body1?.error as { code?: number } | undefined)?.code).not.toBe(-32600);
    expect((body2?.error as { code?: number } | undefined)?.code).not.toBe(-32600);
    expect(body1?.result).toBeDefined();
    expect(body2?.result).toBeDefined();
  });

  it("lets a client initialize then list tools through the stateless path", async () => {
    // Доказывает, что реальный сценарий MCP работает, а не только handshake initialize:
    // изменение транспорта, чинящее init, но ломающее tools/list,
    // было бы поймано здесь. Stateless-транспорты на каждый запрос не требуют
    // предварительного initialize на том же соединении, поэтому свежий POST перечисляет тулзы.
    const initRes = await initialize(port);
    expect(initRes.status).toBe(200);
    await readJsonRpc(initRes);

    const listRes = await postRpc(port, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const listBody = await readJsonRpc(listRes);

    expect(listRes.status).toBe(200);
    expect(listBody?.error).toBeUndefined();
    const tools = (listBody?.result as { tools?: unknown[] } | undefined)?.tools;
    expect(Array.isArray(tools)).toBe(true);
    expect((tools as unknown[]).length).toBeGreaterThan(0);
  });

  it("rejects non-POST /mcp with 405 instead of opening an idle SSE stream", async () => {
    // Клиент SDK после init открывает необязательный GET SSE-поток и воспринимает 405
    // как «у сервера нет SSE». События публикуются вне полосы через
    // broadcast-эндпоинт API, поэтому разрешение GET держало бы простой server/transport на
    // каждого клиента без пользы — значит stateless-путь принимает только POST.
    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${env.authToken}`,
      },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
    await res.text();
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`http://localhost:${port}/unknown`);
    expect(res.status).toBe(404);
    await res.text();
  });

  it("createToolContext builds one stateful, shared RateLimiter", () => {
    // Обработчик замыкается на одном контексте, поэтому каждый сервер на запрос
    // делит этот ограничитель. Если бы он пересоздавался на каждый запрос, корзина
    // сбрасывалась бы и лимитирование молча ломалось — поэтому проверяем,
    // что состояние корзины накапливается между вызовами.
    const context = createToolContext(env);
    for (let i = 0; i < env.rateLimitReadBurst; i++) {
      expect(context.rateLimiter.check("listTasks", "read")).toBe(true);
    }
    expect(context.rateLimiter.check("listTasks", "read")).toBe(false);
  });
});

describe("MCP HTTP transport — Participants Mode bearer auth", () => {
  const protectedEnv = {
    ...env,
    participantsModeEnabled: true,
    authToken: "dedicated-mcp-token",
  };
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const context = createToolContext(protectedEnv);
    server = createServer(createMcpHttpHandler(protectedEnv, context));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("keeps health public but rejects missing and invalid MCP bearer tokens", async () => {
    expect((await fetch(`http://localhost:${port}/health`)).status).toBe(200);

    const missing = await initialize(port, null);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({
      code: "mcp_authentication_required",
    });
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");

    const invalid = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
      }),
    });
    expect(invalid.status).toBe(401);
  });

  it("accepts the exact dedicated MCP bearer token", async () => {
    const response = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer dedicated-mcp-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect((await readJsonRpc(response))?.result).toBeDefined();
  });
});

describe("MCP HTTP transport — legacy single-session (default, flag off)", () => {
  const legacyEnv = { ...env, httpMultiSession: false };
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const context = createToolContext(legacyEnv);
    server = createServer(createMcpHttpHandler(legacyEnv, context));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("preserves previous behavior: the 2nd client initialize collides with -32600", async () => {
    // С выключенным флагом на весь процесс переиспользуется один общий stateful-
    // транспорт. Первый клиент инициализируется, второй сталкивается — ровно то
    // поведение до исправления, которое гейтит AIF_MCP_HTTP_MULTI_SESSION_ENABLED.
    const res1 = await initialize(port);
    const body1 = await readJsonRpc(res1);
    expect(res1.status).toBe(200);
    expect(body1?.result).toBeDefined();

    const res2 = await initialize(port);
    const body2 = await readJsonRpc(res2);
    expect((body2?.error as { code?: number } | undefined)?.code).toBe(-32600);
  });
});
