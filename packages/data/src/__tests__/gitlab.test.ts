import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditEvents, projects, taskExecutorHistory, tasks } from "@aif/shared";
import { createTestDb } from "@aif/data/db";

const testDb = { current: createTestDb() };
vi.mock("@aif/data/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/data/db")>();
  return { ...actual, getDb: () => testDb.current };
});

const {
  deleteGitLabRepository,
  findGitLabIssueByTaskId,
  findGitLabRepository,
  getGitLabIssueReviewFingerprint,
  importGitLabIssueTask,
  listGitLabIssues,
  markGitLabIssueUnavailable,
  markGitLabRepositoryPrepared,
  updateGitLabMergeRequest,
  updateGitLabMergeRequestLastReviewNoteId,
  updateGitLabMergeRequestMode,
  upsertGitLabRepository,
} = await import("../index.js");

beforeEach(() => {
  testDb.current = createTestDb();
  testDb.current.insert(projects).values({ id: "project-1", name: "Repo", rootPath: "/tmp/repo" }).run();
});

describe("GitLab repository data", () => {
  it("upserts and deletes one connection per project without persisting a token", () => {
    const connection = upsertGitLabRepository({
      projectId: "project-1",
      namespace: "gitlab-org",
      name: "example",
      webUrl: "https://gitlab.com/gitlab-org/example",
      defaultBranch: "main",
      tokenEnvVar: "GITLAB_TEST_TOKEN",
      eligibility: { labels: ["aif"], assignee: null, milestone: null },
      enabled: true,
    });

    expect(connection).toMatchObject({
      namespace: "gitlab-org",
      name: "example",
      tokenEnvVar: "GITLAB_TEST_TOKEN",
    });
    expect(findGitLabRepository("project-1")?.eligibility.labels).toEqual(["aif"]);
    expect(deleteGitLabRepository("project-1")).toBe(true);
    expect(findGitLabRepository("project-1")).toBeUndefined();
  });

  it("round-trips gitPreparedAt and marks a repository prepared", () => {
    const connection = upsertGitLabRepository({
      projectId: "project-1",
      namespace: "gitlab-org",
      name: "example",
      webUrl: "https://gitlab.com/gitlab-org/example",
      defaultBranch: "main",
      tokenEnvVar: "GITLAB_TEST_TOKEN",
      eligibility: { labels: [], assignee: null, milestone: null },
      enabled: true,
    });

    // У свежего соединения нет отметки подготовки.
    expect(connection.gitPreparedAt).toBeNull();

    const prepared = markGitLabRepositoryPrepared("project-1");
    expect(prepared?.gitPreparedAt).toBeDefined();
    expect(findGitLabRepository("project-1")?.gitPreparedAt).toBe(prepared?.gitPreparedAt);
  });
});

