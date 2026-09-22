import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbUsageEvent } from "@aif/data";

const notifyTaskUsageBroadcastMock = vi.fn();
const notifyProjectRuntimeLimitBroadcastMock = vi.fn();

vi.mock("../notifier.js", () => ({
  notifyTaskUsageBroadcast: (...args: unknown[]) => notifyTaskUsageBroadcastMock(...args),
  notifyProjectRuntimeLimitBroadcast: (...args: unknown[]) =>
    notifyProjectRuntimeLimitBroadcastMock(...args),
}));

const { handleUsageSinkRecorded } = await import("../usageSinkCallbacks.js");

function makeUsageEvent(overrides: Partial<DbUsageEvent> = {}): DbUsageEvent {
  return {
    context: {
      source: "task",
      projectId: "project-1",
      taskId: "task-1",
      chatSessionId: null,
      ...(overrides.context ?? {}),
    },
    runtimeId: "claude",
    providerId: "anthropic",
    profileId: "profile-1",
    transport: "sdk",
    workflowKind: "implementer",
    usageReporting: "FULL",
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      costUsd: 0.01,
    },
    recordedAt: new Date("2026-09-22T00:00:00.000Z"),
    ...overrides,
  };
}

describe("handleUsageSinkRecorded", () => {
  beforeEach(() => {
    notifyTaskUsageBroadcastMock.mockReset();
    notifyProjectRuntimeLimitBroadcastMock.mockReset();
  });

  it("broadcasts task usage and runtime-limit updates for task-scoped events", () => {
    // BR: BR-trigger.automation.runtime-limit-gate
    // FR: REQ-FR-dashboard.realtime.broadcast-live-updates
    // NFR: REQ-NFR-ops.observability.audit-trail-completeness
    // KI: KI-12
    const event = makeUsageEvent();

    handleUsageSinkRecorded(event);

    expect(notifyTaskUsageBroadcastMock).toHaveBeenCalledWith("task-1", "project-1", {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      costUsd: 0.01,
    });
    expect(notifyProjectRuntimeLimitBroadcastMock).toHaveBeenCalledWith("project-1", "profile-1", {
      taskId: "task-1",
    });
  });

  it("works for injected/non-coordinator usage-sink context without task broadcast", () => {
    // BR: BR-trigger.automation.runtime-limit-gate
    // FR: REQ-FR-dashboard.realtime.broadcast-live-updates
    // NFR: REQ-NFR-ops.observability.audit-trail-completeness
    // KI: KI-12
    const event = makeUsageEvent({
      context: {
        source: "chat",
        projectId: "project-2",
        taskId: null,
        chatSessionId: "chat-1",
      },
      profileId: "profile-2",
      usage: {
        inputTokens: 3,
        outputTokens: 4,
        totalTokens: 7,
      },
    });

    handleUsageSinkRecorded(event);

    expect(notifyTaskUsageBroadcastMock).not.toHaveBeenCalled();
    expect(notifyProjectRuntimeLimitBroadcastMock).toHaveBeenCalledWith("project-2", "profile-2", {
      taskId: null,
    });
  });
});
