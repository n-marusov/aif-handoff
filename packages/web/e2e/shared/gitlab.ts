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

interface GitLabBranchResponse {
  name?: string;
  merged?: boolean;
  protected?: boolean;
  default?: boolean;
}

/**
 * Создаёт ветку в тестовом репозитории и коммитит в неё файл-маркер.
 *
 * Идемпотентность и устойчивость (P1.1):
 *   1. pre-check — ветка уже существует → повторно не создаётся (только коммит файла);
 *   2. при гонке/повторе создания POST может вернуть HTTP 400 — в этом случае helper
 *      делает read-after-write и переиспользует ветку, если она уже появилась;
 *   3. тело 400 от GitLab пробрасывается структурированно (`error`, `message`,
 *      `branch`, `ref`) через GitLabApiError для быстрого разбора в спеке;
 *   4. после успешного POST ветка верифицируется отдельным read-запросом.
 *
 * Возвращает эффективное имя ветки (в текущем контракте это исходное branchName);
 * вызывающий код обязан использовать возвращённое значение для последующих MR-операций.
 */
export async function createGitLabBranchWithCommit(
  request: APIRequestContext,
  branchName: string,
  marker: string,
): Promise<string> {
  const effectiveBranch = await ensureGitLabBranch(request, branchName);

  await gitLabApi(
    request,
    `/projects/${gitLabProjectPathEncoded()}/repository/files/${encodeURIComponent(`e2e/${marker}.md`)}`,
    "POST",
    {
      branch: effectiveBranch,
      content: `# ${marker}\n`,
      commit_message: `test(e2e): add ${marker}`,
    },
  );

  return effectiveBranch;
}

async function ensureGitLabBranch(request: APIRequestContext, branchName: string): Promise<string> {
  const encoded = encodeURIComponent(branchName);

  // 1) Pre-check: ветка уже существует → используем её (идемпотентность, без 400).
  const existing = await gitLabApi<GitLabBranchResponse>(
    request,
    `/projects/${gitLabProjectPathEncoded()}/repository/branches/${encoded}`,
    "GET",
  ).catch((error: unknown) => {
    if (error instanceof GitLabApiError && error.status === 404) {
      return null;
    }
    throw error;
  });
  if (existing) {
    return branchName;
  }

  // 2) Попытка создать ветку. При гонке (уже создана другим процессом) GitLab
  //    может ответить 400: в этом случае делаем read-after-write и переиспользуем
  //    ветку, если она уже существует. Без string-matching по тексту ошибки.
  try {
    await gitLabApi(
      request,
      `/projects/${gitLabProjectPathEncoded()}/repository/branches`,
      "POST",
      { branch: branchName, ref: "main" },
    );
  } catch (error) {
    if (error instanceof GitLabApiError && error.status === 400) {
      const branchAfter400 = await gitLabApi<GitLabBranchResponse>(
        request,
        `/projects/${gitLabProjectPathEncoded()}/repository/branches/${encoded}`,
        "GET",
      ).catch((readError: unknown) => {
        if (readError instanceof GitLabApiError && readError.status === 404) {
          return null;
        }
        throw readError;
      });
      if (branchAfter400) {
        return branchName;
      }
      // Всё ещё 400, но ветка не подтверждена read-after-write: добавляем
      // branch/ref в ошибку и пробрасываем для диагностики в спеке.
      throw new GitLabApiError({
        status: error.status,
        method: "POST",
        path: `/projects/${gitLabProjectPathEncoded()}/repository/branches`,
        bodyText: error.bodyText,
        payload: {
          ...(error.payload ?? {}),
          branch: branchName,
          ref: "main",
        },
      });
    }
    throw error;
  }

  // 4) Read-верификация созданной ветки (fail-fast при рассинхроне).
  const created = await gitLabApi<GitLabBranchResponse>(
    request,
    `/projects/${gitLabProjectPathEncoded()}/repository/branches/${encodeURIComponent(branchName)}`,
    "GET",
  ).catch((error: unknown) => {
    if (error instanceof GitLabApiError && error.status === 404) {
      throw new Error(
        `branch ${branchName} was not created (GitLab returned 404 on read-verification after POST)`,
      );
    }
    throw error;
  });
  if (!created) {
    throw new Error(`branch ${branchName} read-verification returned no payload`);
  }

  return branchName;
}
