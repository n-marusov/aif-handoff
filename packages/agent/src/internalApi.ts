import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { getEnv, logger } from "@aif/shared";
import { GitLabPrepareError, prepareGitLabRepositoryForProject } from "./gitlabPrepare.js";
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

function gitlabPrepareErrorResponse(c: Context, error: GitLabPrepareError) {
  log.warn(
    { projectId: error.projectId, kind: error.kind, err: error.message },
    "GitLab prepare failed",
  );
  return c.json(
    {
      error: error.message,
      code: `gitlab_prepare_${error.kind}`,
      projectId: error.projectId,
    },
    422,
  );
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

  app.post("/gitlab/prepare", async (c) => {
    let body: { projectId?: string };
    try {
      body = (await c.req.json()) as { projectId?: string };
    } catch {
      return c.json({ error: "Invalid JSON body", code: "invalid_body" }, 400);
    }
    if (!body.projectId) {
      return c.json({ error: "projectId is required", code: "invalid_body" }, 400);
    }

    log.info({ projectId: body.projectId }, "GitLab prepare requested");
    try {
      const result = prepareGitLabRepositoryForProject(body.projectId);
      log.info({ projectId: body.projectId }, "GitLab prepare completed");
      return c.json({ ok: true, gitPreparedAt: result.gitPreparedAt });
    } catch (error) {
      if (error instanceof GitLabPrepareError) {
        return gitlabPrepareErrorResponse(c, error);
      }
      log.error({ projectId: body.projectId, err: error }, "Unexpected GitLab prepare failure");
      return c.json({ error: "GitLab prepare failed", code: "gitlab_prepare_internal" }, 500);
    }
  });

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
