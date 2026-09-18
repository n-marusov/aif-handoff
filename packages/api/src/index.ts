/**
 * Точка входа сервера @aif/api (Hono + WebSocket, порт 3009 по умолчанию).
 *
 * Это единственное место, где собирается приложение целиком, и порядок
 * операций здесь - не стилистика, а контракт:
 *
 * 1. WebSocket подключается до маршрутов. Обработчик upgrade должен быть
 *    привязан к нижележащему node-серверу до того, как Hono начнет отдавать
 *    запросы, иначе первые соединения останутся без апгрейда.
 * 2. Middleware монтируется до маршрутов и в фиксированном порядке: CORS
 *    обязан отработать на preflight без аутентификации, а CSRF проверяется
 *    последним, уже имея контекст участника.
 * 3. Разовые восстановительные действия выполняются до старта прослушивания,
 *    чтобы агент и UI никогда не увидели полу-восстановленное состояние.
 * 4. Graceful shutdown регистрируется сразу после старта, потому что открытые
 *    WebSocket-соединения держат event loop и без явного закрытия следующий
 *    запуск упадет с EADDRINUSE.
 */

import { Hono } from "hono";
import { getEnv, logger } from "@aif/shared";
import { listProjects, listStaleInProgressTasks, resetStaleQaRuns } from "@aif/data";
import { projectsRouter } from "./routes/projects.js";
import { tasksRouter } from "./routes/tasks.js";
import { chatRouter } from "./routes/chat.js";
import { buildSettingsOverview, settingsRoutes } from "./routes/settings.js";
import { runtimeProfilesRouter } from "./routes/runtimeProfiles.js";
import { codexAuthRouter } from "./routes/codexAuth.js";
import { authRouter } from "./routes/auth.js";
import { participantsRouter } from "./routes/participants.js";
import { githubRouter } from "./routes/github.js";
import { gitlabRouter } from "./routes/gitlab.js";
import { setupWebSocket, closeAllWebSocketClients } from "./ws.js";
import { requestLogger } from "./middleware/logger.js";
import { trackApiLoad } from "./middleware/apiLoad.js";
import { startServer } from "./serverBootstrap.js";
import { createCodexIndexService } from "./services/codexIndex.js";
import { seedBootstrapRuntimeProfile } from "./services/profileBootstrap.js";
import { createGracefulShutdownHandler } from "./shutdown.js";
import { participantAuth, type ParticipantApiEnv } from "./middleware/participantAuth.js";
import { participantCsrf } from "./middleware/csrf.js";
import { participantRouteAuthorization } from "./middleware/requireRole.js";
import { participantCors } from "./middleware/participantCors.js";

const log = logger("server");
// Момент загрузки модуля используется как начало отсчета uptime: отдельного
// события "сервер готов" для /health не нужно, а такой отсчет переживает
// инициализацию БД.
const startTime = Date.now();
const nodeServerV2WebSocketEnabled = getEnv().AIF_API_NODE_SERVER_V2_WEBSOCKET_ENABLED;

// Типизированное окружение Hono: в контекст кладется участник запроса,
// поэтому обработчики и middleware видят его без дополнительных приведений.
const app = new Hono<ParticipantApiEnv>();

// WebSocket должен быть подключён до регистрации маршрутов.
// Возвращаемые функции нужны на двух разных этапах: webSocketServer уходит
// в адаптер сокета, а injectWebSocket - в startServer, где он привязывается к
// конкретному экземпляру http-сервера.
const { injectWebSocket, webSocketServer } = setupWebSocket(app, nodeServerV2WebSocketEnabled);

// Промежуточные обработчики
// Порядок ниже значим. CORS стоит первым, чтобы preflight не упирался в
// аутентификацию; аутентификация идет до проверки ролей, а CSRF - после обеих,
// так как ему нужны и участник, и уже разобранное тело запроса.
app.use("*", participantCors());
app.use("*", trackApiLoad);
app.use("*", requestLogger);
app.use("*", participantAuth);
app.use("*", participantRouteAuthorization());
app.use("*", participantCsrf());

// Проверка здоровья сервиса
// Намеренно не трогает БД: пробники оркестратора дергают этот путь часто,
// и обращение к SQLite здесь добавило бы нагрузку без пользы.
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

// Статус агента: активные задачи, лаг heartbeat, uptime
// Путь только для чтения и работает без блокировок: список задач берется по
// уже загруженным строкам, а лаг вычисляется из временных меток.
app.get("/agent/status", (c) => {
  const now = Date.now();
  const activeTasks = listStaleInProgressTasks().map((t) => {
    const heartbeatAt = t.lastHeartbeatAt ? new Date(t.lastHeartbeatAt).getTime() : null;
    // Фолбэк на updatedAt: задача в работе могла еще ни разу не прислать
    // heartbeat, но она не должна выглядеть "зависшей" вечно.
    const updatedAt = t.updatedAt ? new Date(t.updatedAt).getTime() : now;
    const lagMs = heartbeatAt ? now - heartbeatAt : now - updatedAt;

    return {
      id: t.id,
      title: t.title,
      status: t.status,
      lastHeartbeatAt: t.lastHeartbeatAt,
      heartbeatLagMs: lagMs,
      heartbeatStale: lagMs > 5 * 60 * 1000, // > 5 мин без heartbeat
      updatedAt: t.updatedAt,
    };
  });

  return c.json({
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeTasks,
    activeTaskCount: activeTasks.length,
    staleTasks: activeTasks.filter((t) => t.heartbeatStale).length,
    checkedAt: new Date().toISOString(),
  });
});

