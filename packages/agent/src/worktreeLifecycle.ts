import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { countOtherLiveTasksReferencingWorktree } from "@aif/data";
import { logger, workingTreeClean } from "@aif/shared";
import { withProjectGitLock } from "./gitOperationLock.js";

const log = logger("worktree-lifecycle");

export interface StashAndRemoveWorktreeInput {
  taskId: string;
  projectId: string;
  projectRoot: string;
  branchName: string | null;
  worktreePath: string | null;
  /** Free-form reason recorded in the stash message and logs. */
  reason: string;
}

export interface StashAndRemoveWorktreeResult {
  cleaned: boolean;
  reason?: string;
  skippedDueToReference?: boolean;
  /** SHA of the stash created for uncommitted work (null when the tree was clean). */
  stashSha?: string | null;
}

function runGit(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: stdout.trim(), stderr: "" };
  } catch (err) {
    const error = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      status: typeof error.status === "number" ? error.status : 1,
      stdout: error.stdout ? error.stdout.toString().trim() : "",
      stderr: error.stderr ? error.stderr.toString().trim() : String(err),
    };
  }
}

/**
 * Snapshot → stash → reference check → remove → prune a task worktree.
 *
 * Ordering is deliberate: uncommitted work is stashed (never destroyed) BEFORE
 * the folder is removed, and removal is refused when another live task still
 * references the same folder. The branch is intentionally left in place — an
 * open PR/MR may still need it.
 */
export async function stashAndRemoveWorktree(
  input: StashAndRemoveWorktreeInput,
): Promise<StashAndRemoveWorktreeResult> {
  const { taskId, projectId, projectRoot, branchName, worktreePath, reason } = input;

  log.info(
    { taskId, branchName, worktreePath, step: "snapshot", reason },
    "Worktree cleanup requested",
  );

  if (!worktreePath) {
    log.warn({ taskId, reason }, "Worktree cleanup skipped: task has no recorded worktree");
    return { cleaned: false, reason: "no_worktree" };
  }

  if (!existsSync(worktreePath)) {
    log.warn(
      { taskId, branchName, worktreePath },
      "Worktree cleanup skipped: folder no longer exists; pruning stale registrations",
    );
    await withProjectGitLock({ projectRoot, operation: "worktree-prune" }, () =>
      runGit(projectRoot, ["worktree", "prune"]),
    );
    return { cleaned: false, reason: "worktree_missing" };
  }

  const references = countOtherLiveTasksReferencingWorktree({
    projectId,
    branchName,
    worktreePath,
    excludeTaskId: taskId,
  });
  log.info(
    { taskId, branchName, worktreePath, step: "reference_check", references },
    "Worktree reference check completed",
  );
  if (references > 0) {
    log.warn(
      { taskId, branchName, worktreePath, references },
      "Worktree cleanup skipped: another live task references the same worktree",
    );
    return { cleaned: false, reason: "referenced_by_live_task", skippedDueToReference: true };
  }

  return withProjectGitLock({ projectRoot, operation: "worktree-cleanup" }, () => {
    let stashSha: string | null = null;

    if (workingTreeClean(worktreePath)) {
      log.info(
        { taskId, branchName, worktreePath, step: "stash", stashSha: null },
        "Worktree already clean; skipping stash",
      );
    } else {
      const stashMessage = `aif task ${taskId} cleanup: ${reason}`;
      const stashResult = runGit(worktreePath, ["stash", "push", "-u", "-m", stashMessage]);
      if (stashResult.status !== 0) {
        log.error(
          {
            taskId,
            branchName,
            worktreePath,
            step: "stash",
            stderr: stashResult.stderr,
          },
          "Worktree cleanup aborted: stash failed; worktree not removed",
        );
        return { cleaned: false, reason: "stash_failed" };
      }
      const shaResult = runGit(worktreePath, ["rev-parse", "refs/stash"]);
      stashSha = shaResult.status === 0 && shaResult.stdout ? shaResult.stdout : null;
      log.info(
        { taskId, branchName, worktreePath, step: "stash", stashSha },
        "Stashed uncommitted worktree changes",
      );
    }

    const removeResult = runGit(projectRoot, ["worktree", "remove", "--force", worktreePath]);
    if (removeResult.status !== 0) {
      log.error(
        { taskId, branchName, worktreePath, step: "remove", stderr: removeResult.stderr },
        "Worktree removal failed",
      );
      return { cleaned: false, reason: "remove_failed", stashSha };
    }
    log.info(
      { taskId, branchName, worktreePath, step: "remove", stashSha },
      "Removed task worktree",
    );

    const pruneResult = runGit(projectRoot, ["worktree", "prune"]);
    if (pruneResult.status !== 0) {
      log.warn(
        { taskId, step: "prune", stderr: pruneResult.stderr },
        "Worktree prune failed (best-effort)",
      );
    } else {
      log.info(
        { taskId, branchName, worktreePath, step: "prune", stashSha },
        "Pruned worktree registrations",
      );
    }

    return { cleaned: true, stashSha };
  });
}
