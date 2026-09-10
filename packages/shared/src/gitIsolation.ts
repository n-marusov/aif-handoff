import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { logger } from "./logger.js";
import { getProjectConfig, type AifProjectGit } from "./projectConfig.js";

const log = logger("git-isolation");

export class BranchIsolationError extends Error {
  readonly kind:
    | "dirty_worktree"
    | "branch_missing"
    | "branch_drift"
    | "base_branch_unavailable"
    | "base_update_failed"
    | "checkout_failed"
    | "create_failed"
    | "invalid_branch_name"
    | "git_disabled_with_persisted_branch"
    | "not_a_repo_with_persisted_branch"
    | "worktree_create_failed"
    | "worktree_path_collision";
  readonly branchName: string | null;
  readonly projectRoot: string;

  constructor(
    kind: BranchIsolationError["kind"],
    message: string,
    projectRoot: string,
    branchName: string | null,
  ) {
    super(message);
    this.name = "BranchIsolationError";
    this.kind = kind;
    this.projectRoot = projectRoot;
    this.branchName = branchName;
  }
}

export function isBranchIsolationError(err: unknown): err is BranchIsolationError {
  return err instanceof BranchIsolationError;
}

export interface EnsureFeatureBranchInput {
  projectRoot: string;
  taskId: string;
  title: string;
  explicitBranchName?: string | null;
  switchOnly?: boolean;
}

export interface EnsureFeatureBranchResult {
  action: "skipped" | "created" | "switched";
  branchName: string | null;
  reason?: string;
}

export interface EnsureTaskWorktreeInput {
  projectRoot: string;
  taskId: string;
  title: string;
  explicitBranchName?: string | null;
  explicitWorktreePath?: string | null;
  /**
   * Stable project identity used to build the worktree project segment.
   * When absent the segment falls back to a deterministic
   * `<basename>-<shortHash(projectRoot)>` derived from the filesystem path.
   */
  projectId?: string | null;
}

