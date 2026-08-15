import { Hono, type Context } from "hono";
import { getEnv, logger } from "@aif/shared";
import {
  deleteGitLabRepository,
  findGitLabIssueByTaskId,
  findGitLabRepository,
  findProjectById,
  findTaskById,
  getGitLabIssueReviewFingerprint,
  importGitLabIssueTask,
  listGitLabIssues,
  markGitLabIssueUnavailable,
  recordGitLabRepositorySync,
  setTaskFields,
  updateGitLabMergeRequest,
  updateTaskStatus,
  upsertGitLabRepository,
} from "@aif/data";
import { jsonValidator } from "../middleware/zodValidator.js";
import { gitlabConnectSchema, gitlabPublishSchema, gitlabSyncSchema } from "../schemas.js";
import { callAgentGitPrepare } from "../services/gitlabPrepareBridge.js";
import {
  GitLabApiError,
  GitLabClient,
  findMergeRequestClosingIssue,
  issueIsEligible,
  reviewFingerprint,
  toIssueSnapshot,
} from "../services/gitlab.js";
import type { ParticipantApiEnv } from "../middleware/participantAuth.js";

const log = logger("gitlab-routes");
const REVIEW_MARKER = "<!-- aif-gitlab-review -->";

export const gitlabRouter = new Hono<ParticipantApiEnv>();

// Gate only GitLab-specific paths (/:id/gitlab + /:id/gitlab/*). The router is
// mounted at /projects alongside the GitHub router; a bare use("*") here would
// intercept GitHub requests first and block them whenever GIT_PROVIDER is not
// gitlab. Two patterns are required: Hono's `gitlab*` wildcard does not match
// the bare `/gitlab` path, only its sub-paths.
gitlabRouter.use("/:id/gitlab", async (c, next) => {
  const env = getEnv();
  if (env.GIT_PROVIDER !== "gitlab" || !env.AIF_GITLAB_ISSUE_MR_ENABLED) {
    log.debug(
      { method: c.req.method, path: c.req.path, gitProvider: env.GIT_PROVIDER },
      "GitLab issue-to-MR route blocked by provider selector or rollout flag",
    );
    return c.json({ error: "GitLab issue-to-MR mode is disabled", code: "feature_disabled" }, 403);
  }
  await next();
});
gitlabRouter.use("/:id/gitlab/*", async (c, next) => {
  const env = getEnv();
  if (env.GIT_PROVIDER !== "gitlab" || !env.AIF_GITLAB_ISSUE_MR_ENABLED) {
    log.debug(
      { method: c.req.method, path: c.req.path, gitProvider: env.GIT_PROVIDER },
      "GitLab issue-to-MR route blocked by provider selector or rollout flag",
    );
    return c.json({ error: "GitLab issue-to-MR mode is disabled", code: "feature_disabled" }, 403);
  }
  await next();
});

function tokenFor(envVar: string): string {
  if (!/^GITLAB_[A-Z0-9_]+$/.test(envVar)) {
    throw new GitLabApiError(
      "GitLab token environment variable must use the GITLAB_* prefix",
      400,
      "authentication",
    );
  }
  const token = process.env[envVar]?.trim();
  if (!token)
    throw new GitLabApiError(
      `GitLab token environment variable ${envVar} is not configured`,
      400,
      "authentication",
    );
  return token;
}

function gitlabErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof GitLabApiError)) {
    log.error({ err: error }, "Unexpected GitLab integration failure");
    return c.json({ error: "GitLab integration failed", code: "gitlab_upstream" }, 502);
  }
  const body = {
    error: error.message,
    code: `gitlab_${error.adapterCode}`,
    retryAt: error.retryAt,
  };
  if (
    error.httpStatus === 400 ||
    error.httpStatus === 401 ||
    error.httpStatus === 403 ||
    error.httpStatus === 404 ||
    error.httpStatus === 422 ||
    error.httpStatus === 429
  ) {
    return c.json(body, error.httpStatus);
  }
  return c.json(body, 502);
}

function clientFor(connection: { tokenEnvVar: string }): GitLabClient {
  return new GitLabClient(tokenFor(connection.tokenEnvVar), getEnv().AIF_GITLAB_BASE_URL);
}

gitlabRouter.get("/:id/gitlab", (c) => {
  const projectId = c.req.param("id");
  if (!findProjectById(projectId)) return c.json({ error: "Project not found" }, 404);
  return c.json({
    connection: findGitLabRepository(projectId) ?? null,
    issues: listGitLabIssues(projectId),
  });
});

