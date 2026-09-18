/**
 * Транспорт Codex CLI: запускает бинарник `codex` как дочерний процесс, подаёт
 * промпт через stdin и превращает поток `stream-json` (JSONL) в единый формат
 * рантайма — RuntimeEvent/RuntimeRunResult.
 *
 * Зачем CLI, если есть SDK-транспорт (sdk.ts)? CLI переиспользует уже
 * выполненную OAuth-сессию (`codex login`), не требует API-ключа и через
 * escape-hatch `codexCliArgs` в профиле позволяет полностью переопределить
 * форму команды. Плата за это — все подводные камни дочерних процессов; файл
 * во многом — каталог защит от них:
 *  - промпт идёт в stdin, а не в argv: аргументы видны всем процессам ОС,
 *    ограничены длиной (~32k символов у CreateProcess) и требуют экранирования
 *    кавычек;
 *  - stdout разбирается построчно из буфера: границы чанков 'data' не совпадают
 *    с границами строк JSONL;
 *  - окружение собирается allowlist'ом: третьестороннему бинарнику не отдаётся
 *    весь process.env, чтобы не утекли посторонние секреты;
 *  - каждое поле вывода CLI — `unknown`, с проверкой типа и явным `| null`
 *    перед доступом (Nullable Cast Rule);
 *  - ошибки классифицируются единой точкой входа — classifyCodexRuntimeError —
 *    и дальше различаются по структурированной категории, а не по тексту;
 *  - жизненный цикл завязан на 'close', а не 'exit': stdio должно отдать
 *    данные до конца, иначе потеряется последняя строка потока.
 */
import { spawn, execFileSync } from "node:child_process";
import type { RuntimeEvent, RuntimeRunInput, RuntimeRunResult, RuntimeUsage } from "../../types.js";
import { buildRuntimeLimitEvent } from "../../limitEvents.js";
import {
  makeProcessRunTimeoutError,
  makeProcessStartTimeoutError,
  resolveRetryDelay,
  sleepMs,
  withProcessTimeouts,
} from "../../timeouts.js";
import { classifyCodexRuntimeError } from "./errors.js";
import { ensureCodexProviderConfig } from "./config.js";
import { getCodexSessionLimitSnapshot } from "./sessions.js";
import { assertSafeWindowsShellExecutablePath } from "../../shellSafety.js";
import {
  normalizeCodexApprovalPolicy,
  normalizeCodexSandboxMode,
  warnOnInvalidCodexPermissionOverride,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from "./permissions.js";
import { PROXY_ENV_VARS } from "../../proxyEnv.js";
import { CODEX_MODEL_EFFORT_LEVELS, resolveModelEffortOption } from "../../modelEffort.js";

// На Windows голое "codex" — это .cmd-шим от npm, который нельзя запустить
// напрямую: либо shell:true, либо ручной cmd.exe /c с собственным экранированием
// (см. spawnCliWindows).
const IS_WINDOWS = process.platform === "win32";

// Минимальный «структурный» контракт логгера: адаптер не зависит от pino или
// конкретной реализации — достаточно объекта, умеющего часть этих методов.
// Всё опционально: тому, кому логи не нужны, проще передать undefined, чем
// noop-заглушку.
export interface CodexCliLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

// Троттлинг опроса лимитов сессии: снапшот полезно перечитывать, но не на
// каждую разобранную JSONL-строку — это файловое I/O впустую, новых данных там
// ещё нет.
const CODEX_SESSION_LIMIT_POLL_INTERVAL_MS = 1_000;

// Сужение типов для недоверенных данных: payload'ы из JSON.parse потока
// дочернего процесса — всегда `unknown`. asRecord не возвращает null (пустой
// объект — безвредная заготовка), а readString — возвращает, и вызывающий
// обязан обрабатывать это явно, а не прятать опциональность за слепым кастом:
// так требует правило Nullable Cast Rule.
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Определяет эффективные approval policy и sandbox mode для запуска Codex CLI.
 *
 * Трёхслойный приоритет:
 *   1. явные опции профиля (`options.approvalPolicy` / `options.sandboxMode`)
 *   2. дефолты bypass (когда `execution.bypassPermissions=true`)
 *   3. стабильные не-bypass дефолты (`on-request` + `workspace-write`)
 *
 * Не-bypass дефолты держат поведение одинаковым на всех хостах независимо
 * от ~/.codex/config.toml пользователя — до рефакторинга
 * bypass-permissions эти дефолты задавала Codex-специфичная фабрика хуков
 * в слое api; теперь логика живёт внутри адаптера,
 * и api/agent/runtime делят один контракт.
 *
 * Значения всегда ненулевые — вызывающий всегда эмитит соответствующий
 * `-c approval_policy="..."` / `-c sandbox_mode="..."` override. Маршрутизация
 * через `-c`, а не `--sandbox` / атомарный флаг
 * `--dangerously-bypass-approvals-and-sandbox`, обязательна потому, что
 * подкоманда `codex exec resume` наотрез отвергает
 * `--sandbox`.
 */
function resolveCodexPermissionOverrides(
  input: RuntimeRunInput,
  logger?: CodexCliLogger,
): {
  approvalPolicy: CodexApprovalPolicy;
  sandboxMode: CodexSandboxMode;
} {
  const options = asRecord(input.options);
  const rawApproval = readString(options.approvalPolicy);
  const rawSandbox = readString(options.sandboxMode);
  const explicitApproval = normalizeCodexApprovalPolicy(rawApproval);
  const explicitSandbox = normalizeCodexSandboxMode(rawSandbox);
  const bypass = input.execution?.bypassPermissions === true;

  // Неверное значение не роняет запуск, а предупреждает: опечатка в профиле
  // не должна ломать задачу — значение нормализуется к безопасному дефолту, но
  // в логе остаётся след, кто и что накосячил.
  warnOnInvalidCodexPermissionOverride({
    logger,
    runtimeId: input.runtimeId,
    transport: "cli",
    field: "approvalPolicy",
    rawValue: rawApproval,
    normalizedValue: explicitApproval,
  });
  warnOnInvalidCodexPermissionOverride({
    logger,
    runtimeId: input.runtimeId,
    transport: "cli",
    field: "sandboxMode",
    rawValue: rawSandbox,
    normalizedValue: explicitSandbox,
  });

  // bypass меняет пару значений сразу: "never" (не спрашивать подтверждений) +
  // "danger-full-access" (отключить песочницу). Либо оба, либо ни одного:
  // частичный bypass дал бы не автоматизацию, а ложное ощущение разрешений.
  const resolved = {
    approvalPolicy: explicitApproval ?? (bypass ? "never" : "on-request"),
    sandboxMode: explicitSandbox ?? (bypass ? "danger-full-access" : "workspace-write"),
  };

  logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      transport: "cli",
      approvalPolicy: resolved.approvalPolicy,
      sandboxMode: resolved.sandboxMode,
      approvalSource: explicitApproval ? "options" : bypass ? "bypass-default" : "default",
      sandboxSource: explicitSandbox ? "options" : bypass ? "bypass-default" : "default",
      bypassPermissions: bypass,
    },
    "Resolved Codex CLI approval and sandbox settings",
  );

  // Значения всегда не null: вызывающий безусловно подставляет `-c`-флаги,
  // поэтому «не задано» превращается в дефолт здесь, а не у вызывающего.
  return resolved;
}

