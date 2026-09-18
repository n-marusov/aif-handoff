/**
 * Жизненный цикл дочернего процесса `codex app-server`.
 *
 * Модуль отвечает за три вещи: собрать безопасное окружение для ребёнка, запустить его
 * и корректно погасить (SIGTERM -> ожидание -> SIGKILL -> ожидание). Дочерний процесс
 * общается с адаптером по stdio, поэтому stdin/stdout занимать ничем другим нельзя:
 * любой посторонний вывод в stdout сломает поток JSON-RPC.
 *
 * Окружение фильтруется по белому списку ключей и префиксов: ребёнок не должен унаследовать
 * произвольные переменные родителя, а секреты не должны попадать в него случайно. Что именно
 * прошло и что было отброшено, видно в статистике из buildCodexAppServerEnvWithStats - она
 * уходит в логи, и без неё диагностика «codex не видит прокси/ключ» превращается в угадывание.
 */

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { RuntimeTransport } from "../../../types.js";
import { buildSafeWindowsShellCommandLine } from "../../../shellSafety.js";
import { PROXY_ENV_VARS } from "../../../proxyEnv.js";

// Платформа вычисляется один раз: process.platform в рантайме не меняется,
// а проверок на Windows в модуле несколько (спавн и сигналы).
const IS_WINDOWS = process.platform === "win32";

// Белый список, а не чёрный: перечислять небезопасные переменные бессмысленно - их число
// не ограничено. Здесь только то, без чего node/codex не стартуют или работают криво:
// пути, домашний каталог, локали, цвета вывода и прокси.
const ALLOWED_ENV_KEYS = new Set([
  "HOME",
  "USER",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "FORCE_COLOR",
  "NO_COLOR",
  "NODE_ENV",
  ...PROXY_ENV_VARS,
]);

// Префиксы открывают группы переменных целиком: OPENAI_/CODEX_ - конфигурация провайдера,
// AIF_/HANDOFF_ - настройки самого продукта, LC_/XDG_ - локали и расположение конфигов.
const ALLOWED_ENV_PREFIXES = ["OPENAI_", "CODEX_", "AIF_", "HANDOFF_", "LC_", "XDG_"];

// Блоклист применяется только к «окружению по умолчанию»: если профиль явно включает
// API-key-аутентификацию, ключ форвардится раньше этой проверки (см. allowApiKey).
/**
 * Env-переменные, которые по умолчанию не пробрасываются в дочерний процесс
 * Codex app-server. `OPENAI_API_KEY` / `OPENAI_BASE_URL` признаются только когда
 * API-key авторизация явно включена профилем через `apiKeyEnvVar`/`apiKey`
 * (решается до обращения к этому набору — см. `buildCodexAppServerEnvWithStats`).
 * Зеркалирует блок-листы SDK/CLI-транспортов, чтобы все три локальных Codex-транспорта
 * одинаково изолировали внешний OpenAI-auth env. `NODE_OPTIONS` вырезается всегда.
 */
const BLOCKED_ENV_KEYS = new Set(["OPENAI_API_KEY", "OPENAI_BASE_URL", "NODE_OPTIONS"]);

// Тайминги эскалации: сначала процессу даётся шанс завершиться самому (SIGTERM),
// и только потом применяется SIGKILL. Оба значения короткие, потому что сессии
// одноразовые и долгое ожидание лишь тормозит вызывающий код.
const DEFAULT_TERMINATE_TIMEOUT_MS = 1_000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 500;
// Хвост stderr хранится в памяти для диагностики: держать весь вывод нельзя,
// поэтому объём ограничен количеством сохранённых элементов.
const MAX_STDERR_TAIL_LINES = 50;

// Структурный логгер pino-совместимого вида: контекст объектом, сообщение строкой.
// Все методы необязательные - в тестах логгер можно не передавать вовсе.
export interface CodexAppServerLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

