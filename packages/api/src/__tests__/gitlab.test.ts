import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { projects, resetEnvCache } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return { ...actual, getDb: () => testDb.current };
});

const { gitlabRouter } = await import("../routes/gitlab.js");
const { GitLabClient, findMergeRequestClosingIssue, issueIsEligible } =
  await import("../services/gitlab.js");
const {
  deleteTask,
  findGitLabIssue,
  findTaskById,
  importGitLabIssueTask,
  updateTaskStatus,
  upsertGitLabRepository,
} = await import("@aif/data");

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  testDb.current = createTestDb();
  testDb.current
    .insert(projects)
    .values({ id: "project-1", name: "Repo", rootPath: "/tmp/repo" })
    .run();
  vi.stubEnv("GITLAB_TEST_TOKEN", "secret-token");
  vi.stubEnv("GIT_PROVIDER", "gitlab");
  vi.stubEnv("AIF_GITLAB_ISSUE_MR_ENABLED", "true");
  resetEnvCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEnvCache();
});

describe("GitLab client", () => {
  it("classifies rate limits from structured HTTP fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { message: "limit" },
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "60",
            },
          },
        ),
      ),
    );

    await expect(
      new GitLabClient("secret", "https://gitlab.com/api/v4").getRepository("owner/repo"),
    ).rejects.toMatchObject({
      httpStatus: 429,
      adapterCode: "rate_limited",
    });
  });

  it("retries transient DNS/network failures then succeeds", async () => {
    const eaiAgain = new TypeError("fetch failed");
    (eaiAgain as { cause?: { code?: string } }).cause = { code: "EAI_AGAIN" };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(eaiAgain)
      .mockRejectedValueOnce(eaiAgain)
      .mockResolvedValue(
        jsonResponse({
          id: 1,
          path_with_namespace: "owner/repo",
          web_url: "https://gitlab.com/owner/repo",
          default_branch: "main",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const repo = await new GitLabClient("secret", "https://gitlab.com/api/v4").getRepository(
      "owner/repo",
    );

    expect(repo.path_with_namespace).toBe("owner/repo");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it("gives up after retries when the network error persists", async () => {
    const eaiAgain = new TypeError("fetch failed");
    (eaiAgain as { cause?: { code?: string } }).cause = { code: "EAI_AGAIN" };
    const fetchMock = vi.fn().mockRejectedValue(eaiAgain);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GitLabClient("secret", "https://gitlab.com/api/v4").getRepository("owner/repo"),
    ).rejects.toMatchObject({ message: "fetch failed" });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    vi.unstubAllGlobals();
  });

  it("surfaces GitLab error_description for scope denials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: "insufficient_granular_scope",
            error_description: "Access denied: requires fine-grained PAT with [User: Read]",
          },
          { status: 403 },
        ),
      ),
    );

    await expect(
      new GitLabClient("secret", "https://gitlab.com/api/v4").getRepository("owner/repo"),
    ).rejects.toMatchObject({
      httpStatus: 403,
      adapterCode: "forbidden",
      message:
        "GitLab API 403: insufficient_granular_scope: Access denied: requires fine-grained PAT with [User: Read]",
    });
    vi.unstubAllGlobals();
  });

  it("applies label, assignee, and milestone eligibility", () => {
    expect(
      issueIsEligible(
        {
          id: 1,
          iid: 1,
          web_url: "https://gitlab.com/o/r/-/issues/1",
          state: "opened",
          title: "Task",
          description: "",
          author: { username: "author" },
          labels: [{ name: "aif" }],
          assignees: [{ username: "bot" }],
          milestone: { title: "v1" },
          updated_at: "2026-08-13T00:00:00Z",
        },
        { labels: ["aif"], assignee: "bot", milestone: "v1" },
      ),
    ).toBe(true);
  });

  it("folds commit statuses with allow_failure into a tri-state check result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          { status: "failed", allow_failure: true },
          { status: "success", allow_failure: false },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { status: "running", allow_failure: false },
          { status: "pending", allow_failure: true },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { status: "canceled", allow_failure: false },
          { status: "skipped", allow_failure: false },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitLabClient("secret", "https://gitlab.com/api/v4");
    // failed && allow_failure folds like success alongside an explicit success
    await expect(client.getCommitChecks("namespace", "repo", "abc")).resolves.toBe("success");
    // pending/running always folds to pending
    await expect(client.getCommitChecks("namespace", "repo", "abc")).resolves.toBe("pending");
    // canceled/skipped fold like success
    await expect(client.getCommitChecks("namespace", "repo", "abc")).resolves.toBe("success");
    // empty statuses → null
    await expect(client.getCommitChecks("namespace", "repo", "abc")).resolves.toBeNull();
  });

  it.each([
    ["pending", "pending"],
    ["approved", "approved"],
  ] as const)("maps approvals to reviewState %s", async (approvedValue, expectedReviewState) => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        approved: approvedValue === "approved",
        approved_by: approvedValue === "approved" ? [{ user: { username: "reviewer" } }] : [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitLabClient("secret", "https://gitlab.com/api/v4");
    const state = await client.getMergeRequestApprovals("namespace", "repo", 7);
    expect(state.reviewState).toBe(expectedReviewState);
  });

  it.each([
    [401, "authentication"],
    [404, "not_found"],
    [422, "validation"],
    [403, "forbidden"],
    [500, "upstream"],
  ] as const)("classifies HTTP %s as %s", async (status, expectedCode) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ message: "boom" }, { status })),
    );
    await expect(
      new GitLabClient("secret", "https://gitlab.com/api/v4").getRepository("owner/repo"),
    ).rejects.toMatchObject({ httpStatus: status, adapterCode: expectedCode });
  });

  it("uses Retry-After from the ratelimit-reset header when retry-after is absent", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 300;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { message: "limit" },
          {
            status: 429,
            headers: { "Content-Type": "application/json", "Ratelimit-Reset": String(resetAt) },
          },
        ),
      ),
    );
    await expect(
      new GitLabClient("secret", "https://gitlab.com/api/v4").getRepository("owner/repo"),
    ).rejects.toMatchObject({ adapterCode: "rate_limited" });
  });

  it("serializes object error messages from the upstream payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ message: { base: ["Repository is missing"] } }, { status: 404 }),
        ),
    );
    await expect(
      new GitLabClient("secret", "https://gitlab.com/api/v4").getRepository("owner/repo"),
    ).rejects.toMatchObject({
      adapterCode: "not_found",
      httpStatus: 404,
    });
  });

  it("updates an existing marker note in place instead of creating a new one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ id: 99, body: "<!-- aif-gitlab-review -->\nOld text", author: null }]),
      )
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitLabClient("secret", "https://gitlab.com/api/v4");
    await client.upsertMarkerNote({
      namespace: "namespace",
      name: "repo",
      mrIid: 7,
      marker: "<!-- aif-gitlab-review -->",
      body: "New review text",
    });

    const putCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(putCalls).toHaveLength(1);
    expect(String(putCalls[0]![0])).toContain("/notes/99");
  });

  it("rejects an issue when labels, assignee, or milestone do not match eligibility", () => {
    const issue = {
      id: 1,
      iid: 1,
      web_url: "https://gitlab.com/o/r/-/issues/1",
      state: "opened" as const,
      title: "Task",
      description: "",
      author: { username: "author" },
      labels: [{ name: "other" }],
      assignees: [{ username: "someone-else" }],
      milestone: { title: "v2" },
      updated_at: "2026-08-13T00:00:00Z",
    };
    expect(issueIsEligible(issue, { labels: ["aif"], assignee: "bot", milestone: "v1" })).toBe(
      false,
    );
    // No filters means everything passes even without matching labels/assignees/milestone.
    expect(issueIsEligible(issue, { labels: [], assignee: null, milestone: null })).toBe(true);
  });

  it("returns null when no merge request closes the issue", () => {
    const closing = findMergeRequestClosingIssue(
      [{ iid: 1, description: "Closes #2" }] as never,
      99,
    );
    expect(closing).toBeNull();
  });
});

