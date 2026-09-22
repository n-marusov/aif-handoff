import { describe, expect, it } from "vitest";
import { evaluateBudgetSamples, median, resolvePerfBudgetPolicy } from "../lib/perfBudgetPolicy";

// BR: BR-trigger.automation.pipeline
// FR: REQ-FR-dashboard.board.render-kanban-columns
// NFR: REQ-NFR-ops.observability.telemetry-overhead-budget
// KI: KI-08

describe("perf budget policy", () => {
  it("uses strict single-attempt policy in CI", () => {
    expect(resolvePerfBudgetPolicy({ CI: "true" })).toEqual({ attempts: 1, useMedian: false });
  });

  it("uses median policy with retries for local runs", () => {
    expect(resolvePerfBudgetPolicy({ CI: "false" })).toEqual({ attempts: 3, useMedian: true });
  });

  it("calculates median for odd and even samples", () => {
    expect(median([9, 1, 5])).toBe(5);
    expect(median([10, 2, 6, 4])).toBe(5);
  });

  it("evaluates budget strictly when policy is strict", () => {
    const result = evaluateBudgetSamples([1200, 800, 700], 1000, { attempts: 1, useMedian: false });
    expect(result.mode).toBe("strict");
    expect(result.representativeMs).toBe(1200);
    expect(result.pass).toBe(false);
  });

  it("evaluates budget by median for local retries", () => {
    const result = evaluateBudgetSamples([1500, 900, 800], 1000, { attempts: 3, useMedian: true });
    expect(result.mode).toBe("median");
    expect(result.representativeMs).toBe(900);
    expect(result.pass).toBe(true);
  });
});