// Вход запуска - то, что приходит от вызывающего слоя. apiKey/apiKeyEnvVar/baseUrl
// продублированы на верхнем уровне и в options: часть вызывающих заполняет прямые поля,
// часть - общий объект настроек профиля, и оба источника нужно поддерживать.
export interface CodexAppServerLaunchInput {
  runtimeId: string;
  profileId?: string | null;
  transport?: RuntimeTransport;
  options?: Record<string, unknown>;
  projectRoot?: string;
  cwd?: string;
  apiKey?: string | null;
  apiKeyEnvVar?: string | null;
  baseUrl?: string | null;
}

// Статистика сборки окружения: сколько ключей прошло, сколько отфильтровано и сколько
// заблокировано как секреты. Возвращается множеством, разделённым по причинам,
// потому что «не прошло по белому списку» и «заблокировано» - разные диагнозы.
export interface CodexAppServerEnvironmentStats {
  env: Record<string, string>;
  forwardedCount: number;
  filteredCount: number;
  blockedCount: number;
  droppedDisallowedPrefixKeys: string[];
}

// Контекст процесса - это «ручка» для последующего завершения: сам ChildProcess,
// накопленный хвост stderr и параметры запуска, которые нужны только для логов.
export interface CodexAppServerProcessContext {
  process: ChildProcessWithoutNullStreams;
  stderrTail: string[];
  executablePath: string;
  args: string[];
  cwd?: string;
}

// Объект-обёртка над входом: так в сигнатуру запуска можно добавить опции
// (например, логгер), не меняя её при каждом расширении.
export interface CodexAppServerSpawnOptions {
  input: CodexAppServerLaunchInput;
  logger?: CodexAppServerLogger;
}

export function resolveCodexAppServerExecutable(input: CodexAppServerLaunchInput): string {
  // Приоритет источников: явная настройка профиля, затем переменная окружения родителя,
  // и только в самом конце - имя из PATH. Так рабочая конфигурация не теряется.
  const options = asRecord(input.options);
  const configuredCliPath =
    readString(options.codexCliPath) ?? readString(process.env.CODEX_CLI_PATH);
  return configuredCliPath ?? "codex";
}

export function buildCodexAppServerEnv(input: CodexAppServerLaunchInput): Record<string, string> {
  // Упрощённый фасад: большинству вызывающих нужен только env,
  // а статистика - тем, кто пишет её в логи.
  return buildCodexAppServerEnvWithStats(input).env;
}

