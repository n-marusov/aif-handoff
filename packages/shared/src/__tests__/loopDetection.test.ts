import { describe, expect, it } from "vitest";
import { isReadOnlyToolCall, READ_ONLY_TOOLS, READ_ONLY_BASH_PATTERNS } from "../loopDetection.js";

describe("loop detection classification", () => {
  it("classifies file-read tools as read-only", () => {
    expect(isReadOnlyToolCall("Read", undefined)).toBe(true);
    expect(isReadOnlyToolCall("Read", "src/auth.ts")).toBe(true);
    expect(isReadOnlyToolCall("Glob", "**/*.ts")).toBe(true);
    expect(isReadOnlyToolCall("Grep", "import")).toBe(true);
  });

  it("classifies write tools as NOT read-only", () => {
    expect(isReadOnlyToolCall("Edit", "src/auth.ts")).toBe(false);
    expect(isReadOnlyToolCall("Write", "src/auth.ts")).toBe(false);
    expect(isReadOnlyToolCall("Bash", "git add src/auth.ts")).toBe(false);
    expect(isReadOnlyToolCall("Bash", "git commit -m 'x'")).toBe(false);
    expect(isReadOnlyToolCall("Bash", "git push")).toBe(false);
  });

  it("classifies read-only bash commands as read-only", () => {
    expect(isReadOnlyToolCall("Bash", "git show a245fef:./src/auth.ts")).toBe(true);
    expect(isReadOnlyToolCall("Bash", "git diff a245fef^ a245fef -- src/auth.ts")).toBe(true);
    expect(isReadOnlyToolCall("Bash", "git status")).toBe(true);
    expect(isReadOnlyToolCall("Bash", "cat package.json")).toBe(true);
    expect(isReadOnlyToolCall("Bash", "sed -n '1,20p' file.ts")).toBe(true);
    expect(isReadOnlyToolCall("Bash", "rg -n 'import' src")).toBe(true);
    expect(isReadOnlyToolCall("Bash", "ls -la")).toBe(true);
  });

  it("classifies mutating bash commands as NOT read-only", () => {
    expect(isReadOnlyToolCall("Bash", "pnpm install")).toBe(false);
    expect(isReadOnlyToolCall("Bash", "npm run build")).toBe(false);
    expect(isReadOnlyToolCall("Bash", "git checkout -b feature/x")).toBe(false);
    expect(isReadOnlyToolCall("Bash", "rm -rf dist")).toBe(false);
  });

  it("exposes stable read-only constants", () => {
    expect(READ_ONLY_TOOLS.has("Read")).toBe(true);
    expect(READ_ONLY_TOOLS.has("Write")).toBe(false);
    expect(READ_ONLY_BASH_PATTERNS.test("git show sha")).toBe(true);
    expect(READ_ONLY_BASH_PATTERNS.test("git commit")).toBe(false);
  });
});
