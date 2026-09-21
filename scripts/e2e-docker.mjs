// E2E: поднимает стек docker-compose (включая тестовый GitLab) и гоняет
// Playwright-спектры против него.
//
// Что делает скрипт:
//   1. Создаёт `.env` из `.env.example` (базовый compose объявляет
//      `env_file: .env`) и `.env.e2e` из `.env.e2e.example` — окружение E2E,
//      которое задаёт изолированные host-порты стека (не пересекаются с dev).
//   2. Поднимает стек: `docker compose --env-file .env.e2e -f
//      docker-compose.yml -f docker-compose.e2e.yml up -d` (образы собираются
//      при первом запуске, дальше переиспользуются).
//   3. Ждёт готовности API (`/health`), web (`/`) и GitLab (`/-/health`).
//   4. Идемпотентно сеет эталонный проект E2E (c1de80b3-...) в БД контейнера
//      api — GUI-спектры ходят на `/project/<этот id>`, а доска не рендерится,
//      если проекта нет в `GET /projects`.
//   5. Идемпотентно провижинит тестовый GitLab:
//        - root-пользователя с паролем GITLAB_ROOT_PASSWORD, если его нет
//          (первичный сиид GitLab может не отработать — см. ensureGitLabRootUser);
//        - root PAT с фиксированным значением GITLAB_TOKEN (rails runner),
//          если токена с именем aif-e2e ещё нет;
//        - тестовый репозиторий root/e2e-target с README (Issue → MR → Approve
//          → comment → merge), если проекта нет.
//   6. Запускает Playwright с `AIF_SKIP_DEV_SERVER=1`, чтобы config не
//      поднимал собственный dev-стек (webServer), а подключался к compose.
//
// Стек после прогона остаётся поднятым (аналог `make docker-dev`);
// остановка — `make docker-dev-down`.
//
// Режимы:
//   (без аргументов) # полный прогон: подготовка + GUI + API (аналог --all)
//   node scripts/e2e-docker.mjs --prepare   # только подготовка стека
//   node scripts/e2e-docker.mjs --gui       # подготовка + GUI-спектры
//   node scripts/e2e-docker.mjs --api       # подготовка + API-спектры
//   node scripts/e2e-docker.mjs --all       # подготовка + GUI + API
//   node scripts/e2e-docker.mjs --down      # остановить E2E-стек и удалить тома
//
// Кросс-платформенно: на Windows команды запускаются через cmd.exe, как в
// scripts/dev.mjs / packages/web/scripts/run-perf.mjs.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Файлы окружения.
const DEV_ENV_FILE = `${REPO_ROOT}.env`;
const DEV_ENV_EXAMPLE = `${REPO_ROOT}.env.example`;
const E2E_ENV_FILE = `${REPO_ROOT}.env.e2e`;
const E2E_ENV_EXAMPLE = `${REPO_ROOT}.env.e2e.example`;

// Compose-файлы: базовый dev-стек + e2e-расширение (тестовый GitLab).
const COMPOSE_FILES = ["-f", "docker-compose.yml", "-f", "docker-compose.e2e.yml"];

// Port по умолчанию совпадает с дефолтами compose и тестов; при переопределении
// в `.env.e2e` (PORT/WEB_PORT) скрипт подхватывает эти значения, чтобы URL-ы
// тестов и стенда не разошлись.
const DEFAULT_API_PORT = 3009;
const DEFAULT_WEB_PORT = 5180;
const DEFAULT_GITLAB_WEB_PORT = 8929;
// Пароль root по умолчанию. Значение обязано проходить проверку сложности
// GitLab (без словарных слов и без username "root") — иначе первичный сиид
// 003_admin.rb падает и root-пользователь не создаётся.
const DEFAULT_GITLAB_ROOT_PASSWORD = "Xq7Zt2Lm9Vb4Kp";

const READY_TIMEOUT_MS = 600_000;
const READY_POLL_MS = 1_000;
// Первый запуск GitLab CE (reconfigure + миграции) занимает минуты.
const GITLAB_READY_TIMEOUT_MS = 20 * 60_000;
const GITLAB_READY_POLL_MS = 3_000;

const E2E_PROJECT = {
  id: "c1de80b3-2ba0-48c7-9f04-2d777472d218",
  name: "VNC",
  // Путь внутри контейнера: compose монтирует PROJECTS_DIR в /home/www.
  rootPath: "/home/www/vnc",
};