// Результат намеренно null-явный: пустой массив и отсутствующая настройка —
// для вызывающего одно и то же (значит, дефолтные аргументы), и `null` говорит
// об этом честнее, чем проверка длины.
function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.filter((entry): entry is string => typeof entry === "string");
  return parsed.length > 0 ? parsed : null;
}

interface NormalizedCliArgs {
  args: string[];
  /**
   * True, когда кастомные `codexCliArgs` встроили промпт плейсхолдером
   * `{prompt}` в любое место любого аргумента (включая составные формы вида
   * `--payload=prefix {prompt} suffix`). Отслеживается до подстановки — после
   * возврата `normalizeCliArgs()` литеральный токен `{prompt}` исчезает из
   * `args`, поэтому флаг — единственный надёжный сигнал для подавления stdin.
   */
  usesPromptPlaceholder: boolean;
}

function normalizeCliArgs(
  input: RuntimeRunInput,
  effectivePrompt: string,
  logger?: CodexCliLogger,
): NormalizedCliArgs {
  const options = asRecord(input.options);
  const configured = readStringArray(options.codexCliArgs);

  // Кастомные аргументы — применяем шаблонные подстановки.
  //
  // `effectivePrompt` уже несёт `execution.systemPromptAppend`, prepended
  // функцией `composePrompt()`, поэтому языковая директива реестра (и любые
  // другие сквозные добавки) доходит до модели и через плейсхолдер `{prompt}` —
  // не только по обычному пути stdin.
  if (configured) {
    let usesPromptPlaceholder = false;
    // Подстановка закрывает ровно три плейсхолдера, остальной текст аргумента
    // идёт как есть: неизвестный токен остаётся видимым в команде и всплывает
    // ошибкой CLI, а не тихо подменяется пустой строкой.
    const args = configured.map((arg) => {
      if (arg.includes("{prompt}")) {
        usesPromptPlaceholder = true;
      }
      return arg
        .replaceAll("{prompt}", effectivePrompt)
        .replaceAll("{model}", input.model ?? "")
        .replaceAll("{session_id}", input.sessionId ?? "");
    });
    return { args, usesPromptPlaceholder };
  }

  // Аргументы по умолчанию — resume сессии или свежий exec
  // "exec" — неинтерактивный подкомандный режим CLI: без TTY, вывод для
  // скрипта, а не для человека.
  const args: string[] = ["exec"];
  // Resume без sessionId ошибкой не считается: тихий откат к свежему запуску
  // предпочтительнее битой команды — потеря контекста видна сразу, а сбой нет.
  if (input.resume && input.sessionId) {
    args.push("resume", input.sessionId);
  }
  // `--json` переводит CLI в режим stream-json: машиночитаемый JSONL вместо
  // human-разметки с ANSI-украшениями — именно его ожидает парсер ниже.
  args.push("--json");
  if (input.model) {
    args.push("--model", input.model);
  }
  // Reasoning effort передаётся TOML-оверрайдом, а не флагом: набор флагов у
  // `exec` и `exec resume` различается, а `-c` работает в обоих. JSON.stringify
  // даёт кавычки, которые требует TOML-синтаксис строкового значения.
  const effort = resolveModelEffortOption(
    options,
    "modelReasoningEffort",
    CODEX_MODEL_EFFORT_LEVELS,
  );
  if (effort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  }

  // Пропуск проверки git-репозитория — включается профилем для не-git каталогов
  if (options.skipGitRepoCheck === true) {
    args.push("--skip-git-repo-check");
  }

  // Approval policy и sandbox mode. Эмитятся всегда, чтобы поведение оставалось
  // стабильным на всех хостах независимо от ~/.codex/config.toml пользователя.
  //
  //   bypass=false, без override профиля → "on-request" + "workspace-write"
  //   bypass=true,  без override профиля → "never"      + "danger-full-access"
  //   явные `options.approvalPolicy` / `options.sandboxMode` всегда главнее
  //
  // Маршрутизация через `-c`, а не `--sandbox` или атомарный флаг
  // `--dangerously-bypass-approvals-and-sandbox`: `codex exec resume`
  // отвергает `--sandbox`, а overrides через `-c` одинаково работают и на
  // свежем exec, и на resume.
  // Кавычки внутри значения — часть TOML-синтаксиса: голое `never` было бы
  // разобрано не как строка.
  const { approvalPolicy, sandboxMode } = resolveCodexPermissionOverrides(input, logger);
  args.push("-c", `approval_policy="${approvalPolicy}"`);
  args.push("-c", `sandbox_mode="${sandboxMode}"`);

  // Дефолтный путь промпт в аргументах не несёт — он уходит в stdin, поэтому
  // флаг-подавитель здесь false по построению, а не потому, что про него забыли.
  return { args, usesPromptPlaceholder: false };
}

// Allowlist вместо блок-листа: process.env напичкан одноразовыми секретами
// (токены CI, пароли к БД), а CLI нужен лишь малый набор. Новая переменная по
// умолчанию «не проходит» — это безопаснее, чем забыть её заблокировать.
// Группы: настройки провайдера (OPENAI_/CODEX_), маркеры самого приложения
// (AIF_/HANDOFF_), локаль (LANG/LC_), поиск и временные файлы (PATH/TMPDIR/
// SHELL/TERM), цвет и время (FORCE_COLOR/NO_COLOR/TZ) и прокси (PROXY_ENV_VARS).
const ALLOWED_ENV_PREFIXES = [
  "OPENAI_",
  "CODEX_",
  "AIF_",
  "HANDOFF_",
  "NODE_",
  "HOME",
  "USER",
  "LANG",
  "LC_",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "XDG_",
  "FORCE_COLOR",
  "NO_COLOR",
  ...PROXY_ENV_VARS,
];

/**
 * Переменные окружения, которые нельзя пробрасывать в Codex CLI по умолчанию,
 * даже если они подходят под разрешённый префикс. Они блокируются, пока
 * API-key авторизация явно не включена через `apiKeyEnvVar`/`apiKey` профиля
 * (решается до обращения к этому набору — см. `buildCuratedEnv`).
 *
 * - `OPENAI_API_KEY` — иначе placeholder/внешний ключ перехватил бы
 *   OAuth-сессию `codex login` и силой перевёл запуск на API-key авторизацию.
 * - `OPENAI_BASE_URL` — устарела для Codex CLI: ломает производную WebSocket
 *   эндпоинта (`wss://.../v1/responses`) и даёт 500. CLI вместо этого читает
 *   `openai_base_url` из `config.toml`.
 *
 * Зеркалирует блок-лист SDK-транспорта (`adapters/codex/sdk.ts`), чтобы все три
 * локальных Codex-транспорта одинаково изолировали внешний OpenAI-auth env.
 */
// Блок-лист внутри allowlist — не случайность: обе переменные подходят под
// разрешённый префикс OPENAI_ и прошли бы фильтрацию, если бы не исключение.
// Без него фоновый placeholder-ключ перехватывал бы OAuth-сессию пользователя.
const BLOCKED_ENV_KEYS = new Set(["OPENAI_API_KEY", "OPENAI_BASE_URL"]);