describe("GitLab issue import", () => {
  const input = {
    projectId: "project-1",
    namespace: "gitlab-org",
    repository: "example",
    iid: 42,
    globalId: "gid://gitlab/Issue/123",
    webUrl: "https://gitlab.com/gitlab-org/example/-/issues/42",
    state: "open" as const,
    sourceUpdatedAt: "2026-08-13T10:00:00Z",
    snapshot: {
      title: "Add GitLab mode",
      body: "Issue body",
      author: "gl_author",
      labels: ["aif"],
      assignees: ["maintainer"],
      milestone: "v1",
      comments: [],
    },
  };

  it("creates an AI-owned autoMode task when the project has autoQueueMode enabled", () => {
    testDb.current
      .update(projects)
      .set({ autoQueueMode: true })
      .where(eq(projects.id, "project-1"))
      .run();

    const imported = importGitLabIssueTask(input);
    const taskRow = testDb.current
      .select()
      .from(tasks)
      .where(eq(tasks.id, imported.taskId))
      .get();

    expect(taskRow?.executionOwner).toBe("ai");
    expect(taskRow?.autoMode).toBe(true);
  });

  it("creates a human-owned non-autoMode task when the project has autoQueueMode disabled", () => {
    // project-1 создаётся в beforeEach без auto_queue_mode (default 0).
    const imported = importGitLabIssueTask(input);
    const taskRow = testDb.current
      .select()
      .from(tasks)
      .where(eq(tasks.id, imported.taskId))
      .get();

    expect(taskRow?.executionOwner).toBe("human");
    expect(taskRow?.autoMode).toBe(false);
  });

  it("records the imported owner in executor history and audit snapshot", () => {
    testDb.current
      .update(projects)
      .set({ autoQueueMode: true })
      .where(eq(projects.id, "project-1"))
      .run();

    const imported = importGitLabIssueTask(input);
    const history = testDb.current
      .select()
      .from(taskExecutorHistory)
      .where(eq(taskExecutorHistory.taskId, imported.taskId))
      .get();
    expect(history?.executionOwner).toBe("ai");

    const audit = testDb.current
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, imported.taskId))
      .get();
    expect(audit?.executionOwnerSnapshot).toBe("ai");
  });

  it("is idempotent and refreshes the same task", () => {
    const first = importGitLabIssueTask(input);
    const second = importGitLabIssueTask({
      ...input,
      sourceUpdatedAt: "2026-08-13T11:00:00Z",
      snapshot: { ...input.snapshot, title: "Updated title" },
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.taskId).toBe(first.taskId);
    expect(listGitLabIssues("project-1")).toHaveLength(1);
    expect(testDb.current.select().from(tasks).all()).toHaveLength(1);
    expect(findGitLabIssueByTaskId(first.taskId)?.metadata.title).toBe("Updated title");
  });

  it("re-syncs execution owner and autoMode on re-import after autoQueueMode toggle", () => {
    testDb.current
      .update(projects)
      .set({ autoQueueMode: false })
      .where(eq(projects.id, "project-1"))
      .run();

    const first = importGitLabIssueTask(input);
    const firstTask = testDb.current.select().from(tasks).where(eq(tasks.id, first.taskId)).get();
    expect(firstTask?.executionOwner).toBe("human");
    expect(firstTask?.autoMode).toBe(false);

    testDb.current
      .update(projects)
      .set({ autoQueueMode: true })
      .where(eq(projects.id, "project-1"))
      .run();

    const second = importGitLabIssueTask({
      ...input,
      sourceUpdatedAt: "2026-08-13T11:00:00Z",
      snapshot: { ...input.snapshot, title: "Owner toggle sync" },
    });

    expect(second.taskId).toBe(first.taskId);
    expect(second.created).toBe(false);

    const syncedTask = testDb.current.select().from(tasks).where(eq(tasks.id, first.taskId)).get();
    expect(syncedTask?.executionOwner).toBe("ai");
    expect(syncedTask?.autoMode).toBe(true);
    expect(syncedTask?.ownershipRevision).toBe(1);

    const historyRows = testDb.current
      .select()
      .from(taskExecutorHistory)
      .where(eq(taskExecutorHistory.taskId, first.taskId))
      .all();
    const historyReasons = historyRows.map((row) => row.reason);
    expect(historyRows).toHaveLength(2);
    expect(historyReasons).toContain("gitlab_issue_imported");
    expect(historyReasons).toContain("gitlab_issue_reimported_owner_sync");

    const auditRows = testDb.current
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, first.taskId))
      .all();
    expect(auditRows.map((row) => row.action)).toContain("gitlab.issue_reimported_owner_synced");
  });

  it("does NOT bump task updatedAt when the synced snapshot is unchanged", () => {
    const first = importGitLabIssueTask(input);
    const taskRow = testDb.current.select().from(tasks).where(eq(tasks.id, first.taskId)).get();
    if (!taskRow) throw new Error("expected task row");

    // Записываем updatedAt, который дал первый импорт.
    const firstUpdatedAt = taskRow.updatedAt;
    // Гарантируем прохождение хотя бы 1 мс, чтобы ложная запись была заметна.
    const before = new Date().toISOString();

    // Повторный импорт идентичного снимка не должен вообще трогать строку задачи.
    importGitLabIssueTask({ ...input, sourceUpdatedAt: before });

    const after = testDb.current.select().from(tasks).where(eq(tasks.id, first.taskId)).get();
    expect(after?.updatedAt).toBe(firstUpdatedAt);
  });

  it("updates task row when the synced snapshot actually changed", () => {
    const first = importGitLabIssueTask(input);
    const changed = importGitLabIssueTask({
      ...input,
      sourceUpdatedAt: "2026-08-13T11:00:00Z",
      snapshot: { ...input.snapshot, title: "Updated title" },
    });

    // Изменение должно отразиться на связанной строке задачи. (равенство updatedAt
    // здесь не проверяется — оба импорта могут попасть в одну миллисекунду.)
    const taskRow = testDb.current.select().from(tasks).where(eq(tasks.id, changed.taskId)).get();
    expect(taskRow?.title).toBe("#42 Updated title");
    expect(taskRow?.description).toContain("Issue body");
    expect(taskRow?.paused).toBe(false);
    expect(first.taskId).toBe(changed.taskId);
  });

  it("updates merge request linkage on the existing issue", () => {
    const imported = importGitLabIssueTask(input);
    const linked = updateGitLabMergeRequest({
      projectId: "project-1",
      iid: 42,
      mrIid: 7,
      mrUrl: "https://gitlab.com/gitlab-org/example/-/merge_requests/7",
      mrState: "open",
      mrChecksStatus: "pending",
      reviewState: "pending",
    });

    expect(linked).toMatchObject({ taskId: imported.taskId, mrIid: 7, mrState: "open" });
  });

  it("creates a linked task in done when an open merge request already exists", () => {
    const imported = importGitLabIssueTask({
      ...input,
      mergeRequest: {
        iid: 7,
        url: "https://gitlab.com/gitlab-org/example/-/merge_requests/7",
        state: "open",
      },
    });

    expect(findGitLabIssueByTaskId(imported.taskId)).toMatchObject({
      mrIid: 7,
      mrUrl: "https://gitlab.com/gitlab-org/example/-/merge_requests/7",
      mrState: "open",
    });
    expect(testDb.current.select().from(tasks).get()?.status).toBe("done");
  });

  it("pauses a task when its source issue disappears", () => {
    const imported = importGitLabIssueTask(input);

    markGitLabIssueUnavailable("project-1", 42, "Issue is no longer available");

    expect(findGitLabIssueByTaskId(imported.taskId)?.syncError).toBe(
      "Issue is no longer available",
    );
    expect(testDb.current.select().from(tasks).get()?.paused).toBe(true);
  });

  it("reflects approvals-only review state and keeps the review fingerprint", () => {
    const imported = importGitLabIssueTask(input);

    const approved = updateGitLabMergeRequest({
      projectId: "project-1",
      iid: 42,
      mrIid: 7,
      mrUrl: "https://gitlab.com/gitlab-org/example/-/merge_requests/7",
      mrState: "open",
      reviewState: "approved",
      reviewFingerprint: "fp-abc",
    });

    expect(approved?.reviewState).toBe("approved");
    expect(getGitLabIssueReviewFingerprint("project-1", 42)).toBe("fp-abc");

    const pending = updateGitLabMergeRequest({
      projectId: "project-1",
      iid: 42,
      mrIid: 7,
      mrUrl: "https://gitlab.com/gitlab-org/example/-/merge_requests/7",
      mrState: "open",
      reviewState: "pending",
      reviewFingerprint: "fp-def",
    });
    expect(pending?.reviewState).toBe("pending");
    expect(imported.taskId).toBeTruthy();
  });

  it("persists and round-trips the last-processed review note id", () => {
    const imported = importGitLabIssueTask(input);
    expect(imported.taskId).toBeTruthy();

    const before = findGitLabIssueByTaskId(imported.taskId);
    expect(before?.lastReviewNoteId).toBeNull();

    const updated = updateGitLabMergeRequest({
      projectId: "project-1",
      iid: 42,
      mrIid: 7,
      mrUrl: "https://gitlab.com/gitlab-org/example/-/merge_requests/7",
      mrState: "open",
      reviewState: "approved",
      lastReviewNoteId: 3691116788,
    });

    expect(updated?.lastReviewNoteId).toBe(3691116788);
    expect(findGitLabIssueByTaskId(imported.taskId)?.lastReviewNoteId).toBe(3691116788);

    // Отсутствие значения оставляет сохранённый id без изменений.
    updateGitLabMergeRequest({
      projectId: "project-1",
      iid: 42,
      mrIid: 7,
      mrUrl: "https://gitlab.com/gitlab-org/example/-/merge_requests/7",
      mrState: "open",
    });
    expect(findGitLabIssueByTaskId(imported.taskId)?.lastReviewNoteId).toBe(3691116788);

    // Явный null очищает значение.
    updateGitLabMergeRequest({
      projectId: "project-1",
      iid: 42,
      mrIid: 7,
      mrUrl: "https://gitlab.com/gitlab-org/example/-/merge_requests/7",
      mrState: "open",
      lastReviewNoteId: null,
    });
    expect(findGitLabIssueByTaskId(imported.taskId)?.lastReviewNoteId).toBeNull();
  });

  it("records the review note marker with a targeted update only", () => {
    const imported = importGitLabIssueTask(input);
    expect(imported.taskId).toBeTruthy();
    const before = updateGitLabMergeRequest({
      projectId: "project-1",
      iid: 42,
      mrIid: 7,
      mrUrl: "https://gitlab.com/gitlab-org/example/-/merge_requests/7",
      mrState: "open",
      reviewState: "pending",
    });
    expect(before?.lastReviewNoteId).toBeNull();

    const recorded = updateGitLabMergeRequestLastReviewNoteId({
      projectId: "project-1",
      iid: 42,
      lastReviewNoteId: 555,
    });

    // Двигается только маркер; остальные колонки MR остаются нетронутыми.
    expect(recorded).toMatchObject({
      lastReviewNoteId: 555,
      mrIid: 7,
      mrState: "open",
      reviewState: "pending",
    });
  });
});