describe("GitLab project routes", () => {
  it("rejects GitLab routes while the rollout flag is disabled", async () => {
    vi.stubEnv("AIF_GITLAB_ISSUE_MR_ENABLED", "false");
    resetEnvCache();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/projects", gitlabRouter);

    const response = await app.request("/projects/project-1/gitlab", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository: "namespace/repo", tokenEnvVar: "GITLAB_TEST_TOKEN" }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "feature_disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects GitLab routes when GIT_PROVIDER is github", async () => {
    vi.stubEnv("GIT_PROVIDER", "github");
    resetEnvCache();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/projects", gitlabRouter);

    const response = await app.request("/projects/project-1/gitlab", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository: "namespace/repo", tokenEnvVar: "GITLAB_TEST_TOKEN" }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "feature_disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes GitLab routes when both routers are mounted and GIT_PROVIDER is gitlab", async () => {
    // Regression: with GIT_PROVIDER=gitlab and GitHub mounted BEFORE GitLab
    // (as in src/index.ts), the GitHub gate must NOT intercept GitLab paths.
    const { githubRouter } = await import("../routes/github.js");
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 1,
        path_with_namespace: "namespace/repo",
        web_url: "https://gitlab.com/namespace/repo",
        default_branch: "main",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/projects", githubRouter);
    app.route("/projects", gitlabRouter);

    // GitLab connect must reach the GitLab route (not be blocked by GitHub gate).
    const response = await app.request("/projects/project-1/gitlab", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository: "namespace/repo", tokenEnvVar: "GITLAB_TEST_TOKEN" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ namespace: "namespace", name: "repo" });

    // GitHub paths must still be blocked when the provider is gitlab.
    const githubResponse = await app.request("/projects/project-1/github", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository: "owner/repo", tokenEnvVar: "GITHUB_TEST_TOKEN" }),
    });
    expect(githubResponse.status).toBe(403);
    expect(await githubResponse.json()).toMatchObject({ code: "feature_disabled" });
  });

  it("connects a repository and performs an idempotent empty sync", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 1,
          path_with_namespace: "namespace/repo",
          web_url: "https://gitlab.com/namespace/repo",
          default_branch: "main",
        }),
      )
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/projects", gitlabRouter);

    const connected = await app.request("/projects/project-1/gitlab", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository: "namespace/repo",
        tokenEnvVar: "GITLAB_TEST_TOKEN",
        enabled: true,
        eligibility: { labels: ["aif"], assignee: null, milestone: null },
      }),
    });
    expect(connected.status).toBe(200);
    expect(await connected.json()).toMatchObject({
      namespace: "namespace",
      name: "repo",
      tokenConfigured: true,
    });

    const synced = await app.request("/projects/project-1/gitlab/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(synced.status).toBe(200);
    expect(await synced.json()).toMatchObject({ imported: 0, updated: 0, skipped: 0 });
  });

  it("connects a repository in a nested subgroup and syncs using the full namespace path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 2,
          path_with_namespace: "group/subgroup/repo",
          web_url: "https://gitlab.com/group/subgroup/repo",
          default_branch: "main",
        }),
      )
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/projects", gitlabRouter);

    const connected = await app.request("/projects/project-1/gitlab", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository: "group/subgroup/repo",
        tokenEnvVar: "GITLAB_TEST_TOKEN",
        enabled: true,
        eligibility: { labels: [], assignee: null, milestone: null },
      }),
    });
    expect(connected.status).toBe(200);
    expect(await connected.json()).toMatchObject({
      namespace: "group/subgroup",
      name: "repo",
      tokenConfigured: true,
    });

    // Sync must hit the URL-encoded full namespace path, not a truncated one.
    const synced = await app.request("/projects/project-1/gitlab/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(synced.status).toBe(200);
    expect(fetchMock.mock.calls[1]![0]).toContain("group%2Fsubgroup%2Frepo");
  });

  it("rejects a connection when its credential environment variable is absent", async () => {
    vi.stubEnv("GITLAB_MISSING_TOKEN", "");
    const app = new Hono();
    app.route("/projects", gitlabRouter);
    const response = await app.request("/projects/project-1/gitlab", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository: "namespace/repo", tokenEnvVar: "GITLAB_MISSING_TOKEN" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "gitlab_authentication" });
  });

  it.each([
    { approved: false, expectedReviewState: "pending", expectedStatus: "done" },
    { approved: true, expectedReviewState: "approved", expectedStatus: "done" },
  ] as const)(
    "imports an issue with a closing MR when approvals are approved=$approved",
    async ({ approved, expectedReviewState, expectedStatus }) => {
      upsertGitLabRepository({
        projectId: "project-1",
        namespace: "namespace",
        name: "repo",
        webUrl: "https://gitlab.com/namespace/repo",
        defaultBranch: "main",
        tokenEnvVar: "GITLAB_TEST_TOKEN",
        eligibility: { labels: [], assignee: null, milestone: null },
        enabled: true,
      });
      const mergeRequest = {
        iid: 200,
        web_url: "https://gitlab.com/namespace/repo/-/merge_requests/200",
        state: "opened",
        merged_at: null,
        source_branch: "feature/gitlab-issue-154",
        sha: "0123456789abcdef",
        description: "Closes #154",
      };
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(
            jsonResponse([
              {
                id: 1000,
                iid: 154,
                global_id: "gid://gitlab/Issue/1000",
                web_url: "https://gitlab.com/namespace/repo/-/issues/154",
                state: "opened",
                title: "GitLab mode",
                description: "Implement it",
                author: { username: "author" },
                labels: [],
                assignees: [],
                milestone: null,
                updated_at: "2026-08-13T00:00:00Z",
              },
            ]),
          )
          .mockResolvedValueOnce(jsonResponse([mergeRequest]))
          .mockResolvedValueOnce(jsonResponse([])) // issue notes
          .mockResolvedValueOnce(jsonResponse({ approved, approved_by: [] }))
          .mockResolvedValueOnce(jsonResponse([{ status: "success", allow_failure: false }])),
      );
      const app = new Hono();
      app.route("/projects", gitlabRouter);

      const response = await app.request("/projects/project-1/gitlab/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await response.json()) as { issues: Array<{ taskId: string }> };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ imported: 1, updated: 0, skipped: 0 });
      expect(findTaskById(body.issues[0]!.taskId)?.status).toBe(expectedStatus);
      expect(findGitLabIssue("project-1", 154)).toMatchObject({
        mrIid: 200,
        mrUrl: mergeRequest.web_url,
        mrState: "open",
        reviewState: expectedReviewState,
      });
    },
  );

  it("skips closed orphaned issues and links merge requests to existing tasks", async () => {
    upsertGitLabRepository({
      projectId: "project-1",
      namespace: "namespace",
      name: "repo",
      webUrl: "https://gitlab.com/namespace/repo",
      defaultBranch: "main",
      tokenEnvVar: "GITLAB_TEST_TOKEN",
      eligibility: { labels: [], assignee: null, milestone: null },
      enabled: true,
    });
    const closed = importGitLabIssueTask({
      projectId: "project-1",
      namespace: "namespace",
      repository: "repo",
      iid: 168,
      globalId: "gid://gitlab/Issue/168",
      webUrl: "https://gitlab.com/namespace/repo/-/issues/168",
      state: "open",
      sourceUpdatedAt: "2026-08-12T00:00:00Z",
      snapshot: {
        title: "Already completed",
        body: "Done elsewhere",
        author: "author",
        labels: [],
        assignees: [],
        milestone: null,
        comments: [],
      },
    });
    const open = importGitLabIssueTask({
      projectId: "project-1",
      namespace: "namespace",
      repository: "repo",
      iid: 154,
      globalId: "gid://gitlab/Issue/154",
      webUrl: "https://gitlab.com/namespace/repo/-/issues/154",
      state: "open",
      sourceUpdatedAt: "2026-08-12T00:00:00Z",
      snapshot: {
        title: "GitLab mode",
        body: "Implement it",
        author: "author",
        labels: [],
        assignees: [],
        milestone: null,
        comments: [],
      },
    });
    deleteTask(closed.taskId);

    const mergeRequest = {
      iid: 200,
      web_url: "https://gitlab.com/namespace/repo/-/merge_requests/200",
      state: "opened",
      merged_at: null,
      source_branch: "feature/gitlab-issue-154",
      sha: "0123456789abcdef",
      description: "Closes #154",
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse([
            {
              id: 168,
              iid: 168,
              global_id: "gid://gitlab/Issue/168",
              web_url: "https://gitlab.com/namespace/repo/-/issues/168",
              state: "closed",
              title: "Already completed",
              description: "Done elsewhere",
              author: { username: "author" },
              labels: [],
              assignees: [],
              milestone: null,
              updated_at: "2026-08-13T00:00:00Z",
            },
            {
              id: 154,
              iid: 154,
              global_id: "gid://gitlab/Issue/154",
              web_url: "https://gitlab.com/namespace/repo/-/issues/154",
              state: "opened",
              title: "GitLab mode",
              description: "Implement it",
              author: { username: "author" },
              labels: [],
              assignees: [],
              milestone: null,
              updated_at: "2026-08-13T00:00:00Z",
            },
          ]),
        )
        .mockResolvedValueOnce(jsonResponse([mergeRequest]))
        .mockResolvedValueOnce(jsonResponse([])) // issue notes
        .mockResolvedValueOnce(jsonResponse({ approved: false, approved_by: [] }))
        .mockResolvedValueOnce(jsonResponse([{ status: "success", allow_failure: false }])),
    );
    const app = new Hono();
    app.route("/projects", gitlabRouter);

    const response = await app.request("/projects/project-1/gitlab/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ imported: 0, updated: 1, skipped: 1 });
    expect(findGitLabIssue("project-1", 168)?.taskId).toBeNull();
    expect(findTaskById(closed.taskId)).toBeUndefined();
    const linked = findGitLabIssue("project-1", 154);
    expect(linked).toMatchObject({ mrIid: 200, mrState: "open" });
    expect(linked?.taskId).toBe(open.taskId);
    expect(findTaskById(open.taskId)?.status).toBe("done");
  });

  it("rejects a connection when its token environment variable lacks the GITLAB_ prefix", async () => {
    const app = new Hono();
    app.route("/projects", gitlabRouter);
    const response = await app.request("/projects/project-1/gitlab", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository: "namespace/repo", tokenEnvVar: "MY_TOKEN" }),
    });
    // The connect schema rejects non-GITLAB_* token env var names with 400.
    expect(response.status).toBe(400);
  });

  it("returns 404 for a missing project on GET and missing connection on DELETE", async () => {
    const app = new Hono();
    app.route("/projects", gitlabRouter);

    const missingGet = await app.request("/projects/missing/gitlab");
    expect(missingGet.status).toBe(404);

    const deleteResponse = await app.request("/projects/project-1/gitlab", { method: "DELETE" });
    expect(deleteResponse.status).toBe(404);
    expect(await deleteResponse.json()).toMatchObject({
      error: "GitLab connection not found",
    });
  });

  it("returns 404 when syncing without a connection and returns zeros when the connection is disabled", async () => {
    const app = new Hono();
    app.route("/projects", gitlabRouter);

    const noConnection = await app.request("/projects/project-1/gitlab/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(noConnection.status).toBe(404);

    upsertGitLabRepository({
      projectId: "project-1",
      namespace: "namespace",
      name: "repo",
      webUrl: "https://gitlab.com/namespace/repo",
      defaultBranch: "main",
      tokenEnvVar: "GITLAB_TEST_TOKEN",
      eligibility: { labels: [], assignee: null, milestone: null },
      enabled: false,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const disabled = await app.request("/projects/project-1/gitlab/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ imported: 0, updated: 0, skipped: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks the task verified when the merge request is merged and pauses it when closed unmerged", async () => {
    upsertGitLabRepository({
      projectId: "project-1",
      namespace: "namespace",
      name: "repo",
      webUrl: "https://gitlab.com/namespace/repo",
      defaultBranch: "main",
      tokenEnvVar: "GITLAB_TEST_TOKEN",
      eligibility: { labels: [], assignee: null, milestone: null },
      enabled: true,
    });
    const imported = importGitLabIssueTask({
      projectId: "project-1",
      namespace: "namespace",
      repository: "repo",
      iid: 154,
      globalId: "gid://gitlab/Issue/154",
      webUrl: "https://gitlab.com/namespace/repo/-/issues/154",
      state: "open",
      sourceUpdatedAt: "2026-08-13T00:00:00Z",
      snapshot: {
        title: "GitLab mode",
        body: "Implement it",
        author: "author",
        labels: [],
        assignees: [],
        milestone: null,
        comments: [],
      },
      mergeRequest: {
        iid: 200,
        url: "https://gitlab.com/namespace/repo/-/merge_requests/200",
        state: "open",
      },
    });
    updateTaskStatus(
      imported.taskId,
      "done",
      {},
      { kind: "system", id: "test", displayNameSnapshot: "Test" },
    );
    const app = new Hono();
    app.route("/projects", gitlabRouter);

    // Merged MR → verified
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse([
            {
              id: 154,
              iid: 154,
              global_id: "gid://gitlab/Issue/154",
              web_url: "https://gitlab.com/namespace/repo/-/issues/154",
              state: "opened",
              title: "GitLab mode",
              description: "Implement it",
              author: { username: "author" },
              labels: [],
              assignees: [],
              milestone: null,
              updated_at: "2026-08-13T00:00:00Z",
            },
          ]),
        )
        .mockResolvedValueOnce(jsonResponse([])) // issue notes
        .mockResolvedValueOnce(
          jsonResponse({
            iid: 200,
            web_url: "https://gitlab.com/namespace/repo/-/merge_requests/200",
            state: "merged",
            merged_at: "2026-08-13T12:00:00Z",
            source_branch: "feature/gitlab-issue-154",
            sha: "0123456789abcdef",
            description: "Closes #154",
          }),
        ) // getMergeRequest (existing.mrIid path)
        .mockResolvedValueOnce(jsonResponse({ approved: false, approved_by: [] }))
        .mockResolvedValueOnce(jsonResponse([{ status: "success", allow_failure: false }])),
    );

    await app.request("/projects/project-1/gitlab/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(findTaskById(imported.taskId)?.status).toBe("verified");

    // Closed unmerged MR → paused
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse([
            {
              id: 154,
              iid: 154,
              global_id: "gid://gitlab/Issue/154",
              web_url: "https://gitlab.com/namespace/repo/-/issues/154",
              state: "opened",
              title: "GitLab mode",
              description: "Implement it",
              author: { username: "author" },
              labels: [],
              assignees: [],
              milestone: null,
              updated_at: "2026-08-13T00:00:00Z",
            },
          ]),
        )
        .mockResolvedValueOnce(jsonResponse([])) // issue notes
        .mockResolvedValueOnce(
          jsonResponse({
            iid: 200,
            web_url: "https://gitlab.com/namespace/repo/-/merge_requests/200",
            state: "closed",
            merged_at: null,
            source_branch: "feature/gitlab-issue-154",
            sha: "0123456789abcdef",
            description: "Closes #154",
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ approved: false, approved_by: [] }))
        .mockResolvedValueOnce(jsonResponse([{ status: "success", allow_failure: false }])),
    );

    await app.request("/projects/project-1/gitlab/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(findTaskById(imported.taskId)?.paused).toBe(true);
  });

  it("returns 404 when publishing for an unlinked task", async () => {
    const app = new Hono();
    app.route("/projects", gitlabRouter);
    const response = await app.request("/projects/project-1/gitlab/tasks/task-unknown/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feature/x", commitSha: "0123456789abcdef" }),
    });
    expect(response.status).toBe(404);
  });

  it("recovers a merge request with a 422 on create by finding the existing one", async () => {
    upsertGitLabRepository({
      projectId: "project-1",
      namespace: "namespace",
      name: "repo",
      webUrl: "https://gitlab.com/namespace/repo",
      defaultBranch: "main",
      tokenEnvVar: "GITLAB_TEST_TOKEN",
      eligibility: { labels: [], assignee: null, milestone: null },
      enabled: true,
    });
    const imported = importGitLabIssueTask({
      projectId: "project-1",
      namespace: "namespace",
      repository: "repo",
      iid: 154,
      globalId: "gid://gitlab/Issue/154",
      webUrl: "https://gitlab.com/namespace/repo/-/issues/154",
      state: "open",
      sourceUpdatedAt: "2026-08-13T00:00:00Z",
      snapshot: {
        title: "GitLab mode",
        body: "Implement it",
        author: "author",
        labels: [],
        assignees: [],
        milestone: null,
        comments: [],
      },
    });
    const mergeRequest = {
      iid: 200,
      web_url: "https://gitlab.com/namespace/repo/-/merge_requests/200",
      state: "opened",
      merged_at: null,
      source_branch: "feature/gitlab-issue-154",
      sha: "0123456789abcdef",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([])) // findMergeRequest → none
      .mockResolvedValueOnce(jsonResponse({ message: { base: ["duplicate"] } }, { status: 422 })) // create → 422
      .mockResolvedValueOnce(jsonResponse([mergeRequest])) // findMergeRequest again
      .mockResolvedValueOnce(jsonResponse(mergeRequest)) // updateMergeRequest
      .mockResolvedValueOnce(jsonResponse([])) // listMergeRequestNotes (no reviewComments → fingerprint null → skip note)
      .mockResolvedValueOnce(jsonResponse([{ status: "success", allow_failure: false }])) // statuses
      .mockResolvedValueOnce(jsonResponse({ approved: false, approved_by: [] })); // approvals
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/projects", gitlabRouter);

    const response = await app.request(
      `/projects/project-1/gitlab/tasks/${imported.taskId}/publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch: "feature/gitlab-issue-154",
          commitSha: "0123456789abcdef",
          implementationLog: "Implemented",
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mrIid: 200, mrState: "open" });
  });

  it("creates one merge request and reuses it on repeated publication", async () => {
    upsertGitLabRepository({
      projectId: "project-1",
      namespace: "namespace",
      name: "repo",
      webUrl: "https://gitlab.com/namespace/repo",
      defaultBranch: "main",
      tokenEnvVar: "GITLAB_TEST_TOKEN",
      eligibility: { labels: [], assignee: null, milestone: null },
      enabled: true,
    });
    const imported = importGitLabIssueTask({
      projectId: "project-1",
      namespace: "namespace",
      repository: "repo",
      iid: 154,
      globalId: "gid://gitlab/Issue/154",
      webUrl: "https://gitlab.com/namespace/repo/-/issues/154",
      state: "open",
      sourceUpdatedAt: "2026-08-13T00:00:00Z",
      snapshot: {
        title: "GitLab mode",
        body: "Implement it",
        author: "author",
        labels: [],
        assignees: [],
        milestone: null,
        comments: [],
      },
    });
    const mergeRequest = {
      iid: 200,
      web_url: "https://gitlab.com/namespace/repo/-/merge_requests/200",
      state: "opened",
      merged_at: null,
      source_branch: "feature/gitlab-issue-154",
      sha: "0123456789abcdef",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([])) // listMergeRequests (find existing)
      .mockResolvedValueOnce(jsonResponse(mergeRequest)) // createMergeRequest
      .mockResolvedValueOnce(jsonResponse([])) // listIssueNotes (marker lookup)
      .mockResolvedValueOnce(jsonResponse({})) // create note
      .mockResolvedValueOnce(jsonResponse([{ status: "success", allow_failure: false }])) // statuses
      .mockResolvedValueOnce(jsonResponse({ approved: false, approved_by: [] })) // approvals
      .mockResolvedValueOnce(jsonResponse(mergeRequest)) // getMergeRequest on second publish
      .mockResolvedValueOnce(jsonResponse(mergeRequest)) // updateMergeRequest
      .mockResolvedValueOnce(jsonResponse([])) // listMergeRequestNotes (marker lookup)
      .mockResolvedValueOnce(jsonResponse([{ status: "success", allow_failure: false }])) // statuses
      .mockResolvedValueOnce(jsonResponse({ approved: false, approved_by: [] })); // approvals
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/projects", gitlabRouter);
    const publish = () =>
      app.request(`/projects/project-1/gitlab/tasks/${imported.taskId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch: "feature/gitlab-issue-154",
          commitSha: "0123456789abcdef",
          implementationLog: "Implemented",
          reviewComments: "Automated review passed",
        }),
      });

    expect(await (await publish()).json()).toMatchObject({ mrIid: 200, mrState: "open" });
    expect(await (await publish()).json()).toMatchObject({ mrIid: 200, mrState: "open" });
    const createCalls = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/merge_requests") && init?.method === "POST",
    );
    const noteCalls = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).includes("/notes") && init?.method === "POST",
    );
    expect(createCalls).toHaveLength(1);
    expect(noteCalls).toHaveLength(1);
  });
});
