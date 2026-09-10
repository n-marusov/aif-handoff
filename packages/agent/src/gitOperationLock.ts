/**
 * Per-project git mutation lock.
 *
 * Once Level 1 parallelism is enabled, two tasks for the same project can
 * concurrently run repo-mutating git operations (`fetch`, branch creation,
 * `worktree add/remove`, `prune`). Git's own ref locks make those calls flaky
 * rather than safe, so every repo-mutating operation is serialized per project
 * root through this keyed async mutex.
 *
 * The lock is held ONLY for the git operation itself. Callers must never wrap
 * LLM/runtime execution in it — that would serialize the whole pipeline.
 */

import { resolve } from "node:path";
import { logger } from "@aif/shared";

const log = logger("git-operation-lock");

/** Warn when a waiter spends longer than this queued behind other operations. */
const LOCK_WAIT_WARN_MS = 15_000;

interface ProjectLockState {
  /** Tail of the FIFO chain; resolving it hands the lock to the next waiter. */
  tail: Promise<void>;
  /** Current holder + queued waiters. Used to garbage-collect idle keys. */
  queued: number;
}

const locks = new Map<string, ProjectLockState>();

function lockKey(projectRoot: string): string {
  return resolve(projectRoot)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

export interface ProjectGitLockInput {
  projectRoot: string;
  /** Short machine-readable label for diagnostics, e.g. "worktree-add". */
  operation: string;
}

/**
 * Run `fn` while holding the project-wide git mutation lock. Tolerates both
 * sync and async callbacks; the lock is always released, including on throw.
 */
export async function withProjectGitLock<T>(
  input: ProjectGitLockInput,
  fn: () => T | Promise<T>,
): Promise<T> {
  const key = lockKey(input.projectRoot);
  const state = locks.get(key) ?? { tail: Promise.resolve(), queued: 0 };
  const previous = state.tail;
  state.queued += 1;
  locks.set(key, state);

  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  state.tail = previous.then(
    () => gate,
    () => gate,
  );

  const waitStartedAt = Date.now();
  log.debug(
    { projectRoot: input.projectRoot, operation: input.operation, queued: state.queued },
    "Waiting for project git lock",
  );
  await previous.catch(() => undefined);

  const waitMs = Date.now() - waitStartedAt;
  log.debug(
    { projectRoot: input.projectRoot, operation: input.operation, waitMs },
    "Acquired project git lock",
  );
  if (waitMs > LOCK_WAIT_WARN_MS) {
    log.warn(
      { projectRoot: input.projectRoot, operation: input.operation, waitMs },
      "Project git lock wait exceeded threshold",
    );
  }

  try {
    return await fn();
  } finally {
    state.queued -= 1;
    if (state.queued <= 0 && locks.get(key) === state) {
      locks.delete(key);
    }
    release();
    log.debug(
      { projectRoot: input.projectRoot, operation: input.operation, waitMs },
      "Released project git lock",
    );
  }
}

/** Test-only: drop all in-flight lock bookkeeping. */
export function resetProjectGitLocks(): void {
  locks.clear();
}