/** A single entry from `git worktree list --porcelain`. */
export interface WorktreeEntry {
  /** Absolute path of the worktree checkout. */
  path: string;
  /** Commit currently checked out in the worktree (null when unknown). */
  head: string | null;
  /** Short branch name, without the `refs/heads/` prefix (null when detached/bare). */
  branch: string | null;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

export interface EnsureTaskWorktreeResult {
  action: "skipped" | "created" | "reused";
  branchName: string | null;
  worktreePath: string | null;
  reason?: string;
}

const BRANCH_SLUG_MAX = 40;

export function slugifyTitle(title: string): string {
  const normalized = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const trimmed = normalized.slice(0, BRANCH_SLUG_MAX).replace(/-+$/, "");
  return trimmed || "task";
}

export function buildBranchName(prefix: string, title: string, taskId: string): string {
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const slug = slugifyTitle(title);
  const shortId = taskId.replace(/-/g, "").slice(0, 6);
  return `${normalizedPrefix}${slug}-${shortId}`;
}

function sanitizeWorktreeSegment(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "task";
}

const WORKTREE_ROOT_DIR_NAME = ".worktrees";
const PROJECT_SEGMENT_HASH_LENGTH = 8;

/**
 * Deterministic per-project worktree segment. Prefers the persisted project id
 * so two projects with the same basename never collide; otherwise derives a
 * stable `<basename>-<shortHash(projectRoot)>` from the filesystem path.
 */
export function buildProjectWorktreeSegment(
  projectRoot: string,
  projectId?: string | null,
): string {
  const trimmedId = projectId?.trim();
  if (trimmedId) return sanitizeWorktreeSegment(trimmedId);
  const hash = createHash("sha1")
    .update(resolve(projectRoot))
    .digest("hex")
    .slice(0, PROJECT_SEGMENT_HASH_LENGTH);
  return sanitizeWorktreeSegment(`${basename(projectRoot)}-${hash}`);
}

/**
 * Resolve the root folder that hosts task worktrees. Precedence:
 * explicit override → `AIF_WORKTREE_ROOT` → `<dirname(projectRoot)>/.worktrees`.
 */
export function resolveWorktreeRoot(
  projectRoot: string,
  explicitRoot?: string | null,
): { worktreeRoot: string; source: "explicit" | "env" | "default" } {
  const explicit = explicitRoot?.trim();
  if (explicit) return { worktreeRoot: resolve(explicit), source: "explicit" };
  const fromEnv = process.env.AIF_WORKTREE_ROOT?.trim();
  if (fromEnv) return { worktreeRoot: resolve(fromEnv), source: "env" };
  return {
    worktreeRoot: resolve(dirname(projectRoot), WORKTREE_ROOT_DIR_NAME),
    source: "default",
  };
}

function isWithinProjectMount(candidate: string, projectRoot: string): boolean {
  const mount = resolve(dirname(projectRoot));
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === mount || normalizedCandidate.startsWith(`${mount}${sep}`);
}

export interface BuildTaskWorktreePathInput {
  projectRoot: string;
  branchName: string;
  projectId?: string | null;
  worktreeRoot?: string | null;
}

/**
 * Branch-scoped task worktree path. The path is a pure function of the BRANCH
 * (plus the project segment), never of the task id — re-running the same issue
 * must land on the same folder so a retained worktree can be adopted instead of
 * triggering `git worktree add` conflicts.
 */
export function buildTaskWorktreePath(input: BuildTaskWorktreePathInput): string {
  const { projectRoot, branchName } = input;
  const { worktreeRoot, source } = resolveWorktreeRoot(projectRoot, input.worktreeRoot);
  const projectSegment = buildProjectWorktreeSegment(projectRoot, input.projectId);
  const branchSegment = sanitizeWorktreeSegment(branchName.replace(/\//g, "-"));
  const worktreePath = resolve(worktreeRoot, projectSegment, branchSegment);

  if (source !== "default" && !isWithinProjectMount(worktreeRoot, projectRoot)) {
    log.warn(
      { projectRoot, worktreeRoot, source, branchName, projectSegment },
      "Configured worktree root is outside the project mount; task worktrees will be created on an external path",
    );
  }
  log.debug(
    { projectRoot, branchName, worktreeRoot, worktreePath, projectSegment, source },
    "Resolved branch-scoped task worktree path",
  );
  return worktreePath;
}

function normalizeWorktreeEntry(partial: Partial<WorktreeEntry>): WorktreeEntry {
  // Git reports worktree paths with POSIX separators even on Windows; resolve
  // them to native form so callers can compare against `path.join` results.
  const rawPath = partial.path ?? "";
  return {
    path: rawPath ? resolve(rawPath) : rawPath,
    head: partial.head ?? null,
    branch: partial.branch ?? null,
    bare: partial.bare ?? false,
    detached: partial.detached ?? false,
    prunable: partial.prunable ?? false,
  };
}

function normalizePathForCompare(path: string): string {
  return resolve(path)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

/**
 * Parse `git worktree list --porcelain` into structured entries. Returns an
 * empty array when the project is not a git work tree (never throws).
 */
export function listWorktrees(projectRoot: string): WorktreeEntry[] {
  const { stdout, status } = runGit(projectRoot, ["worktree", "list", "--porcelain"], {
    ignoreExit: true,
  });
  if (status !== 0 || !stdout) return [];

  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      if (current?.path) entries.push(normalizeWorktreeEntry(current));
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current?.path) entries.push(normalizeWorktreeEntry(current));
      current = { path: line.slice("worktree ".length).trim() };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "prunable") {
      current.prunable = true;
    }
  }
  if (current?.path) entries.push(normalizeWorktreeEntry(current));
  return entries;
}

function findWorktreeForBranch(entries: WorktreeEntry[], branchName: string): WorktreeEntry | null {
  return entries.find((entry) => !entry.bare && entry.branch === branchName) ?? null;
}

function runGit(
  cwd: string,
  args: string[],
  opts: { ignoreExit?: boolean } = {},
): { stdout: string; stderr: string; status: number } {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  try {
    const stdout = execFileSync("git", args, options);
    return { stdout: stdout.toString().trim(), stderr: "", status: 0 };
  } catch (err) {
    const error = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
    };
    const stdout = error.stdout ? error.stdout.toString().trim() : "";
    const stderr = error.stderr ? error.stderr.toString().trim() : String(err);
    const status = typeof error.status === "number" ? error.status : 1;
    if (!opts.ignoreExit) {
      log.debug({ cwd, args, status, stderr }, "git command failed");
    }
    return { stdout, stderr, status };
  }
}

export function isGitRepo(projectRoot: string): boolean {
  if (!existsSync(join(projectRoot, ".git"))) {
    const { status } = runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"], {
      ignoreExit: true,
    });
    return status === 0;
  }
  return true;
}

export function getCurrentBranch(projectRoot: string): string | null {
  const { stdout, status } = runGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"], {
    ignoreExit: true,
  });
  if (status !== 0 || !stdout || stdout === "HEAD") return null;
  return stdout;
}

export function getHeadCommitSha(projectRoot: string): string | null {
  const { stdout, status } = runGit(projectRoot, ["rev-parse", "--verify", "HEAD"], {
    ignoreExit: true,
  });
  return status === 0 && stdout ? stdout : null;
}

