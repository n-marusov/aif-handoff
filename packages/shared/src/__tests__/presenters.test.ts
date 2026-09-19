/**
 * Поведенческие тесты презентационных мапперов, вынесенных из @aif/data
 * (Task 14 плана clean-architecture рефакторинга).
 *
 * Мапперы — чистые функции: на вход принимают строку БД (row-объект), на выходе
 * отдают view-модель. Это позволяет тестировать их без базы данных, собирая
 * row-объекты прямо в тесте. Поведение зафиксировано здесь, в пакете-владельце,
 * чтобы слой данных (который по-прежнему зовёт эти функции через @aif/shared) не
 * был единственной защитой от регрессий.
 */

import { describe, expect, it } from "vitest";
import {
  toAppSettingsResponse,
  toChatMessageResponse,
  toChatSessionResponse,
  toCommentResponse,
  toRuntimeProfileResponse,
  toTaskListItem,
  toTaskResponse,
  toTaskSummary,
} from "../presenters.js";

// Базовые строки: типы колонок повторяют Drizzle-$inferSelect из schema.ts.
// Поля, не участвующие в маппинге, опущены — мапперы спредят «остаток» row,
// поэтому неполная фикстура валидна и для списков, и для деталей.
function makeTaskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1",
    projectId: "proj-1",
    title: "Fix bug",
    description: "Desc",
    status: "implementing",
    autoMode: true,
    executionOwner: "ai",
    ownershipRevision: 0,
    assignees: [],
    tags: '["web","crash"]',
    attachments: null,
    runtimeOptionsJson: '{"model":"claude-3"}',
    autoReviewStateJson: null,
    currentToolJson: null,
    activeRuntimeSelectionJson: null,
    activeRuntimeStatus: null,
    runtimeLimitSnapshotJson: null,
    agentActivityLog: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeTaskListRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1",
    projectId: "proj-1",
    title: "Fix bug",
    description: "Desc",
    status: "backlog",
    autoMode: true,
    executionOwner: "ai",
    ownershipRevision: 0,
    skipReview: false,
    runPostVerify: false,
    tags: '["web"]',
    runtimeLimitSnapshotJson: null,
    currentToolJson: null,
    hasPlan: 1,
    position: 0,
    priority: 1,
    isFix: false,
    paused: false,
    roadmapAlias: null,
    runtimeProfileId: null,
    modelOverride: null,
    blockedReason: null,
    blockedFromStatus: null,
    retryAfter: null,
    retryCount: 0,
    reworkRequested: false,
    reviewIterationCount: 0,
    maxReviewIterations: 3,
    manualReviewRequired: false,
    runtimeLimitUpdatedAt: null,
    tokenInput: 0,
    tokenOutput: 0,
    tokenTotal: 0,
    costUsd: 0,
    lastSyncedAt: null,
    lastHeartbeatAt: null,
    lastActivityAt: null,
    scheduledAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeTaskSummaryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1",
    projectId: "proj-1",
    title: "Fix bug",
    status: "planning",
    autoMode: true,
    executionOwner: "human",
    ownershipRevision: 1,
    skipReview: false,
    runPostVerify: false,
    tags: '["ops"]',
    runtimeLimitSnapshotJson: null,
    runtimeLimitUpdatedAt: null,
    tokenTotal: 10,
    costUsd: 0.01,
    lastSyncedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("toTaskResponse", () => {
  it("parses tags and exposes runtime options without leaking raw JSON columns", () => {
    const response = toTaskResponse(makeTaskRow() as never);
    expect(response.id).toBe("task-1");
    expect(response.tags).toEqual(["web", "crash"]);
    expect(response.runtimeOptions).toEqual({ model: "claude-3" });
    expect(response).not.toHaveProperty("runtimeOptionsJson");
    expect(response).not.toHaveProperty("tags_");
  });

  it("computes permissions for the actor context", () => {
    const response = toTaskResponse(makeTaskRow() as never, {
      participantsModeEnabled: true,
      actor: { kind: "participant", id: "admin-1", displayNameSnapshot: "Admin" },
    });
    expect(response.permissions).toBeDefined();
    expect(typeof response.permissions?.canAssign).toBe("boolean");
    expect(Array.isArray(response.permissions?.permittedActions)).toBe(true);
    expect(response.permissions?.canHandoff).toBe(false);
  });

  it("redacts provider secrets from the agent activity log", () => {
    const response = toTaskResponse(
      makeTaskRow({ agentActivityLog: "sk-ant-secret\nline" }) as never,
    );
    expect(response.agentActivityLog).not.toContain("sk-ant-secret");
  });

  it("parses a malformed auto-review payload defensively", () => {
    const response = toTaskResponse(makeTaskRow({ autoReviewStateJson: "{broken" }) as never);
    expect(response.autoReviewState).toBeNull();
  });

  it("tolerates partial and invalid auto-review payloads", () => {
    // Не объект
    expect(
      toTaskResponse(makeTaskRow({ autoReviewStateJson: "[1,2]" }) as never).autoReviewState,
    ).toBeNull();
    // Нет обязательных полей (нет strategy)
    expect(
      toTaskResponse(makeTaskRow({ autoReviewStateJson: "{}" }) as never).autoReviewState,
    ).toBeNull();
    // Нет обязательных полей (нет iteration/findings)
    expect(
      toTaskResponse(makeTaskRow({ autoReviewStateJson: '{"strategy":"closure_first"}' }) as never)
        .autoReviewState,
    ).toBeNull();
    // Невалидный элемент findings (нет source)
    expect(
      toTaskResponse(
        makeTaskRow({
          autoReviewStateJson:
            '{"strategy":"closure_first","iteration":1,"findings":[{"id":"f1","text":"t"}]}',
        }) as never,
      ).autoReviewState,
    ).toBeNull();
    // Дубликат найденного элемента ломает длину normalizedFindings
    expect(
      toTaskResponse(
        makeTaskRow({
          autoReviewStateJson:
            '{"strategy":"closure_first","iteration":1,"findings":[{"id":"f1","text":"t","source":"code_review"},{"id":"f2"}]}',
        }) as never,
      ).autoReviewState,
    ).toBeNull();
  });

  it("parses a valid auto-review payload", () => {
    const response = toTaskResponse(
      makeTaskRow({
        autoReviewStateJson:
          '{"strategy":"closure_first","iteration":2,"findings":[{"id":"f1","text":"ok","source":"code_review"}]}',
      }) as never,
    );
    expect(response.autoReviewState?.strategy).toBe("closure_first");
    expect(response.autoReviewState?.iteration).toBe(2);
    expect(response.autoReviewState?.findings).toHaveLength(1);
  });

  it("parses the current tool when present", () => {
    const response = toTaskResponse(
      makeTaskRow({
        currentToolJson: '{"name":"Read","startedAt":"2026-01-01T00:00:00.000Z"}',
      }) as never,
    );
    expect(response.currentTool?.name).toBe("Read");
  });
});

