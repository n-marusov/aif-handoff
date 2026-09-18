/**
 * CLI-транспорт адаптера Claude: выполнение запросов через запуск бинарника `claude`
 * как дочернего процесса.
 *
 * Применяется, когда на хосте доступен установленный Claude Code и привязываться к
 * встроенному Agent SDK не нужно: сессии, аутентификация и определения агентов живут
 * в самом CLI.
 *
 * Конвейер запуска: собрать аргументы (`buildCliArgs`) -> поднять процесс (с особой
 * логикой для windows-обёрток) -> отдать промпт через stdin -> инкрементально
 * разбирать JSONL из stdout (`processStreamJsonLine`) в RuntimeEvents -> по
 * накопленному состоянию собрать RuntimeRunResult или типизированную ошибку.
 *
 * Два инварианта соблюдаются во всём модуле:
 * - промпт никогда не попадает в argv (только stdin) - см. комментарий к buildCliArgs;
 * - ошибки выходят через конструкторы `errors.ts`: потребители ветвятся по
 *   структурированным `category`/`adapterCode`, а не по тексту сообщения.
 */

import { spawn, execFileSync } from "node:child_process";
import type {
  RuntimeEvent,
  RuntimeLimitSnapshot,
  RuntimeRunInput,
  RuntimeSessionForkInput,
  RuntimeRunResult,
  RuntimeUsage,
} from "../../types.js";
import { RuntimeLimitStatus } from "../../types.js";
import { buildRuntimeLimitEvent } from "../../limitEvents.js";
import { assertSafeWindowsShellExecutablePath } from "../../shellSafety.js";
import {
  makeProcessRunTimeoutError,
  makeProcessStartTimeoutError,
  resolveRetryDelay,
  sleepMs,
  withProcessTimeouts,
} from "../../timeouts.js";
import { classifyClaudeResultSubtype, classifyClaudeRuntimeError } from "./errors.js";
import { normalizeClaudeLimitSnapshot } from "./limit.js";
import { normalizeClaudeEffort, resolveProfileEnvironment } from "./options.js";
import { buildToolUseEvents } from "../../toolEvents.js";
import { parseClaudeAskUserQuestion } from "./questions.js";
import type { ClaudeProviderIdentity } from "./providerIdentity.js";
import { resolveClaudeProviderAuth } from "./providerIdentity.js";
import { fetchZaiClaudeQuotaSnapshot } from "./zaiQuota.js";
import { PROXY_ENV_VARS } from "../../proxyEnv.js";

const IS_WINDOWS = process.platform === "win32";

// Структурное подмножество pino-логгера: все методы опциональны, потому что логирование
// не входит в контракт выполнения - вызывающий код без логгера (тесты, скрипты)
// получает работоспособный транспорт, а места вызова используют опциональные цепочки.
export interface ClaudeCliLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

// Сужение недоверенного значения до записи без исключений: те же правила, что у
// помощников в ../../utils.ts, но оставлены локально в этом модуле. Не-объект (и массив)
// превращается в {}, поэтому вызывающий код никогда не сталкивается с разыменованием
// null.
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Пустая строка приравнивается к отсутствию значения: вызывающему коду не нужна
// отдельная проверка "задано, но пусто" - оба случая означают "бери дефолт".
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Запрос форка может прийти как generic RuntimeRunInput: поле ищут утиной типизацией.
// Каст `as Partial<...>` здесь безопасен: он разрешает только чтение, а typeof
// проверяет фактическое наличие строки в рантайме.
function readForkSourceSessionId(input: RuntimeRunInput): string | null {
  const sourceSessionId = (input as Partial<RuntimeSessionForkInput>).sourceSessionId;
  return typeof sourceSessionId === "string" && sourceSessionId.trim().length > 0
    ? sourceSessionId.trim()
    : null;
}

// Белый список переменных, передаваемых дочернему процессу. Окружение CLI - не только
// сам CLI: оно доходит до хуков и инструментов, поэтому наследование всего process.env
// привело бы к утечке лишних секретов в зону доступности агента. Точные имена (HOME, PATH)
// задают одну переменную, префиксы с нижним подчёркиванием (XDG_, LC_) - семейство.
const ALLOWED_ENV_PREFIXES = [
  "ANTHROPIC_",
  "OPENAI_",
  "CLAUDE_",
  "AIF_",
  "HANDOFF_",
  "NODE_",
  "npm_",
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
  "EDITOR",
  "VISUAL",
  "FORCE_COLOR",
  "NO_COLOR",
  ...PROXY_ENV_VARS,
];