export function countCommitsBetween(
  projectRoot: string,
  baseSha: string,
  headSha: string,
): number | null {
  const { stdout, status } = runGit(projectRoot, ["rev-list", "--count", `${baseSha}..${headSha}`]);
  if (status !== 0 || !/^\d+$/.test(stdout)) return null;
  return Number.parseInt(stdout, 10);
}

export function branchExists(projectRoot: string, branchName: string): boolean {
  const { status } = runGit(
    projectRoot,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    { ignoreExit: true },
  );
  return status === 0;
}

function remoteBranchExists(projectRoot: string, branchName: string): boolean {
  const { status } = runGit(
    projectRoot,
    ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branchName}`],
    { ignoreExit: true },
  );
  return status === 0;
}

function getOriginHeadBranch(projectRoot: string): string | null {
  const { stdout, status } = runGit(
    projectRoot,
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    {
      ignoreExit: true,
    },
  );
  if (status !== 0 || !stdout) return null;
  const prefix = "refs/remotes/origin/";
  if (!stdout.startsWith(prefix)) return null;
  const branchName = stdout.slice(prefix.length).trim();
  return branchName || null;
}

export function workingTreeClean(projectRoot: string): boolean {
  const { stdout, status } = runGit(projectRoot, ["status", "--porcelain"], { ignoreExit: true });
  return status === 0 && stdout.length === 0;
}

export function describeDirtyWorkingTree(projectRoot: string): string | null {
  const { stdout, status } = runGit(projectRoot, ["status", "--porcelain"], { ignoreExit: true });
  if (status !== 0 || stdout.length === 0) return null;
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const summary = lines.slice(0, 5).join(", ");
  return lines.length > 5 ? `${summary}, +${lines.length - 5} more` : summary;
}

export function assertWorkingTreeClean(projectRoot: string, branchName: string | null): void {
  const dirty = describeDirtyWorkingTree(projectRoot);
  if (dirty) {
    throw new BranchIsolationError(
      "dirty_worktree",
      `Working tree at ${projectRoot} has uncommitted changes (${dirty}). Commit, stash, or discard them before continuing.`,
      projectRoot,
      branchName,
    );
  }
}

export function assertCurrentBranch(projectRoot: string, expected: string): void {
  const current = getCurrentBranch(projectRoot);
  if (current !== expected) {
    throw new BranchIsolationError(
      "branch_drift",
      `Branch drift detected: expected HEAD=${expected}, actual HEAD=${current ?? "detached"}.`,
      projectRoot,
      expected,
    );
  }
}

/**
 * Validate a string as a usable git branch name via `git check-ref-format
 * --branch`. Rejects empty prefixes ("" → "/slug"), double slashes,
 * Git-special refspecs like `@{-1}`, and everything else git won't let you
 * `checkout -b`. Normalising at this layer turns surprising `checkout_failed`
 * / `create_failed` errors mid-flow into a deterministic `invalid_branch_name`
 * blocker before any state changes.
 */
export function validateBranchName(projectRoot: string, branchName: string): void {
  if (!branchName || branchName.trim().length === 0) {
    throw new BranchIsolationError(
      "invalid_branch_name",
      `Branch name is empty or whitespace-only.`,
      projectRoot,
      branchName || null,
    );
  }
  if (branchName.startsWith("/") || branchName.endsWith("/") || branchName.includes("//")) {
    throw new BranchIsolationError(
      "invalid_branch_name",
      `Branch name "${branchName}" has invalid slashes.`,
      projectRoot,
      branchName,
    );
  }
  const { status, stderr } = runGit(projectRoot, ["check-ref-format", "--branch", branchName], {
    ignoreExit: true,
  });
  if (status !== 0) {
    throw new BranchIsolationError(
      "invalid_branch_name",
      `Branch name "${branchName}" is not a valid git ref: ${stderr || "rejected by git check-ref-format"}.`,
      projectRoot,
      branchName,
    );
  }
}

function resolveGitConfig(projectRoot: string): AifProjectGit {
  return getProjectConfig(projectRoot).git;
}

function hasProjectConfigFile(projectRoot: string): boolean {
  return existsSync(join(projectRoot, ".ai-factory", "config.yaml"));
}

interface ResolvedBaseBranch {
  branchName: string;
  createFromRemote: boolean;
}

function resolveOriginHeadBaseBranch(projectRoot: string): ResolvedBaseBranch | null {
  const originHeadBranch = getOriginHeadBranch(projectRoot);
  if (!originHeadBranch) return null;
  if (branchExists(projectRoot, originHeadBranch)) {
    return { branchName: originHeadBranch, createFromRemote: false };
  }
  if (remoteBranchExists(projectRoot, originHeadBranch)) {
    return { branchName: originHeadBranch, createFromRemote: true };
  }
  return null;
}

function resolveGitDefaultBaseBranch(
  projectRoot: string,
  fallbackBase: string,
): ResolvedBaseBranch {
  const originHeadBase = resolveOriginHeadBaseBranch(projectRoot);
  if (originHeadBase) {
    log.warn(
      {
        projectRoot,
        configuredBase: fallbackBase,
        resolvedBase: originHeadBase.branchName,
        source: "origin/HEAD",
        createFromRemote: originHeadBase.createFromRemote,
      },
      "No project git base branch is configured; using origin default branch",
    );
    return originHeadBase;
  }
  if (branchExists(projectRoot, "master")) {
    log.warn(
      { projectRoot, configuredBase: fallbackBase, resolvedBase: "master" },
      "No project git base branch is configured; using legacy master branch",
    );
    return { branchName: "master", createFromRemote: false };
  }
  return { branchName: fallbackBase, createFromRemote: false };
}

function resolveBaseBranch(
  projectRoot: string,
  configuredBase: string,
  configFileExists: boolean,
): ResolvedBaseBranch {
  if (!configFileExists) {
    return resolveGitDefaultBaseBranch(projectRoot, configuredBase);
  }
  if (branchExists(projectRoot, configuredBase)) {
    return { branchName: configuredBase, createFromRemote: false };
  }
  if (configuredBase !== "main") {
    return { branchName: configuredBase, createFromRemote: false };
  }
  const originHeadBase = resolveOriginHeadBaseBranch(projectRoot);
  if (originHeadBase) {
    log.warn(
      {
        projectRoot,
        configuredBase,
        resolvedBase: originHeadBase.branchName,
        source: "origin/HEAD",
        createFromRemote: originHeadBase.createFromRemote,
      },
      "Configured base branch is missing; falling back to origin default branch",
    );
    return originHeadBase;
  }
  if (branchExists(projectRoot, "master")) {
    log.warn(
      { projectRoot, configuredBase, resolvedBase: "master" },
      "Configured base branch is missing; falling back to legacy master branch",
    );
    return { branchName: "master", createFromRemote: false };
  }
  return { branchName: configuredBase, createFromRemote: false };
}

function handleBaseBranchRefreshResult(input: {
  projectRoot: string;
  branchName: string;
  baseBranch: string;
  config: AifProjectGit;
  result: { stdout: string; stderr: string; status: number };
  operation: string;
}): void {
  const { projectRoot, branchName, baseBranch, config, result, operation } = input;
  if (result.status === 0) return;

  if (config.strict_base_update) {
    throw new BranchIsolationError(
      "base_update_failed",
      `${operation} failed: ${result.stderr || "unknown error"}. ` +
        `Project has git.strict_base_update=true; refusing to branch from a stale base.`,
      projectRoot,
      branchName,
    );
  }
  log.warn(
    {
      projectRoot,
      branchName,
      baseBranch,
      stderr: result.stderr,
    },
    "Could not fast-forward base branch before creating feature branch; continuing from local base (git.strict_base_update=false)",
  );
}

function refreshBaseBranchForWorktree(input: {
  projectRoot: string;
  branchName: string;
  baseBranch: string;
  config: AifProjectGit;
}): void {
  const { projectRoot, branchName, baseBranch, config } = input;
  const current = getCurrentBranch(projectRoot);
  const args =
    current === baseBranch
      ? ["pull", "--ff-only", "origin", baseBranch]
      : ["fetch", "origin", `${baseBranch}:${baseBranch}`];
  const result = runGit(projectRoot, args, { ignoreExit: true });
  handleBaseBranchRefreshResult({
    projectRoot,
    branchName,
    baseBranch,
    config,
    result,
    operation: `git ${args.join(" ")}`,
  });
}

export function projectUsesSharedBranchIsolation(projectRoot: string): boolean {
  const config = resolveGitConfig(projectRoot);
  return config.enabled && config.create_branches && isGitRepo(projectRoot);
}

export function projectSupportsTaskWorktrees(projectRoot: string): boolean {
  return projectUsesSharedBranchIsolation(projectRoot);
}

function copyPathIfExists(source: string, destination: string): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
}

function copyLatestPatchFiles(
  projectRoot: string,
  worktreePath: string,
  patchesPath: string,
): void {
  const sourceDir = resolve(projectRoot, patchesPath);
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) return;

  const entries = readdirSync(sourceDir)
    .map((name) => {
      const fullPath = join(sourceDir, name);
      const stats = statSync(fullPath);
      return { name, fullPath, mtimeMs: stats.mtimeMs, isFile: stats.isFile() };
    })
    .filter((entry) => entry.isFile && entry.name !== "patch-cursor.json")
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 10);

  const destinationDir = resolve(worktreePath, patchesPath);
  mkdirSync(destinationDir, { recursive: true });
  for (const entry of entries) {
    copyPathIfExists(entry.fullPath, join(destinationDir, entry.name));
  }
}

function excludeWorktreePath(worktreePath: string, relativePath: string): void {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) return;

  const { stdout, status, stderr } = runGit(
    worktreePath,
    ["rev-parse", "--git-path", "info/exclude"],
    {
      ignoreExit: true,
    },
  );
  if (status !== 0 || !stdout) {
    log.warn(
      { worktreePath, relativePath, stderr },
      "Could not resolve git exclude path for copied worktree context",
    );
    return;
  }

  const excludePath = resolve(worktreePath, stdout);
  mkdirSync(dirname(excludePath), { recursive: true });
  const pattern = `/${normalized}/`;
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (existing.split("\n").includes(pattern)) return;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(excludePath, `${prefix}# AIF copied planning context\n${pattern}\n`);
}

