import { createHash } from "node:crypto";
import { logger, type GitLabEligibility, type GitLabIssueSnapshot } from "@aif/shared";

const log = logger("gitlab-api");

export class GitLabApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly adapterCode:
      | "authentication"
      | "forbidden"
      | "not_found"
      | "rate_limited"
      | "validation"
      | "upstream",
    readonly retryAt: string | null = null,
  ) {
    super(message);
    this.name = "GitLabApiError";
  }
}

interface GitLabProjectResponse {
  id: number;
  path_with_namespace: string;
  web_url: string;
  default_branch: string;
}

interface GitLabIssueResponse {
  id: number;
  iid: number;
  web_url: string;
  state: "opened" | "closed";
  title: string;
  description: string | null;
  author: { username: string } | null;
  labels: Array<{ name?: string } | string>;
  assignees: Array<{ username: string }>;
  milestone: { title: string } | null;
  updated_at: string;
}

interface GitLabNoteResponse {
  id: number;
  body: string | null;
  author: { username: string } | null;
  created_at: string;
  updated_at: string;
}

export interface GitLabMergeRequestResponse {
  iid: number;
  web_url: string;
  state: "opened" | "closed" | "merged" | "locked";
  merged_at: string | null;
  source_branch: string;
  sha: string;
  description: string | null;
}

interface GitLabApprovalResponse {
  approved: boolean;
  approved_by: Array<{ user: { username: string } }>;
}

interface GitLabCommitStatusResponse {
  status: "pending" | "running" | "success" | "failed" | "canceled" | "skipped";
  allow_failure: boolean;
}

type GitLabCheckState = "pending" | "success" | "failure" | null;

const SUCCESSFUL_STATUSES = new Set(["success", "canceled", "skipped"]);

function retryAtFromHeaders(headers: Headers): string | null {
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return new Date(Date.now() + retryAfter * 1000).toISOString();
  }
  const rateLimitReset = headers.get("ratelimit-reset");
  const resetSeconds = Number(rateLimitReset);
  return Number.isFinite(resetSeconds) && resetSeconds > 0
    ? new Date(resetSeconds * 1000).toISOString()
    : null;
}

function classifyHttpError(status: number): GitLabApiError["adapterCode"] {
  if (status === 401) return "authentication";
  if (status === 404) return "not_found";
  if (status === 422) return "validation";
  if (status === 429) return "rate_limited";
  if (status === 403) return "forbidden";
  return "upstream";
}

/**
 * GitLab project-scoped requests use either the numeric project id or the
 * URL-encoded `namespace%2Fname` path. We use the encoded path so sync/publish
 * flows never need an extra resolution request after connect validates it.
 */
function projectPath(namespace: string, name: string): string {
  return encodeURIComponent(`${namespace}/${name}`);
}

