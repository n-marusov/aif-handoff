import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { findTaskById } from "@aif/data";
import {
  getProjectConfig,
  getCurrentBranch,
  getHeadCommitSha,
  isGitRepo,
  logger,
} from "@aif/shared";
import {
  buildPlanCommitSubject,
  resolveTargetProjectGitConventions,
  type TargetProjectGitConventions,
} from "./gitConventions.js";

const log = logger("plan-review:commit");

export type PlanReviewCommitStatus =
  | "committed"
  | "no_changes"
  | "blocked_missing_plan"
  | "blocked_dirty_product_files"
  | "not_a_git_repo"
  | "commit_failed";

export interface PlanReviewCommitReport {
  status: PlanReviewCommitStatus;
  commitSha: string | null;
  /** Current branch the plan commit landed on. */
  branch: string | null;
  /** Repository-relative path of the staged plan file. */
  planPath: string | null;
  conventionSource: string;
  /** Commit subject that was (or would have been) used. */
  commitMessage: string | null;
  /** Repository-relative paths staged by this call. */
  stagedPaths: string[];
  /** Dirty product files (up to MAX_DIRTY_PREVIEW) that blocked the commit. */
  dirtyProductPaths: string[];
  error?: string;
}

const MAX_DIRTY_PREVIEW = 20;
const MAX_ERROR_LENGTH = 500;

interface GitResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runGit(cwd: string, args: string[]): GitResult {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  try {
    const stdout = execFileSync("git", args, options);
    return { stdout: stdout.toString(), stderr: "", status: 0 };
  } catch (err) {
    const failure = err as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      stdout: String(failure.stdout ?? "").trim(),
      stderr: String(failure.stderr ?? "").trim(),
      status: failure.status ?? 1,
    };
  }
}

/** List repository-relative dirty paths (modified + untracked files). */
function listDirtyPaths(root: string): string[] {
  const { stdout, status } = runGit(root, ["status", "--porcelain", "-uall", "-z"]);
  if (status !== 0) return [];
  const paths: string[] = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    // Rename/copy entries emit a second NUL record holding only the original
    // path. It has no "XY " prefix, so skip it — the destination is enough.
    if (record[2] !== " ") continue;
    const path = record.slice(3);
    if (path) paths.push(path);
  }
  return paths;
}

function listStagedPaths(root: string): string[] {
  const { stdout, status } = runGit(root, ["diff", "--cached", "--name-only", "-z"]);
  if (status !== 0) return [];
  return stdout.split("\0").filter(Boolean);
}

function normalizePlanPath(rawPath: string, projectRoot: string): string {
  const trimmed = rawPath.trim().replace(/^@+/, "");
  if (!trimmed) {
    return getProjectConfig(projectRoot).paths.plan;
  }
  return trimmed;
}

function sanitizeError(stderr: string): string {
  return stderr.slice(0, MAX_ERROR_LENGTH);
}

/** Git paths always use forward slashes, even on Windows. */
function toPosixPath(pathValue: string): string {
  return pathValue.split("\\").join("/");
}

/**
 * Create a deterministic, plan-only commit on the current branch. Only the
 * task's plan file (plus any explicitly allowed paths) may be staged; any
 * other dirty file is treated as product work and blocks the commit until the
 * working tree has been cleaned.
 *
 * Returns a structured report instead of throwing for expected guard states;
 * callers (plan review publisher) decide whether a guard is fatal.
 */
