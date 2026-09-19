/**
 * Точка входа Codex-адаптера: фабрика createCodexRuntimeAdapter, реализующая
 * контракт RuntimeAdapter из @aif/runtime.
 *
 * Главная идея файла - один рантайм, но четыре разных транспорта (CLI, SDK,
 * app-server, API). Они сильно отличаются по возможностям: CLI не умеет ни
 * списка сессий, ни fork; SDK добавляет сессии; app-server умеет всё, включая
 * fork; API умеет стриминг и tool calling, но никакой локальной работы с
 * файлами. Чтобы потребители (координатор, API, UI) не разбирались в этих
 * деталях, адаптер возвращает разные наборы RuntimeCapabilities для каждого
 * транспорта через getEffectiveCapabilities.
 *
 * Объявленные capabilities - не украшение, а проверяемый контракт: перед стадией
 * воркфлоу runtime/capabilities.ts сверяет требования стадии с этим набором и
 * падает с понятной ошибкой вместо того, чтобы отправить задачу туда, где она
 * заведомо не выполнится. Поэтому флаги должны быть честными:
 * - usageReporting: CLI = PARTIAL (поток может завершиться по таймауту до
 *   события token_count), SDK/API = FULL, app-server = PARTIAL;
 * - RuntimeRunResult.usage при этом всегда `RuntimeUsage | null`: даже на
 *   транспорте с FULL провайдер может не прислать блок usage, и тогда отдаётся
 *   честный null, а не нули. undefined здесь запрещён контрактом.
 *
 * Резолвинг транспорта вынесен в отдельную чистую функцию resolveTransport:
 * она не бросает исключений, а возвращает структуру с источником решения и
 * флагами нормализации/отката. Благодаря этому решение можно залогировать и
 * объяснить пользователю (опечатка в имени транспорта приводит к warn + откату
 * на CLI, а не к падению всего прогона).
 *
 * Логи берутся из опций фабрики, а при отсутствии - из createFallbackLogger:
 * адаптер обязан быть работоспособен как самостоятельный модуль, без внешне
 * настроенного логгера.
 */

import { existsSync } from "node:fs";
import { getEnv } from "@aif/shared";
// asRecord/readString здесь из общего utils рантайма (не из api.ts): те же
// правила разбора, но живут они в одном месте для всех адаптеров.
import { asRecord, readString } from "../../utils.js";
import { getCodexMcpStatus, installCodexMcpServer, uninstallCodexMcpServer } from "./mcp.js";
import { initCodexProject } from "./project.js";
// RuntimeTransport/UsageReporting импортируются как значения, а не только как
// типы: константы используются в сравнениях ниже, и строковые литералы в коде
// не разбрасываются - опечатка отловится компилятором.
import {
  RuntimeTransport,
  UsageReporting,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeConnectionValidationInput,
  type RuntimeConnectionValidationResult,
  type RuntimeModel,
  type RuntimeModelListInput,
  type RuntimeRunInput,
  type RuntimeRunResult,
  type RuntimeSessionForkInput,
  type RuntimeSessionListInput,
  type RuntimeSessionGetInput,
  type RuntimeSessionEventsInput,
  type RuntimeSession,
  type RuntimeEvent,
} from "../../types.js";
import { RuntimeCapabilityError, RuntimeExecutionError } from "../../errors.js";
import { CODEX_MODEL_EFFORT_LEVELS } from "../../modelEffort.js";
import { runCodexCli, probeCodexCli, type CodexCliLogger } from "./cli.js";
import {
  listCodexAgentApiModels,
  runCodexAgentApi,
  runCodexAgentApiStreaming,
  validateCodexAgentApiConnection,
  type CodexAgentApiLogger,
} from "./api.js";
import {
  enrichCodexDiscoveredModels,
  getDefaultCodexModels,
  listCodexAppServerModels,
} from "./modelDiscovery.js";
import { runCodexSdk, type CodexSdkLogger } from "./sdk.js";
import { runCodexAppServer } from "./appServer/run.js";
import {
  getCodexAppServerSession,
  listCodexAppServerSessionEvents,
  listCodexAppServerSessions,
} from "./appServer/sessions.js";
import { spawnCodexAppServerProcess, terminateCodexAppServerProcess } from "./appServer/process.js";
import { JsonlRpcClient } from "./appServer/jsonlRpcClient.js";
import { CodexAppServerClient } from "./appServer/client.js";
import { classifyCodexAppServerError } from "./appServer/errors.js";
import { listCodexSdkSessions, getCodexSdkSession, listCodexSdkSessionEvents } from "./sessions.js";
import { classifyCodexRuntimeError } from "./errors.js";

