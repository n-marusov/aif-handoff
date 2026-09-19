/**
 * Поведенческие тесты доменной политики runtime-limit gate и приоритетов
 * runtime-профиля (Task 15 clean-architecture рефакторинга).
 *
 * evaluateRuntimeLimitGate — чистое решение над RuntimeProfile + getEnv().
 * Тесты подменяют AIF_USAGE_LIMITS_ENABLED и сбрасывают env-кэш между
 * проверками, чтобы обе ветки (флаг вкл/выкл) были покрыты.
 */

import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "../env.js";
import { evaluateRuntimeLimitGate, getProjectRuntimeProfileId } from "../runtimeLimitGate.js";
import { buildRuntimeLimitSignature } from "../runtimeLimitUtils.js";
import type { RuntimeLimitSnapshot, RuntimeProfile } from "../types.js";

const previousUsageLimitsEnabled = process.env.AIF_USAGE_LIMITS_ENABLED;

afterEach(() => {
  if (previousUsageLimitsEnabled === undefined) {
    delete process.env.AIF_USAGE_LIMITS_ENABLED;
  } else {
    process.env.AIF_USAGE_LIMITS_ENABLED = previousUsageLimitsEnabled;
  }
  resetEnvCache();
});

function setLimitsEnabled(enabled: boolean): void {
  process.env.AIF_USAGE_LIMITS_ENABLED = enabled ? "true" : "false";
  resetEnvCache();
}

function makeSnapshot(overrides: Partial<RuntimeLimitSnapshot> = {}): RuntimeLimitSnapshot {
  return {
    source: "sdk_event",
    status: "blocked",
    precision: "heuristic",
    checkedAt: "2026-04-17T10:00:00.000Z",
    providerId: "anthropic",
    windows: [{ scope: "time", resetAt: "2026-04-17T15:00:00.000Z" }],
    ...overrides,
  };
}