gitlabRouter.put("/:id/gitlab", jsonValidator(gitlabConnectSchema), async (c) => {
  const projectId = c.req.param("id");
  if (!findProjectById(projectId)) return c.json({ error: "Project not found" }, 404);
  const body = c.req.valid("json");
  const repositoryPath = body.repository.trim().split("/");
  const requestedName = repositoryPath[repositoryPath.length - 1] ?? "";
  const requestedNamespace = repositoryPath.slice(0, -1).join("/");
  try {
    const client = clientFor({ tokenEnvVar: body.tokenEnvVar });
    const remote = await client.getRepository(body.repository);
    const remotePath = remote.path_with_namespace.split("/");
    const connection = upsertGitLabRepository({
      projectId,
      namespace: remotePath.slice(0, -1).join("/") || requestedNamespace,
      name: remotePath[remotePath.length - 1] || requestedName,
      webUrl: remote.web_url,
      defaultBranch: remote.default_branch,
      tokenEnvVar: body.tokenEnvVar,
      eligibility: body.eligibility,
      enabled: body.enabled,
    });
    // Best-effort git-prepare on connect: the agent extracts the default branch
    // and initializes AI Factory files. Failures are logged (not fatal) — the
    // next Sync now re-runs prepare strictly.
    const prepare = await callAgentGitPrepare(projectId, { strict: false });
    if (!prepare.ok) {
      log.warn(
        { projectId, errorCode: prepare.errorCode, error: prepare.error },
        "GitLab git-prepare deferred on connect; Sync now will re-run it strictly",
      );
    }
    return c.json(connection);
  } catch (error) {
    return gitlabErrorResponse(c, error);
  }
});

gitlabRouter.delete("/:id/gitlab", (c) => {
  return deleteGitLabRepository(c.req.param("id"))
    ? c.body(null, 204)
    : c.json({ error: "GitLab connection not found" }, 404);
});

