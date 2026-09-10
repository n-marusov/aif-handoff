import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  githubIssues,
  githubRepositories,
  projects,
  resetEnvCache,
  taskComments,
  tasks,
} from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import { eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDb = { current: createTestDb() };
const queryMock = vi.fn();
(globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: typeof queryMock }).__AIF_CLAUDE_QUERY_MOCK__ =
  queryMock;

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

const { runPlanner, shouldProvisionWorktree } = await import("../subagents/planner.js");

function streamSuccess(result: string): AsyncIterable<{
  type: "result";
  subtype: "success";
  result: string;
}> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "result", subtype: "success", result };
    },
  };
}

describe("shouldProvisionWorktree", () => {
  it("requires the rollout flag (issue tasks are not exempt)", () => {
    expect(
      shouldProvisionWorktree({
        hasVcsIssue: true,
        flagEnabled: false,
        parallelEnabled: true,
        supportsTaskWorktrees: true,
      }),
    ).toBe(false);
  });

  it("requires a worktree-capable project", () => {
    expect(
      shouldProvisionWorktree({
        hasVcsIssue: true,
        flagEnabled: true,
        parallelEnabled: true,
        supportsTaskWorktrees: false,
      }),
    ).toBe(false);
  });

  it("isolates issue tasks even when the project is not parallel", () => {
    expect(
      shouldProvisionWorktree({
        hasVcsIssue: true,
        flagEnabled: true,
        parallelEnabled: false,
        supportsTaskWorktrees: true,
      }),
    ).toBe(true);
  });

  it("only isolates non-issue tasks when the project is parallel", () => {
    expect(
      shouldProvisionWorktree({
        hasVcsIssue: false,
        flagEnabled: true,
        parallelEnabled: false,
        supportsTaskWorktrees: true,
      }),
    ).toBe(false);
    expect(
      shouldProvisionWorktree({
        hasVcsIssue: false,
        flagEnabled: true,
        parallelEnabled: true,
        supportsTaskWorktrees: true,
      }),
    ).toBe(true);
  });
});

