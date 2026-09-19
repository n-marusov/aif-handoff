import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@aif/data/db";

vi.mock("@aif/data/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/data/db")>();
  return { ...actual, getDb: () => createTestDb() };
});

// Known issue: "`parseTaskCurrentTool` — транзитный реэкспорт из `@aif/data`".
// Reproducer (Task 6): the parser is owned by @aif/shared; @aif/data must not re-export it,
// and the agent must import it from @aif/shared.
describe("data public surface", () => {
  it("does not re-export parseTaskCurrentTool", async () => {
    const data = await import("../index.js");
    expect("parseTaskCurrentTool" in data).toBe(false);
  });

  it("resolves parseTaskCurrentTool from @aif/shared", async () => {
    const shared = await import("@aif/shared");
    expect(typeof shared.parseTaskCurrentTool).toBe("function");
  });
});
