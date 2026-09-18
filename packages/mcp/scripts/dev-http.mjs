import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnDev } from "../../../scripts/lib/spawn-dev.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Этот скрипт всегда запускает MCP в HTTP-режиме, поэтому некорректные значения
// здесь фатальны. Корневой сценарий dev-запуска (scripts/dev.mjs) относится к
// HTTP-режиму MCP как к опциональному.
function resolveMcpPort(value) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "3100";
  }

  const port = Number(trimmed);
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    return String(port);
  }

  throw new Error(`Invalid MCP_PORT: ${trimmed}. Must be an integer between 1 and 65535.`);
}

const port = resolveMcpPort(process.env.MCP_PORT);
console.log(`[mcp] Starting HTTP transport on port ${port}`);

spawnDev({
  command: "node",
  args: ["--watch", "--import", "tsx", "src/index.ts"],
  cwd: packageRoot,
  env: {
    ...process.env,
    MCP_TRANSPORT: "http",
    MCP_PORT: port,
  },
  label: "mcp",
});
