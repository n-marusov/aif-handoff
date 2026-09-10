/**
 * Stage error handler — classifies pipeline errors and applies
 * the appropriate recovery strategy (fast retry, backoff, or revert).
 * Extracted from coordinator.ts for single responsibility.
 */

import type { RuntimeLimitSnapshot } from "@aif/runtime";
import {
  getEnv,
  listWorktrees,
  logger,
  mapSafeRuntimeErrorReason,
  redactProviderTextForLogs,
  type TaskStatus,
} from "@aif/shared";
import { logActivity } from "./hooks.js";
import { AiLoopDetectedError } from "./loopGuard.js";
import {
  findBranchIsolationError,
  findRuntimeExecutionError,
  isExternalFailure,
  isFastRetryableFailure,
  truncateReason,
} from "./errorClassifier.js";
import { getRandomBackoffMinutes } from "./taskWatchdog.js";

const log = logger("stage-error-handler");

type RetryAfterSource = "resetAt" | "retryAfterSeconds" | "random_backoff" | "none";

const NON_RETRYABLE_RUNTIME_CATEGORIES = new Set([
  "model_not_found",
  "context_length",
  "content_filter",
]);

const WORKTREE_SNAPSHOT_MAX = 2_000;

/**
 * Bounded, human-readable snapshot of the git worktree registrations for the
 * project. Attached to branch-isolation failures so an operator can see which
 * folder was holding the branch without having to reproduce the failure.
 */
function buildWorktreeSnapshot(projectRoot: string): string | null {
  try {
    const entries = listWorktrees(projectRoot);
    if (entries.length === 0) return null;
    const rendered = entries
      .map((entry) => {
        const branch = entry.branch ? ` [${entry.branch}]` : entry.detached ? " [detached]" : "";
        const prunable = entry.prunable ? " (prunable)" : "";
        return `${entry.path}${branch}${prunable}`;
      })
      .join("\n");
    return rendered.length > WORKTREE_SNAPSHOT_MAX
      ? `${rendered.slice(0, WORKTREE_SNAPSHOT_MAX)}…[truncated]`
      : rendered;
  } catch {
    return null;
  }
}

export class StageManualBlockError extends Error {
  readonly blockedReason: string;

  constructor(blockedReason: string, message = blockedReason) {
    super(message);
    this.name = "StageManualBlockError";
    this.blockedReason = blockedReason;
  }
}

export type ErrorRecovery =
  | { kind: "fast_retry" }
  | {
      kind: "blocked_external";
      blockedReason: string;
      retryAfter: string | null;
      retryAfterSource: RetryAfterSource;
      retryCount: number;
      limitSnapshot: RuntimeLimitSnapshot | null;
    }
  | { kind: "revert" };

interface StageErrorInput {
  taskId: string;
  stageLabel: string;
  sourceStatus: TaskStatus;
  retryCount: number;
  err: unknown;
}

function findStageManualBlockError(err: unknown): StageManualBlockError | null {
  if (err instanceof StageManualBlockError) return err;
  if (err instanceof Error && "cause" in err && err.cause) {
    return findStageManualBlockError(err.cause);
  }
  return null;
}

function findLoopDetectedError(err: unknown): AiLoopDetectedError | null {
  if (err instanceof AiLoopDetectedError) return err;
  if (err instanceof Error && "cause" in err && err.cause) {
    return findLoopDetectedError(err.cause);
  }
  return null;
}

function buildUserSafeExternalReason(err: unknown): string {
  const runtimeError = findRuntimeExecutionError(err);
  if (!runtimeError) {
    return "Runtime capability check failed. Check the configured runtime profile for this stage.";
  }

  switch (runtimeError.category) {
    case "rate_limit":
      return "Runtime usage limit reached. Task auto-paused until the retry window.";
    case "auth":
      return "Runtime authentication failed. Check the configured runtime profile.";
    case "permission":
      return "Runtime permissions blocked this task. Check the configured runtime profile or approval mode.";
    case "timeout":
      return "Runtime request timed out. Task will retry automatically.";
    case "stream":
      return "Runtime stream failed. Task will retry automatically.";
    case "transport":
    default:
      return "Runtime request failed. Task will retry automatically.";
  }
}