interface CuratedEnvResult {
  env: Record<string, string>;
  forwardedCount: number;
  filteredCount: number;
  blockedCount: number;
  droppedDisallowedPrefixKeys: string[];
}

interface BuildCuratedEnvOptions {
  /**
   * Была ли для этого запуска явно включена API-key авторизация (`apiKeyEnvVar`/
   * `apiKey` профиля). Когда false, внешние `OPENAI_API_KEY` и кастомный
   * `apiKeyEnvVar` блокируются, чтобы placeholder-ключ не перехватил
   * OAuth-сессию `codex login`.
   */
  allowApiKey: boolean;
}

function buildCuratedEnv(apiKeyEnvVar: string, opts: BuildCuratedEnvOptions): CuratedEnvResult {
  const env: Record<string, string> = {};
  let forwardedCount = 0;
  let filteredCount = 0;
  let blockedCount = 0;
  // Счётчики — не украшение: по ним итоговый лог runCodexCli показывает,
  // что нужная переменная «молча» не дошла до дочернего процесса из-за
  // отсутствующего префикса в allowlist.
  const droppedDisallowedPrefixKeys = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    // Явное включение API-key: пробрасываем настроенную ключевую переменную
    // (ей может быть OPENAI_API_KEY) до блок-листа, чтобы API-key авторизация
    // работала, когда профиль её запрашивает.
    if (key === apiKeyEnvVar && opts.allowApiKey) {
      env[key] = value;
      forwardedCount += 1;
      continue;
    }
    // Настроенная ключевая переменная без явного включения не должна утечь в дочерний процесс.
    if (key === apiKeyEnvVar) {
      blockedCount += 1;
      continue;
    }
    // Внешние OpenAI-auth переменные (OPENAI_API_KEY / OPENAI_BASE_URL) блокируются
    // по умолчанию, чтобы placeholder-ключ не перехватил OAuth-сессию `codex login`.
    if (BLOCKED_ENV_KEYS.has(key)) {
      blockedCount += 1;
      continue;
    }
    if (ALLOWED_ENV_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix))) {
      env[key] = value;
      forwardedCount += 1;
    } else {
      filteredCount += 1;
      // По именам запоминаются только npm_*: это обвязка npm-скриптов, их
      // массовое выпадение — норма, а не баг. Перечислять все отфильтрованные
      // переменные было бы шумом в warn-логе.
      if (key.startsWith("npm_")) {
        droppedDisallowedPrefixKeys.add(key);
      }
    }
  }
  return {
    env,
    forwardedCount,
    filteredCount,
    blockedCount,
    droppedDisallowedPrefixKeys: [...droppedDisallowedPrefixKeys],
  };
}

// Приоритет: профиль > env > голое имя. Голое имя разрешается через PATH —
// так обычно и находится глобально установленный CLI.
function resolveCliPath(input: RuntimeRunInput): string {
  const options = asRecord(input.options);
  return readString(options.codexCliPath) ?? readString(process.env.CODEX_CLI_PATH) ?? "codex";
}

/**
 * Проверяет доступность Codex CLI запуском `codex --version`.
 * В Windows голое имя команды вроде `"codex"` требует `shell: true` для резолва `.cmd`.
 */
export function probeCodexCli(cliPath: string): { ok: boolean; version?: string; error?: string } {
  // execFileSync, а не spawn: проба готовности обязана быть синхронной и
  // ограниченной по времени (timeout). stderr игнорируется: предупреждения CLI
  // не признак неработоспособности, а вот ENOENT при спавне — признак. Отказ
  // возвращается как ok:false, а не бросается: «не готов» — штатный результат.
  // На Windows shell:true — вынужденное зло (.cmd-шим), поэтому путь сначала
  // проходит assertSafeWindowsShellExecutablePath: в строку cmd.exe не должен
  // протиснуться ничего похожего на инъекцию.
  try {
    if (IS_WINDOWS) {
      assertSafeWindowsShellExecutablePath(cliPath, "Codex CLI path");
    }
    const out = execFileSync(cliPath, ["--version"], {
      timeout: 5_000,
      shell: IS_WINDOWS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, version: out.toString().trim() };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// 120 секунд — осознанный дефолт: хватает на средний поворот, но зависший
// процесс не блокирует целый этап пайплайна надолго. Number.isFinite отсекает
// NaN/Infinity, которые могут прийти из конфигурации.
function resolveTimeoutMs(input: RuntimeRunInput): number {
  const exec = input.execution;
  if (
    typeof exec?.runTimeoutMs === "number" &&
    Number.isFinite(exec.runTimeoutMs) &&
    exec.runTimeoutMs > 0
  ) {
    return Math.floor(exec.runTimeoutMs);
  }
  return 120_000;
}

/* v8 ignore start -- логика spawn только для Windows, нетестируемо в macOS/Linux CI */
// Ручное экранирование для cmd.exe: автоматическое недоступно из-за
// windowsVerbatimArguments ниже. Кавычки надеваются только при пробелах или
// кавычках внутри аргумента — чистые токены остаются чистыми.
function quoteIfNeeded(arg: string): string {
  return arg.includes(" ") || arg.includes('"') ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

// Запуск через cmd.exe: /d отключает AutoRun-команды из реестра, /c исполняет
// команду и завершает shell. Ключевой момент — windowsVerbatimArguments:true:
// он запрещает Node переэкранировать уже собранную нами строку, иначе кавычки
// Node столкнутся с правилами cmd.exe и аргументы с пробелами развалятся.
function spawnCliWindows(
  cliPath: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string>,
) {
  assertSafeWindowsShellExecutablePath(cliPath, "Codex CLI path");
  const cmd = process.env.ComSpec ?? "cmd.exe";
  const cmdLine = [cliPath, ...args.map(quoteIfNeeded)].join(" ");
  return spawn(cmd, ["/d", "/c", cmdLine], {
    cwd,
    env,
    stdio: "pipe",
    windowsVerbatimArguments: true,
  });
}
/* v8 ignore stop */

// ---------------------------------------------------------------------------
// Обработчик строк stream-json (JSONL)
// ---------------------------------------------------------------------------

// Фрейминг JSONL: по одному JSON-объекту на строку. Беда в том, что поток
// дочернего процесса приходит «data»-чанками с произвольными границами: в
// чанке может быть несколько строк или половина строки. Поэтому буфер и
// flushCompleteLines: обрабатываем только строки, чей завершающий \n уже успел
// прийти.

// Все поля опциональны: схема JSONL у CLI растёт от версии к версии, и код не
// должен падать на отсутствующих полях — отсюда индексная сигнатура и typeof-
// проверки в каждом месте доступа.
interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  [key: string]: unknown;
}

interface CodexStreamMessage {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cached_input_tokens?: number;
  };
  total_cost_usd?: number;
  cost_usd?: number;
  // Legacy-поля одинокого блоба, используемые кастомными интеграциями `codexCliArgs`
  outputText?: string;
  result?: string;
  sessionId?: string;
  events?: Array<Record<string, unknown>>;
}

interface CodexCliStreamState {
  sessionId: string | null;
  outputText: string;
  usage: RuntimeUsage | null;
  events: RuntimeEvent[];
  plainTextFallback: string;
  /** Разобранные сырые JSONL-события — сохраняются в `raw` для совместимости. */
  rawEvents: Array<Record<string, unknown>>;
  /** True, когда хоть одна строка JSONL разобралась успешно. */
  sawAnyJsonLine: boolean;
}

// fallbackSessionId — собственный id сессии для resume; свежий запуск узнает
// настоящий thread_id из события thread.started и перезапишет его.
function createCodexStreamState(fallbackSessionId: string | null): CodexCliStreamState {
  return {
    sessionId: fallbackSessionId,
    outputText: "",
    usage: null,
    events: [],
    plainTextFallback: "",
    rawEvents: [],
    sawAnyJsonLine: false,
  };
}

// Обрезка — про размер потока: события активности идут в UI по WebSocket, и
// один cat большого файла не должен забивать канал. Пустая строка при сбое —
// сознательный выбор: ронять из-за косметической детали весь поток событий
// не за чем.
function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") {
    return input.length > 100 ? `${input.slice(0, 97)}...` : input;
  }
  try {
    const json = JSON.stringify(input);
    if (json.length <= 120) return json;
    return `${json.slice(0, 117)}...`;
  } catch {
    return "";
  }
}