export function buildCodexAppServerEnvWithStats(
  input: CodexAppServerLaunchInput,
): CodexAppServerEnvironmentStats {
  const env: Record<string, string> = {};
  // Раздельные счётчики, а не один общий: причины непопадания ключа в ребёнка разные
  // и в логах их полезно различать.
  let forwardedCount = 0;
  let filteredCount = 0;
  let blockedCount = 0;
  const droppedDisallowedPrefixKeys = new Set<string>();

  const options = asRecord(input.options);
  // Настройки читаются из двух источников: прямые поля входа и options профиля.
  // readString нормализует пустые строки в null, поэтому ?? выбирает корректно.
  const explicitApiKeyEnvVar = readString(input.apiKeyEnvVar) ?? readString(options.apiKeyEnvVar);
  const explicitApiKey = readString(input.apiKey) ?? readString(options.apiKey);
  // Локальные запуски app-server по умолчанию используют `codex login` / OAuth. API-key
  // авторизация включается только явными apiKeyEnvVar/apiKey профиля — внешний
  // OPENAI_API_KEY нельзя ни потреблять, ни пробрасывать: иначе placeholder-
  // ключ перехватит OAuth-сессию.
  const allowApiKey = Boolean(explicitApiKeyEnvVar) || Boolean(explicitApiKey);
  const apiKeyEnvVar = explicitApiKeyEnvVar ?? "OPENAI_API_KEY";

  for (const [key, value] of Object.entries(process.env)) {
    // Проверка через == null отсекает сразу и null, и undefined: в env ребёнка
    // нельзя положить не-строку.
    if (value == null) continue;
    // Явное включение API-key: пробрасываем настроенную ключевую переменную
    // (ей может быть OPENAI_API_KEY) до блок-листа, чтобы API-key авторизация
    // работала, когда профиль её запрашивает.
    if (key === apiKeyEnvVar && allowApiKey) {
      env[key] = value;
      forwardedCount += 1;
      continue;
    }
    // Настроенная ключевая переменная без явного включения не должна утечь в дочерний процесс.
    if (key === apiKeyEnvVar) {
      blockedCount += 1;
      continue;
    }
    // Внешние OpenAI-auth переменные (OPENAI_API_KEY / OPENAI_BASE_URL) блокируются по
    // умолчанию, чтобы placeholder-ключ не перехватил OAuth-сессию `codex login`.
    if (BLOCKED_ENV_KEYS.has(key)) {
      blockedCount += 1;
      continue;
    }
    if (isAllowedEnvironmentKey(key)) {
      // Ни точное имя, ни один из префиксов не совпали - ключ не наследуется.
      env[key] = value;
      forwardedCount += 1;
      continue;
    }
    filteredCount += 1;
    // Отдельно запоминаем отброшенные npm_-ключи: их набор выдаёт запуск из npm-скрипта,
    // и это первая гипотеза при разборе «почему окружение не такое, как в терминале».
    if (key.startsWith("npm_")) {
      droppedDisallowedPrefixKeys.add(key);
    }
  }

  const apiKey = explicitApiKey ?? (allowApiKey ? readString(process.env[apiKeyEnvVar]) : null);
  if (apiKey) {
    // Явный ключ имеет приоритет; из окружения он берётся только при opt-in.
    // OPENAI_API_KEY выставляется дополнительно, потому что codex читает именно его.
    env[apiKeyEnvVar] = apiKey;
    env.OPENAI_API_KEY = apiKey;
  }

  const baseUrl =
    // baseUrl нужен для проксирования на router.ai: он читается из настроек, затем
    // из CODEX_BASE_URL родителя. Трогать OPENAI_BASE_URL не нужно - он в блоклисте.
    readString(input.baseUrl) ??
    readString(options.baseUrl) ??
    readString(process.env.CODEX_BASE_URL);
  if (baseUrl) {
    env.CODEX_BASE_URL = baseUrl;
  }

  // Специфика Windows: прокси может быть задан в любом регистре, и если зазеркалить
  // только одну форму, часть окружения останется без прокси.
  // Env-переменные Windows регистронезависимы; зеркалим каппинг прокси-ключей,
  // чтобы не потерять вариант, если родитель пробросил только верхний/нижний регистр.
  mirrorEnvPair(env, "HTTP_PROXY", "http_proxy");
  mirrorEnvPair(env, "HTTPS_PROXY", "https_proxy");
  mirrorEnvPair(env, "ALL_PROXY", "all_proxy");
  mirrorEnvPair(env, "NO_PROXY", "no_proxy");

  return {
    env,
    forwardedCount,
    filteredCount,
    blockedCount,
    droppedDisallowedPrefixKeys: [...droppedDisallowedPrefixKeys],
  };
}

