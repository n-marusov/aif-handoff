import { execFileSync } from "node:child_process";
import {
  appendTaskActivityLog,
  findGitLabIssueByTaskId,
  findTaskById,
  listEnabledGitLabRepositories,
} from "@aif/data";
import { getEnv, logger } from "@aif/shared";
import { ensureAutoQueueTaskCommit } from "./autoQueueCommit.js";
import { internalApiHeaders } from "./notifier.js";
import { StageManualBlockError } from "./stageErrorHandler.js";

const log = logger("gitlab-workflow");
const SYNC_INTERVAL_MS = 60_000;
const lastSyncAttempts = new Map<string, number>();

interface GitLabApiFailure {
  error?: string;
  code?: string;
  retryAt?: string | null;
}

async function readFailure(response: Response): Promise<GitLabApiFailure> {
  try {
    return (await response.json()) as GitLabApiFailure;
  } catch {
    return {};
  }
}

function gitLabModeActive(): boolean {
  const env = getEnv();
  return env.GIT_PROVIDER === "gitlab" && env.AIF_GITLAB_ISSUE_MR_ENABLED;
}

export async function synchronizeGitLabProjects(now = Date.now()): Promise<void> {
  if (!gitLabModeActive()) {
    log.debug(
      { gitProvider: getEnv().GIT_PROVIDER, gitLabEnabled: getEnv().AIF_GITLAB_ISSUE_MR_ENABLED },
      "GitLab synchronization skipped because provider selector or rollout flag is disabled",
    );
    return;
  }
  const baseUrl = getEnv().API_BASE_URL;
  for (const connection of listEnabledGitLabRepositories()) {
    const lastSync = connection.lastSyncedAt ? Date.parse(connection.lastSyncedAt) : 0;
    const lastAttempt = lastSyncAttempts.get(connection.projectId) ?? 0;
    if (
      (Number.isFinite(lastSync) && now - lastSync < SYNC_INTERVAL_MS) ||
      now - lastAttempt < SYNC_INTERVAL_MS
    ) {
      continue;
    }
    lastSyncAttempts.set(connection.projectId, now);

    const url = `${baseUrl}/projects/${connection.projectId}/gitlab/sync`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: internalApiHeaders(),
        body: "{}",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const failure = await readFailure(response);
        log.warn(
          {
            projectId: connection.projectId,
            status: response.status,
            code: failure.code ?? "gitlab_sync_failed",
            retryAt: failure.retryAt ?? null,
          },
          "GitLab repository sync deferred",
        );
      }
    } catch (error) {
      log.warn(
        { projectId: connection.projectId, err: error },
        "GitLab repository sync unavailable",
      );
    }
  }
}

function pushBranch(projectRoot: string, branch: string): void {
  execFileSync("git", ["push", "--set-upstream", "origin", branch], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function publishGitLabTask(taskId: string, projectRoot: string): Promise<boolean> {
  if (!gitLabModeActive()) {
    log.debug(
      { taskId, gitProvider: getEnv().GIT_PROVIDER },
      "GitLab merge request publication skipped because provider selector or rollout flag is disabled",
    );
    return false;
  }
  const issue = findGitLabIssueByTaskId(taskId);
  if (!issue) return false;

  const task = findTaskById(taskId);
  if (!task?.branchName) {
    throw new StageManualBlockError("GitLab merge request publication requires a task branch.");
  }
  const executionRoot = task.worktreePath ?? projectRoot;
  const commit = await ensureAutoQueueTaskCommit({ taskId, projectRoot: executionRoot });

  try {
    pushBranch(executionRoot, task.branchName);
  } catch (error) {
    log.error({ taskId, branch: task.branchName, err: error }, "GitLab task branch push failed");
    throw new StageManualBlockError(
      "GitLab branch push failed. Check repository access and Git credentials, then retry.",
    );
  }

  const refreshed = findTaskById(taskId);
  const url = `${getEnv().API_BASE_URL}/projects/${task.projectId}/gitlab/tasks/${taskId}/publish`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: internalApiHeaders(),
      body: JSON.stringify({
        branch: task.branchName,
        commitSha: commit.commitSha,
        implementationLog: refreshed?.implementationLog ?? null,
        reviewComments: refreshed?.reviewComments ?? null,
      }),
      signal: AbortSignal.timeout(getEnv().AGENT_GIT_PUBLISH_TIMEOUT_MS),
    });
  } catch (error) {
    log.error(
      { taskId, branch: task.branchName, err: error },
      "GitLab merge request API unavailable",
    );
    throw new StageManualBlockError(
      "GitLab merge request publication is unavailable. Check the API service and retry.",
    );
  }
  if (!response.ok) {
    const failure = await readFailure(response);
    log.warn(
      {
        taskId,
        branch: task.branchName,
        status: response.status,
        code: failure.code ?? "gitlab_publish_failed",
        retryAt: failure.retryAt ?? null,
      },
      "GitLab merge request publication failed",
    );
    throw new StageManualBlockError(
      failure.retryAt
        ? `GitLab rate limit reached until ${failure.retryAt}. Retry after that time.`
        : "GitLab merge request publication failed. Check repository permissions and retry.",
    );
  }

  const completedAt = new Date().toISOString();
  appendTaskActivityLog(
    taskId,
    `[${completedAt}] [gitlab] Published ${task.branchName} for issue #${issue.iid}`,
  );
  log.info(
    { taskId, iid: issue.iid, branch: task.branchName },
    "GitLab merge request synchronized",
  );
  return true;
}