// Переменная с API-ключом сопоставляется по точному имени: она приходит из профиля,
// поэтому произвольные имена не нужно добавлять в белый список.
// executionEnv сливается последним: env конкретной задачи важнее env родительского
// процесса.
function buildCuratedEnv(
  apiKeyEnvVar: string,
  executionEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (
      key === apiKeyEnvVar ||
      ALLOWED_ENV_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix))
    ) {
      env[key] = value;
    }
  }
  Object.assign(env, executionEnv ?? {});
  return env;
}

// Цепочка приоритетов: опция запуска -> CLAUDE_CLI_PATH -> значение адаптера по
// умолчанию -> голое "claude" (ищется через PATH). Так как readString выдаёт null для
// пустых значений, пустая строка на любом этапе не ломает запуск, а уходит ниже.
function resolveCliPath(input: RuntimeRunInput, adapterDefault?: string): string {
  const options = asRecord(input.options);
  return (
    readString(options.claudeCliPath) ??
    readString(process.env.CLAUDE_CLI_PATH) ??
    adapterDefault ??
    "claude"
  );
}

/**
 * Проверяет доступность Claude CLI запуском `claude --version`.
 * В Windows голое имя команды вроде `"claude"` требует `shell: true` для резолва `.cmd`.
 */
export function probeClaudeCli(cliPath: string): { ok: boolean; version?: string; error?: string } {
  try {
    if (IS_WINDOWS) {
      assertSafeWindowsShellExecutablePath(cliPath, "Claude CLI path");
    }
    const out = execFileSync(cliPath, ["--version"], {
      // Пять секунд - щедрый запас для живой установки: если бинарник не отозвался, он
      // фактически сломан, и тянуть проверку дальше смысла нет.
      timeout: 5_000,
      shell: IS_WINDOWS,
      // stderr намеренно игнорируется: вердикт даёт код выхода и stdout. Рабочий CLI
      // вправе что-то предупредительно напечатать - это не провал пробы.
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, version: out.toString().trim() };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/* v8 ignore start -- логика spawn только для Windows, нетестируемо в macOS/Linux CI */
// Минимальное экранирование для cmd.exe: оборачиваем только аргументы с пробелами или
// кавычками. Вложенные кавычки экранируются обратным слэшем - итоговую строку разбирает
// уже сама целевая программа по C-соглашениям (windows-логика, см. v8 ignore).
function quoteIfNeeded(arg: string): string {
  return arg.includes(" ") || arg.includes('"') ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

// На Windows `claude` чаще всего .cmd-обёртка (npm-шим), которую CreateProcess не умеет
// запускать напрямую: команду прогоняем через cmd.exe (/d отключает AutoRun, /c исполняет
// и выходит). Путь к исполняемому файлу проверяется на метасимволы заранее
// (shellSafety.ts): при склейке в одну строку инъекцию дешевле запретить, чем экранировать.
function spawnCliWindows(
  cliPath: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string>,
) {
  assertSafeWindowsShellExecutablePath(cliPath, "Claude CLI path");
  const cmd = process.env.ComSpec ?? "cmd.exe";
  const cmdLine = [cliPath, ...args.map(quoteIfNeeded)].join(" ");
  return spawn(cmd, ["/d", "/c", cmdLine], {
    cwd,
    env,
    stdio: "pipe",
    // Отключает собственное экранирование Node: cmdLine собрана ровно в том виде, в
    // каком её должен увидеть шелл, двойное экранирование сломало бы кавычки.
    windowsVerbatimArguments: true,
  });
}
/* v8 ignore stop */

// runTimeoutMs может прийти из профиля или БД, то есть быть чем угодно:
// Number.isFinite отсекает NaN/Infinity, Math.floor приводит к целому. 300 секунд -
// потолок по умолчанию: зависший прогон лучше высвободить для повтора, чем вечно
// держать слот очереди.
function resolveTimeoutMs(input: RuntimeRunInput): number {
  const exec = input.execution;
  if (
    typeof exec?.runTimeoutMs === "number" &&
    Number.isFinite(exec.runTimeoutMs) &&
    exec.runTimeoutMs > 0
  ) {
    return Math.floor(exec.runTimeoutMs);
  }
  return 300_000;
}

/**
 * Собирает аргументы CLI для бинарника `claude`.
 *
 * Agent mode:  `claude --agent <name> --output-format stream-json --verbose -p`
 * Direct mode: `claude --output-format stream-json --verbose -p`
 *
 * Сам промпт в командную строку НЕ передаётся — он пишется в
 * stdin дочернего процесса в `runCliAttempt`. Так промпт не попадает в argv,
 * и мы не упираемся в лимиты ARG_MAX / cmd.exe на больших промптах
 * (rework-заголовки, полные планы и вложения задачи легко достигают 100+ КБ).
 *
 * stream-json вместо json: CLI выдаёт JSONL-события по мере готовности —
 * фрагменты текста, tool_use, инициализация сессии — runtime получает живую
 * ленту Agent Activity (колбэки onEvent/onToolUse) вместо одного
 * буферизованного куска на выходе. --verbose жёстко обязателен, чтобы CLI
 * действительно стримил промежуточные события в режиме stream-json.
 */
function buildCliArgs(input: RuntimeRunInput): string[] {
  const execution = input.execution;
  const options = asRecord(input.options);
  const args: string[] = [];

  // Определение агента — запускает сабагента через флаг --agent
  const agentName = execution?.agentDefinitionName ?? readString(options.agentDefinitionName);
  if (agentName) {
    args.push("--agent", agentName);
  }

  // Потоковый JSONL-вывод (обязателен, чтобы показывать Agent Activity в реальном времени)
  args.push("--output-format", "stream-json", "--verbose");

  // Опциональные дельты уровня токенов (работает только с --print + stream-json)
  if (execution?.includePartialMessages) {
    args.push("--include-partial-messages");
  }

  // Переопределение модели
  if (input.model) {
    args.push("--model", input.model);
  }

  // Уровень effort (low, medium, high, max)
  const effort = normalizeClaudeEffort(options.effort, options);
  if (effort) {
    args.push("--effort", effort);
  }

  // Ограничение числа шагов (turns)
  if (execution?.maxTurns) {
    args.push("--max-turns", String(execution.maxTurns));
  }

  // Форк выражается тем же --resume: --fork-session велит CLI начать новую сессию
  // с историей источника, а не продолжать её. Отдельного флага форка нет, поэтому
  // порядок и парность флагов имеют значение.
  const forkSourceSessionId = readForkSourceSessionId(input);
  if (forkSourceSessionId) {
    args.push("--resume", forkSourceSessionId, "--fork-session");
  } else if (input.resume && input.sessionId) {
    args.push("--resume", input.sessionId);
  }

  // Добавка к system prompt
  const systemAppend = execution?.systemPromptAppend ?? readString(options.systemPromptAppend);
  if (systemAppend) {
    args.push("--append-system-prompt", systemAppend);
  }

  // Режим разрешений
  // В одноразовом режиме -p интерактивные запросы никто не ответит, поэтому acceptEdits -
  // минимум, позволяющий автономной работе править файлы. Полный обход решается выше
  // (execution.bypassPermissions), транспорт лишь исполняет выбор.
  if (execution?.bypassPermissions) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "acceptEdits");
  }

  // Неинтерактивный print-режим — сам промпт ниже передаётся через stdin.
  args.push("-p");

  return args;
}

// ---------------------------------------------------------------------------
// Обработчик строк stream-json
// ---------------------------------------------------------------------------

// Ручная выжимка недокументированной схемы stream-json CLI (обе таблицы ниже).
// Каждое поле опционально: известное может отсутствовать в части событий, а неизвестные
// появляются со временем и просто игнорируются. Такая схема обязывает читать
// через опциональные цепочки и typeof-проверки на каждом шаге - разыменить
// несуществующее поле здесь нечем.
interface StreamJsonContentItem {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  thinking?: string;
}

interface StreamJsonMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  rate_limit_info?: unknown;
  total_cost_usd?: number;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  message?: {
    content?: StreamJsonContentItem[];
  };
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// Накопители всего прогона в одном объекте: поток разбирается построчно, а результат
// собирается после смерти процесса, так что промежуточным данным нужно пережить цикл
// обработки. Null-ы здесь значимы: `usage: null` означает "строка result не дошла",
// что не то же самое, что обнулённые счётчики.
interface ClaudeCliStreamState {
  sessionId: string | null;
  outputText: string;
  assistantText: string;
  usage: RuntimeUsage | null;
  latestLimitSnapshot: RuntimeLimitSnapshot | null;
  events: RuntimeEvent[];
  terminalErrorSubtype: string | null;
  terminalErrorDetail: string | null;
  plainTextFallback: string;
}

function createCliStreamState(fallbackSessionId: string | null): ClaudeCliStreamState {
  return {
    sessionId: fallbackSessionId,
    outputText: "",
    assistantText: "",
    usage: null,
    latestLimitSnapshot: null,
    events: [],
    terminalErrorSubtype: null,
    terminalErrorDetail: null,
    plainTextFallback: "",
  };
}

// Краткое описание аргументов инструмента попадает в события и логи, но вход может
// содержать тело целого файла - отсюда жёсткие лимиты длины. try/catch не для галочки:
// сигнатура принимает любой unknown, а stringify переваривает не всё (например BigInt).
function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") {
    return input.length > 80 ? `${input.slice(0, 77)}...` : input;
  }
  try {
    const json = JSON.stringify(input);
    if (json.length <= 100) return json;
    return `${json.slice(0, 97)}...`;
  } catch {
    return "";
  }
}

