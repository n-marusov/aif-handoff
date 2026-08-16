import { describe, expect, it } from "vitest";
import { LoopGuard } from "../loopGuard.js";
import { AiLoopDetectedError } from "../subagentQuery.js";

describe("LoopGuard", () => {
  it("throws AiLoopDetectedError when the tool-call cap is exceeded", () => {
    const guard = new LoopGuard({ maxToolCalls: 3, readOnlyBurst: 20 });
    guard.onToolUse("Read", "src/a.ts");
    guard.onToolUse("Read", "src/b.ts");
    guard.onToolUse("Bash", "pnpm install"); // not read-only, but counts toward the cap
    expect(() => guard.onToolUse("Read", "src/c.ts")).toThrow(AiLoopDetectedError);
  });

  it("throws AiLoopDetectedError on a read-only burst with no write", () => {
    const guard = new LoopGuard({ maxToolCalls: 500, readOnlyBurst: 3 });
    guard.onToolUse("Read", "src/a.ts");
    guard.onToolUse("Bash", "git diff sha^ sha -- src/b.ts");
    expect(() => guard.onToolUse("Read", "src/c.ts")).toThrow(AiLoopDetectedError);
  });

  it("resets the read-only burst when a write occurs", () => {
    const guard = new LoopGuard({ maxToolCalls: 500, readOnlyBurst: 3 });
    guard.onToolUse("Read", "src/a.ts");
    guard.onToolUse("Read", "src/b.ts");
    guard.onToolUse("Edit", "src/a.ts"); // write resets the burst
    guard.onToolUse("Read", "src/c.ts");
    guard.onToolUse("Read", "src/d.ts");
    expect(() => guard.onToolUse("Read", "src/e.ts")).toThrow(AiLoopDetectedError);
  });

  it("does not throw within the limits", () => {
    const guard = new LoopGuard({ maxToolCalls: 5, readOnlyBurst: 3 });
    guard.onToolUse("Read", "src/a.ts");
    guard.onToolUse("Edit", "src/a.ts");
    guard.onToolUse("Read", "src/b.ts");
    guard.onToolUse("Read", "src/c.ts");
    expect(() => guard.onToolUse("Bash", "npm run build")).not.toThrow();
  });

  it("attaches structured reason and counts to the error", () => {
    const guard = new LoopGuard({ maxToolCalls: 2, readOnlyBurst: 20 });
    try {
      guard.onToolUse("Read", "src/a.ts");
      guard.onToolUse("Read", "src/b.ts");
      guard.onToolUse("Read", "src/c.ts");
      throw new Error("expected loop error");
    } catch (error) {
      expect(error).toBeInstanceOf(AiLoopDetectedError);
      const loop = error as AiLoopDetectedError;
      expect(loop.code).toBe("possible_loop");
      expect(loop.reason).toBe("tool_call_cap");
      expect(loop.count).toBe(3);
      expect(loop.limit).toBe(2);
    }
  });
});
