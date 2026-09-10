import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  clearDanglingVcsIssueLinks,
  findTaskById,
  listActiveTasksWithWorktrees,
  listProjects,
  setTaskFields,
  updateTaskStatus,
} from "@aif/data";
import {
  ensureTaskWorktree,
  isWorktreeUsable,
  listWorktrees,
  logger,
  pruneWorktrees,
  removeWorktreeForce,
  resolveWorktreeRoot,
} from "@aif/shared";
import { withProjectGitLock } from "./gitOperationLock.js";
import { stashAndRemoveWorktree } from "./worktreeLifecycle.js";

const log = logger("worktree-reconcile");

export interface ReconcileWorktreesInput {
  projectId: string;
  projectRoot: string;
  reason: string;
}

export interface ReconcileWorktreesSummary {
  scanned: number;
  removed: number;
  repaired: number;
  adoptedLegacy: number;
  danglingLinksCleared: number;
}

function normalizePath(value: string): string {
  return resolve(value)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function isUnderWorktreeRoot(candidate: string, worktreeRoot: string): boolean {
  const normalizedRoot = resolve(worktreeRoot)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
  return normalizePath(candidate).startsWith(`${normalizedRoot}${sep}`);
}

function parkTask(taskId: string, reason: string): void {
  const task = findTaskById(taskId);
  try {
    updateTaskStatus(
      taskId,
      "blocked_external",
      {
        blockedReason: reason,
        blockedFromStatus: task?.status ?? null,
        retryAfter: null,
      },
      {
        kind: "system",
        id: "worktree-reconcile",
        displayNameSnapshot: "Worktree reconciliation",
      },
    );
    log.error({ taskId, reason }, "Parked task as blocked_external after reconciliation failure");
  } catch (error) {
    log.error(
      { taskId, reason, err: error instanceof Error ? error.message : String(error) },
      "Failed to park task after reconciliation failure",
    );
  }
}

/**
 * Reconcile the DB (declared source of truth for worktrees) with the folders on
 * disk and the VCS issue links:
 *
 *  - remove + prune worktrees no live task references (the incident's root
 *    cause: an ownerless worktree holding a branch);
 *  - drop unhealthy registrations (folder deleted / `.git` link gone) so they
 *    stop holding a branch hostage;
 *  - recreate a missing or unusable folder for a live task at its canonical
 *    path, else park it blocked_external;
 *  - clear dangling `github_issues`/`gitlab_issues` task links.
 *
 * Best-effort: a failure here must never crash the poll cycle.
 */
export async function reconcileWorktrees(
  input: ReconcileWorktreesInput,
): Promise<ReconcileWorktreesSummary> {
  const { projectId, projectRoot, reason } = input;
  let scanned = 0;
  let removed = 0;
  let repaired = 0;
  let adoptedLegacy = 0;

  const activeTasks = listActiveTasksWithWorktrees(projectId);
  const referencedPaths = new Set(activeTasks.map((task) => normalizePath(task.worktreePath)));
  const referencedBranches = new Set(
    activeTasks
      .map((task) => task.branchName)
      .filter((branch): branch is string => Boolean(branch)),
  );
  const { worktreeRoot } = resolveWorktreeRoot(projectRoot);

  for (const entry of listWorktrees(projectRoot)) {
    if (!isUnderWorktreeRoot(entry.path, worktreeRoot)) continue;
    scanned += 1;
    if (referencedPaths.has(normalizePath(entry.path))) continue;

    // A live task's branch may be mid-provisioning (folder created before the
    // row was persisted). Never remove a worktree that belongs to a live branch.
    if (entry.branch && referencedBranches.has(entry.branch)) {
      adoptedLegacy += 1;
      log.warn(
        { projectId, projectRoot, worktreePath: entry.path, branch: entry.branch },
        "Retaining worktree whose branch belongs to a live task (provisioning window)",
      );
      continue;
    }

    const healthy = !entry.prunable && isWorktreeUsable(entry.path, entry.branch);
    if (!healthy) {
      // A stale registration (missing folder, broken `.git` link) holds the
      // branch hostage and cannot be stashed. Drop it so the next provision can
      // check the branch out again.
      const forceRemoved = await withProjectGitLock(
        { projectRoot, operation: "reconcile-remove-unhealthy" },
        () => removeWorktreeForce(projectRoot, entry.path),
      );
      const prunedRegistrations = await withProjectGitLock(
        { projectRoot, operation: "reconcile-prune" },
        () => pruneWorktrees(projectRoot),
      );
      const registrationCleared =
        forceRemoved || !listWorktrees(projectRoot).some((item) => item.path === entry.path);
      if (registrationCleared) removed += 1;
      log.warn(
        {
          projectId,
          projectRoot,
          worktreePath: entry.path,
          branch: entry.branch,
          prunable: entry.prunable,
          forceRemoved,
          prunedRegistrations,
          registrationCleared,
        },
        registrationCleared
          ? "Removed unhealthy worktree registration"
          : "Could not remove unhealthy worktree registration; manual cleanup required",
      );
      continue;
    }

    const result = await stashAndRemoveWorktree({
      taskId: `orphan:${entry.path}`,
      projectId,
      projectRoot,
      branchName: entry.branch,
      worktreePath: entry.path,
      reason: `reconcile_orphan:${reason}`,
    });
    if (result.cleaned) {
      removed += 1;
      log.warn(
        { projectId, projectRoot, worktreePath: entry.path, branch: entry.branch },
        "Removed orphan worktree not referenced by any live task",
      );
    }
  }

  for (const task of activeTasks) {
    if (isWorktreeUsable(task.worktreePath, task.branchName)) continue;

    // Missing folder OR a folder that is no longer a usable checkout (a stale
    // registration left behind by a failed/partial removal). Drop stale
    // registrations first so the branch is free, then provision the CANONICAL
    // branch-scoped worktree instead of resurrecting a poisoned legacy path.
    const recordedPath = task.worktreePath;
    const recordedPathExists = existsSync(recordedPath);
    const prunedRegistrations = await withProjectGitLock(
      { projectRoot, operation: "reconcile-prune" },
      () => pruneWorktrees(projectRoot),
    );
    log.warn(
      {
        taskId: task.id,
        recordedWorktreePath: recordedPath,
        recordedPathExists,
        branchName: task.branchName,
        prunedRegistrations,
      },
      "Task worktree is missing or unusable; provisioning a fresh canonical worktree",
    );

    const title = findTaskById(task.id)?.title ?? task.id;
    try {
      const result = await withProjectGitLock({ projectRoot, operation: "reconcile-repair" }, () =>
        ensureTaskWorktree({
          projectRoot,
          taskId: task.id,
          title,
          projectId,
          explicitBranchName: task.branchName,
        }),
      );
      if (result.worktreePath) {
        setTaskFields(task.id, {
          worktreePath: result.worktreePath,
          updatedAt: new Date().toISOString(),
        });
        repaired += 1;
        log.warn(
          {
            taskId: task.id,
            previousWorktreePath: recordedPath,
            worktreePath: result.worktreePath,
          },
          "Repaired task worktree",
        );
      } else {
        parkTask(
          task.id,
          `Worktree ${recordedPath} is missing or unusable and could not be recreated (${
            result.reason ?? "unknown reason"
          }).`,
        );
      }
    } catch (error) {
      const manualHint = recordedPathExists
        ? ` Leftover folder at ${recordedPath} may still hold the branch; remove it or run 'git worktree prune'.`
        : "";
      parkTask(
        task.id,
        `Worktree ${recordedPath} is missing or unusable and recreation failed: ${
          error instanceof Error ? error.message : String(error)
        }.${manualHint}`,
      );
    }
  }

  const { githubLinksCleared, gitlabLinksCleared } = clearDanglingVcsIssueLinks();
  const danglingLinksCleared = githubLinksCleared + gitlabLinksCleared;

  const summary: ReconcileWorktreesSummary = {
    scanned,
    removed,
    repaired,
    adoptedLegacy,
    danglingLinksCleared,
  };
  log.info({ projectId, projectRoot, reason, ...summary }, "Worktree reconciliation completed");
  return summary;
}

/**
 * Run reconciliation for every project. Best-effort per project so one bad repo
 * cannot abort the whole sweep (or the poll cycle that triggered it).
 */
export async function reconcileAllProjectWorktrees(reason: string): Promise<void> {
  for (const project of listProjects()) {
    if (!project.rootPath) continue;
    try {
      await reconcileWorktrees({
        projectId: project.id,
        projectRoot: project.rootPath,
        reason,
      });
    } catch (error) {
      log.error(
        {
          projectId: project.id,
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        "Worktree reconciliation failed for project; continuing",
      );
    }
  }
}