export function spawnCodexAppServerProcess(
  options: CodexAppServerSpawnOptions,
): CodexAppServerProcessContext {
  // Транспорт попадает только в логи, но по нему потом видно, откуда пришёл запуск.
  const transport = options.input.transport ?? RuntimeTransport.CLI;
  // Всё, что зависит только от входа, вычисляется заранее: если spawn бросит,
  // в логах останется уже разрешённый путь и cwd.
  const executablePath = resolveCodexAppServerExecutable(options.input);
  const envStats = buildCodexAppServerEnvWithStats(options.input);
  const cwd = options.input.cwd ?? options.input.projectRoot;
  // Ровно один аргумент: подкоманда app-server переводит codex в режим JSON-RPC-сервера
  // поверх stdio, без неё процесс запустится как интерактивный CLI.
  const args = ["app-server"];

  // В логи идут только счётчики и имена, а не значения переменных:
  // среди них могут быть секреты.
  options.logger?.debug?.(
    {
      runtimeId: options.input.runtimeId,
      profileId: options.input.profileId ?? null,
      transport,
      executablePath,
      cwd: cwd ?? null,
      forwardedEnvCount: envStats.forwardedCount,
      filteredEnvCount: envStats.filteredCount,
      blockedEnvCount: envStats.blockedCount,
      droppedDisallowedPrefixCount: envStats.droppedDisallowedPrefixKeys.length,
      optionKeys: Object.keys(asRecord(options.input.options)),
    },
    "DEBUG [runtime:codex] Starting Codex app-server process over stdio",
  );

  if (envStats.droppedDisallowedPrefixKeys.length > 0) {
    // Предупреждение отдельным событием: обычный debug-лог могут и не включить,
    // а ситуация «окружение собрано не так, как ожидал пользователь» важна.
    options.logger?.warn?.(
      {
        runtimeId: options.input.runtimeId,
        profileId: options.input.profileId ?? null,
        transport,
        droppedDisallowedPrefixKeys: envStats.droppedDisallowedPrefixKeys.slice(0, 10),
      },
      "WARN [runtime:codex] Dropped disallowed environment prefix keys while building Codex app-server environment",
    );
  }

  const childProcess =
    // Специфика Windows: .cmd/.bat-обёртки (а codex часто ставится именно так) нельзя
    // запустить через spawn напрямую без шелла, поэтому используется cmd.exe /d /c
    // с явно построенной и проверенной командной строкой.
    IS_WINDOWS && !executablePath.toLowerCase().endsWith(".exe")
      ? spawn(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/c", buildWindowsAppServerCommandLine(executablePath, args)],
          {
            cwd,
            env: envStats.env,
            stdio: "pipe",
            // Node не должен экранировать строку повторно: она уже собрана
            // buildSafeWindowsShellCommandLine, и второе экранирование её сломает.
            windowsVerbatimArguments: true,
          },
        )
      : spawn(executablePath, args, {
          cwd,
          env: envStats.env,
          stdio: "pipe",
        });

  const stderrTail: string[] = [];
  // Подписка ставится сразу после спавна: ошибки старта приходят в stderr раньше,
  // чем завершится рукопожатие, и без слушателя они потерялись бы.
  childProcess.stderr.on("data", (chunk: Buffer | string) => {
    stderrTail.push(String(chunk));
    // В диагностике ценнее конец вывода (там обычно причина падения), поэтому
    // старые элементы вытесняются, а не новые.
    while (stderrTail.length > MAX_STDERR_TAIL_LINES) {
      stderrTail.shift();
    }
  });

  return {
    process: childProcess,
    stderrTail,
    executablePath,
    args,
    cwd,
  };
}

export async function terminateCodexAppServerProcess(
  context: CodexAppServerProcessContext,
  logger?: CodexAppServerLogger,
  terminateTimeoutMs = DEFAULT_TERMINATE_TIMEOUT_MS,
  forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
): Promise<void> {
  // Эскалация завершения: сигнал -> ожидание -> жёсткий килл -> ожидание.
  // Функция никогда не бросает: её зовут из finally, и исключение сломало бы
  // обработку исходной ошибки вызывающего кода.
  if (hasProcessExited(context.process)) {
    // Процесс уже мёртв - ждать нечего; повторный kill по освобождённому PID
    // в теории мог бы адресоваться уже другому процессу.
    return;
  }

  logger?.debug?.(
    {
      executablePath: context.executablePath,
      cwd: context.cwd ?? null,
      terminateTimeoutMs,
    },
    "DEBUG [runtime:codex] Terminating Codex app-server process",
  );

  try {
    // SIGTERM - вежливый сигнал: процесс успевает закрыть сокеты и убрать временные файлы.
    context.process.kill("SIGTERM");
  } catch {
    // kill умеет бросать (например, платформа не знает такой сигнал), поэтому
    // fallback - вызов без сигнала, то есть платформенный вариант по умолчанию.
    try {
      context.process.kill();
    } catch {
      // игнорируем
    }
  }

  const exited = await waitForExit(context.process, terminateTimeoutMs);
  if (exited) {
    return;
  }

  // Не вышел за отведённое время - значит, завис или игнорирует SIGTERM.
  logger?.warn?.(
    {
      executablePath: context.executablePath,
      cwd: context.cwd ?? null,
      forceKillTimeoutMs,
    },
    "WARN [runtime:codex] Graceful Codex app-server shutdown timed out, forcing kill",
  );

  try {
    // SIGKILL процесс перехватить не может, поэтому после него остаётся только ждать.
    context.process.kill("SIGKILL");
  } catch {
    try {
      context.process.kill();
    } catch {
      // игнорируем
    }
  }

  const forceExited = await waitForExit(context.process, forceKillTimeoutMs);
  if (!forceExited) {
    // Остался жив даже после SIGKILL (например, процесс в контейнере ждёт родителя):
    // сообщаем об этом, но не бросаем - вызывающий уже находится в finally.
    logger?.warn?.(
      {
        executablePath: context.executablePath,
        cwd: context.cwd ?? null,
      },
      "WARN [runtime:codex] Codex app-server process did not exit after force kill",
    );
  }
}

