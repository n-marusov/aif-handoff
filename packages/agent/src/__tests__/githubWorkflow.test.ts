import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listRepositoriesMock = vi.fn();
const findGitHubIssueMock = vi.fn();
const appendActivityLogMock = vi.fn();
const findTaskMock = vi.fn();
const ensureAutoQueueCommitMock = vi.fn();
const execFileSyncMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

vi.mock("@aif/data", () => ({
  appendTaskActivityLog: (...args: unknown[]) => appendActivityLogMock(...args),
  findGitHubIssueByTaskId: (...args: unknown[]) => findGitHubIssueMock(...args),
  findTaskById: (...args: unknown[]) => findTaskMock(...args),
  listEnabledGitHubRepositories: (...args: unknown[]) => listRepositoriesMock(...args),
}));

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return { ...actual, getEnv: () => actual.validateEnv(process.env) };
});

vi.mock("../autoQueueCommit.js", () => ({
  ensureAutoQueueTaskCommit: (...args: unknown[]) => ensureAutoQueueCommitMock(...args),
}));

const { synchronizeGitHubProjects, publishGitHubTask, publishGitHubPlanTask } =
  await import("../githubWorkflow.js");
const { StageManualBlockError } = await import("../stageErrorHandler.js");

describe("GitHub workflow synchronization", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv("API_BASE_URL", "http://localhost:3999");
    vi.stubEnv("AIF_GITHUB_ISSUE_PR_ENABLED", "true");
    listRepositoriesMock.mockClear();
    findGitHubIssueMock.mockClear();
    listRepositoriesMock.mockReturnValue([
      { projectId: "project-1", lastSyncedAt: null },
      { projectId: "project-2", lastSyncedAt: "2026-08-08T09:59:40.000Z" },
    ]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("syncs due repositories once per interval", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as typeof fetch;

    await synchronizeGitHubProjects(Date.parse("2026-08-08T10:00:00.000Z"));
    await synchronizeGitHubProjects(Date.parse("2026-08-08T10:00:10.000Z"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3999/projects/project-1/github/sync",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("does not inspect repositories or call GitHub paths while the rollout flag is disabled", async () => {
    vi.stubEnv("AIF_GITHUB_ISSUE_PR_ENABLED", "false");
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;

    await synchronizeGitHubProjects(Date.parse("2026-08-08T11:00:00.000Z"));

    expect(listRepositoriesMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not inspect repositories or call GitHub paths when GIT_PROVIDER is gitlab", async () => {
    vi.stubEnv("GIT_PROVIDER", "gitlab");
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;

    await synchronizeGitHubProjects(Date.parse("2026-08-08T11:00:00.000Z"));

    expect(listRepositoriesMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GitHub workflow publication", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv("API_BASE_URL", "http://localhost:3999");
    vi.stubEnv("GIT_PROVIDER", "github");
    vi.stubEnv("AIF_GITHUB_ISSUE_PR_ENABLED", "true");
    findGitHubIssueMock.mockClear();
    appendActivityLogMock.mockClear();
    findTaskMock.mockClear();
    ensureAutoQueueCommitMock.mockClear();
    execFileSyncMock.mockClear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses the configured publish timeout for the internal API call", async () => {
    vi.stubEnv("AGENT_GIT_PUBLISH_TIMEOUT_MS", "45000");
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => new AbortController().signal);
    findGitHubIssueMock.mockReturnValue({ projectId: "project-1", issueNumber: 154 });
    findTaskMock.mockReturnValue({ projectId: "project-1", branchName: "feature/x" });
    ensureAutoQueueCommitMock.mockResolvedValue({ commitSha: "abc" });
    execFileSyncMock.mockReturnValue(Buffer.from(""));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as typeof fetch;

    await publishGitHubTask("task-1", "/tmp/repo");

    expect(timeoutSpy).toHaveBeenCalledWith(45000);
  });
});

describe("GitHub plan PR publication", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv("API_BASE_URL", "http://localhost:3999");
    vi.stubEnv("GIT_PROVIDER", "github");
    vi.stubEnv("AIF_GITHUB_ISSUE_PR_ENABLED", "true");
    findGitHubIssueMock.mockClear();
    appendActivityLogMock.mockClear();
    findTaskMock.mockClear();
    execFileSyncMock.mockClear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("pushes the branch and calls the publish-plan endpoint with an activity log", async () => {
    findGitHubIssueMock.mockReturnValue({ projectId: "project-1", issueNumber: 154 });
    findTaskMock.mockReturnValue({ projectId: "project-1", branchName: "feature/plan-154" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as typeof fetch;

    const result = await publishGitHubPlanTask("task-1", "/tmp/repo");

    expect(result).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["push", "--set-upstream", "origin", "feature/plan-154"],
      expect.objectContaining({ cwd: "/tmp/repo" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3999/projects/project-1/github/tasks/task-1/publish-plan",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ branch: "feature/plan-154" }),
      }),
    );
    expect(appendActivityLogMock).toHaveBeenCalledWith(
      "task-1",
      expect.stringContaining("[github] Published plan PR for feature/plan-154 (issue #154)"),
    );
  });

  it("throws StageManualBlockError when the plan branch push fails", async () => {
    findGitHubIssueMock.mockReturnValue({ projectId: "project-1", issueNumber: 154 });
    findTaskMock.mockReturnValue({ projectId: "project-1", branchName: "feature/plan-154" });
    execFileSyncMock.mockImplementation(() => {
      throw new Error("push rejected");
    });

    await expect(publishGitHubPlanTask("task-1", "/tmp/repo")).rejects.toThrow(/push failed/i);
  });

  it("throws StageManualBlockError on a non-OK publish-plan response", async () => {
    findGitHubIssueMock.mockReturnValue({ projectId: "project-1", issueNumber: 154 });
    findTaskMock.mockReturnValue({ projectId: "project-1", branchName: "feature/plan-154" });
    execFileSyncMock.mockReturnValue(Buffer.from(""));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({}),
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(publishGitHubPlanTask("task-1", "/tmp/repo")).rejects.toBeInstanceOf(
      StageManualBlockError,
    );
  });
});