// Настройки (передаём значения окружения во фронтенд)
// Обзор строится из окружения процесса, а не из БД: UI должен показывать
// именно то, с чем запущен сервер, даже если запись в настройках отличается.
app.get("/settings", async (c) => {
  return c.json(await buildSettingsOverview());
});

// Маршруты
// Три роутера делят префикс /projects. Порядок регистрации здесь - приоритет
// сопоставления, поэтому projectsRouter стоит первым и не должен перехватывать
// маршруты интеграций.
app.route("/auth", authRouter);
app.route("/participants", participantsRouter);
app.route("/projects", projectsRouter);
app.route("/projects", githubRouter);
app.route("/projects", gitlabRouter);
app.route("/tasks", tasksRouter);
app.route("/chat", chatRouter);
app.route("/settings", settingsRoutes);
app.route("/runtime-profiles", runtimeProfilesRouter);

// Прокси входа Codex OAuth под feature-флагом AIF_ENABLE_CODEX_LOGIN_PROXY.
// Эндпоинт /auth/codex/capabilities регистрируется всегда, чтобы фронтенд
// мог определить доступность функции. Мутирующие маршруты монтируются только
// при включённом флаге.
// Заглушка-роутер вместо полного набора маршрутов: контракт ответа
// сохраняется, и фронтенд не отличается от случая, когда фича выключена
// вовсе, но мутирующие обработчики не существуют.
if (getEnv().AIF_ENABLE_CODEX_LOGIN_PROXY) {
  log.info("Codex login proxy enabled - mounting /auth/codex routes");
  app.route("/auth/codex", codexAuthRouter);
} else {
  log.debug("Codex login proxy disabled - mounting capabilities endpoint only");
  const disabledRouter = new Hono();
  disabledRouter.get("/capabilities", (c) => c.json({ loginProxyEnabled: false }));
  app.route("/auth/codex", disabledRouter);
}

// Инициализация БД и запуск сервера
// Порт читается напрямую из окружения, а не из getEnv(): значение нужно до
// полной валидации, а резервный 3009 совпадает с dev-прокси фронтенда.
const port = Number(process.env.PORT) || 3009;

// Проверяем готовность слоя данных и БД
// Холостое чтение - самый дешевый способ дождаться миграций и открытия файла
// БД. Если база недоступна, процесс упадет до приема трафика.
listProjects();

// Восстанавливаем задачи, оставшиеся в qaStatus:"running" после сбоя/рестарта.
// Иначе атомарный захват QA (tryStartQaRun) блокировал бы им дальнейшие запуски.
// Восстановление выполняет сам слой данных: здесь важно только то, что оно
// происходит ровно один раз при старте, до появления первых запросов.
const recoveredQaRuns = resetStaleQaRuns();
if (recoveredQaRuns > 0) {
  log.warn({ recoveredQaRuns }, "Reset stale running QA runs to error after restart");
}

// Автосоздание глобального runtime-профиля (и общих значений по умолчанию)
// из env при старте. Работает только при AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED=true.
// См. services/profileBootstrap.ts и шаги 3.1+3.3 в gitlab-demo.md.
// Результат различает "выключено" и "выполнено": при выключенном флаге лог не
// пишется вовсе, чтобы не шуметь в обычном локальном запуске.
const bootstrapResult = seedBootstrapRuntimeProfile();
if (bootstrapResult.action !== "disabled") {
  log.info({ ...bootstrapResult }, "Runtime profile bootstrap result");
}
// Индексер Codex создается до listen, но запускается только из onStarted:
// сканирование сессий не должно идти, пока порт не занят и сервер не готов.
const codexIndexService = createCodexIndexService();

const server = startServer({
  fetch: app.fetch,
  port,
  webSocketServer,
  injectWebSocket,
  onStarted() {
    void codexIndexService.start();
  },
  logger: log,
});

// ---------------------------------------------------------------------------
// Корректная остановка: останавливаем индексер Codex, закрываем HTTP-сервер и
// принудительно завершаем WS-клиентов. Иначе соединения держат event loop,
// и следующий перезапуск упирается в EADDRINUSE.
// ---------------------------------------------------------------------------
// Все зависимости передаются сюда явно, а не импортируются внутри обработчика:
// так порядок остановки виден в одном месте, а модуль shutdown остается
// тестируемым без запуска настоящего сервера.
const onShutdown = createGracefulShutdownHandler({
  logger: log,
  stopCodexIndex: () => codexIndexService.stop(),
  closeWebSockets: closeAllWebSocketClients,
  closeServer: () => {
    server.close();
  },
  exitProcess: (code) => {
    process.exit(code);
  },
});

// Два разных сигнала ведут в один обработчик: SIGINT приходит от Ctrl+C, а
// SIGTERM - от Docker и tsx-watch при перезапуске.
process.on("SIGINT", () => {
  void onShutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void onShutdown("SIGTERM");
});

// app и server экспортируются для тестов и для пакета agent: они поднимают
// сервер в собственном процессе, не перезапуская точку входа.
export { app, server };
