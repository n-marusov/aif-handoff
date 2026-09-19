import { describe, expect, it } from "vitest";
import { taskExecutionRoot } from "../taskExecutionRoot.js";

describe("taskExecutionRoot", () => {
  it("prefers the worktree path when present", () => {
    expect(taskExecutionRoot({ worktreePath: "/tmp/wt", rootPath: "/tmp/project" })).toBe(
      "/tmp/wt",
    );
  });

  it("falls back to the project root when no worktree exists", () => {
    expect(taskExecutionRoot({ worktreePath: null, rootPath: "/tmp/project" })).toBe(
      "/tmp/project",
    );
    expect(taskExecutionRoot({ worktreePath: undefined, rootPath: "/tmp/project" })).toBe(
      "/tmp/project",
    );
  });
});
