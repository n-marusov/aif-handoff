import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listRepositoriesMock = vi.fn();
const findGitLabIssueMock = vi.fn();
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
  findGitLabIssueByTaskId: (...args: unknown[]) => findGitLabIssueMock(...args),
  findTaskById: (...args: unknown[]) => findTaskMock(...args),
  listEnabledGitLabRepositories: (...args: unknown[]) => listRepositoriesMock(...args),
}));

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return { ...actual, getEnv: () => actual.validateEnv(process.env) };
});

vi.mock("../autoQueueCommit.js", () => ({
  ensureAutoQueueTaskCommit: (...args: unknown[]) => ensureAutoQueueCommitMock(...args),
}));

const { synchronizeGitLabProjects, publishGitLabTask, publishGitLabPlanTask } =
  await import("../gitlabWorkflow.js");
const { StageManualBlockError } = await import("../stageErrorHandler.js");

describe("GitLab workflow synchronization", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv("API_BASE_URL", "http://localhost:3999");
    vi.stubEnv("GIT_PROVIDER", "gitlab");
    vi.stubEnv("AIF_GITLAB_ISSUE_MR_ENABLED", "true");
    listRepositoriesMock.mockClear();
    findGitLabIssueMock.mockClear();
    appendActivityLogMock.mockClear();
    findTaskMock.mockClear();
    ensureAutoQueueCommitMock.mockClear();
    listRepositoriesMock.mockReturnValue([
      { projectId: "project-1", lastSyncedAt: null },
      { projectId: "project-2", lastSyncedAt: "2026-08-13T09:59:40.000Z" },
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

    await synchronizeGitLabProjects(Date.parse("2026-08-13T10:00:00.000Z"));
    await synchronizeGitLabProjects(Date.parse("2026-08-13T10:00:10.000Z"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3999/projects/project-1/gitlab/sync",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("does not inspect repositories or call GitLab paths when GIT_PROVIDER is github", async () => {
    vi.stubEnv("GIT_PROVIDER", "github");
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;

    await synchronizeGitLabProjects(Date.parse("2026-08-13T11:00:00.000Z"));

    expect(listRepositoriesMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not inspect repositories or call GitLab paths while the rollout flag is disabled", async () => {
    vi.stubEnv("AIF_GITLAB_ISSUE_MR_ENABLED", "false");
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;

    await synchronizeGitLabProjects(Date.parse("2026-08-13T11:00:00.000Z"));

    expect(listRepositoriesMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GitLab workflow publication", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv("API_BASE_URL", "http://localhost:3999");
    vi.stubEnv("GIT_PROVIDER", "gitlab");
    vi.stubEnv("AIF_GITLAB_ISSUE_MR_ENABLED", "true");
    findGitLabIssueMock.mockClear();
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

  it("skips publication when GIT_PROVIDER is not gitlab", async () => {
    vi.stubEnv("GIT_PROVIDER", "github");
    const result = await publishGitLabTask("task-1", "/tmp/repo");
    expect(result).toBe(false);
    expect(findGitLabIssueMock).not.toHaveBeenCalled();
  });

  it("pushes the branch and publishes through the internal API with an activity log", async () => {
    findGitLabIssueMock.mockReturnValue({
      projectId: "project-1",
      iid: 154,
      mrMode: "plan_review",
    });
    findTaskMock.mockReturnValue({
      projectId: "project-1",
      branchName: "feature/gitlab-issue-154",
      implementationLog: "Implemented",
      reviewComments: "Automated review passed",
    });
    ensureAutoQueueCommitMock.mockResolvedValue({ commitSha: "0123456789abcdef" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as typeof fetch;
    execFileSyncMock.mockClear();

    const result = await publishGitLabTask("task-1", "/tmp/repo");

    expect(result).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["push", "--set-upstream", "origin", "feature/gitlab-issue-154"],
      expect.objectContaining({ cwd: "/tmp/repo" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3999/projects/project-1/gitlab/tasks/task-1/publish",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          branch: "feature/gitlab-issue-154",
          commitSha: "0123456789abcdef",
          implementationLog: "Implemented",
          reviewComments: "Automated review passed",
        }),
      }),
    );
    expect(appendActivityLogMock).toHaveBeenCalledWith(
      "task-1",
      expect.stringContaining("[gitlab] Published feature/gitlab-issue-154 for issue #154"),
    );
  });

  it("throws StageManualBlockError when the branch push fails", async () => {
    findGitLabIssueMock.mockReturnValue({ projectId: "project-1", iid: 154 });
    findTaskMock.mockReturnValue({ projectId: "project-1", branchName: "feature/x" });
    ensureAutoQueueCommitMock.mockResolvedValue({ commitSha: "abc" });
    execFileSyncMock.mockImplementation(() => {
      throw new Error("push rejected");
    });

    await expect(publishGitLabTask("task-1", "/tmp/repo")).rejects.toBeInstanceOf(
      StageManualBlockError,
    );
  });

  it("throws StageManualBlockError with retryAt messaging on a non-OK API response", async () => {
    findGitLabIssueMock.mockReturnValue({ projectId: "project-1", iid: 154 });
    findTaskMock.mockReturnValue({ projectId: "project-1", branchName: "feature/x" });
    ensureAutoQueueCommitMock.mockResolvedValue({ commitSha: "abc" });
    execFileSyncMock.mockReturnValue(Buffer.from(""));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ retryAt: "2026-08-13T12:00:00Z" }),
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(publishGitLabTask("task-1", "/tmp/repo")).rejects.toThrow(/rate limit/i);
  });

  it("uses the configured publish timeout for the internal API call", async () => {
    vi.stubEnv("AGENT_GIT_PUBLISH_TIMEOUT_MS", "45000");
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => new AbortController().signal);
    findGitLabIssueMock.mockReturnValue({ projectId: "project-1", iid: 154 });
    findTaskMock.mockReturnValue({ projectId: "project-1", branchName: "feature/x" });
    ensureAutoQueueCommitMock.mockResolvedValue({ commitSha: "abc" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as typeof fetch;

    await publishGitLabTask("task-1", "/tmp/repo");

    expect(timeoutSpy).toHaveBeenCalledWith(45000);
  });
});

describe("GitLab plan MR publication", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv("API_BASE_URL", "http://localhost:3999");
    vi.stubEnv("GIT_PROVIDER", "gitlab");
    vi.stubEnv("AIF_GITLAB_ISSUE_MR_ENABLED", "true");
    findGitLabIssueMock.mockClear();
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
    findGitLabIssueMock.mockReturnValue({ projectId: "project-1", iid: 154 });
    findTaskMock.mockReturnValue({ projectId: "project-1", branchName: "feature/plan-154" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as typeof fetch;

    const result = await publishGitLabPlanTask("task-1", "/tmp/repo");

    expect(result).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["push", "--set-upstream", "origin", "feature/plan-154"],
      expect.objectContaining({ cwd: "/tmp/repo" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3999/projects/project-1/gitlab/tasks/task-1/publish-plan",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ branch: "feature/plan-154" }),
      }),
    );
    expect(appendActivityLogMock).toHaveBeenCalledWith(
      "task-1",
      expect.stringContaining("[gitlab] Published plan MR for feature/plan-154 (issue #154)"),
    );
  });

  it("throws StageManualBlockError when the plan branch push fails", async () => {
    findGitLabIssueMock.mockReturnValue({ projectId: "project-1", iid: 154 });
    findTaskMock.mockReturnValue({ projectId: "project-1", branchName: "feature/plan-154" });
    execFileSyncMock.mockImplementation(() => {
      throw new Error("push rejected");
    });

    await expect(publishGitLabPlanTask("task-1", "/tmp/repo")).rejects.toBeInstanceOf(
      StageManualBlockError,
    );
  });

  it("throws StageManualBlockError on a non-OK publish-plan response", async () => {
    findGitLabIssueMock.mockReturnValue({ projectId: "project-1", iid: 154 });
    findTaskMock.mockReturnValue({ projectId: "project-1", branchName: "feature/plan-154" });
    execFileSyncMock.mockReturnValue(Buffer.from(""));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({}),
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(publishGitLabPlanTask("task-1", "/tmp/repo")).rejects.toBeInstanceOf(
      StageManualBlockError,
    );
  });
});
