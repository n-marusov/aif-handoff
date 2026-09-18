// stdioEnv обязан импортироваться первым — он направляет логи в stderr до
// инициализации логгера @aif/shared, оставляя stdout чистым для stdio JSON-RPC.
import "./stdioEnv.js";
import { createServer } from "node:http";
import { logger } from "@aif/shared";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadMcpEnv } from "./env.js";
import type { McpEnv } from "./env.js";
import { createToolContext, createMcpServer, createMcpHttpHandler } from "./server.js";

const log = logger("mcp");

async function startStdio(env: McpEnv) {
  const context = createToolContext(env);
  const server = createMcpServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP server connected via stdio transport");
}

async function startHttp(env: McpEnv) {
  const context = createToolContext(env);
  const httpServer = createServer(createMcpHttpHandler(env, context));

  httpServer.listen(env.httpPort, () => {
    log.info(
      { port: env.httpPort, endpoint: "/mcp" },
      "MCP server listening via Streamable HTTP transport",
    );
  });

  // Корректное завершение, чтобы порт освобождался при Ctrl+C / перезагрузке tsx-watch.
  // Выходим синхронно — tsx watch + turbo конфликтуют при Ctrl+C и ругаются
  // «Previous process hasn't exited yet», если закрытие асинхронное.
  let shuttingDown = false;
  const onShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "Shutdown signal received — exiting");
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", () => onShutdown("SIGINT"));
  process.on("SIGTERM", () => onShutdown("SIGTERM"));
}

async function main() {
  const env = loadMcpEnv();

  log.info(
    {
      transport: env.transport,
      httpPort: env.httpPort,
    },
    "MCP server starting",
  );

  if (env.transport === "http") {
    await startHttp(env);
  } else {
    await startStdio(env);
  }
}

main().catch((error) => {
  log.error(
    { error: error instanceof Error ? error.message : String(error) },
    "MCP server failed to start",
  );
  process.exit(1);
});

// Публичная поверхность для потребителей пакета @aif/mcp.
export { loadMcpEnv, RateLimiter, toMcpError, rateLimitError, validationError } from "./server.js";
export type { ToolContext, ToolRegistrar } from "./server.js";
