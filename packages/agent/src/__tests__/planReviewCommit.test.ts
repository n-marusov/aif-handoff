import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projects, tasks } from "@aif/shared";
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

const { ensurePlanReviewCommit } = await import("../planReviewCommit.js");

const TASK_TITLE = "Implement plan review PR gate";

function headSha(rootPath: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootPath,
    encoding: "utf8",
  }).trim();
}

function seedTask(rootPath: string, taskId = "task"): void {
  testDb.current.insert(projects).values({ id: "project", name: "Project", rootPath }).run();
  testDb.current
    .insert(tasks)
    .values({ id: taskId, projectId: "project", title: TASK_TITLE, status: "plan_ready" })
    .run();
}

function writePlan(rootPath: string, taskId = "task"): void {
  mkdirSync(join(rootPath, ".ai-factory"), { recursive: true });
  writeFileSync(join(rootPath, ".ai-factory", "PLAN.md"), `# Plan for ${taskId}\n`);
}

beforeEach(() => {
  testDb.current = createTestDb();
});

describe("ensurePlanReviewCommit", () => {
  it("commits only the plan file with a deterministic subject", () => {
    const { rootPath } = createGitTestRoot("plan-review-commit-single-");
    seedTask(rootPath);
    writePlan(rootPath);

    const before = headSha(rootPath);
    const report = ensurePlanReviewCommit({ taskId: "task", projectRoot: rootPath });

    expect(report.status).toBe("committed");
    expect(report.planPath).toBe(".ai-factory/PLAN.md");
    expect(report.conventionSource).toBe("default");
    expect(report.commitMessage).toBe(`docs(plan): ${TASK_TITLE}`);
    expect(report.branch).toBe("main");
    expect(report.stagedPaths).toEqual([".ai-factory/PLAN.md"]);
    expect(report.dirtyProductPaths).toEqual([]);

    const after = headSha(rootPath);
    expect(after).not.toBe(before);
    const subject = execFileSync("git", ["log", "-1", "--format=%s"], {
      cwd: rootPath,
      encoding: "utf8",
    }).trim();
    expect(subject).toBe(`docs(plan): ${TASK_TITLE}`);
    const changedFiles = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: rootPath,
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(changedFiles).toEqual([".ai-factory/PLAN.md"]);
  });

  it("blocks when dirty product files exist and leaves the tree uncommitted", () => {
    const { rootPath } = createGitTestRoot("plan-review-commit-blocked-");
    seedTask(rootPath);
    writePlan(rootPath);
    // Dirty product file outside the plan.
    writeFileSync(join(rootPath, "README.md"), "# test\nchanged\n");

    const before = headSha(rootPath);
    const report = ensurePlanReviewCommit({ taskId: "task", projectRoot: rootPath });

    expect(report.status).toBe("blocked_dirty_product_files");
    expect(report.commitSha).toBeNull();
    expect(report.dirtyProductPaths).toEqual(["README.md"]);
    expect(headSha(rootPath)).toBe(before);
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: rootPath,
      encoding: "utf8",
    }).trim();
    expect(staged).toBe("");
  });

  it("honors an explicit commit prefix declared in the target rules", () => {
    const { rootPath } = createGitTestRoot("plan-review-commit-rules-");
    writeFileSync(
      join(rootPath, "RULES.md"),
      ["## Git conventions", "branch_prefix: fix/", "commit_subject_prefix: docs(plans)", ""].join(
        "\n",
      ),
    );
    execFileSync("git", ["add", "-A"], { cwd: rootPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "test: add rules", "--no-verify"], {
      cwd: rootPath,
      stdio: "ignore",
    });

    seedTask(rootPath);
    writePlan(rootPath);
    const report = ensurePlanReviewCommit({ taskId: "task", projectRoot: rootPath });

    expect(report.status).toBe("committed");
    expect(report.conventionSource).toBe("rules");
    expect(report.commitMessage).toBe(`docs(plans): ${TASK_TITLE}`);
  });

  it("returns no_changes when the plan is already committed", () => {
    const { rootPath } = createGitTestRoot("plan-review-commit-nochanges-");
    seedTask(rootPath);
    writePlan(rootPath);
    const first = ensurePlanReviewCommit({ taskId: "task", projectRoot: rootPath });
    expect(first.status).toBe("committed");

    const report = ensurePlanReviewCommit({ taskId: "task", projectRoot: rootPath });
    expect(report.status).toBe("no_changes");
    expect(report.commitSha).toBeNull();
    expect(report.stagedPaths).toEqual([]);
  });

  it("returns blocked_missing_plan when the plan file does not exist", () => {
    const { rootPath } = createGitTestRoot("plan-review-commit-missing-");
    seedTask(rootPath);
    const report = ensurePlanReviewCommit({ taskId: "task", projectRoot: rootPath });
    expect(report.status).toBe("blocked_missing_plan");
    expect(report.commitSha).toBeNull();
  });

  it("sets a fallback git identity when user.email is unconfigured", () => {
    const rootPath = mkdtempSync(join(tmpdir(), "plan-review-commit-identity-"));
    execFileSync("git", ["init", "--initial-branch=main"], {
      cwd: rootPath,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "commit.gpgsign", "false"], {
      cwd: rootPath,
      stdio: "ignore",
    });
    writeFileSync(join(rootPath, "README.md"), "# test\n");
    execFileSync("git", ["add", "-A"], { cwd: rootPath, stdio: "ignore" });
    // Deterministic base commit authored via env identity (no local config).
    execFileSync(
      "git",
      [
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@t.local",
        "commit",
        "-m",
        "test: init",
        "--no-verify",
      ],
      {
        cwd: rootPath,
        stdio: "ignore",
      },
    );

    seedTask(rootPath);
    writePlan(rootPath);
    const report = ensurePlanReviewCommit({ taskId: "task", projectRoot: rootPath });

    expect(report.status).toBe("committed");
    expect(report.commitSha).toBeTruthy();
    // Commit author must be resolved (either from fallback or pre-existing
    // system config) — never "unknown".
    const author = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], {
      cwd: rootPath,
      encoding: "utf8",
    }).trim();
    expect(author).toBeTruthy();
    expect(author).not.toMatch(/unknown/i);
  });
});
