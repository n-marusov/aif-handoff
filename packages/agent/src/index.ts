/**
 * Точка входа процесса агента: сборка зависимостей, запуск планировщика и
 * аккуратное завершение.
 *
 * Почему файл выглядит как линейный скрипт, а не набор функций: порядок действий
 * здесь и есть контракт. Реестр рантаймов, планировщик опроса, канал пробуждения и
 * внутренний HTTP API должны подниматься именно в этом порядке, иначе первый же
 * цикл опроса увидит неинициализированные зависимости.
 *
 * Инварианты и подводные камни:
 * - Планировщик стартует до загрузки реестра рантаймов намеренно: регистрация
 *   адаптеров асинхронная, а координатор умеет ждать её через setRuntimeRegistry.
 * - Сверка worktree на старте выполняется ровно один раз и до первого опроса:
 *   каталоги-сироты от прошлого запуска иначе испортят выделение ветки первым же
 *   задачам.
 * - Дополняющие сервисы (канал пробуждения, внутренний API) объявлены как
 *   best-effort: их падение логируется, но не убивает агента, потому что основной
 *   режим периодического опроса от них не зависит.
 */
import { createRequire } from "node:module";
import { createDbUsageSink, listProjects } from "@aif/data";
import { applyGitIdentity, getEnv, logger } from "@aif/shared";
import { bootstrapRuntimeRegistry } from "@aif/runtime";
import { pollAndProcess, setRuntimeRegistry } from "./coordinator.js";
import { flushAllActivityQueues } from "./hooks.js";
import { notifyProjectRuntimeLimitBroadcast, notifyTaskUsageBroadcast } from "./notifier.js";
import { connectWakeChannel, closeWakeChannel, waitForApiReady } from "./wakeChannel.js";
import { abortAllActiveStages } from "./stageAbort.js";
import { startPollScheduler } from "./pollScheduler.js";
import { startInternalApi, type InternalApiServer } from "./internalApi.js";
import { reconcileAllProjectWorktrees } from "./worktreeReconcile.js";
import { createBrokerRuntime, type BrokerServer } from "./codex/loginBroker.js";

const log = logger("agent");

// `ai-factory` — жёсткая runtime-зависимость: слой runtime вызывает её
// CLI, чтобы создать `.ai-factory/` для каждого нового проекта (см.
// `@aif/runtime/projectInit`). Если её нет локально, runtime откатывается к
// `npx ai-factory ...`, что требует сети и обращения к registry во время
// запуска задачи — хрупко в air-gapped или production-развёртываниях,
// установленных через `npm ci --omit=dev`. Пробуем разрешить модуль при старте
// и громко предупреждаем, чтобы сбой был виден из первой строки лога агента,
// а не похоронен под более поздним предупреждением "skipped task".
function probeAiFactory(): void {
  const localRequire = createRequire(import.meta.url);
  try {
    localRequire.resolve("ai-factory/bin/ai-factory.js");
  } catch {
    log.warn(
      "ai-factory CLI is not installed locally. The agent will fall back to " +
        "`npx ai-factory ...` for project scaffolding, which requires network " +
        "access. Add `ai-factory` to dependencies (not devDependencies) and " +
        "reinstall to make this offline-safe.",
    );
  }
}
probeAiFactory();

// Проверяем переменные окружения
// Валидация окружения идёт до любых побочных эффектов: упасть на старте дешевле,
// чем посреди обработки задачи из-за пустой переменной.
const env = getEnv();

// Если настроено, коммиты сабагентов атрибутируются бот-аккаунту.
// Идентичность применяется глобально до первых коммитов, иначе часть коммитов
// уйдёт от имени разработчика и сломает аудит.
applyGitIdentity({
  botName: env.AIF_GIT_BOT_NAME,
  botEmail: env.AIF_GIT_BOT_EMAIL,
});

// Убеждаемся, что БД готова
// Вызов listProjects() - это не сбор данных, а ленивая инициализация соединения и
// прогон миграций. Без него первый же запрос из планировщика упал бы.
listProjects();