export type CodexRuntimeAdapterLogger = CodexCliLogger & CodexAgentApiLogger & CodexSdkLogger;

// Все поля опциональны: фабрику должно быть можно вызвать без параметров (например,
// в тестах), и тогда подставляются дефолты codex/openai/"Codex".
export interface CreateCodexRuntimeAdapterOptions {
  runtimeId?: string;
  providerId?: string;
  displayName?: string;
  logger?: CodexRuntimeAdapterLogger;
}

// Резервный логгер пишет в console, а не молчит: проблемы адаптера (недоступный
// CLI, откат транспорта) важно видеть даже когда хост не передал логгер.
// Формат "[runtime:codex]" даёт возможность быстро отфильтровать эти строки.
function createFallbackLogger(): CodexRuntimeAdapterLogger {
  return {
    debug(context, message) {
      console.debug("[runtime:codex]", message, context);
    },
    info(context, message) {
      console.info("INFO [runtime:codex]", message, context);
    },
    warn(context, message) {
      console.warn("WARN [runtime:codex]", message, context);
    },
    error(context, message) {
      console.error("ERROR [runtime:codex]", message, context);
    },
  };
}

// В логи вместо полного sessionId уходит только хвост: полный идентификатор
// бесполезен для диагностики (все равно уникален) и достаточно длинный, чтобы
// шумно занимать журнал. null/undefined не превращаются в строку "undefined".
function sessionIdSuffix(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return sessionId.length <= 8 ? sessionId : sessionId.slice(-8);
}

// Источник решения о транспорте хранится для логов и тестов: по нему видно,
// пришло значение из входа, из опций профиля или это дефолт (поле нужно,
// чтобы отличить осознанный выбор пользователя от fallback).
type TransportResolutionSource = "input.transport" | "options.transport" | "default";

// Результат резолвинга транспорта. "requested" сохраняется как строка, а не как
// RuntimeTransport: пользователь мог запросить неизвестное значение, и оно
// нужно для диагностирующего сообщения. Флаги fellBackToDefault и
// normalizedFromLegacy позволяют вызвавшему коду решить, писать ли warn.
interface TransportResolution {
  transport: RuntimeTransport;
  requested: string | null;
  source: TransportResolutionSource;
  normalizedFromLegacy: boolean;
  fellBackToDefault: boolean;
}

// ---------------------------------------------------------------------------
// Разрешение транспорта
// ---------------------------------------------------------------------------

/**
 * Возможности отличаются по транспорту. CLI — минимальный базовый набор,
 * SDK добавляет resume и список сессий, возможности API зависят от удалённой
 * стороны.
 *
 * Таблицы константны и разделены по транспортам, а не собираются динамически:
 * набор возможностей полностью определяется выбранным транспортом и не зависит
 * от профиля. Это позволяет заранее проверить требования стадии воркфлоу.
 */

const CLI_CAPABILITIES: RuntimeCapabilities = {
  // Resume (продолжение сессии по id) CLI умеет, а вот получить список сессий
  // или создать форк - нет: такие операции требуют app-server.
  supportsResume: true,
  supportsSessionFork: false,
  supportsSessionList: false,
  // Агент-дефиниции (.claude/agents и аналоги) CLI не читает.
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
  supportsWorkspaceTools: true,
  supportsIsolatedSubagentWorkflows: false,
  supportsNativeSubagentWorkflows: false,
  // Поток CLI присылает token_count при завершении хода, но в части сценариев
  // раннего завершения (timeout, non-zero exit) событие может не успеть прийти.
  // Поэтому объявляем PARTIAL, чтобы обёртка принимала null usage.
  // PARTIAL здесь выбор в пользу честности: обещать FULL и иногда отдавать
  // null - хуже, чем сразу сказать, что данные могут отсутствовать.
  usageReporting: UsageReporting.PARTIAL,
};

const SDK_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  supportsSessionFork: false,
  // SDK умеет перечислять сессии через свои API (см. sessions.ts).
  supportsSessionList: true,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
  supportsWorkspaceTools: true,
  // SDK-транспорт умеет запускать изолированные и нативные сабагенты.
  supportsIsolatedSubagentWorkflows: true,
  supportsNativeSubagentWorkflows: true,
  // SDK отдаёт usage явно в результате прогона.
  usageReporting: UsageReporting.FULL,
};