function displayNameForCodexTool(itemType: string): string {
  // Маппим внутренние типы элементов codex на более понятные имена активности,
  // где возможно следуя конвенции Claude, чтобы UI показывал "Bash ls" и т.п.
  switch (itemType) {
    case "command_execution":
      return "Bash";
    case "file_read":
      return "Read";
    case "file_write":
      return "Write";
    case "file_edit":
      return "Edit";
    default:
      return itemType;
  }
}

// Двойная запись: в state для воспроизведения в итоге и в колбэк для live-
// стриминга. UI и активность агента видят событие сразу, не дожидаясь выхода
// процесса.
function emitCodexEvent(
  state: CodexCliStreamState,
  execution: RuntimeRunInput["execution"],
  event: RuntimeEvent,
): void {
  state.events.push(event);
  execution?.onEvent?.(event);
}

function accumulateCodexUsage(state: CodexCliStreamState, message: CodexStreamMessage): void {
  const usage = message.usage;
  if (!usage) return;
  const rawInput = usage.input_tokens ?? 0;
  // cached_input_tokens суммируются с input: поля Codex разделяют промахи и
  // попадания кэша, а потреблённый контекст — их сумма; иначе rate limit
  // получал бы занижённую цифру и «свободное место», которого нет.
  const cached = usage.cached_input_tokens ?? 0;
  const inputTokens = rawInput + cached;
  const outputTokens = usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;
  // Полей стоимости два по историческим причинам: новое total_cost_usd и
  // legacy cost_usd, которое ещё шлют кастомные интеграции.
  const costRaw = message.total_cost_usd ?? message.cost_usd;
  // За долгий прогон turn.completed бывает несколько (мульти-тёрн), поэтому
  // значение дополняется, а не перезаписывается последним.
  if (state.usage) {
    state.usage = {
      inputTokens: state.usage.inputTokens + inputTokens,
      outputTokens: state.usage.outputTokens + outputTokens,
      totalTokens: state.usage.totalTokens + totalTokens,
      costUsd:
        typeof costRaw === "number" ? (state.usage.costUsd ?? 0) + costRaw : state.usage.costUsd,
    };
  } else {
    state.usage = {
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd: typeof costRaw === "number" ? costRaw : undefined,
    };
  }
}

function processCodexJsonLine(
  line: string,
  state: CodexCliStreamState,
  execution: RuntimeRunInput["execution"],
): void {
  const trimmed = line.trim();
  // Пустые строки — законные разделители в потоке: пропускать их обязательно,
  // иначе JSON.parse на пустоте засорит plainTextFallback.
  if (!trimmed) return;

  let message: CodexStreamMessage;
  // JSON.parse бросает на обычной текстовой строке — это норма: в stdout CLI
  // попадают предупреждения о деприкации. Такие строки копятся в
  // plainTextFallback и спасают вывод прогона, если JSON в поток не пришёл
  // вообще ни один.
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") {
      // Перенос добавляется в начало, а не в конец: первая строка фолбэка не
      // должна начинаться с пустой.
      state.plainTextFallback += (state.plainTextFallback ? "\n" : "") + trimmed;
      return;
    }
    message = parsed as CodexStreamMessage;
  } catch {
    state.plainTextFallback += (state.plainTextFallback ? "\n" : "") + trimmed;
    return;
  }

  // Флаг различает два разных исхода: «поток JSONL, но ни одно событие не
  // распознано» (вывод действительно пуст) и «CLI говорил текстом» (тут
  // спасает фолбэк).
  state.sawAnyJsonLine = true;
  // Сырые события хранятся как есть: они уходят в raw итогового результата для
  // обратной совместимости и разбора инцидентов — парсер их не переписывает.
  state.rawEvents.push(message as unknown as Record<string, unknown>);

  // Отсутствующий или нестроковый type ошибкой не считается: такой объект не
  // совпадёт ни с одной веткой и будет просто проигнорирован — так новая схема
  // CLI не ломает старый код.
  const type = typeof message.type === "string" ? message.type : "";
  const nowIso = new Date().toISOString();

  // thread.started — источник истины для id сессии: CLI сообщает его сам, и
  // дальше id уходит в итоговый результат и в опрос лимитов.
  if (type === "thread.started") {
    if (typeof message.thread_id === "string" && message.thread_id.length > 0) {
      state.sessionId = message.thread_id;
    }
    emitCodexEvent(state, execution, {
      type: "system:init",
      timestamp: nowIso,
      level: "debug",
      message: "Codex thread started",
      data: { sessionId: state.sessionId },
    });
    return;
  }

  if (type === "item.started" && message.item) {
    const item = message.item;
    const itemType = typeof item.type === "string" ? item.type : "";
    // agent_message пропускается на started: текст ещё не готов, показывать
    // пустую «инструмент-активность» смысла нет — он придёт целиком в completed.
    if (itemType && itemType !== "agent_message") {
      const displayName = displayNameForCodexTool(itemType);
      // Для shell-инструментов предпочитаем поле `command`, иначе суммаризируем
      // весь объект item, чтобы строка активности несла осмысленный контекст.
      const detailSource: unknown =
        typeof item.command === "string"
          ? item.command
          : { ...item, id: undefined, status: undefined };
      const summary = summarizeToolInput(detailSource);
      const detailSuffix = summary ? ` ${summary}` : "";
      emitCodexEvent(state, execution, {
        type: "tool:use",
        timestamp: nowIso,
        level: "info",
        message: `${displayName}${detailSuffix}`,
        data: { name: displayName, itemType, item },
      });
      execution?.onToolUse?.(displayName, detailSuffix);
    }
    return;
  }

  if (type === "item.completed" && message.item) {
    const item = message.item;
    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType === "agent_message" && typeof item.text === "string") {
      // Мульти-тёрн: каждый завершённый агентский текст добавляется к
      // накопленному, пустая строка между ними — визуальный разделитель тёрнов.
      if (state.outputText) state.outputText += "\n\n";
      state.outputText += item.text;
      emitCodexEvent(state, execution, {
        type: "stream:text",
        timestamp: nowIso,
        level: "debug",
        message: item.text,
        data: { text: item.text },
      });
    }
    // События завершения инструмента намеренно не повторяем —
    // `item.started` уже выдал tool:use, а повтор на завершении
    // удвоил бы журнал в agent activity.
    return;
  }

  // Legacy-событие "message" (старый формат codex CLI)
  if (type === "message" && typeof message.text === "string") {
    if (state.outputText) state.outputText += "\n\n";
    state.outputText += message.text;
    emitCodexEvent(state, execution, {
      type: "stream:text",
      timestamp: nowIso,
      level: "debug",
      message: message.text,
      data: { text: message.text },
    });
    return;
  }

  // turn.completed — единственный носитель usage в потоке, поэтому счётчик
  // обновляется ровно здесь, а не в каждом событии.
  if (type === "turn.completed") {
    accumulateCodexUsage(state, message);
    emitCodexEvent(state, execution, {
      type: "result:success",
      timestamp: nowIso,
      level: "info",
      message: "Codex turn completed",
      data: { usage: message.usage },
    });
    return;
  }

  // Прочие типы событий (turn.started, rate limit и т.п.) игнорируются.
  // Неизвестные типы — штатное будущее растущей схемы: игнорировать их
  // безопаснее, чем падать на незнакомом событии после обновления CLI.
}

