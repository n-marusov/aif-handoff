import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@aif/shared";
import { initProject } from "@aif/runtime";
import { getRuntimeRegistrySync } from "./coordinator.js";

const log = logger("repository-prepare");

export type RepositoryProvider = "github" | "gitlab";

export type RepositoryPrepareErrorKind =
  | "init_repo_failed"
  | "remote_failed"
  | "credential_failed"
  | "safe_directory_failed"
  | "fetch_failed"
  | "checkout_failed"
  | "init_failed"
  | "commit_failed"
  | "push_failed"
  | "registry_unavailable"
  | "project_not_found"
  | "connection_not_found";

/** Structured prepare error — consumers dispatch on `kind`, never on message text. */
export class RepositoryPrepareError extends Error {
  readonly kind: RepositoryPrepareErrorKind;
  readonly projectId: string;
  readonly provider: RepositoryProvider;

  constructor(
    kind: RepositoryPrepareErrorKind,
    message: string,
    projectId: string,
    provider: RepositoryProvider,
  ) {
    super(message);
    this.name = "RepositoryPrepareError";
    this.kind = kind;
    this.projectId = projectId;
    this.provider = provider;
  }
}

export interface RepositoryPrepareInput {
  projectId: string;
  projectRoot: string;
  provider: RepositoryProvider;
  /** HTTPS remote URL (a `.git` suffix is not required but is conventional). */
  remoteUrl: string;
  /** Environment variable holding the API token inside the agent container. */
  tokenEnvVar: string;
  /** Shell username used by the HTTPS credential helper. */
  credentialUsername: string;
  /** Branch checked out from the remote; falls back to `main`. */
  defaultBranch: string;
}