// Отдаёт null, если usage в сообщении нет вообще: отсутствие сохраняется как null, а не
// подменяется нулями - учёт стоимости различает эти случаи.
function normalizeStreamJsonUsage(message: StreamJsonMessage): RuntimeUsage | null {
  const usage = message.usage;
  if (!usage) return null;
  const rawInput = usage.input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  // Anthropic тарифицирует создание и чтение кеша отдельно от input_tokens:
  // сводим в одну сумму, чтобы объём ввода сопоставлялся между разными адаптерами.
  const inputTokens = rawInput + cacheCreation + cacheRead;
  const outputTokens = usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;
  // У стоимости было два имени в разных версиях CLI; нечисловое значение остаётся
  // undefined, а не превращается в NaN в результате.
  const costUsdRaw = message.total_cost_usd ?? message.cost_usd;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: typeof costUsdRaw === "number" ? costUsdRaw : undefined,
  };
}

// Единственный источник правды для событий: каждое идёт и в журнал (result.events,
// читаемый после прогона), и живьём в колбек (стриминг для UI). Иначе два потребителя
// могли бы увидеть разное содержимое или порядок.
function emitEvent(
  state: ClaudeCliStreamState,
  execution: RuntimeRunInput["execution"],
  event: RuntimeEvent,
): void {
  state.events.push(event);
  execution?.onEvent?.(event);
}

