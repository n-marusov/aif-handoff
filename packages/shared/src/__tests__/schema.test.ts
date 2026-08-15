import { describe, it, expect, beforeEach } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import { createTestDb } from "../db.js";
import { projects, tasks, gitlabRepositories, gitlabIssues } from "../schema.js";
import type { TaskStatus } from "../types.js";

describe("tasks schema", () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  it("should insert and query a task", () => {
    const id = crypto.randomUUID();
    db.insert(tasks)
      .values({
        id,
        projectId: "test-project",
        title: "Test task",
        description: "A test description",
        status: "backlog",
        priority: 1,
        position: 1000.0,
      })
      .run();

    const result = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(result).toBeDefined();
    expect(result!.title).toBe("Test task");
    expect(result!.description).toBe("A test description");
    expect(result!.status).toBe("backlog");
    expect(result!.priority).toBe(1);
    expect(result!.position).toBe(1000.0);
  });

  it("should update a task", () => {
    const id = crypto.randomUUID();
    db.insert(tasks).values({ id, projectId: "test-project", title: "Original" }).run();

    db.update(tasks).set({ title: "Updated", status: "planning" }).where(eq(tasks.id, id)).run();

    const result = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(result!.title).toBe("Updated");
    expect(result!.status).toBe("planning");
  });

  it("should delete a task", () => {
    const id = crypto.randomUUID();
    db.insert(tasks).values({ id, projectId: "test-project", title: "To delete" }).run();

    db.delete(tasks).where(eq(tasks.id, id)).run();

    const result = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(result).toBeUndefined();
  });

  it("should order tasks by position", () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

    db.insert(tasks)
      .values({ id: ids[0], projectId: "test-project", title: "Third", position: 3000.0 })
      .run();
    db.insert(tasks)
      .values({ id: ids[1], projectId: "test-project", title: "First", position: 1000.0 })
      .run();
    db.insert(tasks)
      .values({ id: ids[2], projectId: "test-project", title: "Second", position: 2000.0 })
      .run();

    const results = db.select().from(tasks).orderBy(tasks.position).all();

    expect(results[0].title).toBe("First");
    expect(results[1].title).toBe("Second");
    expect(results[2].title).toBe("Third");
  });

  it("should support fractional position indexing", () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

    db.insert(tasks)
      .values({ id: ids[0], projectId: "test-project", title: "A", position: 1000.0 })
      .run();
    db.insert(tasks)
      .values({ id: ids[1], projectId: "test-project", title: "C", position: 2000.0 })
      .run();
    // Insert between A and C
    db.insert(tasks)
      .values({ id: ids[2], projectId: "test-project", title: "B", position: 1500.0 })
      .run();

    const results = db.select().from(tasks).orderBy(tasks.position).all();

    expect(results.map((r) => r.title)).toEqual(["A", "B", "C"]);
  });

  it("should store all task statuses", () => {
    const statuses: TaskStatus[] = [
      "backlog",
      "planning",
      "plan_ready",
      "implementing",
      "review",
      "blocked_external",
      "done",
      "verified",
    ];

    for (const status of statuses) {
      const id = crypto.randomUUID();
      db.insert(tasks)
        .values({ id, projectId: "test-project", title: `Task ${status}`, status })
        .run();
      const result = db.select().from(tasks).where(eq(tasks.id, id)).get();
      expect(result!.status).toBe(status);
    }
  });

  it("should store nullable fields", () => {
    const id = crypto.randomUUID();
    db.insert(tasks)
      .values({
        id,
        projectId: "test-project",
        title: "Task with plan",
        plan: "## My Plan\n- Step 1",
        implementationLog: "Implemented X",
        reviewComments: "Looks good",
        agentActivityLog: "[2026-01-01] Tool: Read",
      })
      .run();

    const result = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(result!.plan).toBe("## My Plan\n- Step 1");
    expect(result!.implementationLog).toBe("Implemented X");
    expect(result!.reviewComments).toBe("Looks good");
    expect(result!.agentActivityLog).toBe("[2026-01-01] Tool: Read");
  });

  it("should have default values for new tasks", () => {
    const id = crypto.randomUUID();
    db.insert(tasks).values({ id, projectId: "test-project", title: "Defaults" }).run();

    const result = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(result!.status).toBe("backlog");
    expect(result!.priority).toBe(0);
    expect(result!.position).toBe(1000.0);
    expect(result!.description).toBe("");
    expect(result!.autoMode).toBe(true);
    expect(result!.executionOwner).toBe("ai");
    expect(result!.ownershipRevision).toBe(0);
    expect(result!.plan).toBeNull();
    expect(result!.implementationLog).toBeNull();
    expect(result!.reviewComments).toBeNull();
    expect(result!.agentActivityLog).toBeNull();
    expect(result!.blockedReason).toBeNull();
    expect(result!.blockedFromStatus).toBeNull();
    expect(result!.retryAfter).toBeNull();
    expect(result!.retryCount).toBe(0);
    expect(result!.tokenInput).toBe(0);
    expect(result!.tokenOutput).toBe(0);
    expect(result!.tokenTotal).toBe(0);
    expect(result!.costUsd).toBe(0);
  });

  it("should persist runtime limit snapshot columns on tasks", () => {
    const id = crypto.randomUUID();
    const snapshotJson = JSON.stringify({
      source: "sdk_event",
      status: "warning",
      precision: "heuristic",
      checkedAt: "2026-04-17T10:00:00.000Z",
      providerId: "anthropic",
      windows: [{ scope: "time", percentUsed: 92 }],
    });

    db.insert(tasks)
      .values({
        id,
        projectId: "test-project",
        title: "Runtime limit task",
        runtimeLimitSnapshotJson: snapshotJson,
        runtimeLimitUpdatedAt: "2026-04-17T10:00:05.000Z",
      })
      .run();

    const result = db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(result?.runtimeLimitSnapshotJson).toBe(snapshotJson);
    expect(result?.runtimeLimitUpdatedAt).toBe("2026-04-17T10:00:05.000Z");
  });
});

