import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { githubIssues, gitlabIssues, projects, tasks, resetEnvCache } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import { createGitTestRoot } from "./gitTestUtils.js";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

const publishGitHubPlanTaskMock = vi.fn();
const publishGitLabPlanTaskMock = vi.fn();
vi.mock("../githubWorkflow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../githubWorkflow.js")>();
  return {
    ...actual,
    publishGitHubPlanTask: (...args: unknown[]) => publishGitHubPlanTaskMock(...args),
  };
});
vi.mock("../gitlabWorkflow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gitlabWorkflow.js")>();
  return {
    ...actual,
    publishGitLabPlanTask: (...args: unknown[]) => publishGitLabPlanTaskMock(...args),
  };
});

const { runPlanReviewPublisher, taskRequiresPlanReview } =
  await import("../planReviewPublisher.js");

function enableFlag(): void {
  process.env.AIF_PLAN_REVIEW_PR_ENABLED = "true";
  resetEnvCache();
}

function seedTask(
  rootPath: string,
  taskId: string,
  opts: { branch?: string; withGithub?: boolean; withGitlab?: boolean; plan?: string } = {},
): void {
  testDb.current
    .insert(projects)
    .values({ id: "project", name: "Project", rootPath })
    .onConflictDoNothing()
    .run();
  testDb.current
    .insert(tasks)
    .values({
      id: taskId,
      projectId: "project",
      title: "Implement plan review gate",
      status: "plan_ready",
      autoMode: true,
      branchName: opts.branch ?? "feature/x",
      plan: opts.plan ?? "# Plan\n- [ ] do work",
    })
    .run();
  if (opts.withGithub) {
    testDb.current
      .insert(githubIssues)
      .values({
        projectId: "project",
        issueNumber: 7,
        taskId,
        nodeId: "node-7",
        htmlUrl: "https://github.com/o/r/issues/7",
        state: "open",
        metadataJson: "{}",
        sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
        lastSyncedAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
  }
  if (opts.withGitlab) {
    testDb.current
      .insert(gitlabIssues)
      .values({
        projectId: "project",
        iid: 9,
        taskId,
        globalId: "gid://gitlab/Issue/9",
        webUrl: "https://gitlab.com/g/p/-/issues/9",
        state: "open",
        metadataJson: "{}",
        sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
        lastSyncedAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
  }
}

function writePlan(rootPath: string): void {
  mkdirSync(join(rootPath, ".ai-factory"), { recursive: true });
  writeFileSync(join(rootPath, ".ai-factory", "PLAN.md"), "# Plan\n- [ ] do work\n");
}

function findTask(taskId: string) {
  return testDb.current.select().from(tasks).where(eq(tasks.id, taskId)).get();
}

beforeEach(() => {
  testDb.current = createTestDb();
  publishGitHubPlanTaskMock.mockReset();
  publishGitLabPlanTaskMock.mockReset();
  resetEnvCache();
});

describe("taskRequiresPlanReview", () => {
  it("is false when the feature flag is off", () => {
    delete process.env.AIF_PLAN_REVIEW_PR_ENABLED;
    resetEnvCache();
    const { rootPath } = createGitTestRoot("plan-review-flag-off-");
    seedTask(rootPath, "task", { withGithub: true });
    expect(taskRequiresPlanReview("task")).toBe(false);
  });

  it("is true only for VCS-linked tasks when the flag is on", () => {
    enableFlag();
    const { rootPath } = createGitTestRoot("plan-review-flag-on-");
    seedTask(rootPath, "task", { withGithub: true });
    seedTask(rootPath, "local", {});
    expect(taskRequiresPlanReview("task")).toBe(true);
    expect(taskRequiresPlanReview("local")).toBe(false);
  });
});

describe("runPlanReviewPublisher", () => {
  it("publishes a GitHub plan and leaves the task in plan_review with published state", async () => {
    enableFlag();
    const { rootPath } = createGitTestRoot("plan-review-publish-gh-");
    seedTask(rootPath, "task", { withGithub: true });
    writePlan(rootPath);
    publishGitHubPlanTaskMock.mockResolvedValue(true);

    await runPlanReviewPublisher("task", rootPath);

    expect(publishGitHubPlanTaskMock).toHaveBeenCalledWith("task", rootPath);
    const task = findTask("task");
    expect(task?.status).toBe("plan_review");
    expect(task?.planReviewState).toBe("published");
    expect(task?.planReviewPublishedAt).toBeTruthy();
  });

  it("publishes a GitLab plan and leaves the task in plan_review", async () => {
    enableFlag();
    const { rootPath } = createGitTestRoot("plan-review-publish-gl-");
    seedTask(rootPath, "task", { withGitlab: true });
    writePlan(rootPath);
    publishGitLabPlanTaskMock.mockResolvedValue(true);

    await runPlanReviewPublisher("task", rootPath);

    expect(publishGitLabPlanTaskMock).toHaveBeenCalledWith("task", rootPath);
    const task = findTask("task");
    expect(task?.status).toBe("plan_review");
    expect(task?.planReviewState).toBe("published");
  });

  it("does not move a task when the provider publish reports no completion", async () => {
    enableFlag();
    const { rootPath } = createGitTestRoot("plan-review-publish-noop-");
    seedTask(rootPath, "task", { withGithub: true });
    writePlan(rootPath);
    publishGitHubPlanTaskMock.mockResolvedValue(false);

    await runPlanReviewPublisher("task", rootPath);

    const task = findTask("task");
    expect(task?.status).toBe("plan_ready");
    expect(task?.planReviewState).toBeNull();
  });

  it("defers (stays plan_ready) when there is no persisted branch", async () => {
    enableFlag();
    const { rootPath } = createGitTestRoot("plan-review-nobranch-");
    seedTask(rootPath, "task", { withGithub: true, branch: "" });
    writePlan(rootPath);

    await runPlanReviewPublisher("task", rootPath);

    const task = findTask("task");
    expect(task?.status).toBe("plan_ready");
    expect(publishGitHubPlanTaskMock).not.toHaveBeenCalled();
  });

  it("defers (stays plan_ready) when the plan file does not exist on disk", async () => {
    enableFlag();
    const { rootPath } = createGitTestRoot("plan-review-noplan-");
    seedTask(rootPath, "task", { withGithub: true });

    await runPlanReviewPublisher("task", rootPath);

    const task = findTask("task");
    expect(task?.status).toBe("plan_ready");
    expect(publishGitHubPlanTaskMock).not.toHaveBeenCalled();
  });

  it("blocks when product files are dirty before approval", async () => {
    enableFlag();
    const { rootPath } = createGitTestRoot("plan-review-dirty-");
    seedTask(rootPath, "task", { withGithub: true });
    writePlan(rootPath);
    // Dirty product file outside the plan (README.md exists from the git root).
    writeFileSync(join(rootPath, "README.md"), "# dirty product change\n", { flag: "a" });

    await expect(runPlanReviewPublisher("task", rootPath)).rejects.toThrow();

    const task = findTask("task");
    expect(task?.status).toBe("plan_ready");
    expect(publishGitHubPlanTaskMock).not.toHaveBeenCalled();
  });
});