describe("toTaskListItem", () => {
  it("maps the list projection with boolean hasPlan and parsed tags", () => {
    const item = toTaskListItem(makeTaskListRow() as never, [], {
      participantsModeEnabled: false,
      actor: { kind: "anonymous", id: null, displayNameSnapshot: null },
    });
    expect(item.hasPlan).toBe(true);
    expect(item.tags).toEqual(["web"]);
    expect(item.id).toBe("task-1");
    expect(item.currentTool).toBeNull();
  });

  it("normalizes hasPlan numeric flags", () => {
    expect(toTaskListItem(makeTaskListRow({ hasPlan: 1 }) as never).hasPlan).toBe(true);
    expect(toTaskListItem(makeTaskListRow({ hasPlan: 0 }) as never).hasPlan).toBe(false);
    expect(toTaskListItem(makeTaskListRow({ hasPlan: true }) as never).hasPlan).toBe(true);
  });
});

describe("toTaskSummary", () => {
  it("keeps identity, status and assignees of the summary row", () => {
    const summary = toTaskSummary(
      makeTaskSummaryRow({
        assignees: [{ participantId: "u1", displayName: "Alice", role: "member", active: true }],
      }) as never,
    );
    expect(summary.id).toBe("task-1");
    expect(summary.status).toBe("planning");
    expect(summary.tags).toEqual(["ops"]);
    expect(summary.assignees).toHaveLength(1);
    expect(summary.permissions).toBeDefined();
  });
});