// Тестовый репозиторий в GitLab (namespace root = пользователь root).
const GITLAB_TEST_PROJECT = {
  pathWithNamespace: "root/e2e-target",
  name: "e2e-target",
  description: "AIF Handoff E2E test repository (Issue -> MR -> Approve -> comment -> merge)",
};

function log(message) {
  console.log(`[e2e-docker] ${message}`);
}

function fail(message) {
  console.error(`[e2e-docker] ERROR: ${message}`);
  process.exitCode = 1;
}

function parseEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && value) values[key] = value;
  }
  return values;
}

function quoteWindowsArg(value) {
  if (/^[\w./:=@-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Экранирует значение для одинарной ruby-строки (пароли/токены с кавычками). */
function rubyString(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
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
  const { env: extraEnv, stdin, ...spawnOptions } = options;
  const spec = commandSpec(command, args);
  const stdinValue = typeof stdin === "string" ? Buffer.from(stdin, "utf8") : (stdin ?? undefined);
  const child = spawn(spec.command, spec.args, {
    stdio: stdinValue === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    ...spawnOptions,
    env: buildSpawnEnv(extraEnv),
  });
  if (stdinValue !== undefined) {
    child.stdin.write(stdinValue);
    child.stdin.end();
  }
  return child;
}

async function runCommand(command, args, options = {}) {
  const child = spawnInherited(command, args, options);
  const [code, signal] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(`${command} exited with ${code ?? signal}`);
  }
}

/** Запускает команду и возвращает её stdout (для парсинга вывода). */
async function runCommandCapture(command, args, options = {}) {
  const { env: extraEnv, stdin, ...spawnOptions } = options;
  const spec = commandSpec(command, args);
  const stdinValue = typeof stdin === "string" ? Buffer.from(stdin, "utf8") : (stdin ?? undefined);
  const child = spawn(spec.command, spec.args, {
    stdio: ["pipe", "pipe", "inherit"],
    ...spawnOptions,
    env: buildSpawnEnv(extraEnv),
  });
  if (stdinValue !== undefined) {
    child.stdin.write(stdinValue);
    child.stdin.end();
  }
  const stdout = await new Promise((resolve) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stdout.on("end", () => resolve(output));
  });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(`${command} exited with ${code ?? signal}`);
  }
  return stdout;
}

async function waitForHttp(
  url,
  timeoutMs = READY_TIMEOUT_MS,
  pollMs = READY_POLL_MS,
  requireOk = false,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: "HEAD" });
      // requireOk отсекает «мягкие» ответы (3xx/4xx): для GitLab нужен
      // настоящий 2xx, иначе 404 неготового стенда неотличим от готового.
      const ready = requireOk
        ? response.status >= 200 && response.status < 300
        : response.status >= 200 && response.status < 500;
      if (ready) return;
    } catch {
      // Сервис ещё поднимается.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting ${timeoutMs}ms for ${url}`);
}

// ---------------------------------------------------------------------------
// Файлы окружения
// ---------------------------------------------------------------------------

function ensureEnvFile(templatePath, targetPath, label) {
  if (existsSync(targetPath)) return;
  if (!existsSync(templatePath)) {
    throw new Error(`${templatePath} not found — cannot bootstrap ${targetPath}`);
  }
  copyFileSync(templatePath, targetPath);
  log(`created ${label} from template (adjust values if needed)`);
}

function ensureEnvFiles() {
  // `.env` — базовый compose использует `env_file: .env` (порты/секреты dev).
  ensureEnvFile(DEV_ENV_EXAMPLE, DEV_ENV_FILE, ".env");
  // `.env.e2e` — порты и настройки E2E-стека (изолированы от dev).
  ensureEnvFile(E2E_ENV_EXAMPLE, E2E_ENV_FILE, ".env.e2e");
}

function envForE2e() {
  return parseEnvFile(E2E_ENV_FILE);
}

function resolveUrls() {
  const env = envForE2e();
  const apiPort = env.PORT ? Number(env.PORT) : DEFAULT_API_PORT;
  const webPort = env.WEB_PORT ? Number(env.WEB_PORT) : DEFAULT_WEB_PORT;
  const gitlabWebPort = env.GITLAB_WEB_PORT ? Number(env.GITLAB_WEB_PORT) : DEFAULT_GITLAB_WEB_PORT;
  const gitlabRootPassword = env.GITLAB_ROOT_PASSWORD ?? DEFAULT_GITLAB_ROOT_PASSWORD;
  const gitlabToken = env.GITLAB_TOKEN ?? "";
  return {
    apiUrl: `http://localhost:${apiPort}`,
    wsUrl: `ws://localhost:${apiPort}/ws`,
    webUrl: `http://localhost:${webPort}`,
    gitlabUrl: `http://localhost:${gitlabWebPort}`,
    gitlabApiUrl: `http://localhost:${gitlabWebPort}/api/v4`,
    gitlabRootPassword,
    gitlabToken,
    apiPort,
    webPort,
    gitlabWebPort,
  };
}