export function ensurePlanReviewCommit(input: {
  taskId: string;
  /** Project repository root; the git work tree defaults to this. */
  projectRoot: string;
  /** Optional git work tree path (task worktree or shared checkout). */
  executionRoot?: string;
  /** Extra repository-relative paths that are allowed alongside the plan. */
  extraAllowedPaths?: string[];
  /** Pre-resolved conventions (testability; resolved when omitted). */
  conventions?: TargetProjectGitConventions;
}): PlanReviewCommitReport {
  const task = findTaskById(input.taskId);
  if (!task) {
    throw new Error(`Task ${input.taskId} not found for plan review commit`);
  }
  const executionRoot = input.executionRoot ?? input.projectRoot;

  if (!isGitRepo(executionRoot)) {
    log.warn(
      { taskId: task.id, executionRoot },
      "Plan review commit blocked: not a git repository",
    );
    return {
      status: "not_a_git_repo",
      commitSha: null,
      branch: null,
      planPath: null,
      conventionSource: "n/a",
      commitMessage: null,
      stagedPaths: [],
      dirtyProductPaths: [],
    };
  }

  // Ensure Git identity is configured locally so deterministic commits work
  // even in environments (e.g. Docker containers) that lack a global config.
  const who = runGit(executionRoot, ["config", "user.email"]);
  if (!who.stdout.trim()) {
    runGit(executionRoot, ["config", "user.name", "AI Factory Agent"]);
    runGit(executionRoot, ["config", "user.email", "agent@aif.handoff"]);
    log.debug(
      { taskId: task.id, executionRoot },
      "Set fallback Git identity for plan review commit",
    );
  }

  const conventions = input.conventions ?? resolveTargetProjectGitConventions(executionRoot);
  const planRel = normalizePlanPath(task.planPath, executionRoot);
  const planAbs = resolve(executionRoot, planRel);
  const branch = getCurrentBranch(executionRoot);

  if (!existsSync(planAbs)) {
    log.warn(
      { taskId: task.id, executionRoot, planRel, conventionSource: conventions.source },
      "Plan review commit blocked: plan file is missing",
    );
    return {
      status: "blocked_missing_plan",
      commitSha: null,
      branch,
      planPath: planRel,
      conventionSource: conventions.source,
      commitMessage: null,
      stagedPaths: [],
      dirtyProductPaths: [],
    };
  }

  const allowedAbs = new Set<string>([
    planAbs,
    ...(input.extraAllowedPaths ?? []).map((p) => resolve(executionRoot, p)),
  ]);
  const allowedRel = new Set<string>(
    [...allowedAbs].map((abs) => toPosixPath(relative(executionRoot, abs))),
  );

  // Infrastructure directory prefixes — scaffolding created by the tooling
  // (planner, initProject), never product/implementation code. Allow files
  // under these prefixes in the plan commit so plan review doesn't block on
  // setup artifacts while still catching real product files.
  const INFRASTRUCTURE_PREFIXES = [".ai-factory/", ".claude/"];

  const dirty = listDirtyPaths(executionRoot);
  const dirtyAbs = new Set(dirty.map((path) => resolve(executionRoot, path)));
  const dirtyProductPaths = dirty.filter((path) => {
    if (allowedAbs.has(resolve(executionRoot, path))) return false;
    const rel = toPosixPath(path);
    return !INFRASTRUCTURE_PREFIXES.some((prefix) => rel.startsWith(prefix));
  });

  if (dirtyProductPaths.length > 0) {
    const preview = dirtyProductPaths.slice(0, MAX_DIRTY_PREVIEW);
    log.warn(
      {
        taskId: task.id,
        executionRoot,
        dirtyCount: dirty.length,
        allowedCount: allowedRel.size,
        disallowedCount: dirtyProductPaths.length,
        disallowedPreview: preview,
        conventionSource: conventions.source,
      },
      "Plan review commit blocked by dirty product files",
    );
    return {
      status: "blocked_dirty_product_files",
      commitSha: null,
      branch,
      planPath: planRel,
      conventionSource: conventions.source,
      commitMessage: null,
      stagedPaths: [],
      dirtyProductPaths: preview,
    };
  }

  const dirtyAllowed = dirty.filter((path) => dirtyAbs.has(resolve(executionRoot, path)));
  if (dirtyAllowed.length === 0) {
    log.debug(
      { taskId: task.id, executionRoot, planRel, conventionSource: conventions.source },
      "Plan review commit skipped: no plan changes to commit",
    );
    return {
      status: "no_changes",
      commitSha: null,
      branch,
      planPath: planRel,
      conventionSource: conventions.source,
      commitMessage: null,
      stagedPaths: [],
      dirtyProductPaths: [],
    };
  }

  const commitMessage = buildPlanCommitSubject(task.title, conventions);
  const beforeSha = getHeadCommitSha(executionRoot);

  log.debug(
    {
      taskId: task.id,
      executionRoot,
      dirtyCount: dirtyAllowed.length,
      allowedPaths: dirtyAllowed,
      conventionSource: conventions.source,
    },
    "Staging plan files for deterministic plan commit",
  );
  for (const relPath of dirtyAllowed) {
    runGit(executionRoot, ["add", "--", relPath]);
  }

  const staged = listStagedPaths(executionRoot);
  const stagedAllowed = staged.filter((path) => allowedRel.has(path));
  if (stagedAllowed.length === 0) {
    log.warn(
      { taskId: task.id, executionRoot, planRel },
      "Plan review commit blocked: nothing allowed could be staged",
    );
    return {
      status: "commit_failed",
      commitSha: null,
      branch,
      planPath: planRel,
      conventionSource: conventions.source,
      commitMessage,
      stagedPaths: [],
      dirtyProductPaths: [],
      error: "No allowed plan paths were staged",
    };
  }

  const commit = runGit(executionRoot, ["commit", "--no-verify", "-m", commitMessage]);
  if (commit.status !== 0) {
    log.error(
      {
        taskId: task.id,
        executionRoot,
        planRel,
        stagedPaths: stagedAllowed,
        err: sanitizeError(commit.stderr),
      },
      "Deterministic plan commit failed",
    );
    return {
      status: "commit_failed",
      commitSha: null,
      branch,
      planPath: planRel,
      conventionSource: conventions.source,
      commitMessage,
      stagedPaths: stagedAllowed,
      dirtyProductPaths: [],
      error: sanitizeError(commit.stderr),
    };
  }

  const commitSha = getHeadCommitSha(executionRoot);
  log.info(
    {
      taskId: task.id,
      executionRoot,
      commitSha,
      branch,
      planRel,
      stagedPaths: stagedAllowed,
      conventionSource: conventions.source,
    },
    "Plan review commit created",
  );

  if (!commitSha || (beforeSha && commitSha === beforeSha)) {
    return {
      status: "commit_failed",
      commitSha: null,
      branch,
      planPath: planRel,
      conventionSource: conventions.source,
      commitMessage,
      stagedPaths: stagedAllowed,
      dirtyProductPaths: [],
      error: "Commit did not advance HEAD",
    };
  }

  return {
    status: "committed",
    commitSha,
    branch,
    planPath: planRel,
    conventionSource: conventions.source,
    commitMessage,
    stagedPaths: stagedAllowed,
    dirtyProductPaths: [],
  };
}
