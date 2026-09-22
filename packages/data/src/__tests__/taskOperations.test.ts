import { beforeEach, describe, expect, it, vi } from "vitest";
import { projects, toTaskResponse } from "@aif/shared";
import { createTestDb } from "@aif/data/db";
import {
  createRuntimeProfile,
  createTaskManaged,
  setTaskPlanContentManaged,
  updateTaskManaged,
  validateProjectScopedRuntimeProfileSelections,
} from "@aif/data";

const testDb = { current: createTestDb() };
vi.mock("@aif/data/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/data/db")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

function seedProject(id = "proj-1", parallelEnabled = false) {
  testDb.current
    .insert(projects)
    .values({
      id,
      name: `Project ${id}`,
      rootPath: "/tmp/test",
      parallelEnabled,
    })
    .run();
}

describe("taskOperations", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    seedProject("proj-1");
  });

  describe("validateProjectScopedRuntimeProfileSelections", () => {
    it("accepts global and same-project profiles", () => {
      const globalProfile = createRuntimeProfile({
        projectId: null,
        name: "Global",
        runtimeId: "claude",
        providerId: "anthropic",
        enabled: true,
      });
      const projectProfile = createRuntimeProfile({
        projectId: "proj-1",
        name: "Project",
        runtimeId: "codex",
        providerId: "openai",
        enabled: true,
      });

      expect(
        validateProjectScopedRuntimeProfileSelections({
          projectId: "proj-1",
          selections: {
            global: globalProfile!.id,
            project: projectProfile!.id,
          },
        }),
      ).toBeNull();
    });

    it("rejects cross-project and disabled profiles with field errors", () => {
      seedProject("proj-2");
      const foreign = createRuntimeProfile({
        projectId: "proj-2",
        name: "Foreign",
        runtimeId: "claude",
        providerId: "anthropic",
        enabled: true,
      });
      const disabled = createRuntimeProfile({
        projectId: "proj-1",
        name: "Disabled",
        runtimeId: "codex",
        providerId: "openai",
        enabled: false,
      });

      const failure = validateProjectScopedRuntimeProfileSelections({
        projectId: "proj-1",
        selections: {
          foreign: foreign!.id,
          disabled: disabled!.id,
        },
      });
      expect(failure).not.toBeNull();
      expect(failure!.fieldErrors.foreign).toHaveLength(1);
      expect(failure!.fieldErrors.disabled).toHaveLength(1);
    });

    it("ignores null/undefined selections", () => {
      expect(
        validateProjectScopedRuntimeProfileSelections({
          projectId: "proj-1",
          selections: { runtimeProfileId: undefined },
        }),
      ).toBeNull();
    });
  });

  describe("createTaskManaged", () => {
    it("creates a task with mode-defaulted planner flags", async () => {
      const result = createTaskManaged({
        projectId: "proj-1",
        title: "Fast task",
        description: "D",
        actor: { kind: "agent", id: "test", displayNameSnapshot: "Test" },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const task = toTaskResponse(result.task);
      expect(task.status).toBe("backlog");
      // fast-режим по умолчанию: skipReview=true, planDocs/planTests=false
      expect(result.task.skipReview).toBe(true);
      expect(result.task.planDocs).toBe(false);
      expect(result.task.planTests).toBe(false);
    });

    it("forces full planner mode for parallel-enabled projects", () => {
      seedProject("proj-parallel", true);
      const result = createTaskManaged({
        projectId: "proj-parallel",
        title: "Parallel task",
        description: "",
        plannerMode: "fast",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.task.plannerMode).toBe("full");
    });

    it("rejects a cross-project runtime profile", () => {
      seedProject("proj-2");
      const foreign = createRuntimeProfile({
        projectId: "proj-2",
        name: "Foreign",
        runtimeId: "claude",
        providerId: "anthropic",
        enabled: true,
      });
      const result = createTaskManaged({
        projectId: "proj-1",
        title: "Bad",
        description: "",
        runtimeProfileId: foreign!.id,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("invalid_runtime_profile");
    });

    it("returns invalid_ownership when AI-owned task cannot have assignees", () => {
      const result = createTaskManaged({
        projectId: "proj-1",
        title: "AI owned",
        description: "",
        executionOwner: "ai",
        assigneeIds: ["participant-x"],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(["invalid_ownership", "inactive_assignee"]).toContain(result.code);
    });
  });

  describe("updateTaskManaged", () => {
    it("updates fields and returns the updated row", () => {
      const created = createTaskManaged({
        projectId: "proj-1",
        title: "Before",
        description: "D",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = updateTaskManaged({
        taskId: created.task.id,
        patch: { title: "After" },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.task.title).toBe("After");
    });

    it("rejects ownership and lifecycle fields", () => {
      const created = createTaskManaged({
        projectId: "proj-1",
        title: "Reject",
        description: "D",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = updateTaskManaged({
        taskId: created.task.id,
        patch: { executionOwner: "human" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("forbidden_fields");
    });

    it("clears runPlanImprove/runPostVerify when useSubagents is active", () => {
      const created = createTaskManaged({
        projectId: "proj-1",
        title: "Subagent",
        description: "D",
        useSubagents: false,
        runPlanImprove: true,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = updateTaskManaged({
        taskId: created.task.id,
        patch: { title: "X" },
        useSubagents: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.task.runPlanImprove).toBe(false);
      expect(result.task.runPostVerify).toBe(false);
    });

    it("rejects tasks that do not exist", () => {
      const result = updateTaskManaged({
        taskId: "missing-task",
        patch: { title: "X" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("task_not_found");
    });

    it("rejects invalid runtime profile on update", () => {
      const created = createTaskManaged({
        projectId: "proj-1",
        title: "Runtime",
        description: "D",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      seedProject("proj-3");
      const foreign = createRuntimeProfile({
        projectId: "proj-3",
        name: "Foreign",
        runtimeId: "claude",
        providerId: "anthropic",
        enabled: true,
      });

      const result = updateTaskManaged({
        taskId: created.task.id,
        patch: { runtimeProfileId: foreign!.id },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("invalid_runtime_profile");
    });
  });

  // BR: BR-trigger.automation.pipeline
  // FR: REQ-FR-pipeline.stage.auto-advance-after-gate
  // NFR: REQ-NFR-data.compliance.task-transactional-consistency
  // KI: KI-09
  describe("setTaskPlanContentManaged", () => {
    it("sets the plan field and returns the updated row", () => {
      const created = createTaskManaged({
        projectId: "proj-1",
        title: "Plan",
        description: "D",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = setTaskPlanContentManaged(created.task.id, "## Plan\n- [x] one");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const task = toTaskResponse(result.task);
      expect(task.plan).toBe("## Plan\n- [x] one");
    });

    it("returns task_not_found for missing tasks", () => {
      const result = setTaskPlanContentManaged("missing-task", "## Plan");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("task_not_found");
    });
  });
});