function resolveRetryAfter(err: unknown): {
  retryAfter: string;
  retryAfterSource: RetryAfterSource;
  backoffMinutes: number | null;
  limitSnapshot: RuntimeLimitSnapshot | null;
} {
  const runtimeError = findRuntimeExecutionError(err);
  // When usage-limits feature is disabled, don't persist the limit snapshot
  // onto the task. Retry/backoff still applies — we just skip the surface
  // that feeds the (also-gated) UI.
  const limitSnapshot = getEnv().AIF_USAGE_LIMITS_ENABLED
    ? (runtimeError?.limitSnapshot ?? null)
    : null;

  if (runtimeError?.resetAt) {
    const resetAtMs = Date.parse(runtimeError.resetAt);
    if (Number.isFinite(resetAtMs)) {
      return {
        retryAfter: new Date(Math.max(resetAtMs, Date.now())).toISOString(),
        retryAfterSource: "resetAt",
        backoffMinutes: null,
        limitSnapshot,
      };
    }
  }

  if (
    typeof runtimeError?.retryAfterSeconds === "number" &&
    Number.isFinite(runtimeError.retryAfterSeconds) &&
    runtimeError.retryAfterSeconds >= 0
  ) {
    return {
      retryAfter: new Date(Date.now() + runtimeError.retryAfterSeconds * 1000).toISOString(),
      retryAfterSource: "retryAfterSeconds",
      backoffMinutes: null,
      limitSnapshot,
    };
  }

  const backoffMinutes = getRandomBackoffMinutes();
  return {
    retryAfter: new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
    retryAfterSource: "random_backoff",
    backoffMinutes,
    limitSnapshot,
  };
}

/**
 * Classify a stage error and return the recovery strategy + status fields.
 * The caller is responsible for applying the status update.
 */
