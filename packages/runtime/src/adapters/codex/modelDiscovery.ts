/**
 * Получение списка моделей Codex через app-server (JSON-RPC over stdio).
 *
 * Список моделей нельзя получить из статичного каталога: у Codex он зависит от конфига,
 * авторизации и версии CLI, поэтому мы поднимаем штатный app-server и спрашиваем его по
 * протоколу. Отсюда две особенности модуля.
 *
 * Первая: запуск процесса — операция ненадёжная (бинарник может быть не найден, порт
 * занят, инициализация может затянуться), поэтому старт завёрнут в ограниченный retry
 * с задержкой. Вторая: канал RPC и процесс должны быть гарантированно закрыты, иначе
 * зависший дочерний процесс удержит Node.js; поэтому закрытие идёт в finally, причём
 * close() обёрнут отдельно — сбой в нём не должен помешать terminate. Ответы сервера
 * читаются защитно: поля могут отсутствовать, тип — не совпадать (Nullable Cast Rule).
 */

import { RuntimeTransport, type RuntimeModel, type RuntimeModelListInput } from "../../types.js";
import {
  enrichCodexDiscoveredModels,
  getDefaultCodexModels,
  parseCodexRuntimeModel,
} from "./modelDiscovery/modelCatalog.js";
import {
  buildCodexAppServerDiscoveryEnv,
  resolveDiscoveryExecutable,
  spawnCodexAppServer,
  terminateProcess,
} from "./modelDiscovery/process.js";
import { connectJsonRpcClient, sleep } from "./modelDiscovery/rpc.js";
import type {
  CodexModelDiscoveryLogger,
  CodexModelDiscoveryStartupDeps,
  JsonRpcClient,
} from "./modelDiscovery/types.js";

// Константы вынесены наверх, чтобы таймауты и лимиты были видны целиком и не тонули
// среди логики. Значения подобраны так: 5с на запрос достаточно для локального процесса,
// три попытки покрывают гонку при одновременном старте нескольких задач,
// а предел страниц защищает от бесконечного курсора в сломанном ответе сервера.
const DEFAULT_APP_SERVER_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_APP_SERVER_STARTUP_ATTEMPTS = 3;
const DEFAULT_APP_SERVER_STARTUP_RETRY_DELAY_MS = 150;
const MAX_MODEL_LIST_PAGES = 10;

// Реэкспорты: потребители модуля работают с одним импортом, не зная про подкаталог
// modelDiscovery. Это стабильная часть публичного контракта адаптера.
export { buildCodexAppServerDiscoveryEnv, enrichCodexDiscoveredModels, getDefaultCodexModels };
export type { CodexModelDiscoveryLogger };

// Запуск app-server с retry. deps по умолчанию — реальные реализации; в тестах
// подменяются на фейки, поэтому все побочные эффекты идут только через deps.
export async function startCodexAppServerWithRetry(
  input: RuntimeModelListInput,
  logger?: CodexModelDiscoveryLogger,
  deps: CodexModelDiscoveryStartupDeps = {
    spawnCodexAppServer,
    connectJsonRpcClient,
    terminateProcess,
    sleep,
  },
): Promise<{
  attempt: number;
  launch: Awaited<ReturnType<typeof spawnCodexAppServer>>;
  client: JsonRpcClient;
  executablePath: string;
}> {
  const executablePath = resolveDiscoveryExecutable(input);
  // lastError хранится между попытками: последняя ошибка информативнее первой,
  // именно она пойдёт наружу если все попытки исчерпаны.
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= DEFAULT_APP_SERVER_STARTUP_ATTEMPTS; attempt += 1) {
    // Процесс поднимается заново на каждой итерации: переиспользовать сломанный канал нельзя.
    const launch = deps.spawnCodexAppServer(input);
    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: input.transport ?? RuntimeTransport.CLI,
        executablePath,
        // Диагностический флаг: настроен ли путь к CLI явно (в опциях или env).
        // Без него ошибку "бинарник не найден" трудно отличить от "указан неверный путь".
        hasConfiguredCliPath:
          typeof asRecord(input.options).codexCliPath === "string" ||
          typeof process.env.CODEX_CLI_PATH === "string",
        projectRoot: input.projectRoot ?? null,
        attempt,
        maxAttempts: DEFAULT_APP_SERVER_STARTUP_ATTEMPTS,
      },
      "DEBUG [runtime:codex] Starting Codex app-server model discovery over stdio",
    );

    try {
      // Подключение к уже запущенному процессу: внутри проверяется, не успел ли он умереть.
      const client = await deps.connectJsonRpcClient(launch, {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: input.transport ?? RuntimeTransport.CLI,
        requestTimeoutMs: DEFAULT_APP_SERVER_CONNECT_TIMEOUT_MS,
        logger,
      });

      await client.request(
        "initialize",
        {
          clientInfo: {
            name: "aif-runtime-codex-model-discovery",
            title: "AIF Runtime Codex Model Discovery",
            version: "1.0",
          },
          capabilities: {
            // experimentalApi и requestAttestation выключены осознанно: discovery
            // должен работать на стабильной части протокола и совместим с любым CLI.
            experimentalApi: false,
            requestAttestation: false,
          },
        },
        DEFAULT_APP_SERVER_CONNECT_TIMEOUT_MS,
      );
      // Уведомление о завершении рукопожатия; ?. — не все транспорты его поддерживают.
      await client.notify?.("initialized");

      logger?.debug?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: input.transport ?? RuntimeTransport.CLI,
          attempt,
          maxAttempts: DEFAULT_APP_SERVER_STARTUP_ATTEMPTS,
        },
        "DEBUG [runtime:codex] Codex app-server initialize handshake completed",
      );

      return {
        attempt,
        launch,
        client,
        executablePath,
      };
    } catch (error) {
      // Хвост stderr от процесса приклеивается к сообщению: ошибки старта Codex
      // почти всегда описаны именно там, а наружу выбрасывается только Error.message.
      const details = launch.stderrTail.join("").trim();
      const message = error instanceof Error ? error.message : String(error);
      const startupError = new Error(details ? `${message} (${details})` : message);
      lastError = startupError;
      // Обязательная уборка перед следующей попыткой: без неё зомби-процессы накопятся.
      await deps.terminateProcess(launch);

      // Повторяем только если попытки остались: иначе падаем в общий выход ниже.
      if (attempt < DEFAULT_APP_SERVER_STARTUP_ATTEMPTS) {
        logger?.warn?.(
          {
            runtimeId: input.runtimeId,
            profileId: input.profileId ?? null,
            transport: input.transport ?? RuntimeTransport.CLI,
            executablePath,
            attempt,
            maxAttempts: DEFAULT_APP_SERVER_STARTUP_ATTEMPTS,
            error: startupError.message,
            retryDelayMs: DEFAULT_APP_SERVER_STARTUP_RETRY_DELAY_MS,
            nextAttempt: attempt + 1,
          },
          "WARN [runtime:codex] Codex app-server stdio startup failed, retrying",
        );
        // Пауза между попытками нужна из-за гонки при старте нескольких задач
        // одновременно (тот же бинарник, те же файлы конфига).
        await deps.sleep(DEFAULT_APP_SERVER_STARTUP_RETRY_DELAY_MS);
        continue;
      }

      logger?.error?.(
        {
          runtimeId: input.runtimeId,
          profileId: input.profileId ?? null,
          transport: input.transport ?? RuntimeTransport.CLI,
          executablePath,
          attempt,
          maxAttempts: DEFAULT_APP_SERVER_STARTUP_ATTEMPTS,
          error: startupError.message,
        },
        "ERROR [runtime:codex] Codex app-server startup retries exhausted",
      );
    }
  }

  throw (
    // lastError приоритетнее: он с хвостом stderr и понятной причиной.
    // ?? — страховка на случай, если цикл не сделал ни одной итерации (недостижимо сегодня,
    // но без него тип возврата остался бы возможно-null).
    lastError ??
    new Error("Codex app-server startup failed before initialize handshake could complete")
  );
}