function makeProfile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    id: "rp-1",
    projectId: null,
    name: "Gate profile",
    runtimeId: "claude",
    providerId: "anthropic",
    transport: "sdk",
    baseUrl: null,
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    defaultModel: null,
    headers: {},
    options: {},
    enabled: true,
    runtimeLimitSnapshot: null,
    runtimeLimitUpdatedAt: null,
    lastUsage: null,
    lastUsageAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("evaluateRuntimeLimitGate", () => {
  it("never blocks when usage limits are disabled", () => {
    setLimitsEnabled(false);
    const decision = evaluateRuntimeLimitGate(
      makeProfile({ runtimeLimitSnapshot: makeSnapshot() }),
      Date.parse("2026-04-17T12:00:00.000Z"),
    );
    expect(decision.blocked).toBe(false);
    expect(decision.reason).toBe("none");
    expect(decision.runtimeProfileId).toBe("rp-1");
    expect(decision.signature).toBeNull();
  });

  it("does not block a null or profile-less snapshot while limits are enabled", () => {
    setLimitsEnabled(true);
    const noProfile = evaluateRuntimeLimitGate(null, Date.parse("2026-04-17T12:00:00.000Z"));
    expect(noProfile.blocked).toBe(false);
    expect(noProfile.runtimeProfileId).toBeNull();

    const noSnapshot = evaluateRuntimeLimitGate(
      makeProfile(),
      Date.parse("2026-04-17T12:00:00.000Z"),
    );
    expect(noSnapshot.blocked).toBe(false);
    expect(noSnapshot.reason).toBe("none");
  });

  it("blocks with provider_blocked when a blocked snapshot has a future reset hint", () => {
    setLimitsEnabled(true);
    const decision = evaluateRuntimeLimitGate(
      makeProfile({ runtimeLimitSnapshot: makeSnapshot() }),
      Date.parse("2026-04-17T12:00:00.000Z"),
    );
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe("provider_blocked");
    expect(decision.futureHint.source).toBeDefined();
    expect(decision.futureHint.isFuture).toBe(true);
    expect(decision.signature).toBe(buildRuntimeLimitSignature(makeSnapshot()));
    expect(decision.violatedWindow).toBeNull();
  });

  it("does not proactively block a blocked snapshot with no reset hint", () => {
    setLimitsEnabled(true);
    const decision = evaluateRuntimeLimitGate(
      makeProfile({
        runtimeLimitSnapshot: makeSnapshot({
          windows: [{ scope: "time", percentUsed: 100 }],
        }),
      }),
      Date.parse("2026-04-18T12:00:00.000Z"),
    );
    expect(decision.blocked).toBe(false);
    expect(decision.reason).toBe("none");
    // Снимок и подпись всё равно возвращаются для диагностики
    expect(decision.snapshot).not.toBeNull();
    expect(decision.signature).not.toBeNull();
  });

  it("blocks with exact_threshold when an exact warning window is violated and reset is in the future", () => {
    setLimitsEnabled(true);
    const nowMs = Date.parse("2026-04-17T12:00:00.000Z");
    const decision = evaluateRuntimeLimitGate(
      makeProfile({
        runtimeLimitSnapshot: makeSnapshot({
          status: "warning",
          precision: "exact",
          windows: [
            {
              scope: "time",
              percentRemaining: 5,
              warningThreshold: 10,
              resetAt: "2026-04-17T15:00:00.000Z",
            },
          ],
        }),
      }),
      nowMs,
    );
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe("exact_threshold");
    expect(decision.violatedWindow).not.toBeNull();
    expect(decision.signature).not.toBeNull();
  });

  it("does not block an exact warning snapshot whose violated window has no reset hint", () => {
    setLimitsEnabled(true);
    const decision = evaluateRuntimeLimitGate(
      makeProfile({
        runtimeLimitSnapshot: makeSnapshot({
          status: "warning",
          precision: "exact",
          windows: [{ scope: "time", percentRemaining: 5, warningThreshold: 10 }],
        }),
      }),
      Date.parse("2026-04-18T12:00:00.000Z"),
    );
    expect(decision.blocked).toBe(false);
    expect(decision.snapshot).not.toBeNull();
  });

  it("returns a non-blocked decision with snapshot for a healthy snapshot", () => {
    setLimitsEnabled(true);
    const nowMs = Date.parse("2026-04-17T12:00:00.000Z");
    const decision = evaluateRuntimeLimitGate(
      makeProfile({
        runtimeLimitSnapshot: makeSnapshot({
          status: "ok",
          precision: "heuristic",
          windows: [{ scope: "time", percentRemaining: 90 }],
        }),
      }),
      nowMs,
    );
    expect(decision.blocked).toBe(false);
    expect(decision.reason).toBe("none");
    expect(decision.snapshot?.status).toBe("ok");
    expect(decision.signature).not.toBeNull();
  });
});

describe("getProjectRuntimeProfileId", () => {
  const project = {
    id: "p1",
    name: "P",
    rootPath: "/tmp/p",
    defaultTaskRuntimeProfileId: "task-p",
    defaultPlanRuntimeProfileId: "plan-p",
    defaultReviewRuntimeProfileId: "review-p",
    defaultChatRuntimeProfileId: "chat-p",
  };

  it("returns the mode-specific default with chat/plan/review cascades", () => {
    expect(getProjectRuntimeProfileId(project as never, "task")).toBe("task-p");
    expect(getProjectRuntimeProfileId(project as never, "chat")).toBe("chat-p");
    expect(getProjectRuntimeProfileId(project as never, "plan")).toBe("plan-p");
    expect(getProjectRuntimeProfileId(project as never, "review")).toBe("review-p");
  });

  it("falls back to the task default for plan/review when the slot is absent", () => {
    const partial = {
      id: "p1",
      name: "P",
      rootPath: "/tmp/p",
      defaultTaskRuntimeProfileId: "task-p",
      defaultPlanRuntimeProfileId: null,
      defaultReviewRuntimeProfileId: null,
      defaultChatRuntimeProfileId: null,
    };
    expect(getProjectRuntimeProfileId(partial as never, "plan")).toBe("task-p");
    expect(getProjectRuntimeProfileId(partial as never, "review")).toBe("task-p");
  });

  it("returns null when no default is configured", () => {
    expect(getProjectRuntimeProfileId(undefined, "task")).toBeNull();
    expect(getProjectRuntimeProfileId(undefined, "chat")).toBeNull();
  });
});
