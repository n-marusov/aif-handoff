import { describe, expect, it } from "vitest";
import {
  COORDINATOR_STAGE_ORDER,
  stageInProgressStatus,
  TASK_STAGE_LIFECYCLE,
} from "../taskLifecycle.js";

describe("taskLifecycle (coordinator pipeline graph)", () => {
  it("covers the full canonical pipeline order", () => {
    expect(COORDINATOR_STAGE_ORDER).toEqual([
      "planner",
      "improver",
      "plan-checker",
      "plan-publisher",
      "implementer",
      "verifier",
      "reviewer",
      "done-checker",
    ]);
  });

  it("maps each stage to its from/inProgress/onSuccess topology", () => {
    expect(TASK_STAGE_LIFECYCLE.planner).toEqual({
      stage: "planner",
      from: ["planning"],
      inProgress: "planning",
      onSuccess: "plan_review",
    });
    expect(TASK_STAGE_LIFECYCLE.implementer.from).toContain("plan_review");
    expect(TASK_STAGE_LIFECYCLE.implementer.from).toContain("implementing");
    expect(TASK_STAGE_LIFECYCLE.implementer.onSuccess).toBe("verify");
    expect(TASK_STAGE_LIFECYCLE["done-checker"].onSuccess).toBe("accepted");
  });

  it("keeps plan-review loops before implementer so the gate is enforced", () => {
    const planReviewIndexes = ["plan-checker", "plan-publisher"].map((stage) =>
      COORDINATOR_STAGE_ORDER.indexOf(stage as (typeof COORDINATOR_STAGE_ORDER)[number]),
    );
    const implementerIndex = COORDINATOR_STAGE_ORDER.indexOf("implementer");
    expect(Math.max(...planReviewIndexes)).toBeLessThan(implementerIndex);
  });

  it("resolves the in-progress status for a stage", () => {
    expect(stageInProgressStatus("planner")).toBe("planning");
    expect(stageInProgressStatus("implementer")).toBe("implementing");
  });
});