const API_CAPABILITIES: RuntimeCapabilities = {
  // HTTP API не знает про сессии и историю: это безсостояный транспорт,
  // sessionId из ответа - просто идентификатор запроса провайдера.
  supportsResume: false,
  supportsSessionFork: false,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
  // Инструменты исполняет вызывающая сторона: у API нет доступа к рабочему
  // каталогу проекта, поэтому workspace-tools здесь выключены.
  supportsWorkspaceTools: false,
  // При этом вызовы инструментов через протокол поддерживаются - их разбирают
  // parseToolCalls и склейка стриминговых tool_calls (см. api.ts).
  supportsToolCalling: true,
  supportsIsolatedSubagentWorkflows: false,
  supportsNativeSubagentWorkflows: false,
  // FULL - потому что протокол chat/completions штатно отдаёт блок usage; но
  // если конкретный шлюз его не прислал, RuntimeRunResult.usage будет null -
  // это допустимо контрактом и не считается багом.
  usageReporting: UsageReporting.FULL,
};

const APP_SERVER_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: true,
  // Единственный транспорт с поддержкой форка сессии (и то за фича-флагом).
  supportsSessionFork: true,
  supportsSessionList: true,
  supportsAgentDefinitions: false,
  supportsStreaming: true,
  supportsModelDiscovery: true,
  supportsApprovals: false,
  supportsCustomEndpoint: true,
  supportsWorkspaceTools: true,
  // app-server сам решает, присылать ли информацию об использовании:
  // ранний обрыв или отмена могут оставить usage неизвестным.
  usageReporting: UsageReporting.PARTIAL,
};

// Фича-флаг поверх таблицы: fork остаётся в коде и типах, но при выключенном
// AIF_RUNTIME_SESSION_FORK_ENABLED capability не обещается потребителям. Возврат
// исходного объекта (без копии) при включённом флаге важен для тестов,
// которые проверяют ссылочное равенство таблиц.
function withSessionForkRolloutGate(capabilities: RuntimeCapabilities): RuntimeCapabilities {
  if (getEnv().AIF_RUNTIME_SESSION_FORK_ENABLED || !capabilities.supportsSessionFork) {
    return capabilities;
  }
  return { ...capabilities, supportsSessionFork: false };
}

// Резолвинг транспорта не бросает: невалидное значение - не исключительная
// ситуация, а пользовательская ошибка конфигурации, и обрабатывать её нужно
// мягко (warn + откат на CLI). Приоритет входного поля над опциями профиля
// продуман: профиль - это сохранённый дефолт, а поле входа - осознанный выбор
// конкретного запуска.
function resolveTransport(input: {
  transport?: string;
  options?: Record<string, unknown>;
}): TransportResolution {
  const requestedFromInput = readString(input.transport);
  const requestedFromOptions = readString(asRecord(input.options).transport);
  const requested = requestedFromInput ?? requestedFromOptions;
  // source вычисляется даже когда запрошен дефолт: он уходит в логи, и по нему
  // видно, был ли вообще явный запрос транспорта.
  const source: TransportResolutionSource = requestedFromInput
    ? "input.transport"
    : requestedFromOptions
      ? "options.transport"
      : "default";

  // Ничего не запрошено - молча берём CLI и НЕ помечаем это как откат:
  // fellBackToDefault=false, иначе каждый запуск с дефолтным профилем писал бы
  // предупреждение в журнал.
  if (!requested) {
    return {
      transport: RuntimeTransport.CLI,
      requested: null,
      source,
      normalizedFromLegacy: false,
      fellBackToDefault: false,
    };
  }
  if (requested === RuntimeTransport.SDK) {
    return {
      transport: RuntimeTransport.SDK,
      requested,
      source,
      normalizedFromLegacy: false,
      fellBackToDefault: false,
    };
  }
  if (requested === RuntimeTransport.API) {
    return {
      transport: RuntimeTransport.API,
      requested,
      source,
      normalizedFromLegacy: false,
      fellBackToDefault: false,
    };
  }
  if (requested === RuntimeTransport.APP_SERVER) {
    return {
      transport: RuntimeTransport.APP_SERVER,
      requested,
      source,
      normalizedFromLegacy: false,
      fellBackToDefault: false,
    };
  }
  // Легаси-алиас: раньше этот транспорт назывался "agentapi" (и так записан
  // в старых профилях). Переименование не должно ломать сохранённые настройки,
  // поэтому алиас нормализуется в API с флагом normalizedFromLegacy - код
  // выше по стеку решает по нему, залогировать ли предупреждение.
  if (requested === "agentapi") {
    return {
      transport: RuntimeTransport.API,
      requested,
      source,
      normalizedFromLegacy: true,
      fellBackToDefault: false,
    };
  }
  // Неизвестное имя транспорта - не ошибка приложения: возвращается CLI плюс
  // fellBackToDefault=true, чтобы вызывающий код написал warn с исходной
  // строкой requested и пользователь понял, что опечатался.
  return {
    transport: RuntimeTransport.CLI,
    requested,
    source,
    normalizedFromLegacy: false,
    fellBackToDefault: true,
  };
}