export class GitLabClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl: string,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? "GET";
    log.debug({ method, path, baseUrl: this.baseUrl }, "GitLab API request started");
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
      headers: {
        "PRIVATE-TOKEN": this.token,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;
      const code = classifyHttpError(response.status);
      const message =
        (typeof payload?.message === "string" && payload.message) ||
        (typeof payload?.message === "object" && payload.message !== null
          ? JSON.stringify(payload.message)
          : response.statusText);
      log.warn(
        { method, path, status: response.status, adapterCode: code },
        "GitLab API request failed",
      );
      throw new GitLabApiError(
        `GitLab API ${response.status}: ${message}`,
        response.status,
        code,
        code === "rate_limited" ? retryAtFromHeaders(response.headers) : null,
      );
    }
    log.debug({ method, path, status: response.status }, "GitLab API request completed");
    return (await response.json()) as T;
  }

  private async list<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const pageItems = await this.request<T[]>(`${path}${separator}per_page=100&page=${page}`);
      items.push(...pageItems);
      if (pageItems.length < 100) return items;
    }
  }

  /** Validate a namespace/name path on connect — returns the remote project. */
  getRepository(path: string): Promise<GitLabProjectResponse> {
    return this.request(`/projects/${encodeURIComponent(path)}`);
  }

  listIssues(namespace: string, name: string): Promise<GitLabIssueResponse[]> {
    const project = projectPath(namespace, name);
    return this.list<GitLabIssueResponse>(
      `/projects/${project}/issues?scope=all&state=opened&order_by=updated_at`,
    );
  }

  listIssueNotes(namespace: string, name: string, iid: number): Promise<GitLabNoteResponse[]> {
    const project = projectPath(namespace, name);
    return this.list(`/projects/${project}/issues/${iid}/notes`);
  }

  listMergeRequestNotes(
    namespace: string,
    name: string,
    mrIid: number,
  ): Promise<GitLabNoteResponse[]> {
    const project = projectPath(namespace, name);
    return this.list(`/projects/${project}/merge_requests/${mrIid}/notes`);
  }

  listMergeRequests(namespace: string, name: string): Promise<GitLabMergeRequestResponse[]> {
    const project = projectPath(namespace, name);
    return this.list(`/projects/${project}/merge_requests?state=all`);
  }

  getMergeRequest(
    namespace: string,
    name: string,
    mrIid: number,
  ): Promise<GitLabMergeRequestResponse> {
    const project = projectPath(namespace, name);
    return this.request(`/projects/${project}/merge_requests/${mrIid}`);
  }

  findMergeRequest(
    namespace: string,
    name: string,
    branch: string,
  ): Promise<GitLabMergeRequestResponse | null> {
    const project = projectPath(namespace, name);
    const rows = this.list<GitLabMergeRequestResponse>(
      `/projects/${project}/merge_requests?state=all&source_branch=${encodeURIComponent(branch)}`,
    );
    return rows.then((items) => items[0] ?? null);
  }

  createMergeRequest(input: {
    namespace: string;
    name: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
  }): Promise<GitLabMergeRequestResponse> {
    const project = projectPath(input.namespace, input.name);
    return this.request(`/projects/${project}/merge_requests`, {
      method: "POST",
      body: JSON.stringify({
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
        description: input.description,
        remove_source_branch: false,
      }),
    });
  }

  updateMergeRequest(input: {
    namespace: string;
    name: string;
    mrIid: number;
    title: string;
    description: string;
  }): Promise<GitLabMergeRequestResponse> {
    const project = projectPath(input.namespace, input.name);
    return this.request(`/projects/${project}/merge_requests/${input.mrIid}`, {
      method: "PUT",
      body: JSON.stringify({ title: input.title, description: input.description }),
    });
  }

  async getMergeRequestApprovals(
    namespace: string,
    name: string,
    mrIid: number,
  ): Promise<{ reviewState: "pending" | "approved" }> {
    const project = projectPath(namespace, name);
    const approvals = await this.request<GitLabApprovalResponse>(
      `/projects/${project}/merge_requests/${mrIid}/approvals`,
    );
    return { reviewState: latestReviewState(approvals).state };
  }

  async getCommitChecks(namespace: string, name: string, sha: string): Promise<GitLabCheckState> {
    const project = projectPath(namespace, name);
    const statuses = await this.list<GitLabCommitStatusResponse>(
      `/projects/${project}/repository/commits/${encodeURIComponent(sha)}/statuses`,
    );
    const blockingStates: Exclude<GitLabCheckState, null>[] = [];
    for (const status of statuses) {
      if (status.status === "failed") {
        blockingStates.push(status.allow_failure ? "success" : "failure");
      } else if (SUCCESSFUL_STATUSES.has(status.status)) {
        blockingStates.push("success");
      } else {
        blockingStates.push("pending");
      }
    }
    const result: GitLabCheckState = blockingStates.includes("failure")
      ? "failure"
      : blockingStates.includes("pending")
        ? "pending"
        : blockingStates.includes("success")
          ? "success"
          : null;
    log.debug(
      { namespace, name, sha, statusCount: statuses.length, result },
      "Folded GitLab commit statuses",
    );
    return result;
  }

  async upsertMarkerNote(input: {
    namespace: string;
    name: string;
    mrIid: number;
    marker: string;
    body: string;
  }): Promise<void> {
    const notes = await this.listMergeRequestNotes(input.namespace, input.name, input.mrIid);
    const existing = notes.find((note) => note.body?.includes(input.marker));
    const body = `${input.marker}\n${input.body}`;
    if (existing) {
      await this.request(
        `/projects/${projectPath(input.namespace, input.name)}/merge_requests/${input.mrIid}/notes/${existing.id}`,
        { method: "PUT", body: JSON.stringify({ body }) },
      );
      return;
    }
    await this.request(
      `/projects/${projectPath(input.namespace, input.name)}/merge_requests/${input.mrIid}/notes`,
      {
        method: "POST",
        body: JSON.stringify({ body }),
      },
    );
  }
}

export function issueIsEligible(
  issue: GitLabIssueResponse,
  eligibility: GitLabEligibility,
): boolean {
  const labels = (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((label): label is string => Boolean(label));
  const hasLabels = eligibility.labels.every((required) => labels.includes(required));
  const hasAssignee = eligibility.assignee
    ? (issue.assignees ?? []).some((assignee) => assignee.username === eligibility.assignee)
    : true;
  const hasMilestone = eligibility.milestone
    ? issue.milestone?.title === eligibility.milestone
    : true;
  return issue.state === "opened" && hasLabels && hasAssignee && hasMilestone;
}

export function findMergeRequestClosingIssue(
  mergeRequests: GitLabMergeRequestResponse[],
  iid: number,
): GitLabMergeRequestResponse | null {
  const closingReference = new RegExp(
    `\\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\\s+#${iid}(?!\\d)`,
    "i",
  );
  return (
    mergeRequests.find((mr) => mr.description && closingReference.test(mr.description)) ?? null
  );
}

export async function toIssueSnapshot(
  client: GitLabClient,
  namespace: string,
  name: string,
  issue: GitLabIssueResponse,
): Promise<GitLabIssueSnapshot> {
  const notes = await client.listIssueNotes(namespace, name, issue.iid);
  return {
    title: issue.title,
    body: issue.description ?? "",
    author: issue.author?.username ?? "unknown",
    labels: (issue.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label.name))
      .filter((label): label is string => Boolean(label)),
    assignees: (issue.assignees ?? []).map((assignee) => assignee.username),
    milestone: issue.milestone?.title ?? null,
    comments: notes.slice(-100).map((note) => ({
      id: note.id,
      author: note.author?.username ?? "unknown",
      body: note.body ?? "",
      webUrl: issue.web_url,
      createdAt: note.created_at,
      updatedAt: note.updated_at,
    })),
  };
}

export function reviewFingerprint(reviewComments: string): string {
  return createHash("sha256").update(reviewComments).digest("hex");
}

/** Approvals-only review state: approved ⇔ approvals.approved === true; otherwise pending. No changes_requested in v1. */
export function latestReviewState(approvals: GitLabApprovalResponse): {
  state: "pending" | "approved";
} {
  return { state: approvals.approved ? "approved" : "pending" };
}
