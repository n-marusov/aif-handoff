import {
  appendTaskActivityLog,
  findGitHubIssueByTaskId,
  findGitLabIssueByTaskId,
  findTaskById,
  markTaskPlanPublished,
} from "@aif/data";
import { getEnv, getHeadCommitSha, logger } from "@aif/shared";
import { ensurePlanReviewCommit } from "./planReviewCommit.js";
import { publishGitHubPlanTask } from "./githubWorkflow.js";
import { publishGitLabPlanTask } from "./gitlabWorkflow.js";
import { StageManualBlockError } from "./stageErrorHandler.js";

const log = logger("plan-review:publisher");

/**
 * True when a VCS issue-linked task must stop at `plan_review` and wait for a
 * human approval PR/MR review before implementation may start. Only issue
 * links from the enabled provider modes qualify; purely local tasks keep the
 * legacy local flow. Reads the rollout flag and current linkage live so tests
 * can toggle both.
 */
export function taskRequiresPlanReview(taskId: string): boolean {
  const env = getEnv();
  if (!env.AIF_PLAN_REVIEW_PR_ENABLED) return false;
  return Boolean(findGitHubIssueByTaskId(taskId) ?? findGitLabIssueByTaskId(taskId));
}

/**
 * Publish the Change Plan for a plan-review task and leave it waiting in
 * `plan_review` until a human approves it in the VCS.
 *
 * Responsibilities (in order):
 *  1. Reject tasks that are not plan-review eligible (they stay `plan_ready`
 *     and keep the legacy flow).
 *  2. Deterministically commit only the plan file(s) with a non-LLM subject
 *     (ensurePlanReviewCommit) — never product files.
 *  3. Delegate the branch push + provider plan PR/MR publication to the
 *     provider workflow (GitHub/GitLab), which must not add `Closes #...`.
 *  4. Record `planReviewState=published` and transition `plan_ready ->
 *     plan_review` atomically via markTaskPlanPublished (audited).
 *
 * Missing branch/plan is a WARN-only deferral — the task stays `plan_ready`
 * for a later retry. Push or API failures throw StageManualBlockError so the
 * coordinator moves the task to blocked_external for operator attention.
 */
export async function runPlanReviewPublisher(taskId: string, projectRoot: string): Promise<void> {
  const task = findTaskById(taskId);
  if (!task) {
    log.error({ taskId }, "Plan review publish skipped: task not found");
    throw new Error(`Task ${taskId} not found`);
  }
  if (!taskRequiresPlanReview(taskId)) {
    log.debug(
      { taskId, status: task.status, planReviewState: task.planReviewState ?? null },
      "Plan review publish skipped: task is not VCS-linked or the feature flag is off",
    );
    return;
  }

  const executionRoot = task.worktreePath ?? projectRoot;
  const branch = task.branchName;
  if (!branch) {
    log.warn(
      { taskId, projectRoot, executionRoot },
      "Plan review publish deferred: task has no persisted branch yet",
    );
    return;
  }

  // Deterministic plan-only commit. Rejects dirty product files before
  // approval so plan review never accidentally ships implementation work.
  const report = ensurePlanReviewCommit({ taskId, projectRoot: executionRoot });
  if (report.status === "blocked_missing_plan") {
    log.warn(
      { taskId, executionRoot, planPath: report.planPath },
      "Plan review publish deferred: plan file is missing",
    );
    return;
  }
  if (
    report.status === "blocked_dirty_product_files" ||
    report.status === "not_a_git_repo" ||
    report.status === "commit_failed"
  ) {
    log.error(
      {
        taskId,
        status: report.status,
        executionRoot,
        dirtyProductPaths: report.dirtyProductPaths,
        error: report.error ?? null,
      },
      "Plan review publish blocked before branch push",
    );
    throw new StageManualBlockError(
      `Plan review publish blocked (${report.status}). Inspect the work tree and retry.`,
    );
  }
  const commitSha = report.commitSha ?? getHeadCommitSha(executionRoot);

  const githubIssue = findGitHubIssueByTaskId(taskId);
  const gitlabIssue = findGitLabIssueByTaskId(taskId);

  let published: boolean;
  if (githubIssue) {
    published = await publishGitHubPlanTask(taskId, projectRoot);
  } else if (gitlabIssue) {
    published = await publishGitLabPlanTask(taskId, projectRoot);
  } else {
    log.debug({ taskId }, "Plan review publish skipped: issue link disappeared before publish");
    return;
  }

  if (!published) {
    log.warn(
      { taskId, branch, provider: githubIssue ? "github" : "gitlab" },
      "Plan review publish did not complete; task stays at plan_ready",
    );
    return;
  }

  const now = new Date().toISOString();
  appendTaskActivityLog(
    taskId,
    `[${now}] [plan-review] Published change plan on ${branch} (${commitSha}) for review`,
  );
  const result = markTaskPlanPublished({ taskId, commitSha });
  if (!result.ok) {
    log.error(
      { taskId, code: result.code, currentStatus: result.currentStatus ?? null },
      "Failed to mark task plan as published",
    );
    throw new StageManualBlockError(
      `Plan review publish finished but the status transition failed (${result.code}).`,
    );
  }
  log.info(
    {
      taskId,
      branch,
      commitSha,
      githubIssue: Boolean(githubIssue),
      gitlabIssue: Boolean(gitlabIssue),
    },
    "Change plan published for review",
  );
}
