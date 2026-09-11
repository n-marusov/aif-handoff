import { Hono, type Context } from "hono";
import { getEnv, logger } from "@aif/shared";
import {
  deleteGitHubRepository,
  findGitHubIssueByTaskId,
  findGitHubRepository,
  findProjectById,
  findTaskById,
  getGitHubIssueReviewFingerprint,
  importGitHubIssueTask,
  listGitHubIssues,
  markGitHubIssueUnavailable,
  markTaskPlanApproved,
  markTaskPlanChangesRequested,
  recordGitHubRepositorySync,
  setTaskFields,
  updateGitHubPullRequest,
  updateGitHubPullRequestLastReviewId,
  updateGitHubPullRequestMode,
  updateTaskStatus,
  upsertGitHubRepository,
} from "@aif/data";
import { jsonValidator } from "../middleware/zodValidator.js";
import {
  requestWorktreeCleanupAfterMerge,
  snapshotTaskWorktree,
} from "../services/agentInternal.js";
import {
  githubConnectSchema,
  githubPlanPublishSchema,
  githubPublishSchema,
  githubSyncSchema,
} from "../schemas.js";
import {
  GitHubApiError,
  GitHubClient,
  findPullRequestClosingIssue,
  issueIsEligible,
  latestReviewState,
  reviewFingerprint,
  toIssueSnapshot,
} from "../services/github.js";
import type { ParticipantApiEnv } from "../middleware/participantAuth.js";

const log = logger("github-routes");
const REVIEW_MARKER = "<!-- aif-github-review -->";

export const githubRouter = new Hono<ParticipantApiEnv>();

// Gate only GitHub-specific paths (/:id/github + /:id/github/*). The router is
// mounted at /projects alongside the GitLab router; a bare use("*") here would
// intercept GitLab requests first and block them whenever GIT_PROVIDER is not
// github. Two patterns are required: Hono's `github*` wildcard does not match
// the bare `/github` path, only its sub-paths.
githubRouter.use("/:id/github", async (c, next) => {
  if (getEnv().GIT_PROVIDER !== "github" || !getEnv().AIF_GITHUB_ISSUE_PR_ENABLED) {
    log.debug(
      { method: c.req.method, path: c.req.path },
      "GitHub issue-to-PR route blocked by provider selector or rollout flag",
    );
    return c.json({ error: "GitHub issue-to-PR mode is disabled", code: "feature_disabled" }, 403);
  }
  await next();
});
githubRouter.use("/:id/github/*", async (c, next) => {
  if (getEnv().GIT_PROVIDER !== "github" || !getEnv().AIF_GITHUB_ISSUE_PR_ENABLED) {
    log.debug(
      { method: c.req.method, path: c.req.path },
      "GitHub issue-to-PR route blocked by provider selector or rollout flag",
    );
    return c.json({ error: "GitHub issue-to-PR mode is disabled", code: "feature_disabled" }, 403);
  }
  await next();
});

function tokenFor(envVar: string): string {
  if (!/^GITHUB_[A-Z0-9_]+$/.test(envVar)) {
    throw new GitHubApiError(
      "GitHub token environment variable must use the GITHUB_* prefix",
      400,
      "authentication",
    );
  }
  const token = process.env[envVar]?.trim();
  if (!token)
    throw new GitHubApiError(
      `GitHub token environment variable ${envVar} is not configured`,
      400,
      "authentication",
    );
  return token;
}

function githubErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof GitHubApiError)) {
    log.error({ err: error }, "Unexpected GitHub integration failure");
    return c.json({ error: "GitHub integration failed", code: "github_upstream" }, 502);
  }
  const body = {
    error: error.message,
    code: `github_${error.adapterCode}`,
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

githubRouter.get("/:id/github", (c) => {
  const projectId = c.req.param("id");
  if (!findProjectById(projectId)) return c.json({ error: "Project not found" }, 404);
  return c.json({
    connection: findGitHubRepository(projectId) ?? null,
    issues: listGitHubIssues(projectId),
  });
});

githubRouter.put("/:id/github", jsonValidator(githubConnectSchema), async (c) => {
  const projectId = c.req.param("id");
  if (!findProjectById(projectId)) return c.json({ error: "Project not found" }, 404);
  const body = c.req.valid("json");
  const [owner, repository] = body.repository.split("/") as [string, string];
  try {
    const remote = await new GitHubClient(tokenFor(body.tokenEnvVar)).getRepository(
      owner,
      repository,
    );
    const connection = upsertGitHubRepository({
      projectId,
      owner: remote.owner.login,
      name: remote.name,
      htmlUrl: remote.html_url,
      defaultBranch: remote.default_branch,
      tokenEnvVar: body.tokenEnvVar,
      eligibility: body.eligibility,
      enabled: body.enabled,
    });
    return c.json(connection);
  } catch (error) {
    return githubErrorResponse(c, error);
  }
});

githubRouter.delete("/:id/github", (c) => {
  return deleteGitHubRepository(c.req.param("id"))
    ? c.body(null, 204)
    : c.json({ error: "GitHub connection not found" }, 404);
});

githubRouter.post("/:id/github/sync", jsonValidator(githubSyncSchema), async (c) => {
  const projectId = c.req.param("id");
  const connection = findGitHubRepository(projectId);
  if (!connection) return c.json({ error: "GitHub connection not found" }, 404);
  if (!connection.enabled)
    return c.json({ imported: 0, updated: 0, skipped: 0, issues: listGitHubIssues(projectId) });

  try {
    const client = new GitHubClient(tokenFor(connection.tokenEnvVar));
    const remoteIssues = await client.listIssues(connection.owner, connection.name);
    const existingByNumber = new Map(
      listGitHubIssues(projectId).map((issue) => [issue.issueNumber, issue]),
    );
    const hasPullDiscoveryCandidates = remoteIssues.some(
      (issue) =>
        !existingByNumber.get(issue.number)?.prNumber &&
        issueIsEligible(issue, connection.eligibility),
    );
    const openPulls = hasPullDiscoveryCandidates
      ? await client.listOpenPullRequests(connection.owner, connection.name)
      : [];
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const synchronizedNumbers = new Set<number>();
    for (const issue of remoteIssues) {
      const existing = existingByNumber.get(issue.number);
      const eligible = issueIsEligible(issue, connection.eligibility);
      synchronizedNumbers.add(issue.number);
      if (!existing?.taskId && !eligible) {
        skipped += 1;
        continue;
      }
      const closingPull = existing?.prNumber
        ? null
        : findPullRequestClosingIssue(openPulls, issue.number);
      if (closingPull) {
        log.debug(
          { projectId, issueNumber: issue.number, prNumber: closingPull.number },
          "GitHub closing pull request discovered",
        );
      }
      const snapshot = await toIssueSnapshot(client, connection.owner, connection.name, issue);
      const result = importGitHubIssueTask({
        projectId,
        owner: connection.owner,
        repository: connection.name,
        issueNumber: issue.number,
        nodeId: issue.node_id,
        htmlUrl: issue.html_url,
        state: issue.state,
        sourceUpdatedAt: issue.updated_at,
        snapshot,
        ...(closingPull
          ? {
              pullRequest: {
                number: closingPull.number,
                url: closingPull.html_url,
                state: "open" as const,
              },
            }
          : {}),
      });
      if (result.created) imported += 1;
      else updated += 1;

      const prNumber = existing?.prNumber ?? closingPull?.number;
      if (prNumber) {
        const pull =
          closingPull ?? (await client.getPullRequest(connection.owner, connection.name, prNumber));
        const reviews = await client.listReviews(connection.owner, connection.name, prNumber);
        const review = latestReviewState(reviews);
        // Fallback: when the PR author cannot officially approve (GitHub
        // restriction), a COMMENTED review body containing "/approve" acts
        // as a lightweight approval signal.
        const approveComment = reviews
          .filter((r) => r.state === "COMMENTED" && r.body?.includes("/approve"))
          .sort((left, right) =>
            (right.submitted_at ?? "").localeCompare(left.submitted_at ?? ""),
          )[0];
        const effectiveReviewState = approveComment ? "approved" : review.state;
        const effectiveReviewId = approveComment ? approveComment.id : review.id;
        const prState = pull.merged_at ? "merged" : pull.state;
        const checks = await client.getCommitChecks(
          connection.owner,
          connection.name,
          pull.head.sha,
        );
        updateGitHubPullRequest({
          projectId,
          issueNumber: issue.number,
          prNumber: pull.number,
          prUrl: pull.html_url,
          prState,
          prChecksStatus: checks,
          reviewState: effectiveReviewState,
          // lastReviewId is deliberately NOT set here — the plan review
          // approval check below must succeed before we record the review
          // ID, otherwise a transient failure in markTaskPlanApproved
          // would permanently prevent retry on the next sync cycle.
        });
        let task = findTaskById(result.taskId);
        const discoveredPullNeedsDone =
          closingPull && task && task.status !== "done" && task.status !== "verified";
        if (discoveredPullNeedsDone && task) {
          updateTaskStatus(
            task.id,
            "done",
            {},
            { kind: "system", id: "github-sync", displayNameSnapshot: "GitHub Sync" },
          );
          task = findTaskById(result.taskId);
        }
        if (task && prState === "merged" && task.status === "done") {
          const verifiedTask = task;
          updateTaskStatus(
            task.id,
            "verified",
            {},
            { kind: "system", id: "github-sync", displayNameSnapshot: "GitHub Sync" },
          );
          // Lifecycle close-out: drop the worktree, keep the branch.
          await requestWorktreeCleanupAfterMerge(
            snapshotTaskWorktree(
              verifiedTask,
              findProjectById(verifiedTask.projectId)?.rootPath ?? null,
            ),
            `PR #${pull.number}`,
          );
        } else if (task && prState === "closed" && !pull.merged_at) {
          setTaskFields(task.id, { paused: true, updatedAt: new Date().toISOString() });
        } else if (
          task &&
          review.state === "changes_requested" &&
          review.id !== existing?.lastReviewId &&
          task.status === "done"
        ) {
          updateTaskStatus(
            task.id,
            "implementing",
            {
              reworkRequested: true,
              reviewComments: review.body ?? task.reviewComments,
              autoQueueCommitStatus: "pending",
              autoQueueCommitBaseSha: task.commitSha,
              commitSha: null,
              autoQueueCommitError: null,
              autoQueueCommitCompletedAt: null,
            },
            { kind: "system", id: "github-review", displayNameSnapshot: "GitHub Review" },
          );
        } else if (
          task &&
          task.status === "plan_review" &&
          existing?.prMode === "plan_review" &&
          effectiveReviewId !== null &&
          effectiveReviewId !== (existing?.lastReviewId ?? null)
        ) {
          // Plan-review gate: an approved plan PR/MR is the only event allowed
          // to move the task into implementing; a changes-requested review
          // sends it back to planning for replanning on the same branch/PR.
          // A COMMENTED review containing "/approve" is treated as approval.
          if (effectiveReviewState === "approved") {
            const approved = markTaskPlanApproved({
              taskId: task.id,
              actor: {
                kind: "system",
                id: "github-sync",
                displayNameSnapshot: "GitHub Sync",
              },
            });
            if (approved.ok) {
              // Record the review ID only after a successful transition
              // so a transient failure does not block retry on the next sync.
              updateGitHubPullRequestLastReviewId({
                projectId,
                issueNumber: issue.number,
                lastReviewId: effectiveReviewId,
              });
              log.info(
                {
                  taskId: task.id,
                  issueNumber: issue.number,
                  prNumber: pull.number,
                  reviewId: effectiveReviewId,
                  viaComment: Boolean(approveComment),
                },
                "GitHub plan review approved; task resumed at implementing",
              );
            } else {
              log.error(
                {
                  taskId: task.id,
                  issueNumber: issue.number,
                  prNumber: pull.number,
                  reviewId: effectiveReviewId,
                  code: approved.code,
                  currentStatus: approved.currentStatus ?? null,
                },
                "markTaskPlanApproved failed; task will retry on next sync",
              );
            }
          } else if (effectiveReviewState === "changes_requested") {
            const feedback =
              review.body && review.body.trim().length > 0 ? review.body : task.planReviewFeedback;
            const requested = markTaskPlanChangesRequested({
              taskId: task.id,
              feedback,
              actor: {
                kind: "system",
                id: "github-review",
                displayNameSnapshot: "GitHub Review",
              },
            });
            if (requested.ok) {
              updateGitHubPullRequestLastReviewId({
                projectId,
                issueNumber: issue.number,
                lastReviewId: effectiveReviewId,
              });
              log.info(
                {
                  taskId: task.id,
                  issueNumber: issue.number,
                  prNumber: pull.number,
                  reviewId: effectiveReviewId,
                  feedbackLength: feedback?.length ?? 0,
                },
                "GitHub plan review requested changes; task returned to planning",
              );
            } else {
              log.error(
                {
                  taskId: task.id,
                  issueNumber: issue.number,
                  prNumber: pull.number,
                  reviewId: effectiveReviewId,
                  code: requested.code,
                  currentStatus: requested.currentStatus ?? null,
                },
                "markTaskPlanChangesRequested failed; task will retry on next sync",
              );
            }
          }
        } else if (
          task &&
          task.status === "plan_review" &&
          effectiveReviewId !== null &&
          effectiveReviewId === (existing?.lastReviewId ?? null)
        ) {
          log.debug(
            {
              taskId: task.id,
              issueNumber: issue.number,
              prNumber: pull.number,
              reviewId: effectiveReviewId,
              reviewState: effectiveReviewState,
            },
            "GitHub plan review event already processed; skipping",
          );
        }
      }
    }
    for (const existing of existingByNumber.values()) {
      if (!synchronizedNumbers.has(existing.issueNumber)) {
        markGitHubIssueUnavailable(
          projectId,
          existing.issueNumber,
          "Issue is no longer available from the connected repository.",
        );
      }
    }
    recordGitHubRepositorySync(projectId, null);
    log.info({ projectId, imported, updated, skipped }, "GitHub issue synchronization completed");
    return c.json({ imported, updated, skipped, issues: listGitHubIssues(projectId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub sync failed";
    recordGitHubRepositorySync(projectId, message);
    return githubErrorResponse(c, error);
  }
});

githubRouter.post(
  "/:id/github/tasks/:taskId/publish",
  jsonValidator(githubPublishSchema),
  async (c) => {
    const projectId = c.req.param("id");
    const taskId = c.req.param("taskId");
    const connection = findGitHubRepository(projectId);
    const task = findTaskById(taskId);
    const issue = findGitHubIssueByTaskId(taskId);
    if (!connection || !task || !issue || task.projectId !== projectId) {
      return c.json({ error: "GitHub task linkage not found" }, 404);
    }
    const body = c.req.valid("json");
    const approvedPlanSummary = [
      task.planReviewCommitSha
        ? `Approved plan commit: ${task.planReviewCommitSha}`
        : "Approved plan commit: not recorded",
      task.planReviewPublishedAt
        ? `Plan published at: ${task.planReviewPublishedAt}`
        : "Plan published at: not recorded",
      task.planReviewApprovedAt
        ? `Plan approved at: ${task.planReviewApprovedAt}`
        : "Plan approved at: not recorded",
    ].join("\n");
    const prBody = [
      "<!-- aif:pr-mode=implementation -->",
      "## Approved plan",
      approvedPlanSummary,
      `Closes #${issue.issueNumber}`,
      "## Implementation",
      (body.implementationLog ?? "Implementation completed by AIF.").slice(-20_000),
      "## Test evidence",
      task.planTests
        ? "Tests requested by the implementation plan; see commits and CI checks."
        : "No test task was requested by the implementation plan.",
      "_AIF never merges this pull request; a human owns the final decision._",
    ].join("\n\n");
    try {
      const client = new GitHubClient(tokenFor(connection.tokenEnvVar));
      let pull = issue.prNumber
        ? await client.getPullRequest(connection.owner, connection.name, issue.prNumber)
        : await client.findPullRequest(connection.owner, connection.name, body.branch);
      if (pull) {
        pull = await client.updatePullRequest({
          owner: connection.owner,
          repository: connection.name,
          prNumber: pull.number,
          title: task.title,
          body: prBody,
        });
      } else {
        try {
          pull = await client.createPullRequest({
            owner: connection.owner,
            repository: connection.name,
            title: task.title,
            body: prBody,
            head: body.branch,
            base: connection.defaultBranch,
          });
        } catch (error) {
          if (!(error instanceof GitHubApiError) || error.httpStatus !== 422) throw error;
          pull = await client.findPullRequest(connection.owner, connection.name, body.branch);
          if (!pull) throw error;
        }
      }

      const reviewText = body.reviewComments?.trim() ?? "";
      const fingerprint = reviewText ? reviewFingerprint(reviewText) : null;
      if (
        reviewText &&
        fingerprint !== getGitHubIssueReviewFingerprint(projectId, issue.issueNumber)
      ) {
        await client.upsertMarkerComment({
          owner: connection.owner,
          repository: connection.name,
          issueNumber: pull.number,
          marker: REVIEW_MARKER,
          body: reviewText.slice(-50_000),
        });
      }
      const checks = await client.getCommitChecks(connection.owner, connection.name, pull.head.sha);
      const updated = updateGitHubPullRequest({
        projectId,
        issueNumber: issue.issueNumber,
        prNumber: pull.number,
        prUrl: pull.html_url,
        prState: pull.merged_at ? "merged" : pull.state,
        prChecksStatus: checks,
        reviewState: "pending",
        reviewFingerprint: fingerprint,
      });
      const linked =
        updateGitHubPullRequestMode(projectId, issue.issueNumber, "implementation") ?? updated;
      return c.json(linked);
    } catch (error) {
      return githubErrorResponse(c, error);
    }
  },
);

/**
 * Publish (or update) the Change Plan PR for an issue-linked task. The task is
 * left in plan_review until a human approves the PR. Body carries the plan
 * review marker and deliberately omits `Closes #...` — the issue must stay
 * open until the final implementation PR is published.
 */
githubRouter.post(
  "/:id/github/tasks/:taskId/publish-plan",
  jsonValidator(githubPlanPublishSchema),
  async (c) => {
    const projectId = c.req.param("id");
    const taskId = c.req.param("taskId");
    const connection = findGitHubRepository(projectId);
    const task = findTaskById(taskId);
    const issue = findGitHubIssueByTaskId(taskId);
    if (!connection || !task || !issue || task.projectId !== projectId) {
      return c.json({ error: "GitHub task linkage not found" }, 404);
    }
    const body = c.req.valid("json");
    const planText = (task.plan ?? "").trim();
    const prBody = [
      "<!-- aif:pr-mode=plan_review -->",
      "## Change Plan",
      planText.length > 0 ? planText.slice(-50_000) : "_No plan text recorded._",
      "## How to approve",
      "Approve this pull request to start implementation. Request changes to ask the agent to revise the plan — comments are fed back to the planner.",
      "_AIF never merges this pull request; a human owns the final decision._",
    ].join("\n\n");
    try {
      const client = new GitHubClient(tokenFor(connection.tokenEnvVar));
      let pull = issue.prNumber
        ? await client.getPullRequest(connection.owner, connection.name, issue.prNumber)
        : await client.findPullRequest(connection.owner, connection.name, body.branch);
      if (pull) {
        pull = await client.updatePullRequest({
          owner: connection.owner,
          repository: connection.name,
          prNumber: pull.number,
          title: task.title,
          body: prBody,
        });
      } else {
        try {
          pull = await client.createPullRequest({
            owner: connection.owner,
            repository: connection.name,
            title: task.title,
            body: prBody,
            head: body.branch,
            base: connection.defaultBranch,
          });
        } catch (error) {
          if (!(error instanceof GitHubApiError) || error.httpStatus !== 422) throw error;
          pull = await client.findPullRequest(connection.owner, connection.name, body.branch);
          if (!pull) throw error;
        }
      }

      const checks = await client.getCommitChecks(connection.owner, connection.name, pull.head.sha);
      updateGitHubPullRequest({
        projectId,
        issueNumber: issue.issueNumber,
        prNumber: pull.number,
        prUrl: pull.html_url,
        prState: pull.merged_at ? "merged" : pull.state,
        prChecksStatus: checks,
        reviewState: "pending",
      });
      const linked = updateGitHubPullRequestMode(projectId, issue.issueNumber, "plan_review");
      return c.json(linked);
    } catch (error) {
      return githubErrorResponse(c, error);
    }
  },
);