function finalizeCodexResult(
  state: CodexCliStreamState,
  fallbackSessionId: string | null,
): RuntimeRunResult {
  // Обратная совместимость: если кастомные интеграции `codexCliArgs` выдают один
  // AIF-специфичный JSON-блоб (с outputText/result/sessionId/usage/events),
  // мы разобрали его как одно сообщение в rawEvents, но ни один
  // стриминговый обработчик не совпал. Восстанавливаем эту форму здесь.
  if (
    state.rawEvents.length === 1 &&
    !state.outputText &&
    (state.rawEvents[0].outputText != null || state.rawEvents[0].result != null)
  ) {
    // Каждый каст ниже предваряется typeof/Array.isArray-проверкой: каст без
    // проверки молча снял бы `| null` с типа и уронил прогон на реальном
    // битом payload'е (Nullable Cast Rule).
    const parsed = state.rawEvents[0] as CodexStreamMessage & {
      usage?: Record<string, number>;
    };
    const usageRaw = parsed.usage as Record<string, number> | undefined;
    const legacyEvents = Array.isArray((parsed as Record<string, unknown>).events)
      ? ((parsed as Record<string, unknown>).events as Array<Record<string, unknown>>).map((e) => ({
          type: String(e.type ?? "unknown"),
          timestamp: typeof e.timestamp === "string" ? e.timestamp : new Date().toISOString(),
          message: typeof e.message === "string" ? e.message : undefined,
          data: e.data as Record<string, unknown> | undefined,
        }))
      : undefined;
    return {
      outputText: String(parsed.outputText ?? parsed.result ?? ""),
      sessionId:
        typeof (parsed as Record<string, unknown>).sessionId === "string"
          ? ((parsed as Record<string, unknown>).sessionId as string)
          : fallbackSessionId,
      // `null` в usage — явное «не измерено», в отличие от нулей: UI и лимиты
      // различают неизвестное и пустое.
      usage: usageRaw
        ? {
            inputTokens: usageRaw.inputTokens ?? usageRaw.input_tokens ?? 0,
            outputTokens: usageRaw.outputTokens ?? usageRaw.output_tokens ?? 0,
            totalTokens:
              usageRaw.totalTokens ??
              usageRaw.total_tokens ??
              (usageRaw.inputTokens ?? usageRaw.input_tokens ?? 0) +
                (usageRaw.outputTokens ?? usageRaw.output_tokens ?? 0),
            costUsd: usageRaw.costUsd ?? usageRaw.cost_usd,
          }
        : null,
      events: legacyEvents,
      raw: parsed,
    };
  }

  // JSONL-события не разобрались вообще — наружу идёт сырой stdout как plain text.
  // Единственный случай, где plainTextFallback доходит до результата: без
  // этого прогон выглядел бы успешно-пустым вместо честного текста CLI.
  if (!state.sawAnyJsonLine) {
    const raw = state.plainTextFallback;
    return {
      outputText: raw,
      sessionId: fallbackSessionId,
      usage: null,
      raw,
    };
  }

  // Обычный путь: то, что накопили обработчики. id из потока приоритетнее
  // переданного снаружи — CLI источник истины, fallback нужен лишь если
  // thread.started так и не пришёл.
  return {
    outputText: state.outputText,
    sessionId: state.sessionId ?? fallbackSessionId,
    usage: state.usage ?? null,
    events: state.events,
    raw: state.rawEvents,
  };
}

// Снапшот сравнивается по сериализованному виду: это маленький plain-объект
// со стабильным порядком ключей, и JSON.stringify служит дешёвым «отпечатком
// содержимого». Цель — не задублировать runtime:limit, если CLI сам прислал
// идентичный снапшот в своём потоке. Отсутствие events — не ошибка, а
// текстовый результат: отсюда ?? false в конце цепочки.
function hasRuntimeLimitSnapshotSignature(
  events: RuntimeEvent[] | null | undefined,
  signature: string,
): boolean {
  return (
    events?.some((event) => {
      if (event.type !== "runtime:limit") {
        return false;
      }
      return JSON.stringify(event.data?.snapshot ?? null) === signature;
    }) ?? false
  );
}

// Финальное снятие лимитов по состоянию сессии, уже после выхода процесса.
// Отсутствующий снапшот — не ошибка: функция возвращает результат как есть.
// Rate limit — телеметрия, она не имеет права валить уже успешный прогон.
async function appendCodexSessionLimitEvent(input: RuntimeRunInput, result: RuntimeRunResult) {
  const sessionId = result.sessionId ?? null;
  // Без id сессии читать нечего: снапшот лимитов живёт в состоянии сессии, а
  // прогон мог вовсе не завести поток (упал до thread.started).
  if (!sessionId) {
    return result;
  }

  const snapshot = await getCodexSessionLimitSnapshot({
    sessionId,
    runtimeId: input.runtimeId,
    providerId: input.providerId ?? "openai",
    profileId: input.profileId ?? null,
  });
  // Отсутствие снапшота — штатная ситуация (сессия не пишет состояние или файл
  // ещё не появился): результат возвращается как есть, без события.
  if (!snapshot) {
    return result;
  }

  const signature = JSON.stringify(snapshot);
  if (hasRuntimeLimitSnapshotSignature(result.events, signature)) {
    return result;
  }

  const limitEvent = buildRuntimeLimitEvent(snapshot, "token_count");
  // Новый массив вместо мутации: result уже мог уйти подписчикам, и дописывание
  // в старый events перерисовало бы уже отправленные данные.
  const nextEvents = [...(result.events ?? []), limitEvent];
  input.execution?.onEvent?.(limitEvent);

  return {
    ...result,
    events: nextEvents,
  };
}