// Один раз при старте, до первого опроса, сверяем заявленные рабочие деревья с
// папками на диске: бесхозные папки от предыдущего запуска иначе отравили бы
// подготовку веток для первых задач этого запуска.
try {
  await reconcileAllProjectWorktrees("startup");
} catch (err) {
  log.error({ err }, "Startup worktree reconciliation failed; continuing to poll");
}

const pollScheduler = startPollScheduler(async () => {
  try {
    await pollAndProcess();
  } catch (err) {
    // Ошибка одного цикла не должна останавливать таймер: планировщик
    // продолжает тикать, а причина остаётся в логах.
    log.error({ err }, "Unexpected error in poll cycle");
  }
}, env.POLL_INTERVAL_MS);

// Предзагружаем реестр runtime, чтобы инициализация проекта включала все адаптеры
// Загрузка реестра асинхронная и намеренно не блокирует старт: координатор сам
// дождётся готовности реестра, а вот инициализация проекта без него прошла бы с
// неполным списком адаптеров.
bootstrapRuntimeRegistry({
  runtimeModules: env.AIF_RUNTIME_MODULES,
  modelEffortDiscoveryEnabled: env.AIF_RUNTIME_MODEL_EFFORT_DISCOVERY_ENABLED,
  usageSink: createDbUsageSink({
    onRecorded: (event) => {
      if (event.context.taskId && event.context.projectId && event.usage) {
        void notifyTaskUsageBroadcast(event.context.taskId, event.context.projectId, event.usage);
      }
      if (!event.context.projectId || !event.profileId) return;
      // Уведомление об исчерпании лимита шлём без привязки к задаче: лимит
      // относится к профилю проекта, и задачи может уже не быть.
      void notifyProjectRuntimeLimitBroadcast(event.context.projectId, event.profileId, {
        taskId: event.context.taskId ?? null,
      });
    },
  }),
})
  .then((registry) => {
    setRuntimeRegistry(registry);
    log.info("Runtime registry loaded for project initialization");
  })
  .catch((err) => log.warn({ err }, "Failed to pre-load runtime registry"));

// Логируем и настроенный, и фактический интервал: планировщик имеет право поднять
// нижнюю границу, и расхождение должно быть видно сразу, а не при разборе жалоб.
log.info(
  {
    configuredIntervalMs: env.POLL_INTERVAL_MS,
    intervalMs: pollScheduler.intervalMs,
  },
  "Agent coordinator starting",
);

// ---------------------------------------------------------------------------
// Событийное пробуждение: подписка на WS API для немедленных запусков Координатора
// ---------------------------------------------------------------------------
async function triggerWake(reason: string): Promise<void> {
  log.info({ reason }, "Wake-triggered poll cycle starting");
  // Пробуждение идёт через тот же pollAndProcess, что и обычный тик: отдельный
  // путь исполнения означал бы два места, где нужно держать блокировки стадий.
  try {
    await pollAndProcess();
  } catch (err) {
    log.error({ err, reason }, "Unexpected error in wake-triggered poll cycle");
  }
}

if (env.AGENT_WAKE_ENABLED) {
  log.info("Wake transport enabled — probing API readiness before connecting WebSocket");
  // Сначала дожидаемся готовности API: подключение к ещё не поднятому серверу
  // дало бы отказ, после которого канал остался бы молча выключенным.
  void waitForApiReady().then(() => {
    const initiated = connectWakeChannel((reason) => {
      void triggerWake(reason);
    });
    if (!initiated) {
      log.warn("Wake channel connection could not be initiated — falling back to polling only");
    }
  });
} else {
  log.info("Wake transport disabled (AGENT_WAKE_ENABLED=false) — using polling only");
}

