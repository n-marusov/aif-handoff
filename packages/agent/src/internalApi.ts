/**
 * Внутренний HTTP API агента (по умолчанию порт 3010, AGENT_INTERNAL_URL).
 *
 * Зачем отдельный сервер, а не общий REST API: здесь живут операции, которые
 * должны выполняться на машине агента - подготовка git-репозитория в рабочем
 * каталоге, удаление worktree и синхронизация сабмодулей. Перенести их в API
 * нельзя, потому что файловая система у них другая.
 *
 * Инварианты и подводные камни:
 * - Авторизация включается только при заданном INTERNAL_BROADCAST_TOKEN. Пустой
 *   токен означает доверие внутренней сети; это осознанный режим локальной
 *   разработки, а не забытая проверка.
 * - Коды ошибок собираются из структурных полей kind и projectId, а не из текста
 *   сообщения: текст меняется и локализуется, а разбор по подстрокам уже ломался.
 * - Внутренние детали наружу не отдаются: только обобщённый код вида
 *   provider_prepare_internal, всё остальное идёт в лог агента.
 * - Разбор JSON вынесен в try/catch до бизнес-логики, чтобы битое тело давало
 *   явный 400 invalid_body, а не 500 из недр фреймворка.
 */
import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { getEnv, logger } from "@aif/shared";
import { RepositoryPrepareError, type RepositoryProvider } from "./repositoryPrepare.js";
import { prepareGitLabRepositoryForProject } from "./gitlabPrepare.js";
import { prepareGitHubRepositoryForProject } from "./githubPrepare.js";
import { stashAndRemoveWorktree } from "./worktreeLifecycle.js";
import { syncProjectSubmodules } from "./submoduleSync.js";

const log = logger("agent-internal-api");

// Фиксированный порт нужен, чтобы API-сервер и Docker заранее знали адрес агента
// без дополнительного service discovery.
export const AGENT_INTERNAL_API_PORT = 3010;

export interface InternalApiServer {
  server: ServerType;
  port: number;
  host: string;
  close(): Promise<void>;
}

export interface StartInternalApiOptions {
  port?: number;
  host?: string;
  /**
   * Дополнительные Hono-подприложения на этом же сервере (например, broker
   * логина codex), чтобы AGENT_INTERNAL_URL обслуживал все внутренние маршруты на одном порту.
   */
  mountApps?: Hono[];
}

function isAuthorized(c: { req: { header(name: string): string | undefined } }): boolean {
  const token = getEnv().INTERNAL_BROADCAST_TOKEN?.trim();
  // Нет токена - нет проверки: внутренняя сеть доверенная. trim() нужен, чтобы
  // строка из одних пробелов не выглядела как настроенный токен.
  if (!token) return true; // токен не настроен → доверяем внутренней сети
  // Принимаем два вида передачи: стандартный Bearer и отдельный внутренний
  // заголовок, который удобнее прокидывать через прокси и сайдкары.
  const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const headerToken = c.req.header("X-Internal-Broadcast-Token") ?? "";
  return bearer === token || headerToken === token;
}

/**
 * Структурированный сбой подготовки от агента. Классификация опирается только на
 * поля `kind` / `projectId` — никогда на текст сообщения — а HTTP-код
 * формируется из провайдера, известного маршруту.
 */
interface StructuredPrepareFailure {
  kind: string;
  projectId: string;
  message: string;
}

function asPrepareFailure(error: unknown): StructuredPrepareFailure | null {
  // Штатный путь: исключение собственного типа с готовыми структурными полями.
  if (error instanceof RepositoryPrepareError) {
    return { kind: error.kind, projectId: error.projectId, message: error.message };
  }
  // Запасной путь: ошибка пришла как обычный объект (например, из внешнего
  // процесса). Проверяем только строковые kind и projectId - без этого нельзя
  // гарантировать, что ответ будет размечен корректно.
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { kind?: unknown }).kind === "string" &&
    typeof (error as { projectId?: unknown }).projectId === "string"
  ) {
    const candidate = error as { kind: string; projectId: string; message?: unknown };
    return {
      kind: candidate.kind,
      projectId: candidate.projectId,
      // Контракт ответа требует поле message, поэтому вместо undefined
      // подставляем нейтральную заглушку.
      message:
        typeof candidate.message === "string" ? candidate.message : "Repository prepare failed",
    };
  }
  return null;
}

function repositoryPrepareErrorResponse(
  c: Context,
  failure: StructuredPrepareFailure,
  provider: RepositoryProvider,
) {
  log.warn(
    { projectId: failure.projectId, provider, kind: failure.kind, err: failure.message },
    "Repository prepare failed",
  );
  return c.json(
    {
      error: failure.message,
      code: `${provider}_prepare_${failure.kind}`,
      projectId: failure.projectId,
    },
    422,
  );
}

/**
 * Монтирует endpoint подготовки конкретного провайдера. GitHub и GitLab делят
 * контракт запроса/ответа; различаются только провайдер и реализация подготовки,
 * а структурированный код ошибки получает пространство имён провайдера.
 */
