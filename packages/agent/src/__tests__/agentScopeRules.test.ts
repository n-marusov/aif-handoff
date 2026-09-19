import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEnv, resetEnvCache } from "@aif/shared";
import { getAgentScopeRules, resetAgentScopeRulesCache } from "../agentScopeRules.js";

// Реальный файл определений лежит в корне монорепозитория (.claude/agents),
// а тесты runner'а исполняются из packages/agent — указываем каталог через env.
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const definitionsDir = join(repoRoot, ".claude", "agents");

describe("agentScopeRules", () => {
  beforeEach(() => {
    vi.stubEnv("AIF_AGENT_DEFINITIONS_DIR", definitionsDir);
    resetEnvCache();
    resetAgentScopeRulesCache();
    // getEnv() читается внутри loader'а через замыкание process.env; после
    // stubEnv сброс кэша не требуется, но getEnv() в shared кэшируется.
    getEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
    resetAgentScopeRulesCache();
  });

  it("loads the project and review scope rules from the agent definition file", () => {
    const rules = getAgentScopeRules();
    expect(rules.projectScope).toContain("Project scope rule");
    expect(rules.projectScope).toContain("working directory");
    expect(rules.reviewScope).toContain("Review scope rule");
    expect(rules.reviewScope).toContain("diff introduced by the current plan");
  });

  it("is cached across calls until reset", () => {
    const first = getAgentScopeRules();
    const second = getAgentScopeRules();
    expect(second).toBe(first);
  });

  // Known issue: "agentScopeRules: определения резолвятся от process.cwd()".
  // Reproducer (Task 9): with a drifted cwd and no env override the old cwd-based default
  // returned empty rules; the module anchor must resolve the real definitions.
  it("falls back to the module anchor when cwd drifts and the env override is unset", () => {
    vi.stubEnv("AIF_AGENT_DEFINITIONS_DIR", "");
    resetEnvCache();
    resetAgentScopeRulesCache();
    const driftedCwd = mkdtempSync(join(tmpdir(), "aif-scope-cwd-"));
    vi.spyOn(process, "cwd").mockReturnValue(driftedCwd);

    const rules = getAgentScopeRules();

    expect(rules.projectScope).toContain("Project scope rule");
    expect(rules.reviewScope).toContain("Review scope rule");
  });

  it("lets the env override win over the module anchor", () => {
    const customDir = mkdtempSync(join(tmpdir(), "aif-scope-env-"));
    writeFileSync(
      join(customDir, "plan-coordinator.md"),
      [
        "### Project scope rule",
        "ENV OVERRIDE project scope",
        "",
        "### Review scope rule",
        "ENV OVERRIDE review scope",
        "",
      ].join("\n"),
    );
    vi.stubEnv("AIF_AGENT_DEFINITIONS_DIR", customDir);
    resetEnvCache();
    resetAgentScopeRulesCache();

    expect(getAgentScopeRules().projectScope).toContain("ENV OVERRIDE project scope");
  });

  it("honours the cache reset when the definitions directory changes", () => {
    expect(getAgentScopeRules().projectScope).toContain("Project scope rule");

    const customDir = mkdtempSync(join(tmpdir(), "aif-scope-reset-"));
    writeFileSync(
      join(customDir, "plan-coordinator.md"),
      "### Project scope rule\nRESET project scope\n",
    );
    vi.stubEnv("AIF_AGENT_DEFINITIONS_DIR", customDir);
    resetEnvCache();
    resetAgentScopeRulesCache();

    expect(getAgentScopeRules().projectScope).toContain("RESET project scope");
  });
});
