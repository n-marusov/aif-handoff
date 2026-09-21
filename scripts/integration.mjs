// Интеграционный гейт: прогон тестов против реальных внешних сервисов.
//
// Что делает:
//   1. Загружает `.env.integration` (если существует) в process.env, НЕ
//      перезаписывая уже заданные переменные (явное окружение главнее файла).
//   2. Выставляет флаги-гейты: AIF_LLM_INTEGRATION / AIF_GITLAB_INTEGRATION.
//   3. Проверяет обязательные настройки и доступность стенда (fail-fast с
//      ясным сообщением — интеграционный гейт обязан падать громко, а не
//      молча пропускать тесты).
//   4. Прогоняет vitest по нужным воркспейсам/файлам и возвращает ненулевой
//      код при падении любого набора.
//
// Настройки берутся из `.env.integration` (см. README/AGENTS.md): он должен
// существовать локально и обычно создаётся копированием из `.env.e2e`:
//   cp .env.e2e .env.integration
//
// Использование:
//   node scripts/integration.mjs            # LLM + GitLab
//   node scripts/integration.mjs --llm      # только LLM (@aif/runtime)
//   node scripts/integration.mjs --gitlab   # только GitLab (@aif/api)

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_FILE = `${REPO_ROOT}.env.integration`;
const GITLAB_READY_TIMEOUT_MS = 30_000;
const GITLAB_READY_POLL_MS = 1_000;

function log(message) {
  console.log(`[integration] ${message}`);
}

function fail(message) {
  console.error(`[integration] ERROR: ${message}`);
}

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && value) values[key] = value;
  }
  return values;
}

function loadEnvFile() {
  const values = parseEnvFile(ENV_FILE);
  for (const [key, value] of Object.entries(values)) {
    // Явно заданное окружение процесса не перебиваем файлом.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function requireNonEmpty(names, label) {
  const missing = names.filter((name) => !(process.env[name] ?? "").trim());
  if (missing.length === 0) return;
  fail(
    `missing required ${label} settings in .env.integration: ${missing.join(", ")}. ` +
      `Create ${ENV_FILE} (e.g. copy .env.e2e and adjust hosts/ports).`,
  );
}

async function waitForGitLab(baseUrl) {
  const startedAt = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/version`, {
        headers: { "PRIVATE-TOKEN": process.env.GITLAB_TOKEN ?? "" },
      });
      if (response.ok) return true;
    } catch {
      // Стенд ещё поднимается.
    }
    if (Date.now() - startedAt >= GITLAB_READY_TIMEOUT_MS) return false;
    await new Promise((resolve) => setTimeout(resolve, GITLAB_READY_POLL_MS));
  }
}

/**
 * Запускает npm run test в воркспейсе, ожидает завершения и возвращает код.
 * Отличается от spawnDev тем, что НЕ завершает текущий процесс на exit
 * дочернего — гейт должен успеть прогнать оба набора и вернуть сводный код.
 */
async function runSuite(workspace, testFile, label) {
  log(`running ${label} (${workspace} ${testFile})`);
  const args = ["run", "test", `--workspace=${workspace}`, "--", testFile];
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", "npm", ...args], {
          cwd: REPO_ROOT,
          stdio: "inherit",
          env: process.env,
        })
      : spawn("npm", args, {
          cwd: REPO_ROOT,
          stdio: "inherit",
          env: process.env,
        });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) {
    log(`${label}: FAILED (exit ${code ?? signal})`);
    return 1;
  }
  log(`${label}: OK`);
  return 0;
}

async function main() {
  const args = process.argv.slice(1);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node scripts/integration.mjs [--llm] [--gitlab]");
    return;
  }
  const wantsLlm = !args.includes("--gitlab");
  const wantsGitlab = !args.includes("--llm");

  loadEnvFile();

  let failed = false;

  if (wantsLlm) {
    process.env.AIF_LLM_INTEGRATION = "1";
    requireNonEmpty(["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"], "LLM");
    if (await runSuite("@aif/runtime", "codexApi.integration.test.ts", "llm")) failed = true;
  }

  if (wantsGitlab) {
    process.env.AIF_GITLAB_INTEGRATION = "1";
    requireNonEmpty(["AIF_GITLAB_BASE_URL", "GITLAB_TOKEN"], "GitLab");
    const baseUrl = (process.env.AIF_GITLAB_BASE_URL ?? "").trim().replace(/\/+$/, "");
    if (!(await waitForGitLab(baseUrl))) {
      fail(
        `GitLab stand at ${baseUrl} is not reachable. Prepare the E2E stack first: ` +
          `"make e2e-docker" (docker-compose.e2e.yml brings up gitlab + provisions root/e2e-target).`,
      );
      failed = true;
    } else if (await runSuite("@aif/api", "gitlab.integration.test.ts", "gitlab")) {
      failed = true;
    }
  }

  process.exitCode = failed ? 1 : 0;
}

main();