function mountPrepareRoute(
  app: Hono,
  provider: RepositoryProvider,
  run: (projectId: string) => { gitPreparedAt: string },
): void {
  app.post(`/${provider}/prepare`, async (c) => {
    let body: { projectId?: string };
    // Разбор тела отдельно от обработки: невалидный JSON - это 400, а не 500.
    try {
      body = (await c.req.json()) as { projectId?: string };
    } catch {
      return c.json({ error: "Invalid JSON body", code: "invalid_body" }, 400);
    }
    // Валидация до вызова run(): подготовка репозитория - тяжёлая операция, и
    // запускать её на запросе без идентификатора проекта бессмысленно.
    if (!body.projectId) {
      return c.json({ error: "projectId is required", code: "invalid_body" }, 400);
    }

    log.info({ projectId: body.projectId, provider }, "Repository prepare requested");
    try {
      const result = run(body.projectId);
      log.info({ projectId: body.projectId, provider }, "Repository prepare completed");
      return c.json({ ok: true, gitPreparedAt: result.gitPreparedAt });
    } catch (error) {
      const failure = asPrepareFailure(error);
      if (failure) {
        return repositoryPrepareErrorResponse(c, failure, provider);
      }
      // Неопознанная ошибка: наружу отдаём только обобщённый код по провайдеру,
      // чтобы не утечь деталями внутренней реализации.
      log.error(
        { projectId: body.projectId, provider, err: error },
        "Unexpected repository prepare failure",
      );
      return c.json(
        { error: "Repository prepare failed", code: `${provider}_prepare_internal` },
        500,
      );
    }
  });
}

export function createInternalApiApp(): Hono {
  const app = new Hono();

  // Единая авторизационная заглушка на все маршруты: проверка стоит до роутинга
  // и не дублируется внутри mount*-функций, иначе легко забыть её на новой ручке.
  app.use("*", async (c, next) => {
    if (!isAuthorized(c)) {
      log.warn({ path: c.req.path }, "Unauthorized agent-internal API request");
      return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Каждый маршрут монтируется отдельной функцией: контракт одной ручки не должен
  // раздувать createInternalApiApp и мешать тестам поднимать приложение целиком.
  mountWorktreeCleanupRoute(app);

  mountPrepareRoute(app, "gitlab", prepareGitLabRepositoryForProject);
  mountPrepareRoute(app, "github", prepareGitHubRepositoryForProject);

  mountSubmoduleSyncRoute(app);

  return app;
}

interface WorktreeCleanupBody {
  taskId?: string;
  projectId?: string;
  projectRoot?: string;
  branchName?: string | null;
  worktreePath?: string | null;
  reason?: string;
}

function mountWorktreeCleanupRoute(app: Hono): void {
  app.post("/worktrees/cleanup", async (c) => {
    let body: WorktreeCleanupBody;
    // Тело разбирается до очистки: удаление worktree по неполному запросу может
    // снести не тот каталог.
    try {
      body = (await c.req.json()) as WorktreeCleanupBody;
    } catch {
      return c.json({ error: "Invalid JSON body", code: "invalid_body" }, 400);
    }
    if (!body.taskId || !body.projectId || !body.projectRoot) {
      return c.json(
        { error: "taskId, projectId and projectRoot are required", code: "invalid_body" },
        400,
      );
    }

    const reason = body.reason?.trim() || "unspecified";
    // Причина нужна для журнала активности задачи: по ней потом видно, почему
    // worktree был убран (освобождение ресурсов, отмена, ошибка стадии).
    log.info(
      { taskId: body.taskId, worktreePath: body.worktreePath ?? null, reason },
      "Worktree cleanup requested",
    );
    try {
      const result = await stashAndRemoveWorktree({
        taskId: body.taskId,
        projectId: body.projectId,
        projectRoot: body.projectRoot,
        branchName: body.branchName ?? null,
        worktreePath: body.worktreePath ?? null,
        reason,
      });
      return c.json({ ok: true, ...result });
    } catch (error) {
      log.error({ taskId: body.taskId, err: error }, "Worktree cleanup failed");
      // Внутренняя ошибка не детализируется: наружу достаточно кода, а стек и
      // причина уже попали в лог агента.
      return c.json({ error: "Worktree cleanup failed", code: "worktree_cleanup_internal" }, 500);
    }
  });
}

interface SubmoduleSyncBody {
  projectId?: string;
}

function mountSubmoduleSyncRoute(app: Hono): void {
  app.post("/submodules/sync", async (c) => {
    let body: SubmoduleSyncBody;
    try {
      body = (await c.req.json()) as SubmoduleSyncBody;
    } catch {
      return c.json({ error: "Invalid JSON body", code: "invalid_body" }, 400);
    }
    if (!body.projectId) {
      return c.json({ error: "projectId is required", code: "invalid_body" }, 400);
    }

    log.info({ projectId: body.projectId }, "Submodule sync requested");
    // Синхронизация возвращает собственный результат, а не исключение: частичный
    // успех (не все сабмодули инициализированы) должен доехать до вызывающего,
    // иначе он не сможет решить, надо ли повторять.
    const result = syncProjectSubmodules(body.projectId);
    log.info(
      { projectId: body.projectId, ok: result.ok, initialized: result.submodulesInitialized },
      "Submodule sync completed",
    );
    return c.json(result);
  });
}

export function startInternalApi(options: StartInternalApiOptions = {}): InternalApiServer {
  const port = options.port ?? AGENT_INTERNAL_API_PORT;
  const host = options.host ?? "0.0.0.0";
  const app = createInternalApiApp();
  // Дополнительные приложения (например, брокер логина Codex) монтируются на тот
  // же порт: у агента должен быть один внутренний адрес, иначе конфигурация
  // клиентов и прокси разрастается.
  for (const subApp of options.mountApps ?? []) {
    app.route("/", subApp);
  }
  const server = serve({ fetch: app.fetch, port, hostname: host });
  // При запросе порта 0 Node выбирает эфемерный порт — покажем фактический.
  // Порт 0 используется в тестах: реальный номер выбирает ОС, поэтому его надо
  // прочитать из server.address() и вернуть наружу - иначе тест не узнает адрес.
  const boundPort =
    port === 0 && typeof server.address === "function"
      ? ((server.address() as { port: number } | null)?.port ?? port)
      : port;
  log.info({ host, port: boundPort }, "Agent internal API listening");
  return {
    server,
    port: boundPort,
    host,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