describe("toCommentResponse", () => {
  it("maps a comment with participant and parsed attachments", () => {
    const comment = toCommentResponse({
      id: "c1",
      taskId: "task-1",
      author: "human",
      participantId: "u1",
      participant: { id: "u1", displayName: "Alice", role: "member", active: true },
      message: "hello",
      attachments: '[{"name":"a.txt","mimeType":"text/plain"}]',
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never);
    expect(comment.participantId).toBe("u1");
    expect(comment.participant?.displayName).toBe("Alice");
    expect(comment.attachments).toHaveLength(1);
  });

  it("tolerates malformed attachment JSON", () => {
    const comment = toCommentResponse({
      id: "c1",
      taskId: "task-1",
      author: "agent",
      participantId: null,
      participant: null,
      message: "x",
      attachments: "{bad",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never);
    expect(comment.attachments).toEqual([]);
  });
});

describe("toAppSettingsResponse", () => {
  it("maps app settings rows to the view model", () => {
    const row = {
      id: 1,
      defaultTaskRuntimeProfileId: "p-task",
      defaultPlanRuntimeProfileId: "p-plan",
      defaultReviewRuntimeProfileId: "p-review",
      defaultChatRuntimeProfileId: "p-chat",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const settings = toAppSettingsResponse(row as never);
    expect(settings.defaultTaskRuntimeProfileId).toBe("p-task");
    expect(settings.defaultChatRuntimeProfileId).toBe("p-chat");
    expect(settings.id).toBe(1);
  });
});

describe("toRuntimeProfileResponse", () => {
  it("maps profile rows and parses headers/options JSON", () => {
    const row = {
      id: "rp-1",
      projectId: null,
      name: "Default",
      runtimeId: "claude",
      providerId: "anthropic",
      transport: "sdk",
      baseUrl: null,
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      defaultModel: "claude-3-5",
      headersJson: '{"x-custom":"v"}',
      optionsJson: '{"timeoutMs":1000}',
      enabled: true,
      runtimeLimitSnapshotJson: null,
      runtimeLimitUpdatedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const profile = toRuntimeProfileResponse(row as never);
    expect(profile.headers).toEqual({ "x-custom": "v" });
    expect(profile.options).toEqual({ timeoutMs: 1000 });
    expect(profile.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
    expect(profile.lastUsage).toBeNull();
  });

  it("attaches usage state when provided", () => {
    const row = {
      id: "rp-1",
      projectId: null,
      name: "Default",
      runtimeId: "codex",
      providerId: "openai",
      transport: "sdk",
      baseUrl: null,
      apiKeyEnvVar: "OPENAI_API_KEY",
      defaultModel: null,
      headersJson: null,
      optionsJson: null,
      enabled: true,
      runtimeLimitSnapshotJson: null,
      runtimeLimitUpdatedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const profile = toRuntimeProfileResponse(row as never, {
      lastUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0.01 },
      lastUsageAt: "2026-01-01T00:00:00.000Z",
    });
    expect(profile.lastUsage?.totalTokens).toBe(3);
    expect(profile.lastUsageAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("parses a persisted runtime-limit snapshot", () => {
    const row = {
      id: "rp-1",
      projectId: null,
      name: "Gated",
      runtimeId: "claude",
      providerId: "anthropic",
      transport: "sdk",
      baseUrl: null,
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      defaultModel: null,
      headersJson: null,
      optionsJson: null,
      enabled: true,
      runtimeLimitSnapshotJson: JSON.stringify({
        source: "sdk_event",
        status: "blocked",
        precision: "heuristic",
        checkedAt: "2026-04-17T10:00:00.000Z",
        providerId: "anthropic",
        resetAt: "2026-04-17T15:00:00.000Z",
        windows: [{ scope: "time", resetAt: "2026-04-17T15:00:00.000Z" }],
      }),
      runtimeLimitUpdatedAt: "2026-04-17T10:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const profile = toRuntimeProfileResponse(row as never);
    expect(profile.runtimeLimitSnapshot?.status).toBe("blocked");
    expect(profile.runtimeLimitSnapshot?.windows[0].resetAt).toBe("2026-04-17T15:00:00.000Z");
    expect(profile.runtimeLimitUpdatedAt).toBe("2026-04-17T10:00:00.000Z");
  });

  it("tolerates malformed persisted runtime-limit snapshots", () => {
    // Отсутствует обязательное поле providerId
    const missingField = toRuntimeProfileResponse({
      id: "rp-1",
      projectId: null,
      name: "G",
      runtimeId: "claude",
      providerId: "anthropic",
      transport: "sdk",
      baseUrl: null,
      apiKeyEnvVar: "K",
      defaultModel: null,
      headersJson: null,
      optionsJson: null,
      enabled: true,
      runtimeLimitSnapshotJson: JSON.stringify({
        source: "sdk_event",
        status: "blocked",
        precision: "heuristic",
        checkedAt: "2026-04-17T10:00:00.000Z",
        windows: [],
      }),
      runtimeLimitUpdatedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    expect(missingField.runtimeLimitSnapshot).toBeNull();

    // Невалидный JSON
    const brokenJson = toRuntimeProfileResponse({
      id: "rp-2",
      projectId: null,
      name: "G2",
      runtimeId: "claude",
      providerId: "anthropic",
      transport: "sdk",
      baseUrl: null,
      apiKeyEnvVar: "K",
      defaultModel: null,
      headersJson: null,
      optionsJson: null,
      enabled: true,
      runtimeLimitSnapshotJson: "{oops",
      runtimeLimitUpdatedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    expect(brokenJson.runtimeLimitSnapshot).toBeNull();

    // Окно лимита с повреждённым scope
    const badWindow = toRuntimeProfileResponse({
      id: "rp-3",
      projectId: null,
      name: "G3",
      runtimeId: "claude",
      providerId: "anthropic",
      transport: "sdk",
      baseUrl: null,
      apiKeyEnvVar: "K",
      defaultModel: null,
      headersJson: null,
      optionsJson: null,
      enabled: true,
      runtimeLimitSnapshotJson: JSON.stringify({
        source: "sdk_event",
        status: "blocked",
        precision: "heuristic",
        checkedAt: "2026-04-17T10:00:00.000Z",
        providerId: "anthropic",
        windows: [{ percentUsed: 61 }],
      }),
      runtimeLimitUpdatedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    expect(badWindow.runtimeLimitSnapshot).toBeNull();

    // providerMeta приходит null-ом и не валидным объектом
    const metaNull = toRuntimeProfileResponse({
      id: "rp-4",
      projectId: null,
      name: "G4",
      runtimeId: "claude",
      providerId: "anthropic",
      transport: "sdk",
      baseUrl: null,
      apiKeyEnvVar: "K",
      defaultModel: null,
      headersJson: null,
      optionsJson: null,
      enabled: true,
      runtimeLimitSnapshotJson: JSON.stringify({
        source: "sdk_event",
        status: "warning",
        precision: "heuristic",
        checkedAt: "2026-04-17T10:00:00.000Z",
        providerId: "anthropic",
        providerMeta: null,
        windows: [{ scope: "time" }],
      }),
      runtimeLimitUpdatedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    expect(metaNull.runtimeLimitSnapshot).not.toBeNull();
  });
});

describe("toChatSessionResponse / toChatMessageResponse", () => {
  it("maps chat session rows", () => {
    const session = toChatSessionResponse({
      id: "s1",
      projectId: "proj-1",
      title: "Chat",
      agentSessionId: "as1",
      runtimeProfileId: null,
      runtimeSessionId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    expect(session.id).toBe("s1");
    expect(session.runtimeSessionId).toBe("as1");
    expect(session.source).toBe("web");
  });

  it("maps chat message rows and parses attachments", () => {
    const message = toChatMessageResponse({
      id: "m1",
      sessionId: "s1",
      role: "assistant",
      content: "hello",
      attachments: '[{"name":"a.txt","mimeType":"text/plain"}]',
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never);
    expect(message.content).toBe("hello");
    expect(message.attachments).toHaveLength(1);
  });

  it("tolerates malformed chat message attachments", () => {
    const message = toChatMessageResponse({
      id: "m2",
      sessionId: "s1",
      role: "user",
      content: "x",
      attachments: "{bad",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never);
    expect(message.attachments).toBeUndefined();
  });
});
