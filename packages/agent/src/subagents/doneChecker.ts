import {
  findGitHubIssueByTaskId,
  findGitLabIssueByTaskId,
  findTaskById,
  updateTaskStatus,
} from "@aif/data";
import { CLEAN_STATE_RESET, logger } from "@aif/shared";
import { logActivity } from "../hooks.js";
import { notifyTaskBroadcast } from "../notifier.js";

const log = logger("done-checker");

/**
 * Check if the task's linked PR/MR is merged or approved, and if so,
 * auto-transition from `done` to `accepted`.
 *
 * This runs as a self-loop stage in the PIPELINE (like plan-checker):
 *   - If the PR is merged or review-approved → transition to `accepted`
 *   - If not → no-op, stay in `done`, try again on the next poll cycle
 *
 * Also checks the task's VCS-synced review comments for an `/approve`
 * command as an alternative approval signal.
 */
export async function runDoneChecker(taskId: string, _projectRoot: string): Promise<void> {
  const task = findTaskById(taskId);
  if (!task) {
    log.error({ taskId }, "Task not found for done-checker");
    return;
  }

  // Only act on tasks in `done` status with an AI execution owner.
  if (task.status !== "done" || task.executionOwner !== "ai") {
    return;
  }

  const githubIssue = findGitHubIssueByTaskId(taskId);
  const gitlabIssue = findGitLabIssueByTaskId(taskId);

  // Check merge/approval state
  const merged = githubIssue?.prState === "merged" || gitlabIssue?.mrState === "merged" || false;
  const reviewApproved =
    githubIssue?.reviewState === "approved" || gitlabIssue?.reviewState === "approved" || false;

  // Check for /approve command in VCS review comments (synced from PR/MR)
  const approveCommandFound =
    (task.planReviewFeedback?.trim() ?? "").toLowerCase().includes("/approve") ||
    (task.reviewComments?.trim() ?? "").toLowerCase().includes("/approve") ||
    false;

  if (!merged && !reviewApproved && !approveCommandFound) {
    log.debug(
      { taskId, prState: githubIssue?.prState ?? null, mrState: gitlabIssue?.mrState ?? null },
      "Done-checker: PR not yet merged or approved, staying in done",
    );
    return;
  }

  log.info(
    {
      taskId,
      merged,
      reviewApproved,
      approveCommandFound,
      prNumber: githubIssue?.prNumber ?? null,
      mrIid: gitlabIssue?.iid ?? null,
    },
    "Done-checker: PR/MR approved, transitioning done \u2192 accepted",
  );

  const now = new Date().toISOString();
  logActivity(
    taskId,
    "Agent",
    merged
      ? `[${now}] [done-checker] PR/MR merged; auto-accepting task`
      : reviewApproved
        ? `[${now}] [done-checker] PR/MR review approved; auto-accepting task`
        : `[${now}] [done-checker] /approve comment detected; auto-accepting task`,
  );

  updateTaskStatus(taskId, "accepted", CLEAN_STATE_RESET, {
    kind: "agent",
    id: "done-checker",
    displayNameSnapshot: "Done Checker",
  });

  void notifyTaskBroadcast(taskId, "task:moved", {
    title: task.title,
    fromStatus: "done",
    toStatus: "accepted",
  });
  void notifyTaskBroadcast(taskId, "task:updated", {
    title: task.title,
    fromStatus: "done",
    toStatus: "accepted",
  });
}