// Память наблюдателя за лимитами, живёт между опросами внутри одной попытки.
// lastCheckedAtMs реализует троттлинг (не читать снапшот слишком часто),
// lastSignature — дедупликацию (не эмитить один и тот же лимит дважды).
interface CodexSessionLimitObserverState {
  lastCheckedAtMs: number;
  lastSignature: string | null;
}

async function maybeEmitCodexSessionLimitEvent(input: {
  runtimeInput: RuntimeRunInput;
  sessionId: string | null;
  state: CodexCliStreamState;
  observerState: CodexSessionLimitObserverState;
  logger?: CodexCliLogger;
  force?: boolean;
}): Promise<void> {
  const sessionId = input.sessionId;
  // Пока CLI не прислал thread.started, id ещё не известен — опрашивать нечего.
  if (!sessionId) {
    return;
  }

  const nowMs = Date.now();
  // Троттлинг + дедупликация по сигнатуре: опрос вызывается после каждой
  // разобранной JSONL-строки, и без обоих фильтров состояние сессии читалось
  // бы в tight-loop, а событие пересылалось при каждом чтении. Нулевой
  // lastCheckedAtMs означает «ещё не проверяли» — первый опрос проходит без
  // троттлинга.
  if (
    input.force !== true &&
    input.observerState.lastCheckedAtMs > 0 &&
    nowMs - input.observerState.lastCheckedAtMs < CODEX_SESSION_LIMIT_POLL_INTERVAL_MS
  ) {
    return;
  }
  input.observerState.lastCheckedAtMs = nowMs;

  const snapshot = await getCodexSessionLimitSnapshot({
    sessionId,
    runtimeId: input.runtimeInput.runtimeId,
    providerId: input.runtimeInput.providerId ?? "openai",
    profileId: input.runtimeInput.profileId ?? null,
  });
  // Нет снапшота — нет и события: молчание наблюдателя не должно выглядеть в UI
  // как «лимиты в порядке», поэтому не эмитится вообще ничего.
  if (!snapshot) {
    return;
  }

  const signature = JSON.stringify(snapshot);
  if (input.observerState.lastSignature === signature) {
    return;
  }
  input.observerState.lastSignature = signature;

  const limitEvent = buildRuntimeLimitEvent(snapshot, "token_count");
  // Тот же двойной путь, что и у остальных событий: в state — для итогового
  // результата, в колбэк — чтобы UI увидел лимит, не дожидаясь конца прогона.
  emitCodexEvent(input.state, input.runtimeInput.execution, limitEvent);
  input.logger?.debug?.(
    {
      runtimeId: input.runtimeInput.runtimeId,
      transport: "cli",
      sessionId,
      status: snapshot.status,
      checkedAt: snapshot.checkedAt,
    },
    "Observed Codex session token_count rate limits during CLI run",
  );
}

/**
 * Собирает промпт, который реально доходит до модели: `systemPromptAppend`
 * (языковая директива реестра + прочие сквозные добавки) в начале `input.prompt`,
 * разделённые пустой строкой.
 *
 * У Codex CLI нет отдельного слота под system prompt, поэтому это единственный
 * способ донести `execution.systemPromptAppend` до модели. Вычисление один раз
 * на верху запуска и сквозная передача и в шаблонную подстановку, и в запись
 * stdin держат гарантию доставки одинаковой на обычном пути И на кастомных
 * escape-hatch `codexCliArgs`, использующих `{prompt}`.
 */
function composePrompt(input: RuntimeRunInput): string {
  const append = input.execution?.systemPromptAppend?.trim();
  return append ? `${append}\n\n${input.prompt}` : input.prompt;
}

function shouldWritePromptToStdin(args: string[], usesPromptPlaceholder: boolean): boolean {
  // Любой кастомный аргумент, содержавший `{prompt}`, уже несёт составной
  // промпт после подстановки — включая составные формы вида
  // `--payload=prefix {prompt} suffix`, которые проверка `--prompt`/`--prompt=*`
  // ниже не поймала бы. `usesPromptPlaceholder` ловит этот сигнал до
  // подстановки, поэтому stdin подавляется единообразно.
  //
  // Прежняя ветка `args.includes(prompt)` намеренно удалена: `args` обычного
  // пути всегда содержат вспомогательные токены вроде `exec`, `--json` или id
  // модели, поэтому пользовательский промпт, случайно совпавший с таким
  // токеном, дал бы ложное срабатывание и не был бы доставлен. Флаг
  // плейсхолдера плюс явная проверка `--prompt` покрывают все легитимные
  // пути встраивания.
  if (usesPromptPlaceholder) return false;
  return !args.some((arg) => arg === "--prompt" || arg.startsWith("--prompt="));
}

// Единый шов платформенного разветвления: ниже — POSIX-spawn со stdio "pipe".
// Windows-ветка вынесена в spawnCliWindows и закрыта v8 ignore: её нельзя
// проверить в CI на Linux/macOS, и маркер честнее фантомного падения покрытия.
function spawnCodexProcess(
  input: RuntimeRunInput,
  cliPath: string,
  args: string[],
  env: Record<string, string>,
): ReturnType<typeof spawn> {
  // stdio:"pipe" обязателен: в stdin уходит промпт, из stdout читается JSONL,
  // stderr копится для диагностики. cwd — каталог задачи, если задан, иначе
  // корень проекта: относительные пути CLI должен видеть от проекта.
  /* v8 ignore next 2 -- ветка Windows */
  return IS_WINDOWS
    ? spawnCliWindows(cliPath, args, input.cwd ?? input.projectRoot, env)
    : spawn(cliPath, args, { cwd: input.cwd ?? input.projectRoot, env, stdio: "pipe" });
}