// Основная операция: получить список моделей. Процесс поднимается на время запроса
// и гасится в finally — метод не оставляет за собой ресурсов.
export async function listCodexAppServerModels(
  input: RuntimeModelListInput,
  logger?: CodexModelDiscoveryLogger,
): Promise<RuntimeModel[]> {
  const startup = await startCodexAppServerWithRetry(input, logger);
  const { client, launch, executablePath } = startup;

  try {
    const discovered: RuntimeModel[] = [];
    // Пагинация курсором: сервер отдаёт страницами, курсор null означает "начало".
    let cursor: string | null = null;

    for (let page = 0; page < MAX_MODEL_LIST_PAGES; page += 1) {
      const result = asRecord(
        await client.request(
          "model/list",
          {
            cursor,
            includeHidden: false,
            limit: 100,
          },
          DEFAULT_APP_SERVER_CONNECT_TIMEOUT_MS,
        ),
      );
      const models = Array.isArray(result.data) ? result.data : [];
      for (const model of models) {
        const parsed = parseCodexRuntimeModel(model);
        // Пропускаем нераспознанные записи: сервер может добавить новые поля/типы,
        // и падение всей выдачи из-за одной незнакомой модели недопустимо.
        if (parsed) {
          discovered.push(parsed);
        }
      }

      // readString возвращает null на пустой/нестроковый курсор — условие ниже завершает цикл.
      cursor = readString(result.nextCursor);
      if (!cursor) {
        break;
      }
    }

    logger?.debug?.(
      {
        runtimeId: input.runtimeId,
        profileId: input.profileId ?? null,
        transport: input.transport ?? RuntimeTransport.CLI,
        executablePath,
        modelCount: discovered.length,
      },
      "DEBUG [runtime:codex] Fetched model list from Codex app-server",
    );

    return enrichCodexDiscoveredModels(discovered);
  } catch (error) {
    // Тот же приём, что при старте: добавляем stderr к ошибке, чтобы у вызывающего
    // была причина, а не только "request failed".
    const details = launch.stderrTail.join("").trim();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(details ? `${message} (${details})` : message);
  } finally {
    try {
      // Закрываем канал отдельным try: сбой close() не должен помешать убить процесс.
      client.close();
    } finally {
      await terminateProcess(launch);
    }
  }
}

// Локальные защитные хелперы: ответы JSON-RPC приходят как unknown, и на каждом уровне
// нельзя предполагать удачную форму. asRecord даёт пустой объект вместо null,
// чтобы не заставлять вызывающий код проверять на null каждый раз.
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// null вместо пустой строки: вызывающий различает "значение отсутствует" и "значение пустое",
// что важно при проверке курсора пагинации.
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