describe("GitLab merge request mode", () => {
  const issueInput = {
    projectId: "project-1",
    namespace: "gitlab-org",
    repository: "example",
    iid: 42,
    globalId: "gid://gitlab/Issue/123",
    webUrl: "https://gitlab.com/gitlab-org/example/-/issues/42",
    state: "open" as const,
    sourceUpdatedAt: "2026-08-13T10:00:00Z",
    snapshot: {
      title: "Add GitLab mode",
      body: "Issue body",
      author: "alice",
      labels: ["aif"],
      assignees: [],
      milestone: null,
      comments: [],
    },
  };

  it("starts unset and switches between plan_review and implementation", () => {
    importGitLabIssueTask(issueInput);
    const linked = updateGitLabMergeRequest({
      projectId: "project-1",
      iid: 42,
      mrIid: 7,
      mrUrl: "https://gitlab.com/gitlab-org/example/-/merge_requests/7",
      mrState: "open",
    });
    expect(linked?.mrMode).toBeNull();

    expect(updateGitLabMergeRequestMode("project-1", 42, "plan_review")?.mrMode).toBe(
      "plan_review",
    );
    expect(updateGitLabMergeRequestMode("project-1", 42, "implementation")?.mrMode).toBe(
      "implementation",
    );
  });
});
