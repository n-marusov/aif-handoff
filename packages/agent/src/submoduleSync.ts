import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findProjectById } from "@aif/data";
import { logger } from "@aif/shared";

const log = logger("submodule-sync");

export interface SubmoduleSyncResult {
  ok: boolean;
  submodulesInitialized?: boolean;
  error?: string;
}

/**
 * Best-effort git submodule init for an already-prepared project repository.
 *
 * Runs `git submodule update --init --recursive` when .gitmodules exists.
 * This is intended to be called on every sync (not just first prepare) so that
 * projects connected before the submodule-init feature was deployed also get
 * their submodules populated.
 *
 * The call is non-blocking — a failure (unreachable submodule URL, auth error)
 * is logged but never propagated, because the import workflow must continue
 * even when submodules cannot be fetched.
 */
export function syncProjectSubmodules(projectId: string): SubmoduleSyncResult {
  const project = findProjectById(projectId);
  if (!project?.rootPath) {
    log.debug({ projectId }, "Submodule sync skipped: no project root");
    return { ok: true, submodulesInitialized: false };
  }

  const gitmodulesPath = join(project.rootPath, ".gitmodules");
  if (!existsSync(gitmodulesPath)) {
    log.debug({ projectId }, "No .gitmodules found; skipping submodule sync");
    return { ok: true, submodulesInitialized: false };
  }

  log.info({ projectId, projectRoot: project.rootPath }, "Syncing git submodules");
  try {
    execFileSync("git", ["submodule", "update", "--init", "--recursive"], {
      cwd: project.rootPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    log.info({ projectId }, "Submodules synchronized");
    return { ok: true, submodulesInitialized: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ projectId, err: message }, "Submodule sync failed (non-blocking)");
    return { ok: false, submodulesInitialized: false, error: message };
  }
}
