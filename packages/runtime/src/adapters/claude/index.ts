/**
 * Точка входа Claude-адаптера рантайма.
 *
 * Один рантайм покрывает три транспорта: SDK (встроенный Agent SDK), CLI (дочерний
 * процесс, см. ./cli.ts) и API (HTTP через тот же SDK на собственный endpoint).
 * Адаптер реализует контракт RuntimeAdapter: объявляет capabilities, раздаёт
 * run/resume/forkSession по транспортам, выполняет discovery моделей, валидирует
 * конфиг соединения и даёт диагностику и санитизацию ввода.
 *
 * Сквозной принцип - консервативные обещания: capabilities - контракт, который
 * workflow-узлы проверяют до исполнения (assertions в capabilities.ts), поэтому
 * транспорт заявляет фичу только там, где гарантирует её при любой конфигурации.
 * usageReporting - часть того же контракта: учёт доверяет RuntimeRunResult.usage
 * без догадок о полноте транспорта.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { getEnv } from "@aif/shared";
import { findClaudePath, resolveClaudeSdkExecutablePath } from "./findPath.js";
import {
  RuntimeTransport,
  UsageReporting,
  UsageSource,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeConnectionValidationInput,
  type RuntimeConnectionValidationResult,
  type RuntimeDiagnoseErrorInput,
  type RuntimeModel,
  type RuntimeModelListInput,
  type RuntimeRunInput,
  type RuntimeRunResult,
  type RuntimeSession,
  type RuntimeSessionEventsInput,
  type RuntimeSessionForkInput,
  type RuntimeSessionGetInput,
  type RuntimeSessionListInput,
} from "../../types.js";
import { RuntimeCapabilityError, RuntimeExecutionError } from "../../errors.js";
import { CLAUDE_MODEL_EFFORT_LEVELS, normalizeModelEffortLevels } from "../../modelEffort.js";
import { diagnoseClaudeError } from "./diagnostics.js";
import { getClaudeMcpStatus, installClaudeMcpServer, uninstallClaudeMcpServer } from "./mcp.js";
import { initClaudeProject } from "./project.js";
import {
  listClaudeRuntimeSessionEvents,
  getClaudeRuntimeSession,
  listClaudeRuntimeSessions,
} from "./sessions.js";
import { buildClaudeQueryOptions, parseExecutionOptions } from "./options.js";
import { runClaudeRuntime, type ClaudeRuntimeRunLogger } from "./run.js";
import { assertClaudeExecutableCompatible } from "./version.js";
import { runClaudeCli, probeClaudeCli, type ClaudeCliLogger } from "./cli.js";

// Пересечение двух структурных форм логгера: один объект удовлетворяет обоим
// потребителям (run.ts и cli.ts) сразу, поэтому адаптер повсюду прокидывает единый
// логгер, и любой структурно совместимый (например pino) подходит без прослойки-адаптера.
export type ClaudeRuntimeAdapterLogger = ClaudeRuntimeRunLogger & ClaudeCliLogger;

// Всё опционально: реестр строит built-in адаптеры без аргументов, и незаданное
// доопределяется дефолтами (id, автопоиск пути, fallback-логгер).
export interface CreateClaudeRuntimeAdapterOptions {
  runtimeId?: string;
  providerId?: string;
  displayName?: string;
  logger?: ClaudeRuntimeAdapterLogger;
  /** Переопределение пути Claude CLI. Без него путь ищется автоматически через findClaudePath(). */
  executablePath?: string;
}

