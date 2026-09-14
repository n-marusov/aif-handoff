import { findGitLabRepository, findProjectById, markGitLabRepositoryPrepared } from "@aif/data";
import { logger } from "@aif/shared";
import type { GitLabRepositoryConnection } from "@aif/shared";
import { prepareRepository, RepositoryPrepareError } from "./repositoryPrepare.js";

const log = logger("gitlab-prepare");

/**
 * GitLab-specific alias of the shared prepare error. The shared
 * {@link RepositoryPrepareError} carries `provider: "gitlab"` for this path, so
 * callers can keep catching the historical name.
 */
export { RepositoryPrepareError as GitLabPrepareError };
export type { RepositoryPrepareErrorKind as GitLabPrepareErrorKind };

export interface PrepareGitLabInput {
  projectRoot: string;
  connection: GitLabRepositoryConnection;
}

/**
 * Auto-prepare the local git repo for a GitLab connection (standard git only):
 * origin, credential helper, safe.directory, default-branch extraction, and
 * AI Factory scaffold init (committed). Runs synchronously; throws a typed
 * error on the first failure (no silent retries).
 */
export function prepareGitLabRepository(input: PrepareGitLabInput): { gitPreparedAt: string } {
  const { projectRoot, connection } = input;
  const { preparedAt } = prepareRepository({
    projectId: connection.projectId,
    projectRoot,
    provider: "gitlab",
    remoteUrl: connection.webUrl.trim(),
    tokenEnvVar: connection.tokenEnvVar,
    credentialUsername: "oauth2",
    defaultBranch: connection.defaultBranch,
  });

  const prepared = markGitLabRepositoryPrepared(connection.projectId);
  log.info({ projectId: connection.projectId }, "GitLab repository prepared");
  return { gitPreparedAt: prepared?.gitPreparedAt ?? preparedAt };
}

/**
 * HTTP-triggered prepare: load project + connection, run the algorithm, return
 * the prepared timestamp. Throws on any failure.
 */
export function prepareGitLabRepositoryForProject(projectId: string): { gitPreparedAt: string } {
  const project = findProjectById(projectId);
  if (!project) {
    throw new RepositoryPrepareError(
      "project_not_found",
      `Project ${projectId} not found`,
      projectId,
      "gitlab",
    );
  }
  const connection = findGitLabRepository(projectId);
  if (!connection) {
    throw new RepositoryPrepareError(
      "connection_not_found",
      `No GitLab connection for project ${projectId}`,
      projectId,
      "gitlab",
    );
  }
  return prepareGitLabRepository({ projectRoot: project.rootPath, connection });
}
