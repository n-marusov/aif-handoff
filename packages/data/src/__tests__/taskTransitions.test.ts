import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { projects } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

const {
  applyTaskAction,
  createParticipant,
  createTask,
  findTaskById,
  listAuditEvents,
  markTaskPlanApproved,
  markTaskPlanChangesRequested,
  markTaskPlanPublished,
  recordTaskPlanReviewFeedback,
  transitionTaskStatus,
} = await import("../index.js");

const adminActor = {
  kind: "participant" as const,
  id: "admin-1",
  displayNameSnapshot: "Admin",
};

beforeEach(() => {
  testDb.current = createTestDb();
  testDb.current
    .insert(projects)
    .values({ id: "project-1", name: "Project", rootPath: "/tmp/project" })
    .run();
});

describe("atomic task transitions", () => {
  it("commits an assigned participant action and audit record together", async () => {
    const participant = await createParticipant(
      {
        username: "member",
        displayName: "Member",
        password: "password-123",
        role: "member",
      },
      adminActor,
    );
    expect(participant.ok).toBe(true);
    if (!participant.ok) return;
    const task = createTask({
      projectId: "project-1",
      title: "Human task",
      description: "",
      executionOwner: "human",
      assigneeIds: [participant.participant.id],
      actor: adminActor,
    });
    expect(task).toBeDefined();
    if (!task) return;

    const result = applyTaskAction({
      taskId: task.id,
      event: "start_human_work",
      participantsModeEnabled: true,
      actor: {
        kind: "participant",
        id: participant.participant.id,
        displayNameSnapshot: participant.participant.displayName,
      },
      participantRole: "member",
      participantActive: true,
      expectedStatus: "backlog",
    });

    expect(result).toMatchObject({
      ok: true,
      fromStatus: "backlog",
      toStatus: "planning",
    });
    expect(findTaskById(task.id)?.status).toBe("planning");
    expect(listAuditEvents({ taskId: task.id }).at(-1)).toMatchObject({
      action: "task.action.start_human_work",
      statusSnapshot: "planning",
      actor: { kind: "participant", id: participant.participant.id },
      metadata: { fromStatus: "backlog", toStatus: "planning" },
    });
  });

  it("denies unassigned members and reports stale status without mutating", () => {
    const task = createTask({
      projectId: "project-1",
      title: "Unassigned",
      description: "",
      executionOwner: "human",
      actor: adminActor,
    });
    expect(task).toBeDefined();
    if (!task) return;

    expect(
      applyTaskAction({
        taskId: task.id,
        event: "start_human_work",
        participantsModeEnabled: true,
        actor: {
          kind: "participant",
          id: "member-1",
          displayNameSnapshot: "Member",
        },
        participantRole: "member",
      }),
    ).toMatchObject({ ok: false, code: "assignment_required" });
    expect(
      applyTaskAction({
        taskId: task.id,
        event: "start_human_work",
        participantsModeEnabled: true,
        actor: adminActor,
        participantRole: "admin",
        expectedStatus: "planning",
      }),
    ).toMatchObject({
      ok: false,
      code: "status_conflict",
      currentStatus: "backlog",
    });
    expect(findTaskById(task.id)?.status).toBe("backlog");
    expect(listAuditEvents({ taskId: task.id })).toHaveLength(1);
  });

  it("rejects agents on human-owned tasks and permits system recovery", () => {
    const task = createTask({
      projectId: "project-1",
      title: "Human recovery",
      description: "",
      executionOwner: "human",
      actor: adminActor,
    });
    expect(task).toBeDefined();
    if (!task) return;

    expect(
      transitionTaskStatus({
        taskId: task.id,
        status: "blocked_external",
        actor: { kind: "agent", id: "coordinator", displayNameSnapshot: "Coordinator" },
      }),
    ).toMatchObject({ ok: false, code: "ai_handoff_required" });
    expect(
      transitionTaskStatus({
        taskId: task.id,
        status: "blocked_external",
        expectedStatus: "backlog",
        actor: { kind: "system", id: "watchdog", displayNameSnapshot: "Watchdog" },
      }),
    ).toMatchObject({ ok: true, toStatus: "blocked_external" });
  });

  it("rolls back the status mutation when audit persistence fails", () => {
    const task = createTask({
      projectId: "project-1",
      title: "Rollback",
      description: "",
    });
    expect(task).toBeDefined();
    if (!task) return;
    testDb.current.run(sql`
      CREATE TRIGGER fail_status_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'task.status_changed'
      BEGIN
        SELECT RAISE(ABORT, 'forced audit failure');
      END
    `);

    expect(() =>
      transitionTaskStatus({
        taskId: task.id,
        status: "planning",
        expectedStatus: "backlog",
        actor: { kind: "system", id: "test", displayNameSnapshot: "Test" },
      }),
    ).toThrow("forced audit failure");
    expect(findTaskById(task.id)?.status).toBe("backlog");
    expect(listAuditEvents({ taskId: task.id })).toHaveLength(1);
  });
});

