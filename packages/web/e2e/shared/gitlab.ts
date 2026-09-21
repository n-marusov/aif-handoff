import type { APIRequestContext } from "@playwright/test";

export const GITLAB_WEB_URL = process.env.GITLAB_WEB_URL;
export const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
export const GITLAB_REPOSITORY_PATH = "root/e2e-target";

type GitLabHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

interface GitLabApiErrorPayload {
  message?: unknown;
  error?: unknown;
}

export class GitLabApiError extends Error {
  readonly status: number;
  readonly method: GitLabHttpMethod;
  readonly path: string;
  readonly bodyText: string;
  readonly payload: GitLabApiErrorPayload | null;

  constructor(options: {
    status: number;
    method: GitLabHttpMethod;
    path: string;
    bodyText: string;
    payload: GitLabApiErrorPayload | null;
  }) {
    super(`GitLab API ${options.method} ${options.path} failed with HTTP ${options.status}`);
    this.name = "GitLabApiError";
    this.status = options.status;
    this.method = options.method;
    this.path = options.path;
    this.bodyText = options.bodyText;
    this.payload = options.payload;
  }
}

function parseGitLabErrorPayload(text: string): GitLabApiErrorPayload | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return {
      message: record.message,
      error: record.error,
    };
  } catch {
    return null;
  }
}

export function gitLabApiBaseUrl(): string {
  if (!GITLAB_WEB_URL) {
    throw new Error("GITLAB_WEB_URL is required");
  }
  return `${GITLAB_WEB_URL.replace(/\/$/, "")}/api/v4`;
}

export function gitLabProjectPathEncoded(repositoryPath = GITLAB_REPOSITORY_PATH): string {
  return encodeURIComponent(repositoryPath);
}

export async function gitLabApi<T>(
  request: APIRequestContext,
  path: string,
  method: GitLabHttpMethod = "GET",
  data?: unknown,
): Promise<T> {
  if (!GITLAB_TOKEN) {
    throw new Error("GITLAB_TOKEN is required");
  }

  const response = await request.fetch(`${gitLabApiBaseUrl()}${path}`, {
    method,
    headers: {
      "PRIVATE-TOKEN": GITLAB_TOKEN,
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    data,
  });

  if (!response.ok()) {
    const bodyText = await response.text();
    throw new GitLabApiError({
      status: response.status(),
      method,
      path,
      bodyText,
      payload: parseGitLabErrorPayload(bodyText),
    });
  }

  return (await response.json()) as T;
}

interface MergeRequestMergeStatusPayload {
  state?: string;
  detailed_merge_status?: string;
  merge_status?: string;
}

const RETRYABLE_MERGE_STATUSES = new Set(["checking", "preparing", "unchecked"]);

export async function isRetryableMergeReadinessDelay(
  request: APIRequestContext,
  mrIid: number,
): Promise<boolean> {
  const mr = await gitLabApi<MergeRequestMergeStatusPayload>(
    request,
    `/projects/${gitLabProjectPathEncoded()}/merge_requests/${mrIid}`,
    "GET",
  );

  if (mr.state !== "opened") {
    return false;
  }

  const status = mr.detailed_merge_status ?? mr.merge_status ?? null;
  if (!status) {
    return true;
  }

  return RETRYABLE_MERGE_STATUSES.has(status);
}

export async function createGitLabBranchWithCommit(
  request: APIRequestContext,
  branchName: string,
  marker: string,
): Promise<void> {
  await gitLabApi(request, `/projects/${gitLabProjectPathEncoded()}/repository/branches`, "POST", {
    branch: branchName,
    ref: "main",
  });

  await gitLabApi(
    request,
    `/projects/${gitLabProjectPathEncoded()}/repository/files/${encodeURIComponent(`e2e/${marker}.md`)}`,
    "POST",
    {
      branch: branchName,
      content: `# ${marker}\n`,
      commit_message: `test(e2e): add ${marker}`,
    },
  );
}