// Fallback-список на случай отказа или таймаута discovery. Держит алиасы CLI
// (opus/sonnet/haiku), а не датированные версии: алиас всегда резолвится в актуальную
// модель, поэтому список никогда не прикрепит UI к устаревшей версии.
// Наборы effort-уровней различаются по моделям - метаданные подсказывают UI допустимые
// значения --effort/--thinking.
const DEFAULT_CLAUDE_MODELS: RuntimeModel[] = [
  {
    id: "opus",
    label: "Claude Opus",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "max"],
      supportsAdaptiveThinking: true,
    },
  },
  {
    id: "sonnet",
    label: "Claude Sonnet",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
      supportsAdaptiveThinking: true,
    },
  },
  {
    id: "haiku",
    label: "Claude Haiku",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
    },
  },
];
// Discovery поднимает целый Claude Code: 8 секунд - потолок, за которым ждать хуже,
// чем получить дефолтный список, поэтому экран настроек не зависает.
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 8_000;

// Логгер для автономного использования (тесты, скрипты), когда хост не передал общий:
// уровни дублируются в тексте, потому что у console-методов уровня как такового нет, а
// префикс метит источник в потоке из нескольких рантаймов.
function createFallbackLogger(): ClaudeRuntimeAdapterLogger {
  return {
    debug(context, message) {
      console.debug("[runtime:claude]", message, context);
    },
    info(context, message) {
      console.info("INFO [runtime:claude]", message, context);
    },
    warn(context, message) {
      console.warn("WARN [runtime:claude]", message, context);
    },
    error(context, message) {
      console.error("ERROR [runtime:claude]", message, context);
    },
  };
}

// ---------------------------------------------------------------------------
// Возможности runtime с учётом транспорта
// ---------------------------------------------------------------------------

/** SDK-транспорт обладает полным набором возможностей. */
// Отправная точка: от полного набора getEffectiveCapabilities отнимает то, чего не
// гарантирует конкретный транспорт.
const SDK_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionFork: true,
  supportsSessionList: true,
  supportsAgentDefinitions: true,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: true,
  supportsCustomEndpoint: true,
  supportsWorkspaceTools: true,
  usageReporting: UsageReporting.FULL,
  supportsInteractiveQuestions: true,
};

/**
 * CLI-транспорт поддерживает определения агентов (флаг --agent) и сессии
 * (через --resume), но не стриминг и не approvals.
 */
// Ограничения следуют из формы транспорта: одноразовый режим -p не умеет ставить
// выполнение на паузу ради диалога одобрений, а настройка endpoint принадлежит
// установленному CLI, а не отдельному запросу.
const CLI_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionFork: true,
  supportsSessionList: true,
  supportsAgentDefinitions: true,
  supportsStreaming: false,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: false,
  supportsWorkspaceTools: true,
  usageReporting: UsageReporting.FULL,
  supportsInteractiveQuestions: true,
};

/** API-транспорт — требует явные ключ + baseUrl, без определений агентов. */
// Нет и resume/сессий: HTTP-вызов стейтлесс, а хранилище сессий физически живёт на
// стороне Agent SDK / CLI, не под контролем адаптера.
const API_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: false,
  supportsSessionFork: false,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
  supportsWorkspaceTools: false,
  usageReporting: UsageReporting.FULL,
};

// Kill switch для форка сессий: даже где транспорт его поддерживает, при выключенном
// env-флаге возможность срезается. Workflow узнают о запрете именно через capabilities -
// значит одна переменная окружения отключает фичу во всём стеке без выкатки кода.
// Spread строит копию: общие константы SDK_/CLI_CAPABILITIES остаются нетронутыми для
// других потребителей.
function withSessionForkRolloutGate(capabilities: RuntimeCapabilities): RuntimeCapabilities {
  if (getEnv().AIF_RUNTIME_SESSION_FORK_ENABLED || !capabilities.supportsSessionFork) {
    return capabilities;
  }
  return { ...capabilities, supportsSessionFork: false };
}

