import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@aif/shared";

const prepareForProjectMock = vi.fn();
const stashAndRemoveWorktreeMock = vi.fn();

vi.mock("../gitlabPrepare.js", () => ({
  prepareGitLabRepositoryForProject: (...args: unknown[]) => prepareForProjectMock(...args),
  GitLabPrepareError: class GitLabPrepareError extends Error {
    constructor(
      public kind: string,
      message: string,
      public projectId: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("../worktreeLifecycle.js", () => ({
  stashAndRemoveWorktree: stashAndRemoveWorktreeMock,
}));

const { createInternalApiApp } = await import("../internalApi.js");

describe("agent internal API", () => {
  let app: ReturnType<typeof createInternalApiApp>;

  beforeEach(() => {
    prepareForProjectMock.mockReset();
    stashAndRemoveWorktreeMock.mockReset();
    vi.stubEnv("GIT_PROVIDER", "gitlab");
    resetEnvCache();
    app = createInternalApiApp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("exposes /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects a prepare request without a projectId", async () => {
    const res = await app.request("/gitlab/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("runs prepare and returns gitPreparedAt", async () => {
    prepareForProjectMock.mockReturnValue({ gitPreparedAt: "2026-08-15T10:00:00.000Z" });
    const res = await app.request("/gitlab/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "project-1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      gitPreparedAt: "2026-08-15T10:00:00.000Z",
    });
    expect(prepareForProjectMock).toHaveBeenCalledWith("project-1");
  });

  it("surfaces a structured prepare failure as 422", async () => {
    const { GitLabPrepareError } = await import("../gitlabPrepare.js");
    prepareForProjectMock.mockImplementation(() => {
      throw new GitLabPrepareError("fetch_failed", "git fetch origin failed", "project-1");
    });
    const res = await app.request("/gitlab/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "project-1" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("gitlab_prepare_fetch_failed");
  });

  it("returns 401 for unauthorized requests when a token is configured", async () => {
    vi.stubEnv("INTERNAL_BROADCAST_TOKEN", "secret-token");
    resetEnvCache();
    const res = await app.request("/gitlab/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "project-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts an authorized request with the bearer token", async () => {
    vi.stubEnv("INTERNAL_BROADCAST_TOKEN", "secret-token");
    resetEnvCache();
    prepareForProjectMock.mockReturnValue({ gitPreparedAt: "2026-08-15T10:00:00.000Z" });
    const res = await app.request("/gitlab/prepare", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-token",
      },
      body: JSON.stringify({ projectId: "project-1" }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects a worktree cleanup request missing required fields", async () => {
    const res = await app.request("/worktrees/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: "t1" }),
    });
    expect(res.status).toBe(400);
    expect(stashAndRemoveWorktreeMock).not.toHaveBeenCalled();
  });

  it("runs worktree cleanup and returns the agent result", async () => {
    stashAndRemoveWorktreeMock.mockResolvedValue({ cleaned: true, stashSha: "abc123" });
    const res = await app.request("/worktrees/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: "t1",
        projectId: "p1",
        projectRoot: "/tmp/repo",
        branchName: "feature/x",
        worktreePath: "/tmp/wt",
        reason: "task_delete",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleaned: true, stashSha: "abc123" });
    expect(stashAndRemoveWorktreeMock).toHaveBeenCalledWith({
      taskId: "t1",
      projectId: "p1",
      projectRoot: "/tmp/repo",
      branchName: "feature/x",
      worktreePath: "/tmp/wt",
      reason: "task_delete",
    });
  });

  it("surfaces a cleanup failure as 500", async () => {
    stashAndRemoveWorktreeMock.mockRejectedValue(new Error("boom"));
    const res = await app.request("/worktrees/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: "t1", projectId: "p1", projectRoot: "/tmp/repo" }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()) as { code?: string }).toMatchObject({
      code: "worktree_cleanup_internal",
    });
  });
});
