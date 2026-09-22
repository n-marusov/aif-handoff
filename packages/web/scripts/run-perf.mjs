import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const PERF_API_PORT = Number(process.env.AIF_PERF_API_PORT ?? 39009);
const PERF_WEB_PORT = Number(process.env.AIF_PERF_WEB_PORT ?? 35180);
const READY_URL = process.env.AIF_WEB_URL ?? `http://localhost:${PERF_WEB_PORT}`;
const PERF_API_URL = process.env.AIF_PERF_API_URL ?? `http://localhost:${PERF_API_PORT}`;
const PERF_WS_URL = process.env.AIF_PERF_WS_URL ?? `ws://localhost:${PERF_API_PORT}/ws`;
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 500;
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function quoteWindowsArg(value) {
  if (/^[\w./:=@-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function commandSpec(command, args) {
  if (process.platform !== "win32") {
    return { command, args };
  }

  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(quoteWindowsArg).join(" ")],
  };
}

function isValidEnvKey(key) {
  return key.length > 0 && !key.includes("=") && !key.includes("\0");
}

function buildSpawnEnv(extraEnv = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!isValidEnvKey(key) || value === undefined) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (!isValidEnvKey(key) || value === undefined) continue;
    env[key] = String(value);
  }
  return env;
}

function spawnInherited(command, args, options = {}) {
  const { env: extraEnv, ...spawnOptions } = options;
  const spec = commandSpec(command, args);
  return spawn(spec.command, spec.args, {
    stdio: "inherit",
    ...spawnOptions,
    env: buildSpawnEnv(extraEnv),
  });
}

async function waitForReady(child) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    if (child.exitCode !== null) {
      throw new Error(`dev:perf exited before ${READY_URL} became ready`);
    }

    try {
      const response = await fetch(READY_URL, { method: "HEAD" });
      if (response.status >= 200 && response.status < 500) return;
    } catch {
      // Сервер ещё поднимается.
    }

    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }

  throw new Error(`Timed out waiting ${READY_TIMEOUT_MS}ms for ${READY_URL}`);
}

function stopDevServer(child) {
  if (child.exitCode !== null) return;

  try {
    if (child.pid && process.platform === "win32") {
      spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
      });
      return;
    }
    if (child.pid && process.platform !== "win32") {
      process.kill(-child.pid, "SIGTERM");
      return;
    }
    child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function run() {
  const dev = spawnInherited("npm", ["run", "dev:perf"], {
    cwd: REPO_ROOT,
    detached: process.platform !== "win32",
    env: {
      AIF_ENABLE_CODEX_LOGIN_PROXY: "false",
      PARTICIPANTS_MODE_ENABLED: "false",
      PORT: String(PERF_API_PORT),
      AIF_API_PORT: String(PERF_API_PORT),
      API_BASE_URL: PERF_API_URL,
      WEB_PORT: String(PERF_WEB_PORT),
    },
  });

  const devExit = once(dev, "exit").then(([code, signal]) => ({ code, signal }));

  try {
    await waitForReady(dev);

    const perf = spawnInherited(
      "playwright",
      ["test", "--config=playwright.config.ts", "e2e/perf"],
      {
        cwd: WEB_ROOT,
        env: {
          AIF_SKIP_DEV_SERVER: "1",
          AIF_WEB_URL: READY_URL,
          AIF_PERF_API_URL: PERF_API_URL,
          AIF_E2E_API_URL: PERF_API_URL,
          AIF_E2E_WS_URL: PERF_WS_URL,
        },
      },
    );
    const [code, signal] = await once(perf, "exit");
    if (code !== 0) {
      throw new Error(`playwright exited with ${code ?? signal}`);
    }
  } finally {
    stopDevServer(dev);
    await Promise.race([devExit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
