import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskWorktreePath, listWorktrees, resolveWorktreeRoot } from "@aif/shared";

const mocks = vi.hoisted(() => ({
  listActiveTasksWithWorktrees: vi.fn(() => [] as unknown[]),
  clearDanglingVcsIssueLinks: vi.fn(() => ({ githubLinksCleared: 0, gitlabLinksCleared: 0 })),
  findTaskById: vi.fn(() => null as { title?: string; status?: string } | null),
  setTaskFields: vi.fn(),
  updateTaskStatus: vi.fn(),
  listProjects: vi.fn(() => [] as unknown[]),
  countOtherLiveTasksReferencingWorktree: vi.fn(() => 0),
}));

vi.mock("@aif/data", () => ({ ...mocks }));

const { reconcileWorktrees } = await import("../worktreeReconcile.js");
const { resetProjectGitLocks } = await import("../gitOperationLock.js");

const GIT_TIMEOUT_MS = 30_000;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe(
  "reconcileWorktrees",
  () => {
    let projectRoot: string;
    let extraPaths: string[];

    beforeEach(() => {
      resetProjectGitLocks();
      extraPaths = [];
      for (const mock of Object.values(mocks)) mock.mockReset();
      mocks.listActiveTasksWithWorktrees.mockReturnValue([]);
      mocks.clearDanglingVcsIssueLinks.mockReturnValue({
        githubLinksCleared: 0,
        gitlabLinksCleared: 0,
      });
      mocks.findTaskById.mockReturnValue(null);
      mocks.countOtherLiveTasksReferencingWorktree.mockReturnValue(0);

      projectRoot = mkdtempSync(join(tmpdir(), "wt-reconcile-"));
      git(projectRoot, ["init", "--initial-branch=main"]);
      git(projectRoot, ["config", "user.email", "t@t.local"]);
      git(projectRoot, ["config", "user.name", "T"]);
      git(projectRoot, ["config", "commit.gpgsign", "false"]);
      writeFileSync(join(projectRoot, "README.md"), "# t\n");
      git(projectRoot, ["add", "README.md"]);
      git(projectRoot, ["commit", "-m", "init", "--no-verify"]);
    });

    afterEach(() => {
      for (const path of extraPaths) rmSync(path, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    });

    it("removes an orphan worktree that no live task references", async () => {
      const orphanPath = buildTaskWorktreePath({ projectRoot, branchName: "feature/orphan" });
      extraPaths.push(orphanPath, resolveWorktreeRoot(projectRoot).worktreeRoot);
      git(projectRoot, ["worktree", "add", "-b", "feature/orphan", orphanPath, "main"]);

      const summary = await reconcileWorktrees({
        projectId: "p1",
        projectRoot,
        reason: "test",
      });

      expect(summary.removed).toBe(1);
      expect(existsSync(orphanPath)).toBe(false);
      expect(mocks.clearDanglingVcsIssueLinks).toHaveBeenCalledOnce();
    });

    it("drops an unhealthy (prunable) registration under the canonical root", async () => {
      const unhealthyPath = buildTaskWorktreePath({
        projectRoot,
        branchName: "feature/unhealthy",
      });
      extraPaths.push(unhealthyPath, resolveWorktreeRoot(projectRoot).worktreeRoot);
      git(projectRoot, ["worktree", "add", "-b", "feature/unhealthy", unhealthyPath, "main"]);
      rmSync(unhealthyPath, { recursive: true, force: true });

      const summary = await reconcileWorktrees({
        projectId: "p1",
        projectRoot,
        reason: "test",
      });

      expect(summary.removed).toBe(1);
      expect(listWorktrees(projectRoot).some((entry) => entry.branch === "feature/unhealthy")).toBe(
        false,
      );
    });

    it("retains a worktree referenced by a live task", async () => {
      const livePath = buildTaskWorktreePath({ projectRoot, branchName: "feature/live" });
      extraPaths.push(livePath, resolveWorktreeRoot(projectRoot).worktreeRoot);
      git(projectRoot, ["worktree", "add", "-b", "feature/live", livePath, "main"]);
      mocks.listActiveTasksWithWorktrees.mockReturnValue([
        {
          id: "task-live",
          projectId: "p1",
          branchName: "feature/live",
          worktreePath: livePath,
          status: "implementing",
        },
      ]);

      const summary = await reconcileWorktrees({
        projectId: "p1",
        projectRoot,
        reason: "test",
      });

      expect(summary.removed).toBe(0);
      expect(existsSync(livePath)).toBe(true);
    });

    it("repairs a missing folder for a live task", async () => {
      const canonicalPath = buildTaskWorktreePath({
        projectRoot,
        branchName: "feature/repair",
        projectId: "p1",
      });
      extraPaths.push(canonicalPath, resolveWorktreeRoot(projectRoot).worktreeRoot);
      mocks.listActiveTasksWithWorktrees.mockReturnValue([
        {
          id: "task-repair",
          projectId: "p1",
          branchName: "feature/repair",
          worktreePath: canonicalPath,
          status: "implementing",
        },
      ]);
      mocks.findTaskById.mockReturnValue({ title: "Repair me", status: "implementing" });

      const summary = await reconcileWorktrees({
        projectId: "p1",
        projectRoot,
        reason: "test",
      });

      expect(summary.repaired).toBe(1);
      expect(existsSync(canonicalPath)).toBe(true);
      expect(mocks.setTaskFields).toHaveBeenCalledWith(
        "task-repair",
        expect.objectContaining({ worktreePath: canonicalPath }),
      );
      expect(mocks.updateTaskStatus).not.toHaveBeenCalled();
    });

    it("reports dangling VCS links cleared in the summary", async () => {
      mocks.clearDanglingVcsIssueLinks.mockReturnValue({
        githubLinksCleared: 2,
        gitlabLinksCleared: 1,
      });

      const summary = await reconcileWorktrees({
        projectId: "p1",
        projectRoot,
        reason: "test",
      });

      expect(summary.danglingLinksCleared).toBe(3);
    });
  },
  GIT_TIMEOUT_MS,
);