// Структурированный контекст ошибок лимитов: retry-after сразу в секундах и
// миллисекундах, сам снимок и мета провайдера. Потребители ветвятся по этим полям
// (правило проекта), а отсутствие закодировано явным null, а не выдуманными
// значениями по умолчанию.
function buildClaudeLimitErrorMetadata(snapshot: RuntimeLimitSnapshot | null) {
  const retryAfterSeconds = snapshot?.retryAfterSeconds ?? null;
  return {
    resetAt: snapshot?.resetAt ?? null,
    retryAfterSeconds,
    retryAfterMs: retryAfterSeconds != null ? retryAfterSeconds * 1000 : null,
    limitSnapshot: snapshot,
    providerMeta: snapshot?.providerMeta ?? null,
  };
}

// Синхронный обработчик одной JSONL-строки. Тип возвращает void, но умеет бросать
// исключение: заблокированный лимит - штатный сценарий остановки прогона, см. throw
// внутри тела.
function processStreamJsonLine(
  line: string,
  state: ClaudeCliStreamState,
  input: RuntimeRunInput,
  providerIdentity: ClaudeProviderIdentity,
  logger?: ClaudeCliLogger,
): void {
  const execution = input.execution;
  const trimmed = line.trim();
  if (!trimmed) return;

  // Строка, которая не является JSON или не-объект, уходит в plainTextFallback: CLI
  // иной раз печатает в stdout баннеры и уведомления, и выбросить их - значит остаться
  // с пустым выводом у завершённого прогона.
  let message: StreamJsonMessage;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") {
      state.plainTextFallback += (state.plainTextFallback ? "\n" : "") + trimmed;
      return;
    }
    message = parsed as StreamJsonMessage;
  } catch {
    state.plainTextFallback += (state.plainTextFallback ? "\n" : "") + trimmed;
    return;
  }

  const nowIso = new Date().toISOString();

  // Первая строка потока: id сессии стоит запомнить, даже если прогон упадёт через
  // секунду - именно он понадобится для resume/fork позже.
  if (message.type === "system" && message.subtype === "init") {
    if (typeof message.session_id === "string" && message.session_id.length > 0) {
      state.sessionId = message.session_id;
    }
    emitEvent(state, execution, {
      type: "system:init",
      timestamp: nowIso,
      level: "debug",
      message: "Runtime session initialized",
      data: { sessionId: state.sessionId },
    });
    return;
  }

  // Событие лимитов провайдера: переводится на универсальный RuntimeLimitSnapshot,
  // который остальная система понимает независимо от рантайма.
  if (message.type === "rate_limit_event") {
    const snapshot = normalizeClaudeLimitSnapshot({
      info: message.rate_limit_info,
      runtimeId: input.runtimeId,
      providerId: input.providerId ?? "anthropic",
      profileId: input.profileId ?? null,
      checkedAt: nowIso,
      providerIdentity,
    });

    // Пустой результат означает "в событии не было ничего пригодного": лог обязателен,
    // безмолвный выброс бесконечно скрывал бы дрейф схемы на стороне провайдера.
    if (!snapshot) {
      logger?.warn?.(
        {
          runtimeId: input.runtimeId,
          providerId: input.providerId ?? "anthropic",
          profileId: input.profileId ?? null,
        },
        "Dropped Claude rate_limit_event because it did not contain usable limit metadata",
      );
      return;
    }

    state.latestLimitSnapshot = snapshot;
    emitEvent(state, execution, buildRuntimeLimitEvent(snapshot, "rate_limit_event"));
    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        providerId: snapshot.providerId,
        profileId: snapshot.profileId ?? null,
        status: snapshot.status,
        precision: snapshot.precision,
        source: snapshot.source,
        resetAt: snapshot.resetAt ?? null,
      },
      "Translated Claude rate_limit_event into runtime limit snapshot",
    );
    // Бросать здесь - осознанный control flow: исключение ловит обработчик stdout и
    // убивает дочерний процесс. Продолжать работу при заблокированном лимите - жечь
    // токены без ответа; тип ошибки даёт classifyClaudeResultSubtype, поэтому
    // потребитель получает структурированную категорию, а не текст.
    if (snapshot.status === RuntimeLimitStatus.BLOCKED) {
      throw classifyClaudeResultSubtype(
        "rate_limit",
        "Claude runtime reported a blocked limit state",
        buildClaudeLimitErrorMetadata(snapshot),
      );
    }
    return;
  }

  if (message.type === "assistant") {
    if (typeof message.session_id === "string" && !state.sessionId) {
      state.sessionId = message.session_id;
    }
    const content = message.message?.content;
    // При включённом --include-partial-messages Claude выдаёт И токен-дельты
    // (stream_event.content_block_delta.text_delta), И готовый блок
    // assistant после завершения. Выдача stream:text из
    // обоих источников прислала бы полный текст дважды колбэкам, которые
    // конкатенируют (например chat:token → fullAssistantResponse в маршруте
    // чата), поэтому в режиме partial-messages только накапливаем полный текст
    // для резерва, а живой поток ведём дельтами.
    const partialMode = Boolean(execution?.includePartialMessages);
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "text" && typeof item.text === "string") {
          state.assistantText += item.text;
          if (!partialMode) {
            emitEvent(state, execution, {
              type: "stream:text",
              timestamp: nowIso,
              level: "debug",
              message: item.text,
              data: { text: item.text },
            });
          }
        } else if (item.type === "tool_use" && typeof item.name === "string") {
          // buildToolUseEvents даёт на каждый вызов набор событий, а не одно: запрос
          // AskUserQuestion превращается в отдельное событие вопроса, и input инструмента -
          // единственный носитель текста этого вопроса.
          const summary = summarizeToolInput(item.input);
          const detailSuffix = summary ? ` ${summary}` : "";
          const toolUseId = typeof item.id === "string" ? item.id : null;
          for (const event of buildToolUseEvents({
            toolName: item.name,
            toolUseId,
            input: item.input,
            timestamp: nowIso,
            detailSuffix,
            questionPayload: parseClaudeAskUserQuestion(item.name, toolUseId, item.input),
          })) {
            emitEvent(state, execution, event);
          }
          execution?.onToolUse?.(item.name, detailSuffix);
        }
      }
    }
    return;
  }

  // Дельты на уровне токенов приходят только с --include-partial-messages; прочие виды
  // дельт (thinking, JSON аргументов) намеренно игнорируются: протокол CLI разрастается,
  // и отсутствие ветки не должно ломать разбор.
  if (message.type === "stream_event") {
    const delta = message.event?.delta;
    if (
      message.event?.type === "content_block_delta" &&
      delta?.type === "text_delta" &&
      typeof delta.text === "string"
    ) {
      state.outputText += delta.text;
      emitEvent(state, execution, {
        type: "stream:text",
        timestamp: nowIso,
        level: "debug",
        message: delta.text,
        data: { text: delta.text },
      });
    }
    return;
  }

  // Итоговая строка прогона: здесь приходят usage, id сессии и вердикт. Ошибку не
  // бросаем сразу, а фиксируем в state - полное решение принимает runCliAttempt после
  // закрытия процесса, вместе со свежим снимком лимитов.
  if (message.type === "result") {
    state.usage = normalizeStreamJsonUsage(message);
    if (typeof message.session_id === "string") {
      state.sessionId = message.session_id;
    }
    const directResult = typeof message.result === "string" ? message.result : "";
    const subtype = message.subtype ?? "unknown";
    // Два независимых сигнала неудачи из разных поколений CLI: сработает любой, поэтому
    // сравнение с true явное - флаг может отсутствовать, а не быть ложным.
    const isError = subtype !== "success" || message.is_error === true;

    if (isError) {
      state.terminalErrorSubtype = subtype;
      state.terminalErrorDetail = directResult || null;
      emitEvent(state, execution, {
        type: `result:${subtype}`,
        timestamp: nowIso,
        level: "error",
        message: `Query ended with subtype ${subtype}`,
        data: { subtype },
      });
      return;
    }

    // Успех — финализируем outputText. Приоритет: дельты partial-messages, затем
    // накопленный текст assistant, затем финальное поле `result`.
    if (!state.outputText) {
      state.outputText = state.assistantText || directResult;
    }
    emitEvent(state, execution, {
      type: "result:success",
      timestamp: nowIso,
      level: "info",
      message: "CLI execution completed",
      data: {
        numTurns: message.num_turns,
        durationMs: message.duration_ms,
      },
    });
    return;
  }

  // Прочие типы сообщений (rate_limit_event и т.п.) — не публикуем.
}