function copyProjectContextToWorktree(projectRoot: string, worktreePath: string): void {
  const cfg = getProjectConfig(projectRoot);
  const contextFiles = [
    ".ai-factory/config.yaml",
    cfg.paths.description,
    cfg.paths.architecture,
    cfg.paths.research,
    "AGENTS.md",
    "CLAUDE.md",
  ];
  const contextDirs = [".claude", ".ai-factory/skill-context"];
  const requiredParentPaths = [
    cfg.paths.plan,
    cfg.paths.fix_plan,
    cfg.paths.roadmap,
    cfg.paths.patches,
    cfg.paths.evolutions,
    cfg.paths.evolution,
  ];

  for (const relativePath of requiredParentPaths) {
    mkdirSync(dirname(resolve(worktreePath, relativePath)), { recursive: true });
  }

  for (const relativePath of contextFiles) {
    copyPathIfExists(resolve(projectRoot, relativePath), resolve(worktreePath, relativePath));
  }
  for (const relativePath of contextDirs) {
    copyPathIfExists(resolve(projectRoot, relativePath), resolve(worktreePath, relativePath));
  }
  copyLatestPatchFiles(projectRoot, worktreePath, cfg.paths.patches);
  excludeWorktreePath(worktreePath, cfg.paths.patches);
}

