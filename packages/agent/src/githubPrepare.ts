import { findGitHubRepository, findProjectById, markGitHubRepositoryPrepared } from "@aif/data";
import { logger } from "@aif/shared";
import type { GitHubRepositoryConnection } from "@aif/shared";
import { prepareRepository, RepositoryPrepareError } from "./repositoryPrepare.js";

const log = logger("github-prepare");

export interface PrepareGitHubInput {
  projectRoot: string;
  connection: GitHubRepositoryConnection;
}

/**
 * HTTPS clone URL for the connected repository, derived from `htmlUrl` so
 * GitHub Enterprise hosts work without a separate configuration field.
 */
export function buildGitHubRemoteUrl(connection: GitHubRepositoryConnection): string {
  const base = connection.htmlUrl.trim().replace(/\/+$/, "");
  return base.endsWith(".git") ? base : `${base}.git`;
}

/**
 * Auto-prepare the local git repo for a GitHub connection (standard git only):
 * origin, credential helper, safe.directory, default-branch extraction, and
 * AI Factory scaffold init (committed). This is the GitHub counterpart of the
 * GitLab auto git-prepare flow — it closes the parity gap that previously
 * required a manual clone. Runs synchronously; throws a typed error on the
 * first failure (no silent retries).
 */
export function prepareGitHubRepository(input: PrepareGitHubInput): { gitPreparedAt: string } {
  const { projectRoot, connection } = input;
  const { preparedAt } = prepareRepository({
    projectId: connection.projectId,
    projectRoot,
    provider: "github",
    remoteUrl: buildGitHubRemoteUrl(connection),
    tokenEnvVar: connection.tokenEnvVar,
    credentialUsername: "x-access-token",
    defaultBranch: connection.defaultBranch,
  });

  const prepared = markGitHubRepositoryPrepared(connection.projectId);
  log.info({ projectId: connection.projectId }, "GitHub repository prepared");
  return { gitPreparedAt: prepared?.gitPreparedAt ?? preparedAt };
}

/**
 * HTTP-triggered prepare: load project + connection, run the algorithm, return
 * the prepared timestamp. Throws on any failure.
 */
export function prepareGitHubRepositoryForProject(projectId: string): { gitPreparedAt: string } {
  const project = findProjectById(projectId);
  if (!project) {
    throw new RepositoryPrepareError(
      "project_not_found",
      `Project ${projectId} not found`,
      projectId,
      "github",
    );
  }
  const connection = findGitHubRepository(projectId);
  if (!connection) {
    throw new RepositoryPrepareError(
      "connection_not_found",
      `No GitHub connection for project ${projectId}`,
      projectId,
      "github",
    );
  }
  return prepareGitHubRepository({ projectRoot: project.rootPath, connection });
}