// Путь к CLI резолвится из опций профиля, затем из окружения, затем из PATH
// (просто "codex"). Это тот же приоритет, что и у остальных настроек
// транспорта: профиль важнее окружения процесса.
function resolveCliPath(input: RuntimeConnectionValidationInput): string {
  const options = asRecord(input.options);
  return readString(options.codexCliPath) ?? readString(process.env.CODEX_CLI_PATH) ?? "codex";
}

// ---------------------------------------------------------------------------
// Проверка соединения по каждому транспорту
// ---------------------------------------------------------------------------

// Валидация CLI разделена на три уровня проверки, от дешёвого к дорогому:
// конфигурация задана -> файл существует (только если это похоже на путь) ->
// реальный запуск probe. Последний шаг нужен потому, что existsSync работает
// неодинаково на разных платформах с .cmd/.bat-обёртками: файл есть, но запустить
// его нельзя. Валидация не бросает, а возвращает ok/message: это UI-операция,
// и пользователю нужен текст ошибки, а не исключение.
async function validateCodexCliConnection(
  input: RuntimeConnectionValidationInput,
): Promise<RuntimeConnectionValidationResult> {
  const cliPath = resolveCliPath(input);
  if (!cliPath) {
    return {
      ok: false,
      message: "Codex CLI path is not configured",
    };
  }

  // Проверка "похоже на путь" (есть слеши) отделяет случай "пользователь указал
  // файл" от "используется имя из PATH": для второго existsSync бессмысленен,
  // файл найдёт сам spawn при probe.
  const looksLikePath = cliPath.includes("/") || cliPath.includes("\\");
  if (looksLikePath && !existsSync(cliPath)) {
    return {
      ok: false,
      message: `Configured Codex CLI path does not exist: ${cliPath}`,
    };
  }

  // Реально зондируем CLI для проверки доступности (ловит проблемы резолва .cmd в Windows)
  const probe = probeCodexCli(cliPath);
  if (!probe.ok) {
    return {
      ok: false,
      message: `Codex CLI is not reachable (${cliPath}): ${probe.error}`,
    };
  }

  return {
    ok: true,
    message: `Codex CLI ${probe.version ?? "unknown"} (${cliPath})`,
  };
}