gitlabRouter.post("/:id/gitlab/sync", jsonValidator(gitlabSyncSchema), async (c) => {
  const projectId = c.req.param("id");
  const connection = findGitLabRepository(projectId);
  if (!connection) return c.json({ error: "GitLab connection not found" }, 404);
  if (!connection.enabled)
    return c.json({ imported: 0, updated: 0, skipped: 0, issues: listGitLabIssues(projectId) });

  // First sync (or reconnect) also runs strict git-prepare: extract the default
  // branch + init AI Factory files. On failure, surface the error immediately
  // (task stays blocked) instead of importing issues into a broken repo.
  if (!connection.gitPreparedAt) {
    const prepare = await callAgentGitPrepare(projectId, { strict: true });
    if (!prepare.ok) {
      log.warn(
        { projectId, errorCode: prepare.errorCode, error: prepare.error },
        "GitLab git-prepare failed on sync; aborting import",
      );
      return c.json(
        {
          error: prepare.error ?? "GitLab git-prepare failed",
          code: prepare.errorCode ?? "gitlab_prepare_failed",
        },
        502,
      );
    }
  }

  try {
    const client = clientFor(connection);
    const remoteIssues = await client.listIssues(connection.namespace, connection.name);
    const existingByIid = new Map(listGitLabIssues(projectId).map((issue) => [issue.iid, issue]));
    const hasMrDiscoveryCandidates = remoteIssues.some(
      (issue) =>
        !existingByIid.get(issue.iid)?.mrIid && issueIsEligible(issue, connection.eligibility),
    );
    const openMergeRequests = hasMrDiscoveryCandidates
      ? await client.listMergeRequests(connection.namespace, connection.name)
      : [];
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const synchronizedIids = new Set<number>();
    for (const issue of remoteIssues) {
      const existing = existingByIid.get(issue.iid);
      const eligible = issueIsEligible(issue, connection.eligibility);
      synchronizedIids.add(issue.iid);
      if (!existing?.taskId && !eligible) {
        skipped += 1;
        continue;
      }
      const closingMr = existing?.mrIid
        ? null
        : findMergeRequestClosingIssue(openMergeRequests, issue.iid);
      if (closingMr) {
        log.debug(
          { projectId, iid: issue.iid, mrIid: closingMr.iid },
          "GitLab closing merge request discovered",
        );
      }
      const snapshot = await toIssueSnapshot(client, connection.namespace, connection.name, issue);
      const result = importGitLabIssueTask({
        projectId,
        namespace: connection.namespace,
        repository: connection.name,
        iid: issue.iid,
        globalId: `gid://gitlab/Issue/${issue.id}`,
        webUrl: issue.web_url,
        state: issue.state === "closed" ? "closed" : "open",
        sourceUpdatedAt: issue.updated_at,
        snapshot,
        ...(closingMr
          ? {
              mergeRequest: {
                iid: closingMr.iid,
                url: closingMr.web_url,
                state: "open" as const,
              },
            }
          : {}),
      });
      if (result.created) imported += 1;
      else updated += 1;

      const mrIid = existing?.mrIid ?? closingMr?.iid;
      if (mrIid) {
        const mr =
          closingMr ?? (await client.getMergeRequest(connection.namespace, connection.name, mrIid));
        const approvals = await client.getMergeRequestApprovals(
          connection.namespace,
          connection.name,
          mr.iid,
        );
        const mrState: "open" | "closed" | "merged" =
          mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed";
        const checks = await client.getCommitChecks(connection.namespace, connection.name, mr.sha);
        updateGitLabMergeRequest({
          projectId,
          iid: issue.iid,
          mrIid: mr.iid,
          mrUrl: mr.web_url,
          mrState,
          mrChecksStatus: checks,
          reviewState: approvals.reviewState,
        });
        const task = findTaskById(result.taskId);
        const discoveredMrNeedsDone =
          closingMr && task && task.status !== "done" && task.status !== "verified";
        if (discoveredMrNeedsDone && task) {
          updateTaskStatus(
            task.id,
            "done",
            {},
            { kind: "system", id: "gitlab-sync", displayNameSnapshot: "GitLab Sync" },
          );
        }
        if (task && mrState === "merged" && task.status === "done") {
          updateTaskStatus(
            task.id,
            "verified",
            {},
            { kind: "system", id: "gitlab-sync", displayNameSnapshot: "GitLab Sync" },
          );
        } else if (task && mrState === "closed") {
          setTaskFields(task.id, { paused: true, updatedAt: new Date().toISOString() });
        }
      }
    }
    for (const existing of existingByIid.values()) {
      if (!synchronizedIids.has(existing.iid)) {
        markGitLabIssueUnavailable(
          projectId,
          existing.iid,
          "Issue is no longer available from the connected repository.",
        );
      }
    }
    recordGitLabRepositorySync(projectId, null);
    log.info({ projectId, imported, updated, skipped }, "GitLab issue synchronization completed");
    return c.json({ imported, updated, skipped, issues: listGitLabIssues(projectId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitLab sync failed";
    recordGitLabRepositorySync(projectId, message);
    return gitlabErrorResponse(c, error);
  }
});

gitlabRouter.post(
  "/:id/gitlab/tasks/:taskId/publish",
  jsonValidator(gitlabPublishSchema),
  async (c) => {
    const projectId = c.req.param("id");
    const taskId = c.req.param("taskId");
    const connection = findGitLabRepository(projectId);
    const task = findTaskById(taskId);
    const issue = findGitLabIssueByTaskId(taskId);
    if (!connection || !task || !issue || task.projectId !== projectId) {
      return c.json({ error: "GitLab task linkage not found" }, 404);
    }
    const body = c.req.valid("json");
    const mrDescription = [
      `Closes #${issue.iid}`,
      "## Implementation",
      (body.implementationLog ?? "Implementation completed by AIF.").slice(-20_000),
      "## Test evidence",
      task.planTests
        ? "Tests requested by the implementation plan; see commits and CI checks."
        : "No test task was requested by the implementation plan.",
      "_AIF never merges this merge request; a human owns the final decision._",
    ].join("\n\n");
    try {
      const client = clientFor(connection);
      let mr = issue.mrIid
        ? await client.getMergeRequest(connection.namespace, connection.name, issue.mrIid)
        : await client.findMergeRequest(connection.namespace, connection.name, body.branch);
      if (mr) {
        mr = await client.updateMergeRequest({
          namespace: connection.namespace,
          name: connection.name,
          mrIid: mr.iid,
          title: task.title,
          description: mrDescription,
        });
      } else {
        try {
          mr = await client.createMergeRequest({
            namespace: connection.namespace,
            name: connection.name,
            sourceBranch: body.branch,
            targetBranch: connection.defaultBranch,
            title: task.title,
            description: mrDescription,
          });
        } catch (error) {
          if (!(error instanceof GitLabApiError) || error.httpStatus !== 422) throw error;
          const found = await client.findMergeRequest(
            connection.namespace,
            connection.name,
            body.branch,
          );
          if (!found) throw error;
          mr = await client.updateMergeRequest({
            namespace: connection.namespace,
            name: connection.name,
            mrIid: found.iid,
            title: task.title,
            description: mrDescription,
          });
        }
      }

      const reviewText = body.reviewComments?.trim() ?? "";
      const fingerprint = reviewText ? reviewFingerprint(reviewText) : null;
      if (reviewText && fingerprint !== getGitLabIssueReviewFingerprint(projectId, issue.iid)) {
        await client.upsertMarkerNote({
          namespace: connection.namespace,
          name: connection.name,
          mrIid: mr.iid,
          marker: REVIEW_MARKER,
          body: reviewText.slice(-50_000),
        });
      }
      const [checks, approvals] = await Promise.all([
        client.getCommitChecks(connection.namespace, connection.name, mr.sha),
        client.getMergeRequestApprovals(connection.namespace, connection.name, mr.iid),
      ]);
      const linked = updateGitLabMergeRequest({
        projectId,
        iid: issue.iid,
        mrIid: mr.iid,
        mrUrl: mr.web_url,
        mrState: mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed",
        mrChecksStatus: checks,
        reviewState: approvals.reviewState,
        reviewFingerprint: fingerprint,
      });
      return c.json(linked);
    } catch (error) {
      return gitlabErrorResponse(c, error);
    }
  },
);