export function classifyStageError(input: StageErrorInput): ErrorRecovery {
  const { taskId, stageLabel, sourceStatus, err } = input;

  const manualBlockErr = findStageManualBlockError(err);
  if (manualBlockErr) {
    logActivity(
      taskId,
      "Agent",
      `coordinator moved to blocked_external from ${sourceStatus} at ${stageLabel}; retryAfter=manual; source=none; reason=${truncateReason(manualBlockErr.blockedReason)}`,
    );

    log.warn(
      {
        taskId,
        stage: stageLabel,
        errorName: manualBlockErr.name,
      },
      "Subagent stage requested manual block",
    );

    return {
      kind: "blocked_external",
      blockedReason: manualBlockErr.blockedReason,
      retryAfter: null,
      retryAfterSource: "none",
      retryCount: input.retryCount ?? 0,
      limitSnapshot: null,
    };
  }

  const loopErr = findLoopDetectedError(err);
  if (loopErr) {
    const blockedReason = `possible_loop: ${loopErr.reason} (${loopErr.count}/${loopErr.limit})`;
    logActivity(
      taskId,
      "Agent",
      `coordinator moved to blocked_external from ${sourceStatus} at ${stageLabel}; retryAfter=manual; source=none; reason=${truncateReason(blockedReason)}`,
    );

    log.error(
      {
        taskId,
        stage: stageLabel,
        loopReason: loopErr.reason,
        count: loopErr.count,
        limit: loopErr.limit,
        retryAfter: null,
      },
      "Subagent stage aborted due to detected tool-call loop, task requires manual action",
    );

    return {
      kind: "blocked_external",
      blockedReason,
      retryAfter: null,
      retryAfterSource: "none",
      retryCount: input.retryCount ?? 0,
      limitSnapshot: null,
    };
  }

  // Branch / worktree isolation failures must NEVER fall into the generic
  // revert path — generic revert triggers unbounded re-planning on a
  // corrupted work tree. Pin the task to blocked_external with no retry so
  // an operator inspects dirty changes, missing branches, or drift.
  const branchErr = findBranchIsolationError(err);
  if (branchErr) {
    const blockedReason = `Branch isolation failure (${branchErr.kind}): ${branchErr.message}`;
    logActivity(
      taskId,
      "Agent",
      `coordinator moved to blocked_external from ${sourceStatus} at ${stageLabel}; retryAfter=manual; source=none; reason=${truncateReason(blockedReason)}`,
    );
    log.error(
      {
        taskId,
        stage: stageLabel,
        branchKind: branchErr.kind,
        branchName: branchErr.branchName,
        projectRoot: branchErr.projectRoot,
        // Git stderr is safe to keep in logs (no provider text); the worktree
        // snapshot is what makes "branch already checked out elsewhere"
        // diagnosable instead of a bare kind code.
        errorMessage: branchErr.message,
        worktreeSnapshot: buildWorktreeSnapshot(branchErr.projectRoot),
      },
      "Subagent stage aborted due to branch isolation failure",
    );
    return {
      kind: "blocked_external",
      blockedReason,
      retryAfter: null,
      retryAfterSource: "none",
      retryCount: input.retryCount ?? 0,
      limitSnapshot: null,
    };
  }

  const runtimeError = findRuntimeExecutionError(err);
  if (runtimeError && NON_RETRYABLE_RUNTIME_CATEGORIES.has(runtimeError.category)) {
    const safeReason = mapSafeRuntimeErrorReason(runtimeError);
    const blockedReason = `${safeReason.reason} Manual action required before retry.`;
    const limitSnapshot = getEnv().AIF_USAGE_LIMITS_ENABLED
      ? (runtimeError.limitSnapshot ?? null)
      : null;

    logActivity(
      taskId,
      "Agent",
      `coordinator moved to blocked_external from ${sourceStatus} at ${stageLabel}; retryAfter=manual; source=none; reason=${truncateReason(blockedReason)}`,
    );

    log.error(
      {
        taskId,
        stage: stageLabel,
        retryAfter: null,
        retryAfterSource: "none",
        runtimeCategory: runtimeError.category,
        errorName: err instanceof Error ? err.name : typeof err,
        errorMessage:
          err instanceof Error
            ? redactProviderTextForLogs(err.message)
            : redactProviderTextForLogs(String(err)),
      },
      "Subagent failed with non-retryable runtime error, task requires manual action",
    );

    return {
      kind: "blocked_external",
      blockedReason,
      retryAfter: null,
      retryAfterSource: "none",
      retryCount: input.retryCount ?? 0,
      limitSnapshot,
    };
  }

  if (isFastRetryableFailure(err)) {
    const reason = err instanceof Error ? err.message : String(err);

    log.warn(
      { taskId, stage: stageLabel, reason },
      "Subagent hit transient stream interruption, scheduling fast retry",
    );

    return { kind: "fast_retry" };
  }

  if (isExternalFailure(err)) {
    const { retryAfter, retryAfterSource, backoffMinutes, limitSnapshot } = resolveRetryAfter(err);
    const reason = err instanceof Error ? err.message : String(err);
    const blockedReason = buildUserSafeExternalReason(err);
    const runtimeError = findRuntimeExecutionError(err);

    if (reason.trim() && reason.trim() !== blockedReason) {
      log.debug(
        {
          taskId,
          stage: stageLabel,
          safeReason: blockedReason,
          rawReason: redactProviderTextForLogs(reason),
        },
        "Redacted runtime error details before persisting blocked task state",
      );
    }

    if (retryAfterSource === "random_backoff") {
      log.warn(
        {
          taskId,
          stage: stageLabel,
          retryAfter,
          backoffMinutes,
          runtimeId: limitSnapshot?.runtimeId ?? null,
          providerId: limitSnapshot?.providerId ?? null,
          profileId: limitSnapshot?.profileId ?? null,
        },
        "Structured reset metadata missing for external error, falling back to random backoff",
      );
    }

    logActivity(
      taskId,
      "Agent",
      `coordinator moved to blocked_external from ${sourceStatus} at ${stageLabel}; retryAfter=${retryAfter}; source=${retryAfterSource}; reason=${truncateReason(blockedReason)}`,
    );

    log.error(
      {
        taskId,
        stage: stageLabel,
        retryAfter,
        retryAfterSource,
        backoffMinutes,
        runtimeId: limitSnapshot?.runtimeId ?? null,
        providerId: limitSnapshot?.providerId ?? null,
        profileId: limitSnapshot?.profileId ?? null,
        resetAt: runtimeError?.resetAt ?? null,
        retryAfterSeconds: runtimeError?.retryAfterSeconds ?? null,
        errorName: err instanceof Error ? err.name : typeof err,
        errorMessage: redactProviderTextForLogs(reason),
      },
      "Subagent failed with external error, task blocked with backoff",
    );

    return {
      kind: "blocked_external",
      blockedReason,
      retryAfter,
      retryAfterSource,
      retryCount: (input.retryCount ?? 0) + 1,
      limitSnapshot,
    };
  }

  log.error(
    {
      taskId,
      stage: stageLabel,
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage:
        err instanceof Error
          ? redactProviderTextForLogs(err.message)
          : redactProviderTextForLogs(String(err)),
    },
    "Subagent failed, reverting status",
  );

  return { kind: "revert" };
}
