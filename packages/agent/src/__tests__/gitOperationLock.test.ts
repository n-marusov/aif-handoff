import { beforeEach, describe, expect, it } from "vitest";
import { resetProjectGitLocks, withProjectGitLock } from "../gitOperationLock.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withProjectGitLock", () => {
  beforeEach(() => {
    resetProjectGitLocks();
  });

  it("serializes concurrent operations for the same project root", async () => {
    const events: string[] = [];
    const run = (label: string): Promise<void> =>
      withProjectGitLock({ projectRoot: "/repo", operation: label }, async () => {
        events.push(`${label}:start`);
        await delay(15);
        events.push(`${label}:end`);
      });

    await Promise.all([run("a"), run("b"), run("c")]);

    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("runs different project roots concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const run = (root: string): Promise<void> =>
      withProjectGitLock({ projectRoot: root, operation: "op" }, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(20);
        active -= 1;
      });

    await Promise.all([run("/repo-a"), run("/repo-b")]);

    expect(maxActive).toBe(2);
  });

  it("treats path-separator variants of the same root as one lock", async () => {
    const events: string[] = [];
    const run = (root: string): Promise<void> =>
      withProjectGitLock({ projectRoot: root, operation: "op" }, async () => {
        events.push("start");
        await delay(10);
        events.push("end");
      });

    await Promise.all([run("/repo/child"), run("/repo/child/")]);

    expect(events).toEqual(["start", "end", "start", "end"]);
  });

  it("releases the lock when the callback throws", async () => {
    await expect(
      withProjectGitLock({ projectRoot: "/repo", operation: "boom" }, () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");

    const ran: string[] = [];
    await withProjectGitLock({ projectRoot: "/repo", operation: "after" }, () => {
      ran.push("ran");
    });

    expect(ran).toEqual(["ran"]);
  });

  it("returns the callback result", async () => {
    const value = await withProjectGitLock(
      { projectRoot: "/repo", operation: "value" },
      () => "result",
    );
    expect(value).toBe("result");
  });
});
