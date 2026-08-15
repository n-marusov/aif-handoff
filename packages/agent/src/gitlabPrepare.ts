import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findGitLabRepository, findProjectById, markGitLabRepositoryPrepared } from "@aif/data";
import { logger } from "@aif/shared";
import { initProject } from "@aif/runtime";
import type { GitLabRepositoryConnection } from "@aif/shared";
import { getRuntimeRegistrySync } from "./coordinator.js";

const log = logger("gitlab-prepare");

export type GitLabPrepareErrorKind =
  | "remote_failed"
  | "credential_failed"
  | "safe_directory_failed"
  | "fetch_failed"
  | "checkout_failed"
  | "init_failed"
  | "commit_failed"
  | "push_failed"
  | "project_not_found"
  | "connection_not_found"
  | "registry_unavailable";

/** Structured prepare error — consumers dispatch on `kind`, never on message text. */
export class GitLabPrepareError extends Error {
  constructor(
    public readonly kind: GitLabPrepareErrorKind,
    message: string,
    public readonly projectId: string,
  ) {
    super(message);
    this.name = "GitLabPrepareError";
  }
}

interface PrepareInput {
  projectRoot: string;
  connection: GitLabRepositoryConnection;
}

function runGit(projectRoot: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function hasRemote(projectRoot: string, name: string): boolean {
  try {
    const remotes = execFileSync("git", ["remote"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return remotes
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
    return (
      execFileSync("git", ["branch", "--show-current"], {
        cwd: projectRoot,
        encoding: "utf8",
      }).trim() || null
    );
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
 * Auto-prepare the local git repo for a GitLab connection (standard git only):
 * origin, credential helper, safe.directory, default-branch extraction, and
 * AI Factory scaffold init (committed). Runs synchronously; throws a typed
 * GitLabPrepareError on the first failure (no silent retries).
 */
export function prepareGitLabRepository(input: PrepareInput): { gitPreparedAt: string } {
  const { projectRoot, connection } = input;
  const originUrl = connection.webUrl.trim();
  const defaultBranch = connection.defaultBranch?.trim() || "main";

  log.info(
    { projectId: connection.projectId, projectRoot, defaultBranch, origin: originUrl },
    "Preparing GitLab repository",
  );

  // 1. origin
  if (!hasRemote(projectRoot, "origin")) {
    try {
      runGit(projectRoot, ["remote", "add", "origin", originUrl]);
      log.debug({ projectId: connection.projectId, origin: originUrl }, "Added origin remote");
    } catch (err) {
      throw new GitLabPrepareError(
        "remote_failed",
        `git remote add failed: ${err instanceof Error ? err.message : String(err)}`,
        connection.projectId,
      );
    }
  } else {
    log.debug({ projectId: connection.projectId }, "Origin remote already present");
  }

  // 2. credential helper (token from the agent container env)
  const token = process.env[connection.tokenEnvVar]?.trim();
  if (!token) {
    throw new GitLabPrepareError(
      "credential_failed",
      `Environment variable ${connection.tokenEnvVar} is not set in the agent container.`,
      connection.projectId,
    );
  }
  try {
    runGit(projectRoot, [
      "config",
      "credential.helper",
      "!f() { echo username=oauth2; echo password=$GITLAB_TOKEN; }; f",
    ]);
    log.debug({ projectId: connection.projectId }, "Configured credential helper");
  } catch (err) {
    throw new GitLabPrepareError(
      "credential_failed",
      `git config credential.helper failed: ${err instanceof Error ? err.message : String(err)}`,
      connection.projectId,
    );
  }

  // 3. safe.directory (idempotent)
  try {
    execFileSync("git", ["config", "--global", "--add", "safe.directory", projectRoot], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    log.debug({ projectId: connection.projectId, projectRoot }, "Added safe.directory");
  } catch (err) {
    throw new GitLabPrepareError(
      "safe_directory_failed",
      `git config safe.directory failed: ${err instanceof Error ? err.message : String(err)}`,
      connection.projectId,
    );
  }

  // 4. fetch origin
  try {
    runGit(projectRoot, ["fetch", "origin"]);
    log.debug({ projectId: connection.projectId }, "Fetched origin");
  } catch (err) {
    throw new GitLabPrepareError(
      "fetch_failed",
      `git fetch origin failed: ${err instanceof Error ? err.message : String(err)}. Check token access.`,
      connection.projectId,
    );
  }

  // 5. extract default branch (whatever it is named). Empty-origin path: keep
  // local branch, rename to defaultBranch, push scaffold as initial content.
  const remoteExists = remoteBranchExists(projectRoot, defaultBranch);
  if (remoteExists) {
    try {
      runGit(projectRoot, ["checkout", "-B", defaultBranch, `origin/${defaultBranch}`]);
      log.info(
        { projectId: connection.projectId, defaultBranch },
        "Checked out remote default branch",
      );
    } catch (err) {
      throw new GitLabPrepareError(
        "checkout_failed",
        `git checkout -B ${defaultBranch} origin/${defaultBranch} failed: ${err instanceof Error ? err.message : String(err)}`,
        connection.projectId,
      );
    }
  } else {
    try {
      const current = safeGetBranch(projectRoot);
      if (current && current !== defaultBranch) {
        runGit(projectRoot, ["branch", "-M", defaultBranch]);
        log.info({ projectId: connection.projectId, defaultBranch }, "Renamed local branch");
      }
    } catch (err) {
      throw new GitLabPrepareError(
        "checkout_failed",
        `git branch -M ${defaultBranch} failed: ${err instanceof Error ? err.message : String(err)}`,
        connection.projectId,
      );
    }
  }

  // 6. AI Factory init (idempotent) — after checkout, only if .ai-factory missing
  const needsCommit = !existsSync(join(projectRoot, ".ai-factory"));
  if (needsCommit) {
    const registry = getRuntimeRegistrySync();
    if (!registry) {
      throw new GitLabPrepareError(
        "registry_unavailable",
        "Runtime registry is not initialized yet",
        connection.projectId,
      );
    }
    const initResult = initProject({ projectRoot, registry });
    if (!initResult.ok) {
      throw new GitLabPrepareError(
        "init_failed",
        initResult.error ?? "ai-factory init failed",
        connection.projectId,
      );
    }
    log.debug({ projectId: connection.projectId }, "AI Factory init step completed");
  } else {
    log.debug({ projectId: connection.projectId }, "AI Factory scaffold already present");
  }

  // 7. commit scaffold if files appeared (fresh init path). Only commit when
  // there are actually staged changes — a clean tree is not an error.
  if (needsCommit) {
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (dirty.length > 0) {
      try {
        runGit(projectRoot, ["add", "-A"]);
        runGit(projectRoot, ["commit", "-m", "chore: ai-factory scaffold", "--no-verify"]);
        log.info({ projectId: connection.projectId }, "Committed AI Factory scaffold");
      } catch (err) {
        throw new GitLabPrepareError(
          "commit_failed",
          `git commit scaffold failed: ${err instanceof Error ? err.message : String(err)}`,
          connection.projectId,
        );
      }
    } else {
      log.debug({ projectId: connection.projectId }, "No scaffold files to commit");
    }
  }

  // 8. empty-origin path: push scaffold as initial default branch (only when
  // there is a local commit to push).
  if (!remoteExists && safeHasHead(projectRoot)) {
    try {
      runGit(projectRoot, ["push", "-u", "origin", defaultBranch]);
      log.info(
        { projectId: connection.projectId, defaultBranch },
        "Pushed scaffold as initial default branch",
      );
    } catch (err) {
      throw new GitLabPrepareError(
        "push_failed",
        `git push -u origin ${defaultBranch} failed: ${err instanceof Error ? err.message : String(err)}`,
        connection.projectId,
      );
    }
  } else if (!remoteExists) {
    log.debug({ projectId: connection.projectId }, "No local commit to push; skipping");
  }

  const prepared = markGitLabRepositoryPrepared(connection.projectId);
  log.info({ projectId: connection.projectId }, "GitLab repository prepared");
  return { gitPreparedAt: prepared?.gitPreparedAt ?? new Date().toISOString() };
}

/**
 * HTTP-triggered prepare: load project + connection, run the algorithm, return
 * the prepared timestamp. Throws GitLabPrepareError on any failure.
 */
export function prepareGitLabRepositoryForProject(projectId: string): { gitPreparedAt: string } {
  const project = findProjectById(projectId);
  if (!project) {
    throw new GitLabPrepareError("project_not_found", `Project ${projectId} not found`, projectId);
  }
  const connection = findGitLabRepository(projectId);
  if (!connection) {
    throw new GitLabPrepareError(
      "connection_not_found",
      `No GitLab connection for project ${projectId}`,
      projectId,
    );
  }
  return prepareGitLabRepository({ projectRoot: project.rootPath, connection });
}