// Приоритет источников текста: дельты (живой вид) -> блоки assistant -> plainTextFallback
// как спасательный круг для CLI, переставшего говорить JSON. Если id сессии не пришёл из
// потока, наследуем входной - кроме форка, см. runCliAttempt.
function finalizeCliResult(
  state: ClaudeCliStreamState,
  fallbackSessionId: string | null,
): RuntimeRunResult {
  const outputText =
    state.outputText || state.assistantText || state.plainTextFallback.trim() || "";
  return {
    outputText,
    sessionId: state.sessionId ?? fallbackSessionId,
    usage: state.usage,
    events: state.events,
  };
}

// Развилка по платформе: все три потока - pipe, потому что промпт пишут в
// stdin, JSONL читают из stdout, а stderr копят для сообщения о провале.
function spawnCliProcess(
  input: RuntimeRunInput,
  cliPath: string,
  args: string[],
  env: Record<string, string>,
): ReturnType<typeof spawn> {
  /* v8 ignore next 2 -- ветка Windows */
  return IS_WINDOWS
    ? spawnCliWindows(cliPath, args, input.cwd ?? input.projectRoot, env)
    : spawn(cliPath, args, { cwd: input.cwd ?? input.projectRoot, env, stdio: "pipe" });
}

// Одна попытка запуска дочернего процесса от spawn до close. Политика повторов
// (start-таймаут) живёт уровнем выше, поэтому здесь её нет, а вторая попытка стартует
// с чистого состояния. Форма возврата { result, startTimedOut } - самодельное
// размеченное объединение: result валиден только при startTimedOut === false.
function runCliAttempt(
  input: RuntimeRunInput,
  cliPath: string,
  args: string[],
  env: Record<string, string>,
  providerIdentity: ClaudeProviderIdentity,
  authToken: string | null,
  logger?: ClaudeCliLogger,
): Promise<{ result: RuntimeRunResult; startTimedOut: boolean }> {
  const execution = input.execution;
  const child = spawnCliProcess(input, cliPath, args, env);

  // Подключаем общие утилиты таймаутов
  // Два сторожа с разной семантикой: start - процесс вообще не дал вывода (битый или
  // зависший на старте бинарник), run - предельная длительность здорового прогона.
  const timeouts = withProcessTimeouts(child, {
    startTimeoutMs: execution?.startTimeoutMs,
    runTimeoutMs: execution?.runTimeoutMs ?? resolveTimeoutMs(input),
  });

  // Для форка фолбэк - null: новая сессия обязана прийти самим потоком, а возврат id
  // источника был бы ложью - форк приняли бы за обычное продолжение старой сессии.
  const fallbackSessionId = readForkSourceSessionId(input) ? null : (input.sessionId ?? null);
  const state = createCliStreamState(fallbackSessionId);
  // События "data" режут поток по произвольным байтам, а не по границам строк: хвост
  // незавершённой строки доживает в этом буфере до следующего перевода строки.
  let stdoutBuffer = "";
  let stderr = "";
  let streamProcessingError: unknown = null;

  // Выгребает буфер, пока в нём есть целые строки: одно событие data может принести
  // сразу несколько JSONL-записей, а следующее - начаться с середины строки.
  const flushCompleteLines = (): void => {
    let newlineIdx = stdoutBuffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = stdoutBuffer.slice(0, newlineIdx);
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      processStreamJsonLine(line, state, input, providerIdentity, logger);
      newlineIdx = stdoutBuffer.indexOf("\n");
    }
  };

  // Оператор "!" здесь честен: spawn вызван со stdio "pipe", значит потоки существуют
  // гарантированно - типы просто не связывают это с опциями spawn.
  child.stdout!.on("data", (chunk: Buffer | string) => {
    stdoutBuffer += String(chunk);
    try {
      flushCompleteLines();
    } catch (err) {
      // Ошибка разбора (включая throw заблокированного лимита из processStreamJsonLine)
      // не отклоняет промис сразу: она сохраняется, а процесс останавливается. Вердикт
      // соберётся на 'close', где ошибка потока важнее кода выхода и частичного вывода.
      streamProcessingError = err;
      logger?.error?.(
        { runtimeId: input.runtimeId, err },
        "Claude CLI stream-json processing error",
      );
      child.kill("SIGTERM");
    }
  });

  child.stderr!.on("data", (chunk: Buffer | string) => {
    const text = String(chunk);
    stderr += text;
    execution?.onStderr?.(text);
  });

  // Промпт идёт через stdin и никогда не попадает в argv (ARG_MAX /
  // лимиты командной строки cmd.exe обрезали бы большие rework/plan-промпты).
  // EPIPE проглатывается — процесс может завершиться до сброса всего промпта.
  child.stdin!.on("error", () => {
    /* игнорируем broken-pipe */
  });
  child.stdin!.write(input.prompt);
  child.stdin!.end();

  // Если запрошен abort — убиваем дочерний процесс
  // SIGTERM, а не SIGKILL: CLI нужно время сохранить файлы сессии. once: true мешает
  // накоплению слушателей при пересоздании попыток.
  if (execution?.abortController) {
    execution.abortController.signal.addEventListener(
      "abort",
      () => {
        child.kill("SIGTERM");
      },
      { once: true },
    );
  }

  return new Promise((resolve, reject) => {
    // 'error' приходит, когда сорвался сам spawn (например ENOENT - бинарника нет на
    // PATH): случай классифицируется в типизированный RuntimeExecutionError.
    child.on("error", (error) => {
      timeouts.cleanup();
      reject(
        classifyClaudeRuntimeError(
          error,
          undefined,
          buildClaudeLimitErrorMetadata(state.latestLimitSnapshot),
        ),
      );
    });

    // Слушаем 'close', а не 'exit': 'exit' срабатывает в момент смерти процесса, но
    // буферизованные данные stdout могут ещё доходить - решение надо принимать по
    // полному потоку.
    child.on("close", async (code) => {
      timeouts.cleanup();

      // Сбрасываем остаток буфера как финальную строку.
      if (stdoutBuffer.length > 0) {
        try {
          processStreamJsonLine(stdoutBuffer, state, input, providerIdentity, logger);
        } catch {
          /* игнорируем ошибки обработки хвоста */
        }
        stdoutBuffer = "";
      }

      // Вердикт start-таймаута - это промис: гонка "пришёл ли вывод до истечения
      // таймера" внутри withProcessTimeouts разрешается асинхронно.
      const startTimedOut = await timeouts.startTimedOut;

      if (streamProcessingError) {
        reject(
          classifyClaudeRuntimeError(
            streamProcessingError,
            undefined,
            buildClaudeLimitErrorMetadata(state.latestLimitSnapshot),
          ),
        );
        return;
      }

      if (startTimedOut) {
        const startMs = execution?.startTimeoutMs ?? 0;
        logger?.warn?.(
          { runtimeId: input.runtimeId, startTimeoutMs: startMs },
          "Claude CLI start timeout — process produced no output",
        );
        // Resolve, а не reject: start-таймаут - сигнал к повтору, а не фатальная ошибка.
        // Двойной каст null - осознанная шероховатость контракта (правило проекта именно
        // такие места не любит): пока startTimedOut === true, result читать нельзя -
        // единственный потребитель, runClaudeCli, проверяет флаг первым.
        resolve({ result: null as unknown as RuntimeRunResult, startTimedOut: true });
        return;
      }

      // В отличие от start-таймаута этот не повторяется: повторить уже наполовину
      // сделанный прогон нельзя (не идемпотентно), поэтому типизированная ошибка уходит
      // наверх как есть.
      if (timeouts.runTimedOut) {
        const runMs = execution?.runTimeoutMs ?? resolveTimeoutMs(input);
        reject(makeProcessRunTimeoutError(runMs));
        return;
      }

      // Источники сообщения о провале по приоритету: stderr (диагностика самого CLI)
      // важнее частичного вывода. Текст - только для человека: категорию разрешает
      // классификатор по структурированному контексту, а не по подстроке.
      if (code !== 0) {
        const message = `Claude CLI exited with code ${code}: ${stderr || state.outputText || state.plainTextFallback || "unknown error"}`;
        reject(
          classifyClaudeRuntimeError(
            message,
            undefined,
            buildClaudeLimitErrorMetadata(state.latestLimitSnapshot),
          ),
        );
        return;
      }

      // Нулевой код выхода не гарантирует успех: CLI способен сообщить error-subtype в
      // строке result и завершиться «спокойно» - сигнал изнутри потока проверяется
      // последним.
      if (state.terminalErrorSubtype) {
        reject(
          classifyClaudeResultSubtype(
            state.terminalErrorSubtype,
            state.terminalErrorDetail,
            buildClaudeLimitErrorMetadata(state.latestLimitSnapshot),
          ),
        );
        return;
      }

      // Квоту Z.AI перечитывают только после успешного прогона: после провала картина
      // недостоверна, а лишний запрос только мешает. Свой сбой он отрабатывает в warn -
      // наблюдаемость не должна ломать уже состоявшийся результат.
      if (providerIdentity.quotaSource === "zai_monitor" && authToken) {
        logger?.debug?.(
          {
            runtimeId: input.runtimeId,
            providerId: input.providerId ?? "anthropic",
            profileId: input.profileId ?? null,
            quotaAuthEnvVar: providerIdentity.apiKeyEnvVar,
            providerFamily: providerIdentity.providerFamily,
          },
          "Refreshing Z.AI coding quota snapshot with resolved Claude auth identity",
        );
        try {
          const providerSnapshot = await fetchZaiClaudeQuotaSnapshot({
            runtimeId: input.runtimeId,
            providerId: input.providerId ?? "anthropic",
            profileId: input.profileId ?? null,
            identity: providerIdentity,
            authToken,
            logger,
          });
          if (providerSnapshot) {
            state.latestLimitSnapshot = providerSnapshot;
            emitEvent(state, execution, buildRuntimeLimitEvent(providerSnapshot, "zai_monitor"));
          }
        } catch (error) {
          logger?.warn?.(
            {
              runtimeId: input.runtimeId,
              providerId: input.providerId ?? "anthropic",
              profileId: input.profileId ?? null,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to refresh Z.AI coding quota snapshot after Claude CLI run",
          );
        }
      }

      resolve({
        result: finalizeCliResult(state, fallbackSessionId),
        startTimedOut: false,
      });
    });
  });
}

