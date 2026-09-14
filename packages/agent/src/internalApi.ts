import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { getEnv, logger } from "@aif/shared";
import { RepositoryPrepareError, type RepositoryProvider } from "./repositoryPrepare.js";
import { prepareGitLabRepositoryForProject } from "./gitlabPrepare.js";
import { prepareGitHubRepositoryForProject } from "./githubPrepare.js";
import { stashAndRemoveWorktree } from "./worktreeLifecycle.js";

const log = logger("agent-internal-api");

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
   * Extra Hono sub-apps to mount on the same server (e.g. the codex login
   * broker) so AGENT_INTERNAL_URL serves all agent-internal routes on one port.
   */
  mountApps?: Hono[];
}

function isAuthorized(c: { req: { header(name: string): string | undefined } }): boolean {
  const token = getEnv().INTERNAL_BROADCAST_TOKEN?.trim();
  if (!token) return true; // no token configured → trust internal network
  const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const headerToken = c.req.header("X-Internal-Broadcast-Token") ?? "";
  return bearer === token || headerToken === token;
}

/**
 * Structured prepare failure as reported by the agent. Classification relies on
 * the structured `kind` / `projectId` fields only — never on message text — and
 * the HTTP code is composed from the provider known by the route.
 */
interface StructuredPrepareFailure {
  kind: string;
  projectId: string;
  message: string;
}

function asPrepareFailure(error: unknown): StructuredPrepareFailure | null {
  if (error instanceof RepositoryPrepareError) {
    return { kind: error.kind, projectId: error.projectId, message: error.message };
  }
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
 * Mount the provider-specific prepare endpoint. GitHub and GitLab share the
 * request/response contract; only the provider and the prepare implementation
 * differ, and the structured error code is namespaced by provider.
 */
function mountPrepareRoute(
  app: Hono,
  provider: RepositoryProvider,
  run: (projectId: string) => { gitPreparedAt: string },
): void {
  app.post(`/${provider}/prepare`, async (c) => {
    let body: { projectId?: string };
    try {
      body = (await c.req.json()) as { projectId?: string };
    } catch {
      return c.json({ error: "Invalid JSON body", code: "invalid_body" }, 400);
    }
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

  app.use("*", async (c, next) => {
    if (!isAuthorized(c)) {
      log.warn({ path: c.req.path }, "Unauthorized agent-internal API request");
      return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  mountWorktreeCleanupRoute(app);

  mountPrepareRoute(app, "gitlab", prepareGitLabRepositoryForProject);
  mountPrepareRoute(app, "github", prepareGitHubRepositoryForProject);

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
      return c.json({ error: "Worktree cleanup failed", code: "worktree_cleanup_internal" }, 500);
    }
  });
}

export function startInternalApi(options: StartInternalApiOptions = {}): InternalApiServer {
  const port = options.port ?? AGENT_INTERNAL_API_PORT;
  const host = options.host ?? "0.0.0.0";
  const app = createInternalApiApp();
  for (const subApp of options.mountApps ?? []) {
    app.route("/", subApp);
  }
  const server = serve({ fetch: app.fetch, port, hostname: host });
  // When port 0 is requested, Node picks an ephemeral port — expose the actual one.
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
