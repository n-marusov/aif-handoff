import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isPlanFileValid } from "../planFileValidation.js";

describe("planFileValidation", () => {
  it("returns true when the plan file exists with content", () => {
    const root = mkdtempSync(join(tmpdir(), "plan-valid-"));
    mkdirSync(join(root, ".ai-factory"), { recursive: true });
    writeFileSync(join(root, ".ai-factory", "PLAN.md"), "## Plan\n- [ ] Item", "utf8");

    expect(
      isPlanFileValid({ executionRoot: root, isFix: false, planPath: ".ai-factory/PLAN.md" }),
    ).toBe(true);
  });

  it("returns false when the plan file is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "plan-missing-"));
    expect(
      isPlanFileValid({ executionRoot: root, isFix: false, planPath: ".ai-factory/PLAN.md" }),
    ).toBe(false);
  });

  it("returns false when the plan file is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "plan-empty-"));
    mkdirSync(join(root, ".ai-factory"), { recursive: true });
    writeFileSync(join(root, ".ai-factory", "PLAN.md"), "   \n", "utf8");

    expect(
      isPlanFileValid({ executionRoot: root, isFix: false, planPath: ".ai-factory/PLAN.md" }),
    ).toBe(false);
  });

  it("uses the fix plan path for fix tasks", () => {
    const root = mkdtempSync(join(tmpdir(), "plan-fix-"));
    mkdirSync(join(root, ".ai-factory"), { recursive: true });
    writeFileSync(join(root, ".ai-factory", "FIX_PLAN.md"), "## Fix plan", "utf8");

    expect(isPlanFileValid({ executionRoot: root, isFix: true, planPath: null })).toBe(true);
  });

  it("returns false when reading throws", () => {
    const root = mkdtempSync(join(tmpdir(), "plan-broken-"));
    // Мок не требуется: чтение несуществующего родительского каталога бросает.
    expect(
      isPlanFileValid({
        executionRoot: root,
        isFix: false,
        // Путь с null-компонентом гарантированно не читается.
        planPath: join(".ai-factory", "\0forbidden"),
      }),
    ).toBe(false);
  });
});