describe("plan review gate transitions", () => {
  const agentActor = {
    kind: "agent" as const,
    id: "plan-review-test",
    displayNameSnapshot: "Plan Review Test",
  };

  function createReadyAiTask(title: string): string {
    const task = createTask({
      projectId: "project-1",
      title,
      description: "",
      autoMode: true,
      executionOwner: "ai",
      actor: agentActor,
    });
    if (!task) throw new Error("expected task");
    const ready = transitionTaskStatus({
      taskId: task.id,
      status: "plan_ready",
      expectedStatus: "backlog",
      actor: agentActor,
      action: "task.status_changed",
    });
    if (!ready.ok) throw new Error("expected plan_ready transition");
    return task.id;
  }

  it("publishes a ready plan into plan_review with commit metadata", () => {
    const taskId = createReadyAiTask("Publish plan");
    const result = markTaskPlanPublished({
      taskId,
      commitSha: "deadbeef",
      actor: agentActor,
      now: new Date("2030-01-01T10:00:00.000Z"),
    });

    expect(result).toMatchObject({ ok: true, fromStatus: "plan_ready", toStatus: "plan_review" });
    const row = findTaskById(taskId);
    expect(row).toMatchObject({
      status: "plan_review",
      planReviewState: "published",
      planReviewCommitSha: "deadbeef",
      planReviewPublishedAt: "2030-01-01T10:00:00.000Z",
      planReviewApprovedAt: null,
      planReviewFeedback: null,
    });
    expect(listAuditEvents({ taskId }).at(-1)).toMatchObject({
      action: "task.plan_review.published",
      statusSnapshot: "plan_review",
    });
  });

  it("denies publishing when the task is not plan_ready", () => {
    const task = createTask({
      projectId: "project-1",
      title: "Not ready",
      description: "",
      actor: agentActor,
    });
    if (!task) throw new Error("expected task");
    expect(
      markTaskPlanPublished({ taskId: task.id, commitSha: "abc", actor: agentActor }),
    ).toMatchObject({ ok: false, code: "status_conflict", currentStatus: "backlog" });
    expect(findTaskById(task.id)?.status).toBe("backlog");
  });

  it("approves a published plan into implementing", () => {
    const taskId = createReadyAiTask("Approve plan");
    markTaskPlanPublished({ taskId, commitSha: "abc123", actor: agentActor });

    const result = markTaskPlanApproved({
      taskId,
      actor: agentActor,
      now: new Date("2026-09-09T11:00:00.000Z"),
    });
    expect(result).toMatchObject({
      ok: true,
      fromStatus: "plan_review",
      toStatus: "implementing",
    });
    const row = findTaskById(taskId);
    expect(row).toMatchObject({
      status: "implementing",
      planReviewState: "approved",
      planReviewApprovedAt: "2026-09-09T11:00:00.000Z",
    });
  });

  it("denies approval before the plan has been published", () => {
    const taskId = createReadyAiTask("Approve too early");
    expect(markTaskPlanApproved({ taskId, actor: agentActor })).toMatchObject({
      ok: false,
      code: "status_conflict",
      currentStatus: "plan_ready",
    });
  });

  it("routes changes requested back to planning and persists feedback", () => {
    const taskId = createReadyAiTask("Request plan changes");
    markTaskPlanPublished({ taskId, commitSha: "abc123", actor: agentActor });

    const result = markTaskPlanChangesRequested({
      taskId,
      feedback: "Please split the migration into two steps",
      actor: agentActor,
    });
    expect(result).toMatchObject({ ok: true, fromStatus: "plan_review", toStatus: "planning" });
    expect(findTaskById(taskId)).toMatchObject({
      status: "planning",
      planReviewState: "changes_requested",
      planReviewFeedback: "Please split the migration into two steps",
      planReviewApprovedAt: null,
    });
  });

  it("records feedback on a published task without changing status", () => {
    const taskId = createReadyAiTask("Record feedback");
    markTaskPlanPublished({ taskId, commitSha: "abc123", actor: agentActor });

    const row = recordTaskPlanReviewFeedback({
      taskId,
      feedback: "See inline comments on the plan",
      now: new Date("2026-09-09T12:00:00.000Z"),
    });
    expect(row).toMatchObject({
      status: "plan_review",
      planReviewState: "published",
      planReviewFeedback: "See inline comments on the plan",
    });
  });
});