export interface RepositoryPrepareResult {
  preparedAt: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function runGit(projectRoot: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function captureGit(projectRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function hasRemote(projectRoot: string, name: string): boolean {
  try {
    return captureGit(projectRoot, ["remote"])
      .split("\n")
      .map((line) => line.trim())
      .includes(name);
  } catch {
    return false;
  }
}

function remoteBranchExists(projectRoot: string, branch: string): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function safeGetBranch(projectRoot: string): string | null {
  try {
    return captureGit(projectRoot, ["branch", "--show-current"]) || null;
  } catch {
    return null;
  }
}

function safeHasHead(projectRoot: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd: projectRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Provider-neutral auto-bootstrap of a project's local git repository.
 *
 * GitHub and GitLab share this algorithm so Connect and Sync now leave the
 * project root in the same prepared state — the VCS connection, not a manual
 * clone, is the entry point.
 *
 * Order of operations:
 * 1. bootstrap a missing repository (`git init` — the clone equivalent for a
 *    plain folder, so `origin`/fetch have something to attach to);
 * 2. add the `origin` remote;
 * 3. configure the HTTPS credential helper (the token stays in the
 *    environment; only its variable name is expanded by the shell at runtime);
 * 4. register `safe.directory`;
 * 5. fetch `origin`;
 * 6. check out the remote **default branch** — whatever it is named. A local
 *    repository with no commits force-adopts the remote branch (clone
 *    semantics); otherwise the branch is reset onto the remote;
 * 7. initialize the AI Factory scaffold when `.ai-factory/` is missing;
 * 8. commit any outstanding scaffold files;
 * 9. when the remote default branch did not exist yet, push the scaffold as
 *    the initial content of that branch.
 *
 * Runs synchronously and throws a typed {@link RepositoryPrepareError} on the
 * first failure (no silent retries).
 */
export function prepareRepository(input: RepositoryPrepareInput): RepositoryPrepareResult {
  const { projectId, projectRoot, provider, remoteUrl, tokenEnvVar, credentialUsername } = input;
  const defaultBranch = input.defaultBranch?.trim() || "main";

  log.info(
    { projectId, provider, projectRoot, defaultBranch, origin: remoteUrl },
    "Preparing repository",
  );

  // 1. Bootstrap a plain folder: `git remote add` needs a repository, and a
  // project root created without one would otherwise fail before any fetch.
  if (!existsSync(join(projectRoot, ".git"))) {
    mkdirSync(projectRoot, { recursive: true });
    try {
      runGit(projectRoot, ["init"]);
      log.info({ projectId, provider, projectRoot }, "Initialized git repository before prepare");
    } catch (err) {
      throw new RepositoryPrepareError(
        "init_repo_failed",
        `git init failed: ${errorMessage(err)}`,
        projectId,
        provider,
      );
    }
  }

  // 2. origin
  if (!hasRemote(projectRoot, "origin")) {
    try {
      runGit(projectRoot, ["remote", "add", "origin", remoteUrl]);
      log.debug({ projectId, provider, origin: remoteUrl }, "Added origin remote");
    } catch (err) {
      throw new RepositoryPrepareError(
        "remote_failed",
        `git remote add failed: ${errorMessage(err)}`,
        projectId,
        provider,
      );
    }
  } else {
    log.debug({ projectId, provider }, "Origin remote already present");
  }

  // 3. credential helper (token read from the agent container env at runtime)
  if (!process.env[tokenEnvVar]?.trim()) {
    throw new RepositoryPrepareError(
      "credential_failed",
      `Environment variable ${tokenEnvVar} is not set in the agent container.`,
      projectId,
      provider,
    );
  }
  try {
    runGit(projectRoot, [
      "config",
      "credential.helper",
      `!f() { echo username=${credentialUsername}; echo password=$${tokenEnvVar}; }; f`,
    ]);
    log.debug({ projectId, provider }, "Configured credential helper");
  } catch (err) {
    throw new RepositoryPrepareError(
      "credential_failed",
      `git config credential.helper failed: ${errorMessage(err)}`,
      projectId,
      provider,
    );
  }

  // 4. safe.directory (idempotent)
  try {
    execFileSync("git", ["config", "--global", "--add", "safe.directory", projectRoot], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    log.debug({ projectId, provider, projectRoot }, "Added safe.directory");
  } catch (err) {
    throw new RepositoryPrepareError(
      "safe_directory_failed",
      `git config safe.directory failed: ${errorMessage(err)}`,
      projectId,
      provider,
    );
  }

  // 5. fetch origin
  try {
    runGit(projectRoot, ["fetch", "origin"]);
    log.debug({ projectId, provider }, "Fetched origin");
  } catch (err) {
    throw new RepositoryPrepareError(
      "fetch_failed",
      `git fetch origin failed: ${errorMessage(err)}. Check token access.`,
      projectId,
      provider,
    );
  }

  // 6. extract the default branch (whatever it is named). Empty-origin path:
  // keep the local branch, rename it to defaultBranch, and push the scaffold as
  // the initial content in step 9.
  const remoteExists = remoteBranchExists(projectRoot, defaultBranch);
  if (remoteExists) {
    // A repository with zero commits has no history to protect: force the
    // checkout so untracked scaffold files cannot block adopting the remote
    // (this is what makes Sync now behave like a clone).
    const adoptForcefully = !safeHasHead(projectRoot);
    const args = adoptForcefully
      ? ["checkout", "-f", "-B", defaultBranch, `origin/${defaultBranch}`]
      : ["checkout", "-B", defaultBranch, `origin/${defaultBranch}`];
    try {
      runGit(projectRoot, args);
      log.info(
        { projectId, provider, defaultBranch, adopted: adoptForcefully },
        adoptForcefully
          ? "Adopted remote default branch into a repository without commits"
          : "Checked out remote default branch",
      );
    } catch (err) {
      throw new RepositoryPrepareError(
        "checkout_failed",
        `git ${args.join(" ")} failed: ${errorMessage(err)}`,
        projectId,
        provider,
      );
    }
  } else {
    try {
      const current = safeGetBranch(projectRoot);
      if (current && current !== defaultBranch) {
        runGit(projectRoot, ["branch", "-M", defaultBranch]);
        log.info({ projectId, provider, defaultBranch }, "Renamed local branch");
      }
    } catch (err) {
      throw new RepositoryPrepareError(
        "checkout_failed",
        `git branch -M ${defaultBranch} failed: ${errorMessage(err)}`,
        projectId,
        provider,
      );
    }
  }

  // 7. AI Factory init (idempotent) — only when the scaffold is missing.
  if (!existsSync(join(projectRoot, ".ai-factory"))) {
    const registry = getRuntimeRegistrySync();
    if (!registry) {
      throw new RepositoryPrepareError(
        "registry_unavailable",
        "Runtime registry is not initialized yet",
        projectId,
        provider,
      );
    }
    const initResult = initProject({ projectRoot, registry });
    if (!initResult.ok) {
      throw new RepositoryPrepareError(
        "init_failed",
        initResult.error ?? "ai-factory init failed",
        projectId,
        provider,
      );
    }
    log.debug({ projectId, provider }, "AI Factory init step completed");
  } else {
    log.debug({ projectId, provider }, "AI Factory scaffold already present");
  }

  // 8. commit scaffold — commit ANY untracked/modified files (fresh init or
  // leftover from a partial run) so the default branch is clean. A clean tree
  // is not an error.
  const dirty = captureGit(projectRoot, ["status", "--porcelain"]);
  if (dirty.length > 0) {
    try {
      runGit(projectRoot, ["add", "-A"]);
      runGit(projectRoot, ["commit", "-m", "chore: ai-factory scaffold", "--no-verify"]);
      log.info(
        { projectId, provider, fileCount: dirty.split("\n").length },
        "Committed AI Factory scaffold",
      );
    } catch (err) {
      throw new RepositoryPrepareError(
        "commit_failed",
        `git commit scaffold failed: ${errorMessage(err)}`,
        projectId,
        provider,
      );
    }
  } else {
    log.debug({ projectId, provider }, "No scaffold files to commit");
  }

  // 9. empty-origin path: push the scaffold as the initial default branch (only
  // when there is a local commit to push).
  if (!remoteExists && safeHasHead(projectRoot)) {
    try {
      runGit(projectRoot, ["push", "-u", "origin", defaultBranch]);
      log.info({ projectId, provider, defaultBranch }, "Pushed scaffold as initial default branch");
    } catch (err) {
      throw new RepositoryPrepareError(
        "push_failed",
        `git push -u origin ${defaultBranch} failed: ${errorMessage(err)}`,
        projectId,
        provider,
      );
    }
  } else if (!remoteExists) {
    log.debug({ projectId, provider }, "No local commit to push; skipping");
  }

  return { preparedAt: new Date().toISOString() };
}