const WORKTREE_CREATE_MAX_ATTEMPTS = 3;
const STDERR_LOG_MAX = 2_000;

export function ensureTaskWorktree(input: EnsureTaskWorktreeInput): EnsureTaskWorktreeResult {
  const { projectRoot, taskId, title, explicitBranchName, explicitWorktreePath, projectId } = input;
  const config = resolveGitConfig(projectRoot);

  if (!config.enabled) {
    return { action: "skipped", branchName: null, worktreePath: null, reason: "git.enabled=false" };
  }
  if (!isGitRepo(projectRoot)) {
    return {
      action: "skipped",
      branchName: null,
      worktreePath: null,
      reason: "not a git work tree",
    };
  }
  if (!config.create_branches) {
    return {
      action: "skipped",
      branchName: null,
      worktreePath: null,
      reason: "git.create_branches=false",
    };
  }

  const branchName = explicitBranchName?.trim()
    ? explicitBranchName.trim()
    : buildBranchName(config.branch_prefix, title, taskId);
  validateBranchName(projectRoot, branchName);

  const expectedWorktreePath = explicitWorktreePath?.trim()
    ? resolve(explicitWorktreePath.trim())
    : buildTaskWorktreePath({ projectRoot, branchName, projectId });

  // Adopt-don't-fail: when the branch is ALREADY checked out in some worktree,
  // reuse that checkout instead of attempting `git worktree add` on a path that
  // git will refuse (a branch can only be checked out in one worktree). This is
  // what converts the retained-worktree incident into a no-op resume.
  const existingEntries = listWorktrees(projectRoot);
  const occupant = findWorktreeForBranch(existingEntries, branchName);
  if (occupant) {
    if (normalizePathForCompare(occupant.path) !== normalizePathForCompare(expectedWorktreePath)) {
      log.info(
        {
          taskId,
          branchName,
          worktreePath: occupant.path,
          expectedWorktreePath,
        },
        "Adopted existing worktree for branch",
      );
    }
    copyProjectContextToWorktree(projectRoot, occupant.path);
    return { action: "reused", branchName, worktreePath: occupant.path };
  }

  if (existsSync(expectedWorktreePath)) {
    if (isGitRepo(expectedWorktreePath) && getCurrentBranch(expectedWorktreePath) === branchName) {
      copyProjectContextToWorktree(projectRoot, expectedWorktreePath);
      return { action: "reused", branchName, worktreePath: expectedWorktreePath };
    }
    const occupantAtPath = existingEntries.find(
      (entry) =>
        normalizePathForCompare(entry.path) === normalizePathForCompare(expectedWorktreePath),
    );
    const boundTo = occupantAtPath?.branch ?? null;
    throw new BranchIsolationError(
      "worktree_path_collision",
      `Worktree path ${expectedWorktreePath} already exists${
        boundTo ? ` and is bound to ${boundTo}` : ""
      }, not ${branchName}. Remove or prune the stale worktree before retrying.`,
      projectRoot,
      branchName,
    );
  }

  const resolvedBaseBranch = resolveBaseBranch(
    projectRoot,
    config.base_branch,
    hasProjectConfigFile(projectRoot),
  );
  const baseRef = resolvedBaseBranch.createFromRemote
    ? `origin/${resolvedBaseBranch.branchName}`
    : resolvedBaseBranch.branchName;
  if (
    !resolvedBaseBranch.createFromRemote &&
    !branchExists(projectRoot, resolvedBaseBranch.branchName)
  ) {
    throw new BranchIsolationError(
      "base_branch_unavailable",
      `Base branch ${resolvedBaseBranch.branchName} does not exist in ${projectRoot}. Cannot create worktree branch ${branchName} from a known base.`,
      projectRoot,
      branchName,
    );
  }

  if (!branchExists(projectRoot, branchName)) {
    refreshBaseBranchForWorktree({
      projectRoot,
      branchName,
      baseBranch: resolvedBaseBranch.branchName,
      config,
    });
  }

  // Bounded retry driven by FRESH structured state rather than error text:
  // after every failed attempt we re-read `git worktree list` and the branch
  // refs, and adopt whatever appeared in the meantime (parallel provisioning,
  // partially-created worktree, ref written by a concurrent fetch).
  let lastStderr = "";
  let lastStatus = 1;
  let lastArgs: string[] = [];
  for (let attempt = 1; attempt <= WORKTREE_CREATE_MAX_ATTEMPTS; attempt += 1) {
    const branchNowExists = branchExists(projectRoot, branchName);
    const args = branchNowExists
      ? ["worktree", "add", expectedWorktreePath, branchName]
      : ["worktree", "add", "-b", branchName, expectedWorktreePath, baseRef];
    const { status, stderr } = runGit(projectRoot, args, { ignoreExit: true });
    if (status === 0) {
      copyProjectContextToWorktree(projectRoot, expectedWorktreePath);
      log.info(
        { projectRoot, worktreePath: expectedWorktreePath, branchName, taskId, attempt },
        "Created task worktree",
      );
      return { action: "created", branchName, worktreePath: expectedWorktreePath };
    }

    lastStatus = status;
    lastStderr = stderr;
    lastArgs = args;

    const raced = findWorktreeForBranch(listWorktrees(projectRoot), branchName);
    if (raced) {
      log.info(
        { taskId, branchName, worktreePath: raced.path },
        "Adopted existing worktree for branch",
      );
      copyProjectContextToWorktree(projectRoot, raced.path);
      return { action: "reused", branchName, worktreePath: raced.path };
    }

    if (attempt < WORKTREE_CREATE_MAX_ATTEMPTS) {
      log.warn(
        { taskId, branchName, attempt, status, stderr: truncateStderr(stderr) },
        "Task worktree provisioning failed; retrying",
      );
    }
  }

  log.error(
    {
      taskId,
      branchName,
      projectRoot,
      args: lastArgs,
      status: lastStatus,
      stderr: truncateStderr(lastStderr),
    },
    "Task worktree provisioning failed after retries",
  );
  throw new BranchIsolationError(
    "worktree_create_failed",
    `git ${lastArgs.join(" ")} failed after ${WORKTREE_CREATE_MAX_ATTEMPTS} attempts (last exit ${lastStatus}): ${
      lastStderr || "unknown error"
    }`,
    projectRoot,
    branchName,
  );
}