describe("runPlanner comment selection", () => {
  beforeEach(() => {
    (globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: typeof queryMock }).__AIF_CLAUDE_QUERY_MOCK__ =
      queryMock;
    testDb.current = createTestDb();
    delete process.env.AIF_TASK_WORKTREES_ENABLED;
    delete process.env.AIF_GITHUB_ISSUE_PR_ENABLED;
    resetEnvCache();
    queryMock.mockReset();
    queryMock.mockReturnValue(streamSuccess("## New Plan\n- [ ] Step"));

    testDb.current
      .insert(projects)
      .values({
        id: "project-1",
        name: "Test",
        rootPath: "/tmp/planner-test",
      })
      .run();
  });

  it("uses only the latest comment in replanning prompt", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-1",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "planning",
        plan: "Old plan",
        useSubagents: true,
      })
      .run();

    for (let i = 1; i <= 12; i += 1) {
      db.insert(taskComments)
        .values({
          id: `c-${String(i).padStart(2, "0")}`,
          taskId: "task-1",
          author: "human",
          message: `comment-${String(i).padStart(2, "0")}`,
          attachments: "[]",
          createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        })
        .run();
    }

    await runPlanner("task-1", "/tmp/planner-test");

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).not.toContain("/aif-plan");
    expect(call.prompt).toContain("HANDOFF_MODE: 1");
    expect(call.prompt).toContain("HANDOFF_TASK_ID: task-1");
    expect(call.prompt).toContain("Autonomous Handoff mode: true.");
    expect(call.prompt).toContain("Do not perform Handoff MCP sync yourself.");
    expect(call.prompt).toContain("Mode: fast, tests: false, docs: false.");
    expect(call.prompt).toContain("Plan file: @.ai-factory/PLAN.md");
    expect(call.prompt).toContain("message: comment-12");
    expect(call.prompt).not.toContain("message: comment-11");
    expect(call.prompt).not.toContain("message: comment-01");
  });

  it("attaches VCS plan review feedback to the replanning prompt", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-replan-1",
        projectId: "project-1",
        title: "Task",
        description: "Desc",
        status: "planning",
        plan: "Old plan",
        useSubagents: true,
        planReviewFeedback: "Split the migration into two steps",
        planReviewState: "changes_requested",
      })
      .run();

    await runPlanner("task-replan-1", "/tmp/planner-test");

    const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain(
      "VCS plan review feedback (address every point in the revised plan):",
    );
    expect(call.prompt).toContain("Split the migration into two steps");
  });

  it("breaks same-timestamp ties by id and still uses one latest comment", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-2",
        projectId: "project-1",
        title: "Task 2",
        description: "Desc",
        status: "planning",
        plan: "Old plan",
      })
      .run();

    db.insert(taskComments)
      .values({
        id: "c-1",
        taskId: "task-2",
        author: "human",
        message: "older-by-id",
        attachments: "[]",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    db.insert(taskComments)
      .values({
        id: "c-2",
        taskId: "task-2",
        author: "human",
        message: "latest-by-id",
        attachments: "[]",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();

    await runPlanner("task-2", "/tmp/planner-test");

    const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain("message: latest-by-id");
    expect(call.prompt).not.toContain("message: older-by-id");

    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-2")).get();
    expect(updatedTask?.plan).toBe("## New Plan\n- [ ] Step");
  });

  it("uses /aif-fix --plan-first when task is marked as fix", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-fix-1",
        projectId: "project-1",
        title: "Fix login bug",
        description: "Users get 500 on /login",
        attachments:
          '[{"name":"error-log.txt","mimeType":"text/plain","size":12,"path":"tasks/task-fix-1/error-log.txt"}]',
        status: "planning",
        isFix: true,
      })
      .run();
    db.insert(taskComments)
      .values({
        id: "c-fix-latest",
        taskId: "task-fix-1",
        author: "human",
        message: "Please include retry and preserve session tokens",
        attachments:
          '[{"name":"request.txt","mimeType":"text/plain","size":10,"path":"tasks/task-fix-1/comments/c-fix-latest/request.txt"}]',
        createdAt: "2026-01-01T00:00:10.000Z",
      })
      .run();

    await runPlanner("task-fix-1", "/tmp/planner-test");

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as {
      prompt: string;
      options: { extraArgs?: { agent?: string } };
    };
    expect(call.prompt).toContain("/aif-fix --plan-first");
    expect(call.prompt).toContain("Fix login bug");
    expect(call.prompt).toContain("Users get 500 on /login");
    expect(call.prompt).toContain("Task attachments:");
    expect(call.prompt).toContain("error-log.txt");
    expect(call.prompt).toContain("User comments and replanning feedback:");
    expect(call.prompt).toContain("message: Please include retry and preserve session tokens");
    expect(call.prompt).toContain("request.txt");
    expect(call.options.extraArgs).toBeUndefined();
  });

  it("loads plan text from fallback PLAN.md when skill wrote outside canonical plan path", async () => {
    const db = testDb.current;
    const projectRoot = mkdtempSync(join(tmpdir(), "planner-fallback-"));
    mkdirSync(projectRoot, { recursive: true });
    const fallbackPlanPath = join(projectRoot, "PLAN.md");

    db.insert(projects)
      .values({
        id: "project-fallback",
        name: "Fallback Project",
        rootPath: projectRoot,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "task-fallback",
        projectId: "project-fallback",
        title: "Task fallback",
        description: "Desc",
        status: "planning",
        planPath: ".ai-factory/PLAN.md",
      })
      .run();

    queryMock.mockReset();
    queryMock.mockImplementation(() => {
      writeFileSync(fallbackPlanPath, "## Fallback Plan\n- [ ] Step from fallback", "utf8");
      return streamSuccess("Plan written to PLAN.md");
    });

    await runPlanner("task-fallback", projectRoot);

    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-fallback")).get();
    expect(updatedTask?.plan).toBe("## Fallback Plan\n- [ ] Step from fallback");
  });

  it("ignores old fallback PLAN.md during first-time planning when the planner returns inline content", async () => {
    const db = testDb.current;
    const projectRoot = mkdtempSync(join(tmpdir(), "planner-stale-fallback-"));
    mkdirSync(join(projectRoot, ".ai-factory", "plans"), { recursive: true });
    writeFileSync(join(projectRoot, "PLAN.md"), "## Old fallback\n- [x] Task 1: Old work", "utf8");

    db.insert(projects)
      .values({
        id: "project-stale-fallback",
        name: "Stale Fallback Project",
        rootPath: projectRoot,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "task-stale-fallback",
        projectId: "project-stale-fallback",
        title: "Fresh issue task",
        description: "Desc",
        status: "planning",
        planPath: ".ai-factory/plans/github-issue-3.md",
        plannerMode: "full",
        useSubagents: true,
      })
      .run();

    queryMock.mockReset();
    queryMock.mockReturnValue(streamSuccess("## Fresh Plan\n- [ ] Task 1: New work"));

    await runPlanner("task-stale-fallback", projectRoot);

    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-stale-fallback")).get();
    expect(updatedTask?.plan).toBe("## Fresh Plan\n- [ ] Task 1: New work");
    expect(
      readFileSync(join(projectRoot, ".ai-factory", "plans", "github-issue-3.md"), "utf8"),
    ).toContain("Fresh Plan");
  });

  it("does not load target project .ai-factory/PLAN.md when an explicit plan path is requested", async () => {
    const db = testDb.current;
    const projectRoot = mkdtempSync(join(tmpdir(), "planner-explicit-path-"));
    mkdirSync(join(projectRoot, ".ai-factory", "plans"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".ai-factory", "PLAN.md"),
      "# Old target repo plan\n- [x] Task 1: Old work",
      "utf8",
    );

    db.insert(projects)
      .values({
        id: "project-explicit-path",
        name: "Explicit Path Project",
        rootPath: projectRoot,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "task-explicit-path",
        projectId: "project-explicit-path",
        title: "Fresh GitHub issue",
        description: "Create hello.md",
        status: "planning",
        planPath: ".ai-factory/plans/github-issue-3.md",
        plannerMode: "full",
        useSubagents: false,
      })
      .run();

    queryMock.mockReset();
    queryMock.mockReturnValue(streamSuccess("## Fresh Plan\n- [ ] Task 1: Create hello.md"));

    await runPlanner("task-explicit-path", projectRoot);

    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-explicit-path")).get();
    expect(updatedTask?.plan).toBe("## Fresh Plan\n- [ ] Task 1: Create hello.md");
    expect(updatedTask?.plan).not.toContain("Old target repo plan");
  });

  it("creates a feature branch when plannerMode=full and git.create_branches=true", async () => {
    const db = testDb.current;
    const projectRoot = mkdtempSync(join(tmpdir(), "planner-git-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.local"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "T"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["config", "commit.gpgsign", "false"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    writeFileSync(join(projectRoot, "README.md"), "# t\n");
    execFileSync("git", ["add", "README.md"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init", "--no-verify"], {
      cwd: projectRoot,
      stdio: "ignore",
    });

    db.insert(projects)
      .values({
        id: "project-git",
        name: "Git Project",
        rootPath: projectRoot,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "task-git-1",
        projectId: "project-git",
        title: "Add user authentication",
        description: "Implement JWT login",
        status: "planning",
        plannerMode: "full",
        useSubagents: true,
      })
      .run();
    db.insert(githubRepositories)
      .values({
        projectId: "project-git",
        owner: "owner",
        name: "repo",
        htmlUrl: "https://github.com/owner/repo",
        defaultBranch: "main",
      })
      .run();
    db.insert(githubIssues)
      .values({
        projectId: "project-git",
        issueNumber: 154,
        taskId: "task-git-1",
        nodeId: "I_154",
        htmlUrl: "https://github.com/owner/repo/issues/154",
        state: "open",
        sourceUpdatedAt: "2026-08-08T00:00:00.000Z",
        lastSyncedAt: "2026-08-08T00:00:00.000Z",
      })
      .run();

    await runPlanner("task-git-1", projectRoot);

    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    expect(branch).toMatch(/^feature\/add-user-authentication-/);

    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-git-1")).get();
    expect(updatedTask?.branchName).toBe(branch);
  });

  it("creates a task worktree for parallel full planning when the rollout flag is enabled", async () => {
    process.env.AIF_TASK_WORKTREES_ENABLED = "true";
    resetEnvCache();
    const db = testDb.current;
    const projectRoot = mkdtempSync(join(tmpdir(), "planner-worktree-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.local"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "T"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["config", "commit.gpgsign", "false"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    writeFileSync(join(projectRoot, "README.md"), "# t\n");
    execFileSync("git", ["add", "README.md"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init", "--no-verify"], {
      cwd: projectRoot,
      stdio: "ignore",
    });

    db.insert(projects)
      .values({
        id: "project-worktree",
        name: "Worktree Project",
        rootPath: projectRoot,
        parallelEnabled: true,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "task-worktree-1",
        projectId: "project-worktree",
        title: "Parallel worktree",
        description: "",
        status: "planning",
        plannerMode: "full",
        useSubagents: true,
      })
      .run();

    await runPlanner("task-worktree-1", projectRoot);

    const sharedBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-worktree-1")).get();

    expect(sharedBranch).toBe("main");
    expect(updatedTask?.branchName).toMatch(/^feature\/parallel-worktree-/);
    // Branch-scoped path: project segment + branch segment, never the task id.
    expect(updatedTask?.worktreePath).toContain("project-worktree");
    expect(updatedTask?.worktreePath).toContain("feature-parallel-worktree-");
    expect(updatedTask?.worktreePath).not.toContain("task-worktree-1");
    expect(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: updatedTask?.worktreePath ?? projectRoot,
        encoding: "utf8",
      }).trim(),
    ).toBe(updatedTask?.branchName);
  });

  it("restores persisted branch in fast plannerMode for already-bound task (mode-drift safe)", async () => {
    const db = testDb.current;
    const projectRoot = mkdtempSync(join(tmpdir(), "planner-mode-drift-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.local"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "T"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["config", "commit.gpgsign", "false"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    writeFileSync(join(projectRoot, "README.md"), "# t\n");
    execFileSync("git", ["add", "README.md"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init", "--no-verify"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    // Bind a feature branch then drift HEAD back to main.
    execFileSync("git", ["checkout", "-b", "feature/bound-fast"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["checkout", "main"], { cwd: projectRoot, stdio: "ignore" });

    db.insert(projects)
      .values({ id: "project-mode-drift", name: "Mode drift", rootPath: projectRoot })
      .run();
    db.insert(tasks)
      .values({
        id: "task-mode-drift-1",
        projectId: "project-mode-drift",
        title: "Mode drift",
        description: "",
        status: "planning",
        // FAST mode + persisted branchName = the dangerous case the previous
        // gating broke: restore must still happen, otherwise the planner
        // writes plan/log on whatever HEAD happens to be.
        plannerMode: "fast",
        useSubagents: false,
        branchName: "feature/bound-fast",
      })
      .run();

    queryMock.mockReset();
    queryMock.mockReturnValue(streamSuccess("## Plan\n- [ ] x"));

    await runPlanner("task-mode-drift-1", projectRoot);

    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    expect(branch).toBe("feature/bound-fast");
  });

  it("throws BranchIsolationError when subagent silently switched branches (drift)", async () => {
    const db = testDb.current;
    const projectRoot = mkdtempSync(join(tmpdir(), "planner-drift-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.local"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "T"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["config", "commit.gpgsign", "false"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    writeFileSync(join(projectRoot, "README.md"), "# t\n");
    execFileSync("git", ["add", "README.md"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init", "--no-verify"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    // Pre-create the branch so drift test has something to drift AWAY from
    execFileSync("git", ["checkout", "-b", "feature/some-drift"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["checkout", "main"], { cwd: projectRoot, stdio: "ignore" });

    db.insert(projects).values({ id: "project-drift", name: "Drift", rootPath: projectRoot }).run();
    db.insert(tasks)
      .values({
        id: "task-drift-1",
        projectId: "project-drift",
        title: "Drift test",
        description: "",
        status: "planning",
        plannerMode: "full",
        useSubagents: true,
        branchName: "feature/some-drift",
      })
      .run();

    // Simulate subagent switching HEAD away while "running"
    queryMock.mockReset();
    queryMock.mockImplementation(() => {
      execFileSync("git", ["checkout", "main"], { cwd: projectRoot, stdio: "ignore" });
      return streamSuccess("## Plan\n- [ ] x");
    });

    const { isBranchIsolationError } = await import("../gitBranch.js");
    try {
      await runPlanner("task-drift-1", projectRoot);
      throw new Error("expected throw");
    } catch (err) {
      expect(isBranchIsolationError(err)).toBe(true);
      if (isBranchIsolationError(err)) {
        expect(err.kind).toBe("branch_drift");
      }
    }
  });

  it("injects HANDOFF_BRANCH_PREPARED + HANDOFF_BRANCH_NAME into prompt", async () => {
    const db = testDb.current;
    const projectRoot = mkdtempSync(join(tmpdir(), "planner-env-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.local"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "T"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["config", "commit.gpgsign", "false"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    writeFileSync(join(projectRoot, "README.md"), "# t\n");
    execFileSync("git", ["add", "README.md"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init", "--no-verify"], {
      cwd: projectRoot,
      stdio: "ignore",
    });

    db.insert(projects).values({ id: "project-env", name: "Env", rootPath: projectRoot }).run();
    db.insert(tasks)
      .values({
        id: "task-env-1",
        projectId: "project-env",
        title: "Env contract",
        description: "",
        status: "planning",
        plannerMode: "full",
        useSubagents: true,
      })
      .run();

    await runPlanner("task-env-1", projectRoot);

    const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain("HANDOFF_BRANCH_PREPARED: 1");
    expect(call.prompt).toMatch(/HANDOFF_BRANCH_NAME: feature\/env-contract-/);
  });

  it("skips branch creation when plannerMode=fast", async () => {
    const db = testDb.current;
    const projectRoot = mkdtempSync(join(tmpdir(), "planner-fast-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.local"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "T"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["config", "commit.gpgsign", "false"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    writeFileSync(join(projectRoot, "README.md"), "# t\n");
    execFileSync("git", ["add", "README.md"], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init", "--no-verify"], {
      cwd: projectRoot,
      stdio: "ignore",
    });

    db.insert(projects)
      .values({
        id: "project-fast",
        name: "Fast Project",
        rootPath: projectRoot,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "task-fast-1",
        projectId: "project-fast",
        title: "Quick fix",
        description: "",
        status: "planning",
        plannerMode: "fast",
        useSubagents: true,
      })
      .run();

    await runPlanner("task-fast-1", projectRoot);

    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    expect(branch).toBe("main");

    const updatedTask = db.select().from(tasks).where(eq(tasks.id, "task-fast-1")).get();
    expect(updatedTask?.branchName).toBeNull();
  });

  it("uses /aif-plan command format only in skill mode", async () => {
    const db = testDb.current;
    db.insert(tasks)
      .values({
        id: "task-skill-1",
        projectId: "project-1",
        title: "Skill mode task",
        description: "Desc",
        status: "planning",
        planPath: ".ai-factory/PLAN.md",
        useSubagents: false,
      })
      .run();

    await runPlanner("task-skill-1", "/tmp/planner-test");

    const call = queryMock.mock.calls[0]?.[0] as { prompt: string };
    expect(call.prompt).toContain("/aif-plan fast @.ai-factory/PLAN.md docs:false tests:false");
    expect(call.prompt).toContain("HANDOFF_MODE: 1");
    expect(call.prompt).toContain("HANDOFF_TASK_ID: task-skill-1");
  });
});

describe("runPlanner stale plan cleanup", () => {
  beforeEach(() => {
    (globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: typeof queryMock }).__AIF_CLAUDE_QUERY_MOCK__ =
      queryMock;
    testDb.current = createTestDb();
    delete process.env.AIF_TASK_WORKTREES_ENABLED;
    delete process.env.AIF_GITHUB_ISSUE_PR_ENABLED;
    resetEnvCache();
    queryMock.mockReset();
    queryMock.mockReturnValue(streamSuccess("## New Plan\n- [ ] Task 1: Work"));
  });

  it("deletes stale completed plan file on first-time planning", async () => {
    const db = testDb.current;
    const projectRoot = mkdtempSync(join(tmpdir(), "planner-stale-"));
    const planFilePath = join(projectRoot, "PLAN.md");
    const planContent = "- [x] Task 1: Create user model\n- [x] Task 2: Add auth\n";
    writeFileSync(planFilePath, planContent, "utf8");

    db.insert(projects)
      .values({
        id: "project-stale",
        name: "Stale Project",
        rootPath: projectRoot,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "task-stale-1",
        projectId: "project-stale",
        title: "Stale plan task",
        description: "Desc",
        status: "planning",
        planPath: "PLAN.md",
        plannerMode: "fast",
        useSubagents: true,
      })
      .run();

    expect(existsSync(planFilePath)).toBe(true);
    await runPlanner("task-stale-1", projectRoot);

    // First-time planning: stale content should be replaced by the fresh subagent result.
    expect(existsSync(planFilePath)).toBe(true);
    const content = readFileSync(planFilePath, "utf8");
    expect(content).toContain("## New Plan");
    expect(content).toContain("Task 1: Work");
    expect(content).not.toContain("Create user model");
    expect(content).not.toContain("Add auth");
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("keeps plan file intact during replanning (planReviewFeedback set)", async () => {
    const db = testDb.current;
    const projectRoot = mkdtempSync(join(tmpdir(), "planner-replan-"));
    mkdirSync(join(projectRoot, ".ai-factory"), { recursive: true });
    const planFilePath = join(projectRoot, ".ai-factory", "PLAN.md");
    writeFileSync(
      planFilePath,
      "- [x] Task 1: Create user model\n- [x] Task 2: Add auth\n",
      "utf8",
    );

    db.insert(projects)
      .values({
        id: "project-replan",
        name: "Replan Project",
        rootPath: projectRoot,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "task-replan-stale",
        projectId: "project-replan",
        title: "Replan task",
        description: "Desc",
        status: "planning",
        planReviewFeedback: "Please revise the approach",
        useSubagents: true,
        plannerMode: "fast",
      })
      .run();

    expect(existsSync(planFilePath)).toBe(true);
    await runPlanner("task-replan-stale", projectRoot);

    // Replanning: stale file should NOT be deleted
    expect(existsSync(planFilePath)).toBe(true);
    const content = readFileSync(planFilePath, "utf8");
    expect(content).toContain("Task 1: Create user model");
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("deletes pre-existing plan file on first-time planning even when it has incomplete tasks", async () => {
    const db = testDb.current;
    const projectRoot = mkdtempSync(join(tmpdir(), "planner-partial-"));
    mkdirSync(join(projectRoot, ".ai-factory"), { recursive: true });
    const planFilePath = join(projectRoot, ".ai-factory", "PLAN.md");
    writeFileSync(
      planFilePath,
      "- [x] Task 1: Create user model\n- [ ] Task 2: Add auth\n",
      "utf8",
    );

    db.insert(projects)
      .values({
        id: "project-partial",
        name: "Partial Project",
        rootPath: projectRoot,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "task-partial-1",
        projectId: "project-partial",
        title: "Partial task",
        description: "Desc",
        status: "planning",
        plannerMode: "fast",
        useSubagents: true,
      })
      .run();

    expect(existsSync(planFilePath)).toBe(true);
    await runPlanner("task-partial-1", projectRoot);

    expect(existsSync(planFilePath)).toBe(true);
    const content = readFileSync(planFilePath, "utf8");
    expect(content).toContain("## New Plan");
    expect(content).toContain("Task 1: Work");
    expect(content).not.toContain("Create user model");
    expect(content).not.toContain("Add auth");
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("keeps existing plan file when the task already has a persisted plan", async () => {
    const db = testDb.current;
    const projectRoot = mkdtempSync(join(tmpdir(), "planner-persisted-plan-"));
    mkdirSync(join(projectRoot, ".ai-factory"), { recursive: true });
    const planFilePath = join(projectRoot, ".ai-factory", "PLAN.md");
    writeFileSync(
      planFilePath,
      "- [x] Task 1: Create user model\n- [ ] Task 2: Add auth\n",
      "utf8",
    );

    db.insert(projects)
      .values({
        id: "project-persisted-plan",
        name: "Persisted Plan Project",
        rootPath: projectRoot,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "task-persisted-plan-1",
        projectId: "project-persisted-plan",
        title: "Persisted plan task",
        description: "Desc",
        status: "planning",
        plan: "## Existing DB Plan\n- [ ] Keep refining",
        plannerMode: "fast",
        useSubagents: true,
      })
      .run();

    expect(existsSync(planFilePath)).toBe(true);
    await runPlanner("task-persisted-plan-1", projectRoot);

    expect(existsSync(planFilePath)).toBe(true);
    const content = readFileSync(planFilePath, "utf8");
    expect(content).toContain("Task 1: Create user model");
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("does not fail when plan file does not exist", async () => {
    const db = testDb.current;
    const projectRoot = mkdtempSync(join(tmpdir(), "planner-no-file-"));
    mkdirSync(join(projectRoot, ".ai-factory"), { recursive: true });

    db.insert(projects)
      .values({
        id: "project-no-file",
        name: "No File Project",
        rootPath: projectRoot,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "task-no-file-1",
        projectId: "project-no-file",
        title: "No file task",
        description: "Desc",
        status: "planning",
        plannerMode: "fast",
        useSubagents: true,
      })
      .run();

    // File doesn't exist — should not throw
    await expect(runPlanner("task-no-file-1", projectRoot)).resolves.toBeUndefined();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("does not fire for isFix tasks even when plan is fully completed", async () => {
    const db = testDb.current;
    const projectRoot = mkdtempSync(join(tmpdir(), "planner-fix-"));
    mkdirSync(join(projectRoot, ".ai-factory"), { recursive: true });
    const planFilePath = join(projectRoot, ".ai-factory", "PLAN.md");
    writeFileSync(planFilePath, "- [x] Task 1: Fix login bug\n", "utf8");

    db.insert(projects)
      .values({
        id: "project-fix-skip",
        name: "Fix Skip Project",
        rootPath: projectRoot,
      })
      .run();
    db.insert(tasks)
      .values({
        id: "task-fix-skip-1",
        projectId: "project-fix-skip",
        title: "Fix task",
        description: "Desc",
        status: "planning",
        isFix: true,
        useSubagents: false,
      })
      .run();

    expect(existsSync(planFilePath)).toBe(true);
    await runPlanner("task-fix-skip-1", projectRoot);

    // isFix tasks skip the stale cleanup guard
    expect(existsSync(planFilePath)).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
