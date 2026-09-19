import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