function truncateStderr(value: string): string {
  return value.length > STDERR_LOG_MAX ? `${value.slice(0, STDERR_LOG_MAX)}…[truncated]` : value;
}

export function ensureFeatureBranch(input: EnsureFeatureBranchInput): EnsureFeatureBranchResult {
  const { projectRoot, title, explicitBranchName, taskId, switchOnly } = input;
  const config = resolveGitConfig(projectRoot);

  if (!config.enabled) {
    return { action: "skipped", branchName: null, reason: "git.enabled=false" };
  }
  if (!isGitRepo(projectRoot)) {
    return { action: "skipped", branchName: null, reason: "not a git work tree" };
  }
  if (!config.create_branches && !switchOnly) {
    return { action: "skipped", branchName: null, reason: "git.create_branches=false" };
  }

  const branchName = explicitBranchName?.trim()
    ? explicitBranchName.trim()
    : buildBranchName(config.branch_prefix, title, taskId);

  validateBranchName(projectRoot, branchName);

  const current = getCurrentBranch(projectRoot);
  if (current === branchName) {
    return { action: "switched", branchName };
  }

  assertWorkingTreeClean(projectRoot, branchName);

  if (branchExists(projectRoot, branchName)) {
    const { status, stderr } = runGit(projectRoot, ["checkout", branchName], {
      ignoreExit: true,
    });
    if (status !== 0) {
      throw new BranchIsolationError(
        "checkout_failed",
        `git checkout ${branchName} failed: ${stderr || "unknown error"}`,
        projectRoot,
        branchName,
      );
    }
    log.info(
      { projectRoot, branchName, previous: current, taskId },
      "Switched to existing feature branch",
    );
    return { action: "switched", branchName };
  }

  if (switchOnly) {
    throw new BranchIsolationError(
      "branch_missing",
      `Expected feature branch ${branchName} is missing from ${projectRoot}. Planner did not prepare it, or it was deleted between stages.`,
      projectRoot,
      branchName,
    );
  }

  // Step 1: ensure HEAD is on the base branch. We need it both as the
  // create-from-target for `git checkout -b` and as the target of the pull
  // policy below.
  const resolvedBaseBranch = resolveBaseBranch(
    projectRoot,
    config.base_branch,
    hasProjectConfigFile(projectRoot),
  );
  const baseBranch = resolvedBaseBranch.branchName;
  if (current !== baseBranch) {
    if (!branchExists(projectRoot, baseBranch)) {
      if (!resolvedBaseBranch.createFromRemote) {
        throw new BranchIsolationError(
          "base_branch_unavailable",
          `Base branch ${config.base_branch} does not exist in ${projectRoot}. Cannot create ${branchName} from a known base.`,
          projectRoot,
          branchName,
        );
      }
      validateBranchName(projectRoot, baseBranch);
      const { status: trackStatus, stderr: trackErr } = runGit(
        projectRoot,
        ["checkout", "--track", "-b", baseBranch, `origin/${baseBranch}`],
        { ignoreExit: true },
      );
      if (trackStatus !== 0) {
        const { status: checkoutRemoteStatus, stderr: checkoutRemoteErr } = runGit(
          projectRoot,
          ["checkout", "-b", baseBranch, `origin/${baseBranch}`],
          { ignoreExit: true },
        );
        if (checkoutRemoteStatus !== 0) {
          throw new BranchIsolationError(
            "base_branch_unavailable",
            `Could not create local base branch ${baseBranch} from origin/${baseBranch}: ${trackErr || checkoutRemoteErr || "unknown error"}`,
            projectRoot,
            branchName,
          );
        }
      }
      log.info(
        { projectRoot, branchName: baseBranch, remoteBranch: `origin/${baseBranch}` },
        "Created local base branch from origin default branch",
      );
    } else {
      const { status: checkoutStatus, stderr: checkoutErr } = runGit(
        projectRoot,
        ["checkout", baseBranch],
        { ignoreExit: true },
      );
      if (checkoutStatus !== 0) {
        throw new BranchIsolationError(
          "base_branch_unavailable",
          `Could not checkout base branch ${baseBranch}: ${checkoutErr || "unknown error"}`,
          projectRoot,
          branchName,
        );
      }
    }
  }

  // Step 2: refresh the base branch via `git pull --ff-only origin <base>`.
  // Run UNCONDITIONALLY (regardless of whether we just switched into base or
  // were already on it) so `git.strict_base_update=true` cannot be bypassed
  // by a HEAD that already happens to be on a stale local base.
  //
  // Policy: by default treat pull failure as best-effort (warn + continue
  // from local base). Projects that REQUIRE a fresh base before branching
  // opt into strict mode via `git.strict_base_update: true` — pull failure
  // becomes a hard BranchIsolationError("base_update_failed") classified as
  // blocked_external by the coordinator.
  const pullResult = runGit(projectRoot, ["pull", "--ff-only", "origin", baseBranch], {
    ignoreExit: true,
  });
  handleBaseBranchRefreshResult({
    projectRoot,
    branchName,
    baseBranch,
    config,
    result: pullResult,
    operation: `git pull --ff-only origin ${baseBranch}`,
  });

  const { status, stderr } = runGit(projectRoot, ["checkout", "-b", branchName], {
    ignoreExit: true,
  });
  if (status !== 0) {
    throw new BranchIsolationError(
      "create_failed",
      `git checkout -b ${branchName} failed: ${stderr || "unknown error"}`,
      projectRoot,
      branchName,
    );
  }

  log.info({ projectRoot, branchName, previous: current, taskId }, "Created feature branch");
  return { action: "created", branchName };
}

