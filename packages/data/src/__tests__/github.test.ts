import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { projects, tasks } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return { ...actual, getDb: () => testDb.current };
});

const {
  deleteGitHubRepository,
  findGitHubIssueByTaskId,
  findGitHubRepository,
  importGitHubIssueTask,
  listGitHubIssues,
  markGitHubIssueUnavailable,
  updateGitHubPullRequest,
  upsertGitHubRepository,
} = await import("../index.js");

beforeEach(() => {
  testDb.current = createTestDb();
  testDb.current.insert(projects).values({ id: "project-1", name: "Repo", rootPath: "/tmp/repo" }).run();
});

describe("GitHub repository data", () => {
  it("upserts and deletes one connection per project without persisting a token", () => {
    const connection = upsertGitHubRepository({
      projectId: "project-1",
      owner: "openai",
      name: "example",
      htmlUrl: "https://github.com/openai/example",
      defaultBranch: "main",
      tokenEnvVar: "GITHUB_TEST_TOKEN",
      eligibility: { labels: ["aif"], assignee: null, milestone: null },
      enabled: true,
    });

    expect(connection).toMatchObject({
      owner: "openai",
      name: "example",
      tokenEnvVar: "GITHUB_TEST_TOKEN",
    });
    expect(findGitHubRepository("project-1")?.eligibility.labels).toEqual(["aif"]);
    expect(deleteGitHubRepository("project-1")).toBe(true);
    expect(findGitHubRepository("project-1")).toBeUndefined();
  });
});

describe("GitHub issue import", () => {
  const input = {
    projectId: "project-1",
    owner: "openai",
    repository: "example",
    issueNumber: 42,
    nodeId: "I_42",
    htmlUrl: "https://github.com/openai/example/issues/42",
    state: "open" as const,
    sourceUpdatedAt: "2026-08-08T10:00:00Z",
    snapshot: {
      title: "Add GitHub mode",
      body: "Issue body",
      author: "octocat",
      labels: ["aif"],
      assignees: ["maintainer"],
      milestone: "v1",
      comments: [],
    },
  };

  it("is idempotent and refreshes the same task", () => {
    const first = importGitHubIssueTask(input);
    const second = importGitHubIssueTask({
      ...input,
      sourceUpdatedAt: "2026-08-08T11:00:00Z",
      snapshot: { ...input.snapshot, title: "Updated title" },
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.taskId).toBe(first.taskId);
    expect(listGitHubIssues("project-1")).toHaveLength(1);
    expect(testDb.current.select().from(tasks).all()).toHaveLength(1);
    expect(findGitHubIssueByTaskId(first.taskId)?.metadata.title).toBe("Updated title");
  });

  it("does NOT bump task updatedAt when the synced snapshot is unchanged", () => {
    const first = importGitHubIssueTask(input);
    const taskRow = testDb.current.select().from(tasks).where(eq(tasks.id, first.taskId)).get();
    if (!taskRow) throw new Error("expected task row");

    // Record the updatedAt produced by the first import.
    const firstUpdatedAt = taskRow.updatedAt;

    // Identical snapshot re-import must not touch the task row at all.
    importGitHubIssueTask({ ...input, sourceUpdatedAt: new Date().toISOString() });

    const after = testDb.current.select().from(tasks).where(eq(tasks.id, first.taskId)).get();
    expect(after?.updatedAt).toBe(firstUpdatedAt);
  });

  it("updates task row when the synced snapshot actually changed", () => {
    const first = importGitHubIssueTask(input);
    const changed = importGitHubIssueTask({
      ...input,
      sourceUpdatedAt: "2026-08-08T11:00:00Z",
      snapshot: { ...input.snapshot, title: "Updated title" },
    });

    // The change must be reflected on the linked task row. (updatedAt equality
    // is not asserted here — both imports can land in the same millisecond.)
    const taskRow = testDb.current.select().from(tasks).where(eq(tasks.id, changed.taskId)).get();
    expect(taskRow?.title).toBe("#42 Updated title");
    expect(taskRow?.description).toContain("Issue body");
    expect(taskRow?.paused).toBe(false);
    expect(first.taskId).toBe(changed.taskId);
  });

  it("updates pull request linkage on the existing issue", () => {
    const imported = importGitHubIssueTask(input);
    const linked = updateGitHubPullRequest({
      projectId: "project-1",
      issueNumber: 42,
      prNumber: 7,
      prUrl: "https://github.com/openai/example/pull/7",
      prState: "open",
      prChecksStatus: "pending",
    });

    expect(linked).toMatchObject({ taskId: imported.taskId, prNumber: 7, prState: "open" });
  });

  it("creates a linked task in done when an open pull request already exists", () => {
    const imported = importGitHubIssueTask({
      ...input,
      pullRequest: {
        number: 7,
        url: "https://github.com/openai/example/pull/7",
        state: "open",
      },
    });

    expect(findGitHubIssueByTaskId(imported.taskId)).toMatchObject({
      prNumber: 7,
      prUrl: "https://github.com/openai/example/pull/7",
      prState: "open",
    });
    expect(testDb.current.select().from(tasks).get()?.status).toBe("done");
  });

  it("pauses a task when its source issue disappears", () => {
    const imported = importGitHubIssueTask(input);

    markGitHubIssueUnavailable("project-1", 42, "Issue is no longer available");

    expect(findGitHubIssueByTaskId(imported.taskId)?.syncError).toBe(
      "Issue is no longer available",
    );
    expect(testDb.current.select().from(tasks).get()?.paused).toBe(true);
  });
});