// Базовые аргументы docker compose: окружение E2E + оба compose-файла.
function composeArgs(extra = []) {
  return ["--env-file", ".env.e2e", ...COMPOSE_FILES, ...extra];
}

async function prepareStack() {
  ensureEnvFiles();
  const devEnv = parseEnvFile(DEV_ENV_FILE);
  // PROJECTS_DIR может быть задан в .env или приходит из окружения; дефолт
  // compose — ${PWD}/projects (см. docker-compose.yml).
  const projectsDir = devEnv.PROJECTS_DIR || `${REPO_ROOT}projects`;
  if (!existsSync(projectsDir)) {
    mkdirSync(projectsDir, { recursive: true });
    log(`created PROJECTS_DIR ${projectsDir}`);
  }

  log("starting docker compose stack (docker compose up -d)");
  await runCommand("docker", ["compose", ...composeArgs(["up", "-d"])], { cwd: REPO_ROOT });

  const urls = resolveUrls();
  log(`waiting for API ${urls.apiUrl}/health`);
  await waitForHttp(`${urls.apiUrl}/health`);
  log(`waiting for web ${urls.webUrl}/`);
  await waitForHttp(urls.webUrl + "/");
  // `/users/sign_in` отвечает 200 только когда Rails готов. `/-/health` для
  // этого не годится: он доступен лишь с loopback (monitoring_whitelist),
  // поэтому из host всегда 404 — проверка была бы пустой.
  log(`waiting for gitlab ${urls.gitlabUrl}/users/sign_in`);
  await waitForHttp(
    `${urls.gitlabUrl}/users/sign_in`,
    GITLAB_READY_TIMEOUT_MS,
    GITLAB_READY_POLL_MS,
    true,
  );

  await seedReferenceProject();
  await ensureGitLabRootUser(urls);
  await ensureGitLabToken(urls);
  await ensureGitLabTestProject(urls);
  log("stack is ready");
  return urls;
}

// ---------------------------------------------------------------------------
// Эталонный проект приложения (рендер доски в GUI-спектрах)
// ---------------------------------------------------------------------------