// ---------------------------------------------------------------------------
// Всегда работающий внутренний API + опциональный broker логина codex на ОДНОМ
// порту (AGENT_INTERNAL_URL). Когда broker включён, его маршруты монтируются в то же
// Hono-приложение; иначе работают только внутренние маршруты (например, /gitlab/prepare).
// ---------------------------------------------------------------------------
let internalApiServer: InternalApiServer | null = null;
let codexLoginBroker: BrokerServer | null = null;
// Внутренний API поднимается в try/catch: без него недоступна git-подготовка, но
// опрос и обработка задач продолжают работать - это лучший компромисс, чем
// полностью нерабочий агент из-за одного порта.
try {
  if (env.AIF_ENABLE_CODEX_LOGIN_PROXY) {
    log.info(
      { port: env.AIF_CODEX_LOGIN_BROKER_PORT },
      "AIF_ENABLE_CODEX_LOGIN_PROXY=true — mounting codex login broker on internal API port",
    );
    const runtime = createBrokerRuntime({
      port: env.AIF_CODEX_LOGIN_BROKER_PORT,
      codexCliPath: env.CODEX_CLI_PATH ?? "codex",
    });
    internalApiServer = startInternalApi({
      port: env.AIF_CODEX_LOGIN_BROKER_PORT,
      mountApps: [runtime.app],
    });
    codexLoginBroker = {
      runtime,
      server: internalApiServer.server,
      port: internalApiServer.port,
      host: internalApiServer.host,
      // Брокер и внутренний API - один и тот же сервер, отдельного процесса нет.
      close: () => internalApiServer!.close(),
    };
    log.info({ port: internalApiServer.port }, "Codex login broker mounted on internal API");
  } else {
    log.debug("AIF_ENABLE_CODEX_LOGIN_PROXY=false — codex login broker disabled");
    internalApiServer = startInternalApi();
    log.info({ port: internalApiServer.port }, "Agent internal API started");
  }
} catch (err) {
  log.error({ err }, "Failed to start agent internal API; GitLab git-prepare will be unavailable");
}

log.info("Agent coordinator is running. Press Ctrl+C to stop.");

// ---------------------------------------------------------------------------
// Корректное завершение: сбрасываем буферизованные логи активности перед выходом
// ---------------------------------------------------------------------------
function onShutdown(signal: string): void {
  log.info(
    { signal },
    "Shutdown signal received — aborting stages, closing wake channel, flushing activity queues",
  );
  // Порядок важен: сначала останавливаем планировщик, чтобы новые стадии не
  // стартовали; затем прерываем текущие; только потом закрываем каналы и
  // сбрасываем буферы логов активности.
  try {
    pollScheduler.stop();
    abortAllActiveStages();
    closeWakeChannel();
    flushAllActivityQueues();
    if (internalApiServer) {
      void internalApiServer.close();
      internalApiServer = null;
    }
    if (codexLoginBroker) {
      const active = codexLoginBroker.runtime.getCurrentSession();
      // Дочерний процесс логина переживёт выход родителя и останется висеть,
      // поэтому его нужно добить явно перед закрытием сервера.
      if (active && !active.child.killed) {
        log.info({ sessionId: active.id }, "[CodexLoginBroker] killing active login session");
        try {
          active.child.kill("SIGTERM");
        } catch (err) {
          log.warn({ err }, "[CodexLoginBroker] failed to kill child on shutdown");
        }
      }
      void codexLoginBroker.close();
    }
    log.info("Shutdown flush complete");
  } catch (err) {
    // Даже при ошибке во время завершения выходим с кодом 0: иначе оркестратор
    // (Docker, systemd) будет считать остановку аварийной и устроит рестарт-петлю.
    log.error({ err }, "Error during shutdown flush");
  }
  process.exit(0);
}

process.on("SIGINT", () => onShutdown("SIGINT"));
process.on("SIGTERM", () => onShutdown("SIGTERM"));

// Лучшее, что можно сделать для flush при обычном выходе (например, необработанное исключение после обработчика)
// Страховка на случай нештатного выхода: буфер логов активности не должен
// теряться, даже если beforeExit наступил в обход обычной обработки сигналов.
process.on("beforeExit", () => {
  log.debug("beforeExit — flushing remaining activity queues");
  flushAllActivityQueues();
});
