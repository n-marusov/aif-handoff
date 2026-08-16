import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTOR_KINDS,
  EXECUTION_OWNERS,
  PARTICIPANT_ROLES,
  type AuthSessionState,
  type ParticipantBroadcastPayload,
  type TaskExecutorHistoryEntry,
  type TaskHeartbeatPayload,
  type TaskListItem,
  type TaskOwnershipBroadcastPayload,
  type TaskUsagePayload,
  type WsEvent,
} from "../browser.js";

describe("browser-safe participant contracts", () => {
  it("exports the stable participant, owner, and actor enums", () => {
    expect(PARTICIPANT_ROLES).toEqual(["admin", "member"]);
    expect(EXECUTION_OWNERS).toEqual(["ai", "human"]);
    expect(AUDIT_ACTOR_KINDS).toEqual(["participant", "agent", "system", "anonymous"]);
  });

  it("supports authenticated session and collaboration payloads without Node-only fields", () => {
    const session = {
      participantsModeEnabled: true,
      authenticated: true,
      participant: {
        id: "participant-1",
        displayName: "Alice",
        role: "admin",
        active: true,
      },
      csrfToken: "opaque-browser-token",
      expiresAt: "2026-07-25T12:00:00.000Z",
    } satisfies AuthSessionState;
    const actor = {
      kind: "participant",
      id: "participant-1",
      displayNameSnapshot: "Alice",
    } as const;
    const history = {
      id: "history-1",
      taskId: "task-1",
      taskTitleSnapshot: "Task",
      ownershipRevision: 1,
      executionOwner: "human",
      assignees: [
        {
          participantId: "participant-1",
          displayName: "Alice",
          role: "admin",
          active: true,
        },
      ],
      statusSnapshot: "planning",
      actor,
      reason: null,
      createdAt: "2026-07-24T12:00:00.000Z",
    } satisfies TaskExecutorHistoryEntry;
    const participantPayload = {
      participant: session.participant,
      actor,
    } satisfies ParticipantBroadcastPayload;
    const ownershipPayload = {
      taskId: history.taskId,
      projectId: "project-1",
      ownership: {
        executionOwner: history.executionOwner,
        ownershipRevision: history.ownershipRevision,
        assignees: history.assignees,
      },
      actor,
    } satisfies TaskOwnershipBroadcastPayload;
    const events = [
      { type: "participant:updated", payload: participantPayload },
      { type: "task:handoff", payload: ownershipPayload },
    ] satisfies WsEvent[];

    expect(events.map((event) => event.type)).toEqual(["participant:updated", "task:handoff"]);
  });

  it("supports live heartbeat and usage WebSocket payloads", () => {
    const heartbeat = {
      taskId: "task-1",
      lastHeartbeatAt: "2026-08-16T01:51:00.000Z",
    } satisfies TaskHeartbeatPayload;
    const usage = {
      taskId: "task-1",
      projectId: "project-1",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0.01 },
    } satisfies TaskUsagePayload;
    const listItem = {
      id: "task-1",
      projectId: "project-1",
      title: "Task",
      description: "",
      autoMode: true,
      executionOwner: "ai",
      ownershipRevision: 1,
      assignees: [],
      isFix: false,
      status: "implementing",
      priority: 0,
      position: 0,
      blockedReason: null,
      blockedFromStatus: null,
      retryAfter: null,
      retryCount: 0,
      roadmapAlias: null,
      tags: [],
      reworkRequested: false,
      reviewIterationCount: 0,
      maxReviewIterations: 3,
      manualReviewRequired: false,
      paused: false,
      lastSyncedAt: null,
      lastHeartbeatAt: "2026-08-16T01:51:00.000Z",
      scheduledAt: null,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
      hasPlan: false,
    } satisfies TaskListItem;
    const events = [
      { type: "task:heartbeat", payload: heartbeat },
      { type: "task:usage_updated", payload: usage },
    ] satisfies WsEvent[];

    expect(events.map((event) => event.type)).toEqual(["task:heartbeat", "task:usage_updated"]);
    expect(listItem.lastHeartbeatAt).toBe("2026-08-16T01:51:00.000Z");
  });
});