// Точка входа транспорта: один раз резолвит пути и аутентификацию, затем гоняет попытку
// и ровно один повтор при start-таймауте.
export async function runClaudeCli(
  input: RuntimeRunInput,
  logger?: ClaudeCliLogger,
  adapterDefaults?: { pathToClaudeCodeExecutable?: string },
): Promise<RuntimeRunResult> {
  const cliPath = resolveCliPath(input, adapterDefaults?.pathToClaudeCodeExecutable);
  const args = buildCliArgs(input);
  const execution = input.execution;
  const options = asRecord(input.options);
  // Идентичность аутентификации резолвится один раз и в одном месте: её потребляют и
  // сборка env, и монитор квот, так что подсистемы не могут «додумать» разные ключи.
  // Поля options читаются через typeof-проверки: options - недоверенные данные из
  // профиля, их форма не гарантирована.
  const { identity: providerIdentity, authToken } = resolveClaudeProviderAuth({
    providerId: input.providerId ?? "anthropic",
    transport: "cli",
    baseUrl: typeof options.baseUrl === "string" ? options.baseUrl : null,
    apiKeyEnvVar: typeof options.apiKeyEnvVar === "string" ? options.apiKeyEnvVar : null,
    apiKey: typeof options.apiKey === "string" ? options.apiKey : null,
  });
  const apiKeyEnvVar =
    typeof options.apiKeyEnvVar === "string" ? options.apiKeyEnvVar : "ANTHROPIC_API_KEY";
  // Порядок слияния: env профиля - база, environment задачи поверх - значения задачи
  // важнее значений профиля.
  const env = buildCuratedEnv(apiKeyEnvVar, {
    ...resolveProfileEnvironment(input),
    ...execution?.environment,
  });

  // В лог идут пути, счётчики и флаги - но ни текста промпта, ни значений env:
  // промпт может содержать пользовательские данные.
  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "cli",
      cliPath,
      argCount: args.length,
      startTimeoutMs: execution?.startTimeoutMs ?? null,
      runTimeoutMs: execution?.runTimeoutMs ?? resolveTimeoutMs(input),
      hasAgent: args.includes("--agent"),
    },
    "Starting Claude CLI run",
  );

  const { result, startTimedOut } = await runCliAttempt(
    input,
    cliPath,
    args,
    env,
    providerIdentity,
    authToken,
    logger,
  );

  if (startTimedOut) {
    // Один повтор после start-таймаута
    // Одного повтора достаточно, чтобы отличить временное зависание (холодный старт,
    // антивирусная проверка) от системной поломки: второй start-таймаут уже бросает
    // типизированную ошибку вместо маскировки проблемы бесконечными попытками.
    const retryDelayMs = resolveRetryDelay(execution ?? {});
    logger?.warn?.(
      { runtimeId: input.runtimeId, retryDelayMs },
      "Claude CLI start timeout, retrying once after delay",
    );
    await sleepMs(retryDelayMs);

    const retry = await runCliAttempt(
      input,
      cliPath,
      args,
      env,
      providerIdentity,
      authToken,
      logger,
    );
    if (retry.startTimedOut) {
      throw makeProcessStartTimeoutError(execution?.startTimeoutMs ?? 0);
    }
    return retry.result;
  }

  return result;
}