// Одна попытка запуска: собрать потоки, подписаться на события, вернуть
// результат. Кортеж различает два исхода: обычный результат и «процесс молчал
// до стартового таймаута». Во втором случае result бессмыслен, а решение о
// ретрае принимает вызывающий. Все прочие отказы уходят через reject — уже
// классифицированными.
function runCodexCliAttempt(
  input: RuntimeRunInput,
  cliPath: string,
  args: string[],
  env: Record<string, string>,
  composedPrompt: string,
  usesPromptPlaceholder: boolean,
  logger?: CodexCliLogger,
): Promise<{ result: RuntimeRunResult; startTimedOut: boolean }> {
  const execution = input.execution;
  const child = spawnCodexProcess(input, cliPath, args, env);

  // Подключаем общие утилиты таймаутов
  // Два независимых таймера внутри хелпера: start (дочерний процесс молчит и
  // не пишет ни в stdout, ни в stderr) и run (жёсткий потолок всего
  // исполнения). Адаптер лишь потребляет два флага, а cleanup() снимает
  // таймеры при любом исходе, чтобы живой setTimeout не удерживал event loop
  // после смерти процесса — та же логика, что и у unref в shared/withTimeout.
  const timeouts = withProcessTimeouts(child, {
    startTimeoutMs: execution?.startTimeoutMs,
    runTimeoutMs: execution?.runTimeoutMs ?? resolveTimeoutMs(input),
  });

  // Состояние потока и состояние наблюдателя разделены: первое — бухгалтерия
  // вывода прогона, второе — служебный мемо опросов (троттлинг и последняя
  // сигнатура). Смешивать их незачем: природа данных разная.
  const state = createCodexStreamState(input.sessionId ?? null);
  const limitObserverState: CodexSessionLimitObserverState = {
    lastCheckedAtMs: 0,
    lastSignature: null,
  };
  let stdoutBuffer = "";
  let stderr = "";
  // Цепочка сериализует асинхронные опросы: они стартуют часто, а завершаются
  // не гарантированно в том же порядке. Без сериализации устаревший ответ мог
  // бы затереть lastSignature, и дедупликация приняла бы уже отправленные
  // данные за свежие.
  let limitPollChain = Promise.resolve();

  // .catch в хвосте держит цепочку живой: необработанное отклонение убило бы
  // её, и все последующие опросы повисли бы на мёртвом промисе. Наблюдение за
  // лимитами не имеет права ронять полезную работу.
  const scheduleLimitPoll = (force = false): void => {
    limitPollChain = limitPollChain
      .then(() =>
        maybeEmitCodexSessionLimitEvent({
          runtimeInput: input,
          sessionId: state.sessionId,
          state,
          observerState: limitObserverState,
          logger,
          force,
        }),
      )
      .catch((err) => {
        logger?.warn?.(
          {
            runtimeId: input.runtimeId,
            transport: "cli",
            sessionId: state.sessionId,
            err,
          },
          "Failed to inspect Codex session token_count rate limits during CLI run",
        );
      });
  };

  // while, а не if: один чанк может содержать несколько полных строк —
  // буфер вычерпывается целиком, иначе события отстали бы от потока.
  const flushCompleteLines = (): void => {
    let newlineIdx = stdoutBuffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = stdoutBuffer.slice(0, newlineIdx);
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      processCodexJsonLine(line, state, execution);
      scheduleLimitPoll();
      newlineIdx = stdoutBuffer.indexOf("\n");
    }
  };

  // Восклицательные знаки здесь честны: stdio:"pipe" гарантирует наличие
  // потоков, а null-union у spawn.stdout — защита от других режимов stdio, а не
  // реальная опасность в этом коде. try/catch обрамляет весь flush, а не разбор
  // отдельной строки: исключение на одной строке не должно съедать остальной
  // буфер и вешать подписку 'data'.
  child.stdout!.on("data", (chunk: Buffer | string) => {
    stdoutBuffer += String(chunk);
    try {
      flushCompleteLines();
    } catch (err) {
      logger?.error?.(
        { runtimeId: input.runtimeId, err },
        "Codex CLI stream-json processing error",
      );
    }
  });

  // Весь stderr копится в одну строку: он нужен ровно один раз — как
  // диагностика в сообщении при ненулевом коде выхода. Кольцевого буфера,
  // как в agent/stderrCollector, здесь нет: прогон ограничен таймером run,
  // и болтливый CLI всё равно не успеет раздуть память до бесконечности.
  child.stderr!.on("data", (chunk: Buffer | string) => {
    const text = String(chunk);
    stderr += text;
    execution?.onStderr?.(text);
  });

  // Если запрошен abort — убиваем дочерний процесс
  // SIGTERM — просьба завершиться штатно: CLI успеет дозаписать вывод. В
  // противовес таймаутам: withProcessTimeouts добивает зависший процесс
  // SIGKILL'ом, потому что ждать вежливости от зависшего бессмысленно.
  // { once: true } — иначе слушатель протекал бы при переиспользовании сигнала.
  if (execution?.abortController) {
    execution.abortController.signal.addEventListener(
      "abort",
      () => {
        child.kill("SIGTERM");
      },
      { once: true },
    );
  }

  // Без этого обработчика EPIPE при записи упал бы весь процесс Node: у
  // стримов ошибка без слушателя выбрасывается наружу. Молчание безопасно:
  // если ребёнок умер, не прочитав промпт, настоящая причина придёт через
  // 'close' с ненулевым кодом.
  child.stdin!.on("error", () => {
    // Ошибки broken-pipe игнорируются — процесс может завершиться до записи всего stdin
  });
  // `composedPrompt` уже содержит `execution.systemPromptAppend`,
  // пристыкованный к пользовательскому промпту (см. `composePrompt()`). Когда
  // кастомные `codexCliArgs` встраивают промпт через `{prompt}` или `--prompt`,
  // то же значение подставлено в `args`, поэтому `shouldWritePromptToStdin()`
  // здесь пропускает stdin, чтобы не отправить промпт дважды.
  // Промпт пишется в stdin, а не в argv: аргументы командной строки видны
  // любым процессам в списке ОС, упираются в лимит длины командной строки и
  // требуют экранирования кавычек. У канала этих трёх проблем нет. end() закрывает
  // stdin: CLI читает промпт до EOF, без полузакрытия он ждал бы ввода вечно.
  if (shouldWritePromptToStdin(args, usesPromptPlaceholder)) {
    child.stdin!.write(composedPrompt);
  }
  child.stdin!.end();

  // Исход связывают с 'close', а не с 'exit': exit срабатывает в момент
  // смерти процесса, но в буферах stdio ещё могут оставаться неотданные
  // строки — ждать их дренажа критично, иначе потеряется последний тёрн.
  return new Promise((resolve, reject) => {
    // Сбой спавна (ENOENT — нет бинарника) приходит асинхронным событием
    // 'error', а не исключением из spawn(). classifyCodexRuntimeError —
    // единственная разрешённая точка классификации: наружу уходит ошибка со
    // структурированной категорией, по ней и ветвятся, а не по тексту.
    child.on("error", (error) => {
      timeouts.cleanup();
      reject(classifyCodexRuntimeError(error));
    });

    // Обработчик асинхронный, и это ловушка: исключение внутри async-колбэка не
    // попадёт в этот Promise, а всплывёт как unhandledRejection. Поэтому
    // опасные шаги обёрнуты в try, а await limitPollChain безопасен — каждое
    // звено цепочки уже имеет свой .catch.
    child.on("close", async (code) => {
      timeouts.cleanup();

      // Сбрасываем остаток буфера как финальную строку.
      // Хвост без завершающего \n — норма для оборвавшегося потока: после
      // смерти процесса данных больше не будет, поэтому остаток буфера считают
      // полной строкой.
      if (stdoutBuffer.length > 0) {
        try {
          processCodexJsonLine(stdoutBuffer, state, execution);
          scheduleLimitPoll();
        } catch {
          /* игнорируем ошибки обработки хвоста */
        }
        stdoutBuffer = "";
      }

      scheduleLimitPoll(true);
      await limitPollChain;

      const startTimedOut = await timeouts.startTimedOut;

      if (startTimedOut) {
        logger?.warn?.(
          { runtimeId: input.runtimeId, startTimeoutMs: execution?.startTimeoutMs },
          "Codex CLI start timeout — process produced no output",
        );
        // `null as unknown as RuntimeRunResult` — сознательный sentinel, а не
        // случайность: результат на этой ветке бессмыслен, а честный тип
        // заставил бы всех вызывающих проверять null. Контракт держится на
        // флаге startTimedOut — его читают первым.
        resolve({ result: null as unknown as RuntimeRunResult, startTimedOut: true });
        return;
      }

      // Потолок исполнения обеспечивает сам withProcessTimeouts (SIGKILL),
      // поэтому здесь остаётся только превратить факт таймаута в
      // структурированную ошибку вместо ожидания «особого» кода выхода.
      if (timeouts.runTimedOut) {
        const runMs = execution?.runTimeoutMs ?? resolveTimeoutMs(input);
        reject(makeProcessRunTimeoutError(runMs));
        return;
      }

      // Ненулевой код сам по себе безлик, поэтому в сообщение тянут stderr,
      // а при его пустоте — текст модели. Дальше ошибка проходит через
      // классификатор: наружу уходит структурированная категория, текст служит
      // только человеку (Project rule: ветвление по category, не по message).
      if (code !== 0) {
        const tail = state.outputText || state.plainTextFallback || "unknown error";
        const message = `Codex CLI exited with code ${code}: ${stderr || tail}`;
        reject(classifyCodexRuntimeError(message));
        return;
      }

      try {
        resolve({
          result: finalizeCodexResult(state, input.sessionId ?? null),
          startTimedOut: false,
        });
      } catch (error) {
        reject(classifyCodexRuntimeError(error));
      }
    });
  });
}