/**
 * Restore HEAD to a branch a previous stage already persisted on the task.
 * Unlike `ensureFeatureBranch`, this treats `task.branchName` as a
 * source-of-truth contract: once planner stored it, every subsequent stage
 * MUST land on that branch or fail loud. Config flipping to `git.enabled=false`
 * or `git.create_branches=false` after a task was branched does not retroactively
 * release the stage to run on whatever HEAD happens to be.
 *
 * Failures throw `BranchIsolationError` with a kind the coordinator classifies
 * as `blocked_external`:
 *  - `git_disabled_with_persisted_branch` — config toggled off between stages
 *  - `not_a_repo_with_persisted_branch`  — repo was deleted / moved
 *  - `invalid_branch_name`               — persisted value is not a ref git accepts
 *  - `branch_missing`                    — branch was deleted between stages
 *  - `dirty_worktree`                    — switch would clobber uncommitted changes
 *  - `checkout_failed`                   — git refused the switch
 */
export interface RestorePersistedBranchInput {
  projectRoot: string;
  taskId: string;
  persistedBranchName: string;
}

export function restorePersistedBranch(input: RestorePersistedBranchInput): void {
  const { projectRoot, taskId, persistedBranchName } = input;
  const config = resolveGitConfig(projectRoot);

  if (!config.enabled) {
    throw new BranchIsolationError(
      "git_disabled_with_persisted_branch",
      `Task has persisted feature branch ${persistedBranchName} but git.enabled=false. Config drift between stages is not allowed — re-enable git or clear the branch binding before continuing.`,
      projectRoot,
      persistedBranchName,
    );
  }
  if (!isGitRepo(projectRoot)) {
    throw new BranchIsolationError(
      "not_a_repo_with_persisted_branch",
      `Task has persisted feature branch ${persistedBranchName} but ${projectRoot} is not a git work tree.`,
      projectRoot,
      persistedBranchName,
    );
  }

  validateBranchName(projectRoot, persistedBranchName);

  const current = getCurrentBranch(projectRoot);
  if (current === persistedBranchName) {
    return;
  }

  if (!branchExists(projectRoot, persistedBranchName)) {
    throw new BranchIsolationError(
      "branch_missing",
      `Expected feature branch ${persistedBranchName} is missing from ${projectRoot}. It was deleted between stages.`,
      projectRoot,
      persistedBranchName,
    );
  }

  assertWorkingTreeClean(projectRoot, persistedBranchName);

  const { status, stderr } = runGit(projectRoot, ["checkout", persistedBranchName], {
    ignoreExit: true,
  });
  if (status !== 0) {
    throw new BranchIsolationError(
      "checkout_failed",
      `git checkout ${persistedBranchName} failed: ${stderr || "unknown error"}`,
      projectRoot,
      persistedBranchName,
    );
  }

  log.info(
    { projectRoot, branchName: persistedBranchName, previous: current, taskId },
    "Restored persisted feature branch",
  );
}

/**
 * Apply a bot git identity (user.name / user.email) as the global git config
 * so commits made by subagents are attributed to the bot account. No-op when
 * either value is missing. Failures are non-fatal — the caller logs them.
 */
export function applyGitIdentity(input: {
  botName?: string | null;
  botEmail?: string | null;
  logger?: { warn(message: string): void };
}): void {
  const { botName, botEmail } = input;
  const name = botName?.trim();
  const email = botEmail?.trim();
  if (!name || !email) return;

  const run = (args: string[]): void => {
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
  };
  try {
    run(["config", "--global", "user.name", name]);
    run(["config", "--global", "user.email", email]);
    log.info({ botName: name, botEmail: email }, "Applied bot git identity globally");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    input.logger?.warn?.(`Failed to apply bot git identity: ${message}`);
    log.warn({ botName: name, err: message }, "Failed to apply bot git identity");
  }
}