// options - недоверенные данные из UI/БД: пустая строка нормализуется в null, чтобы
// валидация не считала «значение задано» то, где просто есть ключ со "".
function readStringOption(input: RuntimeConnectionValidationInput, key: string): string | null {
  const options = input.options ?? {};
  const raw = options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

// В логи session id попадает только хвост: восьми символов хватает, чтобы связать строки
// одного прогона, не растаскивая полные идентификаторы.
function sessionIdSuffix(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return sessionId.length <= 8 ? sessionId : sessionId.slice(-8);
}

// На Windows PATH-поиск находит npm/nvm-обёртки (claude.cmd / claude.ps1): CLI-транспорту
// они не мешают, но Agent SDK запускает процесс сам и нуждается в настоящем двоичном
// claude.exe. Если путь не удаётся уверенно превратить, результат - undefined: так
// дешевле доверить поиск бинарника самому SDK, чем пытаться исполнить неподходящий файл.
function normalizeSdkExecutablePath(
  path: string | null | undefined,
  logger: ClaudeRuntimeAdapterLogger,
  runtimeId: string,
  options: { explicitPath?: boolean } = {},
): string | undefined {
  // explicitPath = путь задал пользователь, и голое "claude" - его осознанный выбор;
  // автонайденное голое имя доверию не заслуживает: чаще это обёртка.
  const normalized = resolveClaudeSdkExecutablePath(path, process.platform, {
    allowBareUnixExecutable: options.explicitPath,
  });
  if (process.platform !== "win32" || !path) {
    if (path && !normalized) {
      logger.warn(
        {
          runtimeId,
          wrapperPath: path,
        },
        "Dropped auto-discovered Claude SDK wrapper path and deferred to Agent SDK lookup",
      );
    }
    return normalized;
  }
  if (normalized && normalized !== path) {
    logger.info(
      {
        runtimeId,
        wrapperPath: path,
        nativeExecutablePath: normalized,
      },
      "Resolved Claude SDK wrapper path to native executable",
    );
  } else if (!normalized) {
    logger.warn(
      {
        runtimeId,
        wrapperPath: path,
      },
      "Dropped Claude SDK wrapper path and deferred to Agent SDK lookup",
    );
  }
  return normalized;
}

// Discovery моделей реализован как «прогон с пустым промптом» (см. listClaudeModels),
// поэтому запрос списка превращается в форму прогона. Поля авторизации копируются,
// только если в options их ещё нет: явно заданное значение уровня профиля важнее
// обобщённого поля списка и не затирается им.
function toClaudeModelDiscoveryInput(input: RuntimeModelListInput): RuntimeRunInput {
  const options = { ...(input.options ?? {}) };
  if (input.baseUrl && typeof options.baseUrl !== "string") {
    options.baseUrl = input.baseUrl;
  }
  if (input.apiKey && typeof options.apiKey !== "string") {
    options.apiKey = input.apiKey;
  }
  if (input.apiKeyEnvVar && typeof options.apiKeyEnvVar !== "string") {
    options.apiKeyEnvVar = input.apiKeyEnvVar;
  }
  if (input.headers && options.headers == null) {
    options.headers = input.headers;
  }
  // Пустой промпт: discovery нужен только хендшейк при старте сессии, без обращений
  // к модели и без расхода токенов.
  return {
    runtimeId: input.runtimeId,
    providerId: input.providerId,
    profileId: input.profileId,
    transport: input.transport,
    prompt: "",
    model: input.model,
    projectRoot: input.projectRoot,
    cwd: input.projectRoot,
    headers: input.headers,
    options,
    usageContext: { source: UsageSource.MODEL_DISCOVERY },
  };
}

// Таймаут принимается и числом, и числовой строкой: настройки проходят через формы и
// хранилища, где всё становится строкой; мусор (NaN, отрицательные) молча трактуется
// как «не задано», а не бросает исключение.
function resolveModelDiscoveryTimeoutMs(input: RuntimeModelListInput): number {
  const rawTimeout = input.options?.modelDiscoveryTimeoutMs;
  if (typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0) {
    return Math.floor(rawTimeout);
  }
  if (typeof rawTimeout === "string") {
    const parsed = Number.parseInt(rawTimeout, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS;
}

// Отличается от одноимённого хелпера в @aif/shared наличием onTimeout: в обычном race
// проигравшая сторона продолжает жить, и сессия SDK утекла бы. Здесь проигравший
// таймаут сначала выполняет отмену (abort), и лишь затем отклоняет промис.
async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Если сама отмена бросает исключение, вердиктом становится именно она: это
      // ближе к реальной причине, чем обезличенное сообщение о таймауте.
      try {
        onTimeout();
      } catch (error) {
        reject(error);
        return;
      }
      reject(new Error(`Claude model discovery timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // unref, чтобы таймер не удерживал event loop самостоятельно - та же логика, что в
    // shared/src/withTimeout.ts.
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }

    void operation().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function listClaudeModels(
  input: RuntimeModelListInput,
  logger: ClaudeRuntimeAdapterLogger,
  adapterDefaults?: { pathToClaudeCodeExecutable?: string },
): Promise<RuntimeModel[]> {
  const discoveryInput = toClaudeModelDiscoveryInput(input);
  const configuredCliPath =
    typeof input.options?.claudeCliPath === "string" &&
    input.options.claudeCliPath.trim().length > 0
      ? input.options.claudeCliPath.trim()
      : null;
  const execution = parseExecutionOptions(discoveryInput, {
    pathToClaudeCodeExecutable: normalizeSdkExecutablePath(
      configuredCliPath ?? adapterDefaults?.pathToClaudeCodeExecutable,
      logger,
      input.runtimeId,
      { explicitPath: Boolean(configuredCliPath) },
    ),
  });
  // Два контроллера: вызывающего кода (upstream) и собственный у discovery. Последний
  // срабатывает ещё и по таймауту, а слушатель-релей сводит обе причины в один abort
  // для SDK.
  const modelDiscoveryAbortController = new AbortController();
  const upstreamAbortController = execution.abortController;
  let removeAbortRelay: (() => void) | null = null;
  if (upstreamAbortController) {
    const relayAbort = () => {
      modelDiscoveryAbortController.abort(upstreamAbortController.signal.reason);
    };
    // Гонка: сигнал мог сработать между входом в функцию и навешиванием слушателя,
    // поэтому сначала проверяется текущее состояние.
    if (upstreamAbortController.signal.aborted) {
      relayAbort();
    } else {
      upstreamAbortController.signal.addEventListener("abort", relayAbort, { once: true });
      // Удалитель сохраняется до finally: сигналы живут дольше discovery, а неснятый
      // слушатель держал бы на себе замыкание этой функции.
      removeAbortRelay = () => {
        upstreamAbortController.signal.removeEventListener("abort", relayAbort);
      };
    }
  }
  const queryOptions = buildClaudeQueryOptions(
    discoveryInput,
    {
      ...execution,
      abortController: modelDiscoveryAbortController,
    },
    logger,
  );
  const env = queryOptions.env;
  // Повторное сужение env по правилам asRecord: билдер опций мог вернуть что угодно,
  // а диагностика не должна на этом спотыкаться - каст здесь защищён тернарником, а
  // не заменяет проверку.
  const envRecord =
    env && typeof env === "object" && !Array.isArray(env) ? (env as Record<string, unknown>) : {};
  const configuredApiKeyEnvVar =
    typeof discoveryInput.options?.apiKeyEnvVar === "string"
      ? discoveryInput.options.apiKeyEnvVar
      : null;
  logger.debug?.(
    {
      runtimeId: input.runtimeId,
      profileId: input.profileId ?? null,
      transport: input.transport ?? RuntimeTransport.SDK,
      apiKeyEnvVar: configuredApiKeyEnvVar,
      // В диагностику идут флаги наличия ключа/endpoint - никогда сами значения:
      // секретам не место в логах.
      hasConfiguredApiKey: configuredApiKeyEnvVar
        ? Boolean(envRecord[configuredApiKeyEnvVar])
        : false,
      hasAnthropicApiKey: Boolean(envRecord.ANTHROPIC_API_KEY),
      hasBaseUrl: typeof envRecord.ANTHROPIC_BASE_URL === "string",
    },
    "[runtime:claude] Starting Claude model discovery",
  );
  // Применяем тот же guard минимальной версии, что и на пути запуска: discovery
  // моделей тоже поднимает Agent SDK, иначе несовместимый бинарник Claude Code
  // упал бы здесь и молча откатился к встроенному списку моделей.
  await assertClaudeExecutableCompatible(execution.pathToClaudeCodeExecutable, logger, {
    runtimeId: input.runtimeId,
    providerId: input.providerId ?? "anthropic",
    profileId: input.profileId ?? null,
    usageContext: "model-discovery",
  });
  // Session-переменная nullable: query() может упасть ещё до выдачи объекта, а finally
  // выполнится в любом случае - уборка ниже написана с расчётом на null.
  let session: ReturnType<typeof query> | null = null;
  const discoveryStartedAt = Date.now();
  const timeoutMs = resolveModelDiscoveryTimeoutMs(input);
  let timedOut = false;
  let discoveryError: unknown = null;

  try {
    // Пустой async-генератор вместо промпта: сигнатура SDK требует поток сообщений
    // пользователя, а ноль сообщений открывает сессию «ради хендшейка» - в этот момент
    // supportedModels() работает без обращения к модели и без расхода токенов.
    session = query({
      prompt: (async function* emptyPrompt() {})(),
      options: queryOptions as Parameters<typeof query>[0]["options"],
    });
    // На таймауте onTimeout делает две вещи: помечает причину (timedOut меняет способ
    // уборки и уровень лога) и дергает контроллер, окончательно останавливая CLI.
    const models = await withTimeout(
      () => session!.supportedModels(),
      timeoutMs,
      () => {
        timedOut = true;
        modelDiscoveryAbortController.abort();
      },
    );
    logger.debug?.(
      {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: input.transport ?? RuntimeTransport.SDK,
        modelCount: models.length,
        discoveryDurationMs: Date.now() - discoveryStartedAt,
        timeoutMs,
      },
      "[runtime:claude] Claude model discovery finished",
    );
    if (models.length > 0) {
      return models.map((model) => {
        // Условные спреды пропускают неизвестные ключи метаданных вместо записи undefined:
        // для UI «не сообщалось» и «явно не поддерживается» - разные состояния, и наличие
        // ключа несёт ровно этот смысл.
        const supportedEffortLevels = normalizeModelEffortLevels(model.supportedEffortLevels);
        return {
          id: model.value,
          label: model.displayName,
          supportsStreaming: true,
          metadata: {
            description: model.description,
            ...(typeof model.supportsEffort === "boolean"
              ? { supportsEffort: model.supportsEffort }
              : {}),
            ...(supportedEffortLevels ? { supportedEffortLevels } : {}),
            ...(model.supportsAdaptiveThinking ? { supportsAdaptiveThinking: true } : {}),
            ...(model.supportsFastMode ? { supportsFastMode: true } : {}),
            ...(model.supportsAutoMode ? { supportsAutoMode: true } : {}),
          },
        };
      });
    }
  } catch (error) {
    discoveryError = error;
  } finally {
    removeAbortRelay?.();
    try {
      // Способ уборки зависит от причины: после таймаута - грубый close(), потому что
      // вежливый return() в зависшем генераторе мог бы не завершиться никогда; иначе -
      // return(), завершающий контракт итерации.
      if (timedOut) {
        session?.close?.();
      } else {
        await session?.return?.();
      }
    } catch (cleanupError) {
      logger.error?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: input.transport ?? RuntimeTransport.SDK,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        },
        "ERROR [runtime:claude] Failed to clean up Claude model discovery session",
      );
    }
  }

  if (discoveryError) {
    const errorMessage =
      discoveryError instanceof Error ? discoveryError.message : String(discoveryError);
    if (timedOut) {
      logger.warn?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: input.transport ?? RuntimeTransport.SDK,
          timeoutMs,
          discoveryDurationMs: Date.now() - discoveryStartedAt,
          error: errorMessage,
        },
        "WARN [runtime:claude] Claude model discovery timed out, falling back to built-in list",
      );
    } else {
      logger.error?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: input.transport ?? RuntimeTransport.SDK,
          discoveryDurationMs: Date.now() - discoveryStartedAt,
          error: errorMessage,
        },
        "ERROR [runtime:claude] Claude model discovery failed after cleanup, falling back to built-in list",
      );
    }
  }

  // Любой провал discovery завершается одинаково: fallback-списком. Discovery -
  // удобство экрана настроек, а не пропуск к исполнению: прогон работает и по алиасам,
  // поэтому висящий UI того не стоит.
  return DEFAULT_CLAUDE_MODELS;
}

// Валидация зеркалит реальные условия каждого транспорта: задаёт ровно те вопросы,
// которые задаст первый рабочий прогон, - чтобы «сохранено» не расходилось с «работает».
async function validateClaudeConnection(
  input: RuntimeConnectionValidationInput,
): Promise<RuntimeConnectionValidationResult> {
  const transport = input.transport ?? RuntimeTransport.SDK;
  const apiKey = readStringOption(input, "apiKey");
  const apiKeyEnvVar = readStringOption(input, "apiKeyEnvVar");
  const baseUrl = readStringOption(input, "baseUrl");

  if (transport === RuntimeTransport.SDK) {
    // SDK-транспорт использует сессионную авторизацию ~/.claude/ — API-ключ необязателен
    return {
      ok: true,
      message: apiKey
        ? "Claude SDK profile configured with API key"
        : "Claude SDK profile configured (using session auth)",
    };
  }

  if (transport === RuntimeTransport.API) {
    // Все проблемы собираются в список и показываются за один проход: это дешевле для
    // пользователя, чем цикл «исправил - перепроверил - исправил снова».
    const issues: string[] = [];
    if (!apiKey) {
      issues.push(`Missing API key (expected env var: ${apiKeyEnvVar ?? "ANTHROPIC_API_KEY"})`);
    }
    if (!baseUrl) {
      issues.push("Missing base URL for API transport (set ANTHROPIC_BASE_URL or profile baseUrl)");
    }
    if (issues.length > 0) {
      return { ok: false, message: issues.join("; ") };
    }
    return { ok: true, message: "Claude API profile configured" };
  }

  // CLI-транспорт — реально запускаем бинарник, чтобы проверить доступность
  // Реальный запуск `claude --version` - единственная проверка, где наличие ключа в env
  // не доказывает ничего: бинарник может отсутствовать или быть сломан при идеальном
  // конфиге.
  const cliPath = readStringOption(input, "claudeCliPath") ?? "claude";
  const probe = probeClaudeCli(cliPath);
  if (!probe.ok) {
    return {
      ok: false,
      message: `Claude CLI is not reachable (${cliPath}): ${probe.error}`,
    };
  }

  return {
    ok: true,
    message: `Claude CLI ${probe.version ?? "unknown"} (${cliPath})`,
  };
}

// Фабрика закрывает конфигурацию в замыкании: в реестре может жить несколько профилей
// семейства Claude (Anthropic, router.ai, ...) - каждый со своим id, логгером и путём к
// исполняемому файлу, и состояние между ними течь не должно.
export function createClaudeRuntimeAdapter(
  options: CreateClaudeRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const runtimeId = options.runtimeId ?? "claude";
  const providerId = options.providerId ?? "anthropic";
  const logger = options.logger ?? createFallbackLogger();
  const executablePath = options.executablePath ?? findClaudePath();

  // На Windows PATH-резолвер часто отдаёт shell-обёртки npm/nvm вроде
  // `claude`, `claude.cmd` или `claude.ps1`. Agent SDK требует настоящий
  // нативный `claude.exe`, а CLI-транспорт может работать и с shell-обёрткой.
  const sdkExecutablePath = normalizeSdkExecutablePath(executablePath, logger, runtimeId);

  function runByTransport(input: RuntimeRunInput): Promise<RuntimeRunResult> {
    const transport = input.transport ?? RuntimeTransport.SDK;
    // Каждый транспорт получает ту форму пути, с которой он работает: CLI - исходный
    // executablePath (cmd-обёртка ему не мешает), SDK/API - нормализованный native-путь.
    if (transport === RuntimeTransport.CLI) {
      return runClaudeCli(input, logger, { pathToClaudeCodeExecutable: executablePath });
    }
    // SDK и API идут через runtime Agent SDK. Версионный guard
    // (внутри runClaudeRuntime) проверяет ровно тот бинарник, который запускает `query()`:
    // `sdkExecutablePath`, если он пережил нормализацию, иначе
    // бинарник в комплекте SDK, прочитанный из его манифеста. Без откатов на PATH — проверка
    // другого `claude`, чем поднимает SDK, дала бы ложный сигнал.
    return runClaudeRuntime(input, logger, {
      pathToClaudeCodeExecutable: sdkExecutablePath,
    });
  }

  async function forkByTransport(input: RuntimeSessionForkInput): Promise<RuntimeRunResult> {
    const transport = input.transport ?? RuntimeTransport.SDK;
    // API_CAPABILITIES уже говорит «форка нет», но страж повторён здесь: если вызывающий
    // код всё же форсирует транспорт напрямую, он должен получить структурированную
    // RuntimeCapabilityError, а не тихую поломку на несуществующей сессии.
    if (transport === RuntimeTransport.API) {
      logger.warn(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          transport,
          sourceSessionIdSuffix: sessionIdSuffix(input.sourceSessionId),
          skipReason: "unsupported_transport",
        },
        "WARN [runtime:claude] Session fork requested for unsupported transport",
      );
      throw new RuntimeCapabilityError(
        `Claude ${transport} transport does not support session fork`,
      );
    }

    logger.debug(
      {
        runtimeId,
        profileId: input.profileId ?? null,
        transport,
        sourceSessionIdSuffix: sessionIdSuffix(input.sourceSessionId),
      },
      "DEBUG [runtime:claude] Starting Claude session fork run",
    );

    try {
      const result = await runByTransport(input);
      logger.debug(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          transport,
          sourceSessionIdSuffix: sessionIdSuffix(input.sourceSessionId),
          childSessionIdSuffix: sessionIdSuffix(result.sessionId ?? result.session?.id ?? null),
        },
        "DEBUG [runtime:claude] Claude session fork run completed",
      );
      return result;
    } catch (error) {
      logger.error(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          transport,
          sourceSessionIdSuffix: sessionIdSuffix(input.sourceSessionId),
          // Из ошибки в лог берутся структурированные поля: category/adapterCode остаются
          // null для посторонних ошибок - их не выдумывают, и поиск по коду работает без
          // разбора сообщений.
          category: error instanceof RuntimeExecutionError ? error.category : null,
          adapterCode: error instanceof RuntimeExecutionError ? error.adapterCode : null,
          error: error instanceof Error ? error.message : String(error),
        },
        "ERROR [runtime:claude] Claude session fork run failed",
      );
      throw error;
    }
  }

  return {
    descriptor: {
      id: runtimeId,
      providerId,
      displayName: options.displayName ?? "Claude",
      supportsProjectInit: true,
      projectInitAgentName: "claude",
      // lightModel питает авто-ревью (reviewGate): модель должна быть достаточно
      // дешёвой, чтобы проверочный конвейер не съедал основной бюджет задачи.
      lightModel: "haiku",
      defaultApiKeyEnvVar: "ANTHROPIC_API_KEY",
      // Явный ключ важнее auth-токена: порядок в списке — иерархия пробы резолвинга.
      apiKeyEnvCandidates: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
      defaultBaseUrlEnvVar: "ANTHROPIC_BASE_URL",
      // Anthropic SDK знает свой адрес сам: null означает «не подменять».
      defaultBaseUrl: null,
      defaultModelEnvVar: "ANTHROPIC_MODEL",
      defaultModelPlaceholder: "opus",
      defaultTransport: RuntimeTransport.SDK,
      supportedTransports: [RuntimeTransport.SDK, RuntimeTransport.CLI, RuntimeTransport.API],
      effort: {
        optionKey: "effort",
        fallbackLevels: CLAUDE_MODEL_EFFORT_LEVELS,
      },
      // Дескриптор описывает рекламируемый транспорт по умолчанию (SDK): реальную
      // картину для CLI/API берут через getEffectiveCapabilities.
      capabilities: withSessionForkRolloutGate(SDK_CAPABILITIES),
    },
    // Единая точка разрешения транспорта-специфичных capabilities; gate rollout форка
    // применяется только там, где форк вообще живёт (SDK/CLI).
    getEffectiveCapabilities(transport: RuntimeTransport): RuntimeCapabilities {
      switch (transport) {
        case RuntimeTransport.CLI:
          return withSessionForkRolloutGate(CLI_CAPABILITIES);
        case RuntimeTransport.API:
          return API_CAPABILITIES;
        default:
          return withSessionForkRolloutGate(SDK_CAPABILITIES);
      }
    },
    async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
      return runByTransport(input);
    },
    // Resume - тот же пайплайн, что и run, только с выставленным флагом: отдельной
    // ветки сборки опций нет, и расхождение между ними невозможно по построению.
    async resume(input: RuntimeRunInput & { sessionId: string }): Promise<RuntimeRunResult> {
      return runByTransport({ ...input, resume: true });
    },
    async forkSession(input: RuntimeSessionForkInput): Promise<RuntimeRunResult> {
      return forkByTransport(input);
    },
    async listSessions(input: RuntimeSessionListInput): Promise<RuntimeSession[]> {
      return listClaudeRuntimeSessions(input);
    },
    async getSession(input: RuntimeSessionGetInput): Promise<RuntimeSession | null> {
      return getClaudeRuntimeSession(input);
    },
    async listSessionEvents(input: RuntimeSessionEventsInput) {
      return listClaudeRuntimeSessionEvents(input);
    },
    async validateConnection(
      input: RuntimeConnectionValidationInput,
    ): Promise<RuntimeConnectionValidationResult> {
      return validateClaudeConnection(input);
    },
    async listModels(input: RuntimeModelListInput): Promise<RuntimeModel[]> {
      return listClaudeModels(input, logger, {
        pathToClaudeCodeExecutable: sdkExecutablePath,
      });
    },
    async diagnoseError(input: RuntimeDiagnoseErrorInput): Promise<string> {
      return diagnoseClaudeError(input, executablePath);
    },
    // CLI оборачивает слэш-команды и служебный каркас в XML-подобные теги, когда
    // возвращает промпт. Имя команды и message - шум интерфейса, они срезаются целиком;
    // аргументы - текст пользователя, группа $1 сохраняет его без обёртки.
    // system-reminder/task-notification удаляются полностью: вернись сервисный контекст
    // как пользовательский текст, промпт раздувался бы на каждом resume.
    sanitizeInput(text: string): string {
      return text
        .replace(/<command-name>[^<]*<\/command-name>/g, "")
        .replace(/<command-message>[^<]*<\/command-message>/g, "")
        .replace(/<command-args>([^<]*)<\/command-args>/g, "$1")
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
        .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
        .replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g, "")
        .trim();
    },
    initProject(projectRoot) {
      initClaudeProject(projectRoot);
    },
    // MCP-операции делегированы в mcp.ts: здесь только фасад, привязывающий их к
    // id этого рантайма.
    async getMcpStatus(input) {
      return getClaudeMcpStatus(input);
    },
    async installMcpServer(input) {
      return installClaudeMcpServer(input);
    },
    async uninstallMcpServer(input) {
      return uninstallClaudeMcpServer(input);
    },
  };
}