// Публичная точка входа одного прогона почти не содержит логики — она
// выстраивает этапы в порядке: композиция промпта, аргументы, окружение,
// попытка (с одним ретраем на start-timeout), финальное снятие лимитов.
export async function runCodexCli(
  input: RuntimeRunInput,
  logger?: CodexCliLogger,
): Promise<RuntimeRunResult> {
  const cliPath = resolveCliPath(input);
  // Составляем один раз, чтобы один и тот же промпт (systemPromptAppend +
  // промпт пользователя) шёл и в шаблонную подстановку `codexCliArgs`, и в
  // stdin-резерв — иначе кастомный `--prompt={prompt}` молча потерял бы
  // языковую директиву, которую реестр пристыковал через `systemPromptAppend`.
  const composedPrompt = composePrompt(input);
  const { args, usesPromptPlaceholder } = normalizeCliArgs(input, composedPrompt, logger);
  const options = asRecord(input.options);
  const explicitApiKeyEnvVar = readString(options.apiKeyEnvVar);
  const explicitApiKey = readString(options.apiKey);
  const allowApiKey = Boolean(explicitApiKeyEnvVar) || Boolean(explicitApiKey);
  // Дефолтное имя совпадает с тем, что ищет сам Codex CLI: профиль может
  // переопределить переменную, но по умолчанию нужен именно OPENAI_API_KEY.
  const apiKeyEnvVar = explicitApiKeyEnvVar ?? "OPENAI_API_KEY";

  // Для кастомного base URL (OpenAI-совместимый шлюз вроде router.ai) Codex CLI
  // читает эндпоинт из ~/.codex/config.toml (env OPENAI_BASE_URL /
  // CODEX_BASE_URL он игнорирует). Гарантируем наличие блока провайдера до
  // spawn, чтобы CLI шёл в настроенный шлюз, а не в api.openai.com.
  const baseUrl =
    readString(options.baseUrl) ??
    readString(options.agentApiBaseUrl) ??
    readString(process.env.CODEX_BASE_URL) ??
    null;
  if (baseUrl) {
    const ensured = ensureCodexProviderConfig({
      baseUrl,
      apiKeyEnvVar,
      model: readString(input.model) ?? null,
    });
    logger?.info?.(
      { providerName: ensured.providerName, configPath: ensured.configPath, baseUrl },
      "Ensured Codex CLI provider config",
    );
  }

  // Allowlist строится раньше, чем в env попадает явный apiKey: ключ из профиля
  // никогда не приезжает из process.env, так что случайная переменная с тем же
  // именем не имеет шансов просочиться в ребёнка незаметно от аудита.
  const curatedEnv = buildCuratedEnv(apiKeyEnvVar, { allowApiKey });
  const env = curatedEnv.env;
  // Явно заданный литеральный apiKey внедряется напрямую (он никогда не
  // приезжает из process.env). Зеркалируем его в OPENAI_API_KEY, чтобы Codex CLI
  // подхватил ключ независимо от имени кастомной переменной.
  if (explicitApiKey) {
    env[apiKeyEnvVar] = explicitApiKey;
    env.OPENAI_API_KEY = explicitApiKey;
  }
  logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      transport: "cli",
      forwardedEnvCount: curatedEnv.forwardedCount,
      filteredEnvCount: curatedEnv.filteredCount,
      blockedEnvCount: curatedEnv.blockedCount,
      droppedDisallowedPrefixCount: curatedEnv.droppedDisallowedPrefixKeys.length,
    },
    "[runtime:codex] Built Codex CLI environment from curated allowlist",
  );
  if (curatedEnv.droppedDisallowedPrefixKeys.length > 0) {
    logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        transport: "cli",
        droppedDisallowedPrefixKeys: curatedEnv.droppedDisallowedPrefixKeys.slice(0, 10),
      },
      "WARN [runtime:codex] Dropped disallowed environment prefix keys while building Codex CLI environment",
    );
  }

  // Логируется число аргументов, а не сами args: после подстановок внутрь
  // аргументов мог попасть промпт — пользовательский контент не должен утекать
  // в логи рантайма.
  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "cli",
      cliPath,
      argCount: args.length,
      startTimeoutMs: input.execution?.startTimeoutMs ?? null,
      runTimeoutMs: input.execution?.runTimeoutMs ?? resolveTimeoutMs(input),
    },
    "Starting Codex CLI run",
  );

  const { result, startTimedOut } = await runCodexCliAttempt(
    input,
    cliPath,
    args,
    env,
    composedPrompt,
    usesPromptPlaceholder,
    logger,
  );

  // Ровно один повтор и ровно на start-timeout: этот симптом похож на
  // преходящее состояние (бинарник завис при старте, холодный контейнер не
  // прогрет). Повторный сбой означает проблему конфигурации — дальнейшие
  // попытки лишь удлинят прогон.
  if (startTimedOut) {
    // Пауза берётся из execution-intent, а не хардкодится: политикой backoff
    // распоряжается вызывающий, адаптер лишь исполняет её.
    const retryDelayMs = resolveRetryDelay(input.execution ?? {});
    logger?.warn?.(
      { runtimeId: input.runtimeId, retryDelayMs },
      "Codex CLI start timeout, retrying once after delay",
    );
    await sleepMs(retryDelayMs);

    const retry = await runCodexCliAttempt(
      input,
      cliPath,
      args,
      env,
      composedPrompt,
      usesPromptPlaceholder,
      logger,
    );
    if (retry.startTimedOut) {
      // Структурированная ошибка: категория и длительность внутри исключения, так
      // что вызывающий различает сбои по полям, а не разбором сообщения.
      throw makeProcessStartTimeoutError(input.execution?.startTimeoutMs ?? 0);
    }
    return appendCodexSessionLimitEvent(input, retry.result);
  }

  return appendCodexSessionLimitEvent(input, result);
}