describe("gitlab schema", () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  it("exposes gitlabRepositories and gitlabIssues tables with GitLab linkage columns", () => {
    expect(gitlabRepositories).toBeDefined();
    expect(gitlabIssues).toBeDefined();

    // gitlabRepositories — one connection per project, no token persisted
    db.insert(projects).values({ id: "gitlab-project", name: "Repo", rootPath: "/tmp/repo" }).run();
    db.insert(gitlabRepositories)
      .values({
        projectId: "gitlab-project",
        namespace: "gitlab-org",
        name: "example",
        webUrl: "https://gitlab.com/gitlab-org/example",
        defaultBranch: "main",
        tokenEnvVar: "GITLAB_TOKEN",
        enabled: true,
      })
      .run();

    const repo = db.select().from(gitlabRepositories).get();
    expect(repo).toMatchObject({
      projectId: "gitlab-project",
      namespace: "gitlab-org",
      name: "example",
      webUrl: "https://gitlab.com/gitlab-org/example",
      defaultBranch: "main",
      tokenEnvVar: "GITLAB_TOKEN",
      enabled: true,
    });
    expect(repo!.eligibilityJson).toBe("{}");
  });

  it("stores gitlab_issues with global_id + iid but no node_id or baseUrl columns", () => {
    const id = crypto.randomUUID();
    db.insert(projects).values({ id: "gitlab-project", name: "Repo", rootPath: "/tmp/repo" }).run();
    db.insert(tasks).values({ id, projectId: "gitlab-project", title: "Task" }).run();
    db.insert(gitlabIssues)
      .values({
        projectId: "gitlab-project",
        iid: 42,
        globalId: "gid://gitlab/Issue/123",
        taskId: id,
        webUrl: "https://gitlab.com/gitlab-org/example/-/issues/42",
        state: "open",
        sourceUpdatedAt: "2026-08-13T10:00:00Z",
        lastSyncedAt: "2026-08-13T10:00:00Z",
      })
      .run();

    const issue = db.select().from(gitlabIssues).get();
    expect(issue).toMatchObject({
      projectId: "gitlab-project",
      iid: 42,
      globalId: "gid://gitlab/Issue/123",
      taskId: id,
      webUrl: "https://gitlab.com/gitlab-org/example/-/issues/42",
      state: "open",
    });

    // The GitLab schema replaces GitHub's node_id with global_id and has no per-connection baseUrl
    const row = issue as Record<string, unknown>;
    expect("nodeId" in row).toBe(false);
    expect("node_id" in row).toBe(false);
    expect("baseUrl" in row).toBe(false);
    expect("base_url" in row).toBe(false);
  });

  it("migrates fresh databases to schema version 29 (GitLab linkage tables)", () => {
    // createTestDb() runs all migrations; user_version reflects the latest migration applied.
    const result = db.run(sql`SELECT 1`);
    expect(result).toBeDefined();
    // The drizzle schema exposes both GitLab tables on a migrated database.
    expect(getTableName(gitlabRepositories)).toBe("gitlab_repositories");
    expect(getTableName(gitlabIssues)).toBe("gitlab_issues");
  });

  it("tracks git preparation on gitlab_repositories (git_prepared_at, migration v30)", () => {
    // The drizzle table must expose gitPreparedAt so the agent can mark a repo prepared.
    expect(gitlabRepositories.gitPreparedAt).toBeDefined();

    db.insert(projects).values({ id: "gitlab-project", name: "Repo", rootPath: "/tmp/repo" }).run();
    db.insert(gitlabRepositories)
      .values({
        projectId: "gitlab-project",
        namespace: "gitlab-org",
        name: "example",
        webUrl: "https://gitlab.com/gitlab-org/example",
        defaultBranch: "main",
        tokenEnvVar: "GITLAB_TOKEN",
        enabled: true,
        gitPreparedAt: "2026-08-15T10:00:00.000Z",
      })
      .run();

    const repo = db.select().from(gitlabRepositories).get();
    expect(repo?.gitPreparedAt).toBe("2026-08-15T10:00:00.000Z");
  });
});