function mirrorEnvPair(
  env: Record<string, string>,
  uppercaseKey: string,
  lowercaseKey: string,
): void {
  // Пустая строка как прокси означала бы «без прокси», поэтому лучше вообще не создавать
  // ключ, чем создавать его с пустым значением.
  const value = env[uppercaseKey] ?? env[lowercaseKey];
  if (!value) {
    return;
  }
  env[uppercaseKey] = value;
  env[lowercaseKey] = value;
}

function isAllowedEnvironmentKey(key: string): boolean {
  // Два уровня разрешения: точное имя или префикс. Префиксный вариант нужен для групп,
  // полный список которых заранее неизвестен (LC_ALL, XDG_CONFIG_HOME и подобные).
  return ALLOWED_ENV_KEYS.has(key) || ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function hasProcessExited(process: ChildProcess): boolean {
  // exitCode/signalCode выставляются после фактического завершения. Поле killed для этого
  // не годится: оно отражает лишь факт отправки сигнала, а не смерть процесса.
  return process.exitCode != null || process.signalCode != null;
}

function asRecord(value: unknown): Record<string, unknown> {
  // В отличие от одноимённых хелперов в других модулях, здесь возвращается пустой объект,
  // а не null: вызывающий код сразу читает поля настроек через ?. и ??.
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  // trim и проверка длины: строка из пробелов в настройке равносильна её отсутствию
  // и не должна попадать в env или в путь к исполняемому файлу.
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function waitForExit(
  childProcess: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  // Ранний выход: если процесс уже завершился, подписываться на события поздно -
  // события уже не придут, и промис висел бы до таймаута.
  if (hasProcessExited(childProcess)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    // Разрешить промис нужно ровно один раз: события exit и close обычно приходят оба,
    // а без флага cleanup и resolve выполнялись бы повторно.
    let settled = false;
    const cleanup = () => {
      // Снимаем и таймер, и слушатели: незакрытый timer сам по себе удерживает process.
      clearTimeout(timer);
      childProcess.off("exit", onExit);
      childProcess.off("close", onClose);
    };
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onExit = () => settle(true);
    const onClose = () => settle(true);
    // Таймер страхует от зависшего процесса: лучше вернуть false и перейти к SIGKILL,
    // чем ждать бесконечно.
    const timer = setTimeout(() => settle(false), timeoutMs);
    // Слушаем оба события: exit - процесс завершился, close - закрылись его stdio-потоки.
    // Для решения «он мёртв» достаточно любого из них.
    childProcess.once("exit", onExit);
    childProcess.once("close", onClose);
  });
}

export function buildWindowsAppServerCommandLine(executablePath: string, args: string[]): string {
  // Обёртка над общей проверкой командной строки: правила экранирования живут
  // в shellSafety.ts, чтобы все транспорты codex пользовались одной реализацией.
  return buildSafeWindowsShellCommandLine(executablePath, args, "Codex app-server");
}