// Эталонный проект E2E пишется напрямую в БД контейнера api (лучший канал:
// REST-создание проекта ходит в ai-factory init и не позволяет задать
// фиксированный id). better-sqlite3 есть в образе api как зависимость @aif/data.
async function seedReferenceProject() {
  const seedJs = [
    'import Database from "better-sqlite3";',
    "const db = new Database(process.env.DATABASE_URL);",
    'db.pragma("busy_timeout = 5000");',
    `const found = db.prepare("SELECT 1 AS ok FROM projects WHERE id = ?").get("${E2E_PROJECT.id}");`,
    "if (!found) {",
    "  const now = new Date().toISOString();",
    "  const { changes } = db.prepare(`",
    "    INSERT INTO projects (",
    "      id, name, root_path, parallel_enabled, auto_queue_mode,",
    "      token_input, token_output, token_total, cost_usd, created_at, updated_at",
    "    ) VALUES (?,?,?,0,0,0,0,0,0,?,?)",
    "  `).run(",
    `      "${E2E_PROJECT.id}",`,
    `      "${E2E_PROJECT.name}",`,
    `      "${E2E_PROJECT.rootPath}",`,
    "      now,",
    "      now,",
    "    );",
    '  console.log("seed-result=" + (changes ? "inserted" : "skipped"));',
    "} else {",
    '  console.log("seed-result=present");',
    "}",
    "db.close();",
    "",
  ].join("\n");

  try {
    await runCommand(
      "docker",
      ["compose", ...composeArgs(["exec", "-T", "api", "node", "--input-type=module", "-"])],
      {
        cwd: REPO_ROOT,
        stdin: seedJs,
      },
    );
    log(`reference project ${E2E_PROJECT.id} ensured in docker DB`);
  } catch (error) {
    // Сея-шаг не должен ронять API-спектры: проект нужен только GUI (рендер
    // доски). Ошибка exec почти всегда означает проблемы с контейнером.
    log(`WARNING: could not seed reference project: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Тестовый GitLab
// ---------------------------------------------------------------------------

// Гарантирует root-пользователя с паролем GITLAB_ROOT_PASSWORD.
//
// Первичный сиид GitLab (db/fixtures/production/003_admin.rb) создаёт root, но
// падает целиком, если пароль не проходит проверку сложности (например,
// содержит username — для root это строка "root"). Тогда rails_migration
// завершается с ошибкой, а на последующих стартах reconfigure уже не
// запускается (маркер /var/opt/gitlab/bootstrapped) — root так и не появится.
// Поэтому доводим состояние идемпотентно здесь, тем же сервисом, что и сиид.
async function ensureGitLabRootUser(urls) {
  if (!urls.gitlabRootPassword) {
    log("WARNING: GITLAB_ROOT_PASSWORD is empty in .env.e2e — skipping root provisioning");
    return;
  }
  const ruby = [
    "user = User.find_by_username('root')",
    "if user.nil?",
    "  user_args = {",
    "    username: 'root',",
    "    email: 'root@aif-e2e.local',",
    "    name: 'Administrator',",
    "    admin: true,",
    "    organization_id: Organizations::Organization.default_organization.id,",
    `    password: ${rubyString(urls.gitlabRootPassword)},`,
    "    skip_confirmation: true,",
    "  }",
    "  created = Users::CreateService.new(User.new(admin: true), user_args).execute",
    "  raise created.errors.full_messages.join(', ') unless created.persisted?",
    "  puts 'AIF_E2E_ROOT_CREATED'",
    "else",
    "  puts 'AIF_E2E_ROOT_PRESENT'",
    "end",
    "",
  ].join("\n");

  try {
    const stdout = await runCommandCapture(
      "docker",
      ["compose", ...composeArgs(["exec", "-T", "gitlab", "gitlab-rails", "runner", "-"])],
      { cwd: REPO_ROOT, stdin: ruby },
    );
    if (stdout.includes("AIF_E2E_ROOT_CREATED")) {
      log("GitLab root user created");
    } else if (stdout.includes("AIF_E2E_ROOT_PRESENT")) {
      log("GitLab root user already present");
    } else {
      throw new Error(`unexpected runner output: ${stdout.slice(0, 200)}`);
    }
  } catch (error) {
    log(`WARNING: could not ensure GitLab root user: ${error.message}`);
  }
}

// Создаёт root PAT с фиксированным значением (GITLAB_TOKEN из .env.e2e),
// если токена с именем aif-e2e ещё нет. Рантайм-контейнеры api/agent читают
// токен из своей env-переменной GITLAB_TOKEN (см. docker-compose.e2e.yml).
async function ensureGitLabToken(urls) {
  if (!urls.gitlabToken) {
    log("WARNING: GITLAB_TOKEN is empty in .env.e2e — skipping PAT provisioning");
    return;
  }
  const ruby = [
    "user = User.find_by_username('root')",
    "raise 'root user not found' if user.nil?",
    "existing = PersonalAccessToken.find_by(name: 'aif-e2e')",
    "if existing.nil?",
    "  t = PersonalAccessToken.new(user_id: user.id, name: 'aif-e2e', scopes: ['api', 'read_repository', 'write_repository', 'sudo'], expires_at: 365.days.from_now)",
    `  t.set_token(${rubyString(urls.gitlabToken)})`,
    "  t.save!",
    "end",
    "puts 'AIF_E2E_PAT_OK'",
    "",
  ].join("\n");

  try {
    // gitlab-rails runner - читает Ruby-скрипт со stdin (не интерактивный
    // console) и исполняет его в контексте приложения GitLab.
    const stdout = await runCommandCapture(
      "docker",
      ["compose", ...composeArgs(["exec", "-T", "gitlab", "gitlab-rails", "runner", "-"])],
      { cwd: REPO_ROOT, stdin: ruby },
    );
    if (stdout.includes("AIF_E2E_PAT_ERR") || !stdout.includes("AIF_E2E_PAT_OK")) {
      const firstError = stdout.match(/AIF_E2E_PAT_ERR.*/)?.[0];
      throw new Error(firstError ?? `unexpected runner output: ${stdout.slice(0, 200)}`);
    }
    log("GitLab PAT (aif-e2e) ensured");
  } catch (error) {
    // GitLab может быть ещё не готов к rails-runner; не роняем весь прогон,
    // но оставляем явное предупреждение.
    log(`WARNING: could not ensure GitLab PAT: ${error.message}`);
  }
}

// Создаёт тестовый репозиторий root/e2e-target (с README, чтобы была ветка по
// умолчанию) — если его ещё нет. Токен берётся из .env.e2e (GITLAB_TOKEN).
async function ensureGitLabTestProject(urls) {
  if (!urls.gitlabToken) {
    log("WARNING: GITLAB_TOKEN is empty in .env.e2e — skipping test project provisioning");
    return;
  }
  const headers = { "PRIVATE-TOKEN": urls.gitlabToken, "Content-Type": "application/json" };
  const encoded = encodeURIComponent(GITLAB_TEST_PROJECT.pathWithNamespace);

  try {
    const existing = await fetch(`${urls.gitlabApiUrl}/projects/${encoded}`, { headers });
    if (existing.ok) {
      log(`GitLab test repository ${GITLAB_TEST_PROJECT.pathWithNamespace} already present`);
      return;
    }

    const created = await fetch(`${urls.gitlabApiUrl}/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: GITLAB_TEST_PROJECT.name,
        path: GITLAB_TEST_PROJECT.name,
        description: GITLAB_TEST_PROJECT.description,
        initialize_with_readme: true,
        visibility: "private",
      }),
    });
    if (!created.ok) {
      const text = await created.text();
      throw new Error(`POST /projects -> ${created.status}: ${text.slice(0, 300)}`);
    }
    const project = await created.json();
    log(
      `GitLab test repository created: web_url=${project.web_url} default_branch=${project.default_branch}`,
    );
  } catch (error) {
    log(`WARNING: could not ensure GitLab test project: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Playwright
// ---------------------------------------------------------------------------

function runPlaywrightEnv(extraEnv = {}) {
  const urls = resolveUrls();
  const env = {
    AIF_SKIP_DEV_SERVER: "1",
    AIF_WEB_URL: urls.webUrl,
    AIF_E2E_API_URL: urls.apiUrl,
    AIF_E2E_WS_URL: urls.wsUrl,
    GITLAB_TOKEN: urls.gitlabToken,
    GITLAB_WEB_URL: urls.gitlabUrl,
    ...extraEnv,
  };
  log(`web: ${urls.webUrl}, api: ${urls.apiUrl}, ws: ${urls.wsUrl}, gitlab: ${urls.gitlabUrl}`);
  return env;
}

async function runGui() {
  const env = runPlaywrightEnv();
  log("running GUI e2e specs (npm run e2e:gui --workspace=@aif/web)");
  await runCommand("npm", ["run", "e2e:gui", "--workspace=@aif/web"], {
    cwd: REPO_ROOT,
    env,
  });
}

async function runApi() {
  const env = runPlaywrightEnv();
  log("running API e2e specs (npm run e2e:api --workspace=@aif/web)");
  await runCommand("npm", ["run", "e2e:api", "--workspace=@aif/web"], {
    cwd: REPO_ROOT,
    env,
  });
}

async function main() {
  const args = process.argv.slice(1);
  const requested = args.find((arg) =>
    ["--prepare", "--gui", "--api", "--all", "--down"].includes(arg),
  );
  // Без явного режима запускаем полный прогон (--all): иначе сообщение
  // «e2e: OK, all e2e tests passed» после одного prepare было бы вводящим
  // в заблуждение (Makefile всегда передаёт явный режим, bare run — это
  // ручной вызов, который должен действительно прогнать сьют).
  const mode = requested ?? "--all";
  if (mode !== requested) {
    log(`no mode argument given, running full suite (--all)`);
  }

  if (mode === "--down") {
    // Останавливаем только E2E-стек: gitlab + переопределённые сервисы.
    ensureEnvFiles();
    await runCommand(
      "docker",
      ["compose", ...composeArgs(["down", "--volumes", "--remove-orphans"])],
      {
        cwd: REPO_ROOT,
      },
    );
    log("e2e stack stopped and volumes removed");
    return;
  }

  try {
    await prepareStack();
    if (mode === "--prepare") {
      log("stack prepared; run `make e2e-gui`/`make e2e-api` to execute specs");
      return;
    }
    if (mode === "--gui" || mode === "--all") {
      await runGui();
    }
    if (mode === "--api" || mode === "--all") {
      await runApi();
    }
    log(`e2e: OK, all e2e tests passed (mode=${mode})`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main();
