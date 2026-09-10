import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@aif/shared";

const { callAgentWorktreeCleanup, requestWorktreeCleanupAfterMerge, snapshotTaskWorktree } =
  await import("../services/agentInternal.js");

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

const cleanupRequest = {
  taskId: "task-1",
  projectId: "project-1",
  projectRoot: "/tmp/repo",
  branchName: "feature/github-issue-1",
  worktreePath: "/tmp/.worktrees/project-1/feature-github-issue-1",
  reason: "task_delete",
};

describe("callAgentWorktreeCleanup", () => {
  beforeEach(() => {
    vi.stubEnv("AGENT_INTERNAL_URL", "http://agent:3010");
    vi.stubEnv("INTERNAL_BROADCAST_TOKEN", "secret-token");
    resetEnvCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetEnvCache();
  });

  it("posts to the agent cleanup endpoint with internal auth and returns the result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, cleaned: true, stashSha: "abc123" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callAgentWorktreeCleanup(cleanupRequest);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://agent:3010/worktrees/cleanup");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    expect(JSON.parse(String(init.body))).toMatchObject({
      taskId: "task-1",
      reason: "task_delete",
    });
    expect(result).toMatchObject({ ok: true, cleaned: true, stashSha: "abc123" });
  });

  it("surfaces a structured agent failure without throwing (best-effort caller)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: "stash failed", code: "worktree_cleanup_stash_failed" },
            { status: 500 },
          ),
        ),
    );

    const result = await callAgentWorktreeCleanup(cleanupRequest);

    expect(result.ok).toBe(false);
    expect(result.cleaned).toBe(false);
    expect(result.errorCode).toBe("worktree_cleanup_stash_failed");
  });

  it("maps a transport failure to a stable error code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const result = await callAgentWorktreeCleanup(cleanupRequest);

    expect(result).toMatchObject({ ok: false, errorCode: "agent_internal_unavailable" });
  });

  it("reports a reference-protection skip", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ ok: true, cleaned: false, skippedDueToReference: true })),
    );

    const result = await callAgentWorktreeCleanup(cleanupRequest);

    expect(result).toMatchObject({ ok: true, cleaned: false, skippedDueToReference: true });
  });
});

describe("requestWorktreeCleanupAfterMerge", () => {
  beforeEach(() => {
    vi.stubEnv("AGENT_INTERNAL_URL", "http://agent:3010");
    resetEnvCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetEnvCache();
  });

  it("snapshots the task git identity with null-safe defaults", () => {
    expect(snapshotTaskWorktree({ id: "t1", projectId: "p1" }, "/tmp/repo")).toEqual({
      taskId: "t1",
      projectId: "p1",
      projectRoot: "/tmp/repo",
      branchName: null,
      worktreePath: null,
    });
  });

  it("skips the agent call when no worktree is recorded", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await requestWorktreeCleanupAfterMerge(
      {
        taskId: "t1",
        projectId: "p1",
        projectRoot: "/tmp/repo",
        branchName: null,
        worktreePath: null,
      },
      "PR #1",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests cleanup with a pr_merge reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, cleaned: true }));
    vi.stubGlobal("fetch", fetchMock);

    await requestWorktreeCleanupAfterMerge(
      {
        taskId: "t1",
        projectId: "p1",
        projectRoot: "/tmp/repo",
        branchName: "feature/x",
        worktreePath: "/tmp/wt",
      },
      "PR #7",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      reason: "pr_merge:PR #7",
      worktreePath: "/tmp/wt",
    });
  });

  it("never throws when the agent call fails (merge already applied)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    await expect(
      requestWorktreeCleanupAfterMerge(
        {
          taskId: "t1",
          projectId: "p1",
          projectRoot: "/tmp/repo",
          branchName: "feature/x",
          worktreePath: "/tmp/wt",
        },
        "MR !3",
      ),
    ).resolves.toBeUndefined();
  });
});