// SDK-транспорт под капотом всё равно запускает тот же CLI (SDK - это обёртка),
// поэтому здесь сначала выполняется CLI-проверка. Так пользователь не получит
// загадочную ошибку импорта, когда настоящая причина - недоступный бинарник.
async function validateCodexSdkConnection(
  input: RuntimeConnectionValidationInput,
): Promise<RuntimeConnectionValidationResult> {
  const cliValidation = await validateCodexCliConnection(input);
  if (!cliValidation.ok) {
    return cliValidation;
  }

  const cliPath = resolveCliPath(input);
  try {
    // Динамический импорт: пакет @openai/codex-sdk опционален, и его отсутствие
    // должно превращаться в ok:false, а не в ошибку загрузки всего адаптера.
    // Создание Codex проверяет, что codexPathOverride действительно работает.
    const { Codex } = await import("@openai/codex-sdk");
    new Codex({ codexPathOverride: cliPath });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Codex SDK is not available: ${msg}`,
    };
  }

  return {
    ok: true,
    message: `Codex SDK is available and will use CLI ${cliValidation.message}`,
  };
}

// Вход для запуска app-server при валидации собирается всегда с транспортом
// APP_SERVER: процесс нужно поднять именно в этом режиме, иначе рукопожатие
// не о чем. Остальные поля (ключи, baseUrl) переносятся из опций профиля как
// есть - валидация должна проверять ту же конфигурацию, что и реальный прогон.
function buildValidationLaunchInput(input: RuntimeConnectionValidationInput): {
  runtimeId: string;
  profileId: string | null;
  transport: RuntimeTransport;
  options: Record<string, unknown>;
  projectRoot?: string;
  cwd?: string;
  apiKey?: string | null;
  apiKeyEnvVar?: string | null;
  baseUrl?: string | null;
} {
  const options = asRecord(input.options);
  return {
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    transport: RuntimeTransport.APP_SERVER,
    options,
    apiKey: readString(options.apiKey),
    apiKeyEnvVar: readString(options.apiKeyEnvVar),
    baseUrl: readString(options.baseUrl),
  };
}

// Самая тяжёлая валидация: она поднимает реальный процесс codex app-server и
// выполняет initialize-хендшейк. Это единственный способ проверить, что версия
// CLI совместима с протоколом, поэтому честнее подождать пару секунд, чем
// получить отказ уже на этапе выполнения задачи. Таймаут запросов жёстко 5с:
// валидация интерактивна и не должна занимать дольше.
async function validateCodexAppServerConnection(
  input: RuntimeConnectionValidationInput,
): Promise<RuntimeConnectionValidationResult> {
  const cliValidation = await validateCodexCliConnection(input);
  if (!cliValidation.ok) {
    return cliValidation;
  }

  const launch = spawnCodexAppServerProcess({
    input: buildValidationLaunchInput(input),
  });
  const rpcClient = new JsonlRpcClient(launch.process, {
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    transport: RuntimeTransport.APP_SERVER,
    requestTimeoutMs: 5_000,
  });
  const appServerClient = new CodexAppServerClient(rpcClient, {
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    transport: RuntimeTransport.APP_SERVER,
    requestTimeoutMs: 5_000,
  });

  try {
    await appServerClient.initialize({
      // Имя клиента фиксировано и говорящее: оно видно в отличие от
      // пользовательских прогонов логах app-server, и по нему легко понять,
      // что соединение было именно проверочным.
      clientInfo: {
        name: "aif-runtime-codex-validation",
        title: "AIF Runtime Codex Validation",
        version: "1.0",
      },
      capabilities: {
        // experimentalApi может требовать более новая версия CLI, поэтому
        // включение оставлено на усмотрение профиля (строгая проверка === true,
        // "true" из строки не принимается).
        experimentalApi: asRecord(input.options).experimentalApi === true,
        requestAttestation: false,
      },
    });
    return {
      ok: true,
      message: `Codex app-server initialize handshake succeeded (${launch.executablePath})`,
    };
  } catch (error) {
    // Ошибка классифицируется структурно, а category/adapterCode уезжают в
    // details: UI может отличить "не установлен CLI" от "не тот протокол",
    // не разбирая текст сообщения.
    const classified = classifyCodexAppServerError(error);
    const installHint = `Install/update Codex CLI and run 'codex auth login' if needed`;
    return {
      ok: false,
      message: `Codex app-server initialize handshake failed: ${classified.message}. ${installHint}.`,
      details: {
        category: classified.category,
        adapterCode: classified.adapterCode ?? null,
      },
    };
  } finally {
    // Процесс гарантированно завершается даже при исключении: иначе валидация
    // оставляла бы висящий codex app-server на каждую неудачную попытку.
    appServerClient.close("validation finished");
    await terminateCodexAppServerProcess(launch);
  }
}

// ---------------------------------------------------------------------------
// Фабрика адаптера
// ---------------------------------------------------------------------------

// Фабрика возвращает объект-замыкание: runtimeId, providerId и logger
// вычисляются один раз при создании, а методы адаптера уже не принимают их
// параметрами. Это позволяет одному и тому же коду обслуживать несколько
// профилей Codex с разными id.
export function createCodexRuntimeAdapter(
  options: CreateCodexRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const runtimeId = options.runtimeId ?? "codex";
  const providerId = options.providerId ?? "openai";
  const logger = options.logger ?? createFallbackLogger();

  // Единая точка ветвления по транспорту для run и resume: оба метода делают
  // одно и то же, различает их только флаг resume в input.
  async function runByTransport(input: RuntimeRunInput): Promise<RuntimeRunResult> {
    const transportResolution = resolveTransport({
      transport: input.transport,
      options: input.options,
    });
    const transport = transportResolution.transport;
    // Наличие onEvent трактуется как запрос стриминга: если подписчик есть,
    // провайдеру выгоднее отдавать текст по мере генерации, а не одним куском.
    const wantsStreaming = input.execution?.onEvent != null;
    // Три отдельные ветки логирования вместо одной - у каждого случая своя
    // важность: осознанный app-server пишется в debug, легаси-алиас и откат -
    // в warn (пользователь должен узнать, что запрошенное не применилось).
    if (
      transportResolution.requested === RuntimeTransport.APP_SERVER &&
      transportResolution.source !== "default"
    ) {
      logger.debug?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          requestedTransport: transportResolution.requested,
          resolvedTransport: transport,
          source: transportResolution.source,
        },
        "DEBUG [runtime:codex] Explicit app-server transport resolved",
      );
    }
    if (transportResolution.normalizedFromLegacy) {
      logger.warn?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          requestedTransport: transportResolution.requested,
          resolvedTransport: transport,
          source: transportResolution.source,
        },
        "WARN [runtime:codex] Legacy transport alias normalized to api",
      );
    }
    if (transportResolution.fellBackToDefault) {
      logger.warn?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          requestedTransport: transportResolution.requested,
          resolvedTransport: transport,
          source: transportResolution.source,
        },
        "WARN [runtime:codex] Unknown transport requested, defaulting to cli",
      );
    }
    // Решение о транспорте всегда попадает в лог: без этой записи трудно понять
    // задним числом, почему задача ушла в CLI, а не в API.
    logger.info?.(
      {
        runtimeId,
        profileId: input.profileId ?? null,
        transport,
        requestedTransport: transportResolution.requested,
        transportSource: transportResolution.source,
      },
      "INFO [runtime:codex] Selected transport",
    );

    // В fork input добавляется resolved transport: нижележащие транспорты не
    // должны повторно угадывать, какой из них выбран.
    if (transport === RuntimeTransport.SDK) {
      return runCodexSdk(input, logger);
    }

    if (transport === RuntimeTransport.API) {
      if (wantsStreaming) {
        return runCodexAgentApiStreaming({ ...input, transport }, logger);
      }
      return runCodexAgentApi({ ...input, transport }, logger);
    }

    if (transport === RuntimeTransport.APP_SERVER) {
      return runCodexAppServer({ ...input, transport }, logger);
    }

    // CLI - последняя ветка и дефолт: сюда попадает всё, что не опознано выше,
    // включая откат при неизвестном транспорте.
    return runCodexCli({ ...input, transport }, logger);
  }

  // Форк сессии поддерживает только app-server. Вместо тихого неподдерживаемого
  // поведения бросается RuntimeCapabilityError с именем транспорта: это
  // осмысленная ошибка контракта, а не сбой выполнения.
  async function forkByTransport(input: RuntimeSessionForkInput): Promise<RuntimeRunResult> {
    const transportResolution = resolveTransport({
      transport: input.transport,
      options: input.options,
    });
    const transport = transportResolution.transport;

    if (transport !== RuntimeTransport.APP_SERVER) {
      logger.warn?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          transport,
          requestedTransport: transportResolution.requested,
          sourceSessionIdSuffix: sessionIdSuffix(input.sourceSessionId),
          skipReason: "unsupported_transport",
        },
        "WARN [runtime:codex] Session fork requested for unsupported transport",
      );
      throw new RuntimeCapabilityError(
        `Codex ${transport} transport does not support session fork`,
      );
    }

    logger.debug?.(
      {
        runtimeId,
        profileId: input.profileId ?? null,
        transport,
        sourceSessionIdSuffix: sessionIdSuffix(input.sourceSessionId),
      },
      "DEBUG [runtime:codex] Starting Codex session fork run",
    );

    try {
      const result = await runCodexAppServer({ ...input, transport }, logger);
      // В лог идут только суффиксы id - и исходной, и дочерней сессии: этого
      // достаточно, чтобы сопоставить запись с конкретным прогоном.
      logger.debug?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          transport,
          sourceSessionIdSuffix: sessionIdSuffix(input.sourceSessionId),
          childSessionIdSuffix: sessionIdSuffix(result.sessionId ?? result.session?.id ?? null),
        },
        "DEBUG [runtime:codex] Codex session fork run completed",
      );
      return result;
    } catch (error) {
      // Уже классифицированную ошибку повторно не оборачиваем: важно сохранить
      // category/adapterCode, выставленные глубже в стеке, иначе координатор
      // потеряет структурированный контекст для принятия решения.
      const classified =
        error instanceof RuntimeExecutionError ? error : classifyCodexRuntimeError(error);
      logger.error?.(
        {
          runtimeId,
          profileId: input.profileId ?? null,
          transport,
          sourceSessionIdSuffix: sessionIdSuffix(input.sourceSessionId),
          category: classified.category,
          adapterCode: classified.adapterCode ?? null,
          error: classified.message,
        },
        "ERROR [runtime:codex] Codex session fork run failed",
      );
      throw classified;
    }
  }

  return {
    // descriptor описывает адаптер для UI и сервиса резолвинга профилей.
    // capabilities здесь - набор для CLI: это транспорт по умолчанию, с которым
    // адаптер ведёт себя как "наименьший общий знаменатель". Реальный набор для
    // выбранного транспорта выдаёт getEffectiveCapabilities ниже.
    descriptor: {
      id: runtimeId,
      providerId,
      displayName: options.displayName ?? "Codex",
      supportsProjectInit: true,
      projectInitAgentName: "codex",
      // Префикс слэш-команд Codex в промптах скиллов.
      skillCommandPrefix: "$",
      // lightModel не задан: у Codex нет отдельной дешёвой модели для гейтов,
      // и честнее вернуть null, чем выдать произвольную.
      lightModel: null,
      defaultApiKeyEnvVar: "OPENAI_API_KEY",
      apiKeyEnvCandidates: ["OPENAI_API_KEY", "OPENAI_AUTH_TOKEN"],
      defaultBaseUrlEnvVar: "CODEX_BASE_URL",
      // Codex sdk/cli стартуют с OAuth-логина: подмена base URL по умолчанию
      // уводила бы сессию в чужой бэкенд, поэтому null (не подменять).
      // API-транспорт Codex читает OPENAI_BASE_URL — ветка зашита в резолвинге
      // как транспорт-специфичное правило, а не vendor-таблица.
      defaultBaseUrl: null,
      defaultModelEnvVar: "OPENAI_MODEL",
      defaultModelPlaceholder: "gpt-5.4",
      // Порядок транспортов в списке фиксирован: он влияет на порядок в UI
      // настроек профиля, и app-server с api не должны случайно поменяться
      // местами при добавлении новых.
      supportedTransports: [
        RuntimeTransport.SDK,
        RuntimeTransport.CLI,
        RuntimeTransport.APP_SERVER,
        RuntimeTransport.API,
      ],
      defaultTransport: RuntimeTransport.CLI,
      effort: {
        optionKey: "modelReasoningEffort",
        fallbackLevels: CODEX_MODEL_EFFORT_LEVELS,
      },
      capabilities: CLI_CAPABILITIES,
    },

    // Единственное место, где набор возможностей выбирается по транспорту.
    // default вместо явного case CLI - сознательно: неизвестное значение тоже
    // должно получить безопасный минимум, а не undefined.
    getEffectiveCapabilities(transport: RuntimeTransport): RuntimeCapabilities {
      switch (transport) {
        case RuntimeTransport.SDK:
          return SDK_CAPABILITIES;
        case RuntimeTransport.APP_SERVER:
          return withSessionForkRolloutGate(APP_SERVER_CAPABILITIES);
        case RuntimeTransport.API:
          return API_CAPABILITIES;
        default:
          return CLI_CAPABILITIES;
      }
    },

    async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
      try {
        return await runByTransport(input);
      } catch (error) {
        throw classifyCodexRuntimeError(error);
      }
    },

    async resume(input: RuntimeRunInput & { sessionId: string }): Promise<RuntimeRunResult> {
      try {
        return await runByTransport({ ...input, resume: true });
      } catch (error) {
        throw classifyCodexRuntimeError(error);
      }
    },

    async forkSession(input: RuntimeSessionForkInput): Promise<RuntimeRunResult> {
      return await forkByTransport(input);
    },

    async listSessions(input: RuntimeSessionListInput): Promise<RuntimeSession[]> {
      const transport = resolveTransport({
        transport: input.transport,
        options: input.options,
      }).transport;
      if (transport === RuntimeTransport.APP_SERVER) {
        return listCodexAppServerSessions(input, logger);
      }
      return listCodexSdkSessions(input);
    },

    async getSession(input: RuntimeSessionGetInput): Promise<RuntimeSession | null> {
      const transport = resolveTransport({
        transport: input.transport,
        options: input.options,
      }).transport;
      if (transport === RuntimeTransport.APP_SERVER) {
        return getCodexAppServerSession(input, logger);
      }
      return getCodexSdkSession(input);
    },

    async listSessionEvents(input: RuntimeSessionEventsInput): Promise<RuntimeEvent[]> {
      const transport = resolveTransport({
        transport: input.transport,
        options: input.options,
      }).transport;
      if (transport === RuntimeTransport.APP_SERVER) {
        return listCodexAppServerSessionEvents(input, logger);
      }
      return listCodexSdkSessionEvents(input);
    },

    async validateConnection(
      input: RuntimeConnectionValidationInput,
    ): Promise<RuntimeConnectionValidationResult> {
      const rawTransport = readString(input.transport);
      if (
        rawTransport &&
        rawTransport !== RuntimeTransport.CLI &&
        rawTransport !== RuntimeTransport.APP_SERVER &&
        rawTransport !== RuntimeTransport.API &&
        rawTransport !== RuntimeTransport.SDK &&
        rawTransport !== "agentapi"
      ) {
        return {
          ok: false,
          message: `Codex does not support "${rawTransport}" transport. Use "sdk", "cli", "app-server", or "api".`,
        };
      }

      const transport = resolveTransport({
        transport: input.transport,
        options: input.options,
      }).transport;

      if (transport === RuntimeTransport.SDK) {
        return validateCodexSdkConnection(input);
      }

      if (transport === RuntimeTransport.API) {
        const issues: string[] = [];
        const options = asRecord(input.options);
        const apiKey = readString(options.apiKey);
        const baseUrl =
          readString(options.agentApiBaseUrl) ??
          readString(options.baseUrl) ??
          readString(process.env.OPENAI_BASE_URL);
        if (!apiKey) {
          issues.push("Missing API key (expected env var: OPENAI_API_KEY)");
        }
        if (!baseUrl) {
          issues.push(
            "Missing base URL for API transport (set OPENAI_BASE_URL or profile baseUrl)",
          );
        }
        if (issues.length > 0) {
          return { ok: false, message: issues.join("; ") };
        }
        return validateCodexAgentApiConnection({ ...input, transport });
      }

      if (transport === RuntimeTransport.APP_SERVER) {
        return validateCodexAppServerConnection({ ...input, transport });
      }

      return validateCodexCliConnection({ ...input, transport });
    },

    async listModels(input: RuntimeModelListInput): Promise<RuntimeModel[]> {
      const options = asRecord(input.options);
      const transport = resolveTransport({ transport: input.transport, options }).transport;
      if (transport === RuntimeTransport.API) {
        try {
          const models = enrichCodexDiscoveredModels(await listCodexAgentApiModels(input));
          if (models.length > 0) {
            logger.debug?.(
              {
                runtimeId: input.runtimeId,
                profileId: input.profileId ?? null,
                modelCount: models.length,
              },
              "[runtime:codex] Fetched model list from OpenAI API",
            );
            return models;
          }
        } catch {
          logger.warn?.(
            {
              runtimeId: input.runtimeId,
              profileId: input.profileId ?? null,
            },
            "WARN [runtime:codex] OpenAI API model discovery failed, falling back to built-in list",
          );
        }
      }

      if (
        transport === RuntimeTransport.CLI ||
        transport === RuntimeTransport.SDK ||
        transport === RuntimeTransport.APP_SERVER
      ) {
        const slowPathStartedAt = Date.now();
        logger.debug?.(
          {
            runtimeId: input.runtimeId,
            profileId: input.profileId ?? null,
            transport,
          },
          "[runtime:codex] Running app-server model discovery slow path (cache miss at runtime service level)",
        );
        try {
          const models = await listCodexAppServerModels({ ...input, transport }, logger);
          if (models.length > 0) {
            logger.debug?.(
              {
                runtimeId: input.runtimeId,
                profileId: input.profileId ?? null,
                transport,
                discoveryDurationMs: Date.now() - slowPathStartedAt,
              },
              "[runtime:codex] Codex app-server model discovery slow path completed",
            );
            return models;
          }
        } catch (error) {
          logger.warn?.(
            {
              runtimeId: input.runtimeId,
              profileId: input.profileId ?? null,
              transport,
              discoveryDurationMs: Date.now() - slowPathStartedAt,
              error: error instanceof Error ? error.message : String(error),
            },
            "WARN [runtime:codex] Codex app-server model discovery failed, falling back to built-in list",
          );
        }
      }

      logger.debug?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport,
        },
        "[runtime:codex] Returning built-in model list",
      );
      return getDefaultCodexModels();
    },

    initProject(projectRoot) {
      initCodexProject(projectRoot);
    },

    async getMcpStatus(input) {
      return getCodexMcpStatus(input);
    },
    async installMcpServer(input) {
      return installCodexMcpServer(input);
    },
    async uninstallMcpServer(input) {
      return uninstallCodexMcpServer(input);
    },
  };
}
