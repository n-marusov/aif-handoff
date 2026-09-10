import { getEnv, logger } from "@aif/shared";

const log = logger("agent-internal");

export interface WorktreeCleanupRequest {
  taskId: string;
  projectId: string;
  projectRoot: string;
  branchName: string | null;
  worktreePath: string | null;
  reason: string;
}

export interface AgentWorktreeCleanupResult {
  ok: boolean;
  cleaned?: boolean;
  skippedDueToReference?: boolean;
  stashSha?: string | null;
  /** Machine-readable reason for a no-op/skip. */
  reason?: string;
  /** Set on structured failures (agent error body or transport failure). */
  errorCode?: string;
  error?: string;
}

function internalApiHeaders(): Record<string, string> {
  const token = getEnv().INTERNAL_BROADCAST_TOKEN?.trim() ?? "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-Internal-Broadcast-Token"] = token;
  }
  return headers;
}

/** Absolute URL for an agent-internal route, honoring `AGENT_INTERNAL_URL`. */
export function buildAgentInternalUrl(path: string): string {
  const baseUrl = getEnv().AGENT_INTERNAL_URL.replace(/\/$/, "");
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Ask the agent to snapshot, stash, and remove a task worktree. The git side
 * effect must run in the agent process (which owns the working tree); the API
 * only orchestrates, so this stays an HTTP bridge rather than an import.
 *
 * Callers treat this as best-effort: a delete/merge must not fail because the
 * agent is briefly unreachable.
 */
export async function callAgentWorktreeCleanup(
  input: WorktreeCleanupRequest,
  options: { timeoutMs?: number } = {},
): Promise<AgentWorktreeCleanupResult> {
  const url = buildAgentInternalUrl("/worktrees/cleanup");
  const timeoutMs = options.timeoutMs ?? 60_000;

  log.debug(
    {
      taskId: input.taskId,
      projectId: input.projectId,
      worktreePath: input.worktreePath,
      reason: input.reason,
    },
    "Requesting agent worktree cleanup",
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: internalApiHeaders(),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(
      {
        taskId: input.taskId,
        status: null,
        code: "agent_internal_unavailable",
        reason: input.reason,
        err: message,
      },
      "Agent worktree cleanup call failed (unreachable)",
    );
    return { ok: false, errorCode: "agent_internal_unavailable", error: message };
  }

  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    cleaned?: boolean;
    skippedDueToReference?: boolean;
    stashSha?: string | null;
    reason?: string;
    code?: string;
    error?: string;
  } | null;

  if (!response.ok) {
    const errorCode = payload?.code ?? "worktree_cleanup_failed";
    const error = payload?.error ?? `Agent worktree cleanup failed with status ${response.status}`;
    log.warn(
      { taskId: input.taskId, status: response.status, code: errorCode, reason: input.reason },
      "Agent worktree cleanup failed",
    );
    return { ok: false, cleaned: false, errorCode, error };
  }

  log.debug(
    {
      taskId: input.taskId,
      cleaned: payload?.cleaned ?? false,
      skippedDueToReference: payload?.skippedDueToReference ?? false,
    },
    "Agent worktree cleanup completed",
  );
  return {
    ok: true,
    cleaned: payload?.cleaned ?? false,
    skippedDueToReference: payload?.skippedDueToReference ?? false,
    stashSha: payload?.stashSha ?? null,
    reason: payload?.reason,
  };
}

export interface TaskWorktreeSnapshot {
  taskId: string;
  projectId: string;
  projectRoot: string | null;
  branchName: string | null;
  worktreePath: string | null;
}

/** Capture a task's git identity before a transition can mutate or clear it. */
export function snapshotTaskWorktree(
  task: { id: string; projectId: string; branchName?: string | null; worktreePath?: string | null },
  projectRoot: string | null,
): TaskWorktreeSnapshot {
  return {
    taskId: task.id,
    projectId: task.projectId,
    projectRoot,
    branchName: task.branchName ?? null,
    worktreePath: task.worktreePath ?? null,
  };
}

/**
 * Best-effort worktree cleanup right after a merged PR/MR moves a task to
 * `verified`. The branch is retained (the PR/MR may still reference it); only
 * the folder and its registration are removed. Never throws — a merge
 * transition must not fail because the agent is briefly unreachable.
 */
export async function requestWorktreeCleanupAfterMerge(
  snapshot: TaskWorktreeSnapshot,
  reference: string,
): Promise<void> {
  if (!snapshot.worktreePath || !snapshot.projectRoot) {
    log.warn(
      { taskId: snapshot.taskId, reference },
      "Worktree cleanup after merge skipped: no worktree recorded",
    );
    return;
  }
  log.info(
    { taskId: snapshot.taskId, reference, worktreePath: snapshot.worktreePath },
    "Worktree cleanup requested after merge",
  );
  try {
    const result = await callAgentWorktreeCleanup({
      taskId: snapshot.taskId,
      projectId: snapshot.projectId,
      projectRoot: snapshot.projectRoot,
      branchName: snapshot.branchName,
      worktreePath: snapshot.worktreePath,
      reason: `pr_merge:${reference}`,
    });
    if (!result.ok) {
      log.warn(
        { taskId: snapshot.taskId, reference, code: result.errorCode, reason: result.reason },
        "Worktree cleanup after merge did not complete",
      );
    }
  } catch (error) {
    log.warn(
      { taskId: snapshot.taskId, reference, err: error },
      "Worktree cleanup after merge threw; transition already applied",
    );
  }
}
