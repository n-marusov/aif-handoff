import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { countOtherLiveTasksReferencingWorktreeMock } = vi.hoisted(() => ({
  countOtherLiveTasksReferencingWorktreeMock: vi.fn(() => 0),
}));

vi.mock("@aif/data", () => ({
  countOtherLiveTasksReferencingWorktree: countOtherLiveTasksReferencingWorktreeMock,
}));

const { stashAndRemoveWorktree } = await import("../worktreeLifecycle.js");
const { resetProjectGitLocks } = await import("../gitOperationLock.js");

const GIT_TIMEOUT_MS = 20_000;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe(
  "stashAndRemoveWorktree",
  () => {
    let projectRoot: string;
    let worktreePath: string;

    function cleanupInput(overrides: Record<string, unknown> = {}) {
      return {
        taskId: "t1",
        projectId: "p1",
        projectRoot,
        branchName: "feature/x",
        worktreePath: worktreePath as string | null,
        reason: "task_delete",
        ...overrides,
      };
    }

    beforeEach(() => {
      resetProjectGitLocks();
      countOtherLiveTasksReferencingWorktreeMock.mockReset();
      countOtherLiveTasksReferencingWorktreeMock.mockReturnValue(0);

      projectRoot = mkdtempSync(join(tmpdir(), "wt-lifecycle-"));
      git(projectRoot, ["init", "--initial-branch=main"]);
      git(projectRoot, ["config", "user.email", "t@t.local"]);
      git(projectRoot, ["config", "user.name", "T"]);
      git(projectRoot, ["config", "commit.gpgsign", "false"]);
      writeFileSync(join(projectRoot, "README.md"), "# t\n");
      git(projectRoot, ["add", "README.md"]);
      git(projectRoot, ["commit", "-m", "init", "--no-verify"]);

      worktreePath = mkdtempSync(join(tmpdir(), "wt-lifecycle-wt-"));
      rmSync(worktreePath, { recursive: true, force: true });
      git(projectRoot, ["worktree", "add", "-b", "feature/x", worktreePath, "main"]);
    });

    afterEach(() => {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    });

    it("removes a clean worktree, prunes, and keeps the branch", async () => {
      const result = await stashAndRemoveWorktree(cleanupInput());

      expect(result).toEqual({ cleaned: true, stashSha: null });
      expect(existsSync(worktreePath)).toBe(false);
      // Branch is intentionally retained — an open PR/MR may still need it.
      expect(git(projectRoot, ["show-ref", "--verify", "refs/heads/feature/x"])).toContain(
        "refs/heads/feature/x",
      );
    });

    it("stashes uncommitted (tracked and untracked) work before removing", async () => {
      writeFileSync(join(worktreePath, "dirty.txt"), "dirty\n");

      const result = await stashAndRemoveWorktree(cleanupInput());

      expect(result.cleaned).toBe(true);
      expect(result.stashSha).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(worktreePath)).toBe(false);
    });

    it("skips removal when another live task references the same worktree", async () => {
      countOtherLiveTasksReferencingWorktreeMock.mockReturnValue(1);

      const result = await stashAndRemoveWorktree(cleanupInput());

      expect(result).toMatchObject({
        cleaned: false,
        skippedDueToReference: true,
        reason: "referenced_by_live_task",
      });
      expect(existsSync(worktreePath)).toBe(true);
    });

    it("skips when the task has no recorded worktree", async () => {
      const result = await stashAndRemoveWorktree(cleanupInput({ worktreePath: null }));

      expect(result).toMatchObject({ cleaned: false, reason: "no_worktree" });
    });

    it("prunes stale registrations when the folder is already gone", async () => {
      rmSync(worktreePath, { recursive: true, force: true });

      const result = await stashAndRemoveWorktree(cleanupInput());

      expect(result).toMatchObject({ cleaned: false, reason: "worktree_missing" });
      expect(git(projectRoot, ["worktree", "list"])).not.toContain("wt-lifecycle-wt-");
    });
  },
  GIT_TIMEOUT_MS,
);
