/**
 * Контрактный сьют для областей `@aif/data`, которые планируется вынести из
 * модуля при clean-architecture рефакторинге:
 *
 *  - презентационные мапперы (`to*Response/*ListItem/*Summary`) — кандидаты на
 *    перенос в presenter-модуль на стороне доставки (Task 14);
 *  - runtime-limit gate policy (`evaluateRuntimeLimitGate`) — чистый decision,
 *    который должен покинуть data-слой (Task 15).
 *
 * Тесты намеренно фиксируют ТОЛЬКО наблюдаемое поведение через публичный API
 * (без импорта внутренних helper'ов и типов), чтобы перенос логики в другой
 * модуль не потребовал правки этих ассертов.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { projects, resetEnvCache, type RuntimeLimitSnapshot } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";
import {
  createTask,
  createRuntimeProfile,
  findRuntimeProfileById,
  findTaskById,
  persistRuntimeProfileLimitSnapshot,
  toRuntimeProfileResponse,
  updateTaskStatus,
  toTaskResponse,
  toTaskSummary,
  evaluateRuntimeLimitGate,
} from "../index.js";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

function seedProject(): void {
  testDb.current
    .insert(projects)
    .values({ id: "proj-1", name: "Test", rootPath: "/tmp/test" })
    .run();
}

function makeLimitSnapshot(): RuntimeLimitSnapshot {
  return {
    source: "sdk_event",
    status: "blocked",
    precision: "heuristic",
    checkedAt: "2026-04-17T10:00:00.000Z",
    providerId: "anthropic",
    runtimeId: "claude",
    profileId: "profile-1",
    primaryScope: "time",
    resetAt: "2026-04-17T15:00:00.000Z",
    retryAfterSeconds: null,
    warningThreshold: null,
    windows: [{ scope: "time", resetAt: "2026-04-17T15:00:00.000Z" }],
    providerMeta: null,
  };
}

describe("data presentation mappers (contract)", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    seedProject();
  });

  it("toTaskResponse is deterministic for a seeded task and never leaks raw runtime options", () => {
    const task = createTask({
      projectId: "proj-1",
      title: "Contract task",
      description: "Desc",
    });
    expect(task).not.toBeNull();
    const response = toTaskResponse(task!);
    expect(response.id).toBe(task!.id);
    expect(response.title).toBe("Contract task");
    expect(response.projectId).toBe("proj-1");
    expect(response).not.toHaveProperty("runtimeOptionsJson");
  });

  it("toTaskResponse reflects the current task status and ownership for the board", () => {
    const task = createTask({
      projectId: "proj-1",
      title: "State task",
      description: "Desc",
    });
    updateTaskStatus(task!.id, "implementing");
    const freshSync = findTaskById(task!.id);
    const response = toTaskResponse(freshSync as never);
    expect(response.status).toBe("implementing");
    expect(response.executionOwner).toBe("ai");
    expect(response.permissions).toBeDefined();
    expect(Array.isArray(response.assignees)).toBe(true);
  });

  it("toTaskSummary preserves identity and status for the summary row", () => {
    const task = createTask({
      projectId: "proj-1",
      title: "Summary task",
      description: "Desc",
    });
    updateTaskStatus(task!.id, "planning");
    const freshSync = findTaskById(task!.id);
    const summary = toTaskSummary(freshSync as never);
    expect(summary.id).toBe(task!.id);
    expect(summary.status).toBe("planning");
    expect((summary as { assignees?: unknown }).assignees).toEqual([]);
  });
});

describe("runtime limit gate policy (contract)", () => {
  const previousUsageLimitsEnabled = process.env.AIF_USAGE_LIMITS_ENABLED;

  beforeEach(() => {
    testDb.current = createTestDb();
    seedProject();
    process.env.AIF_USAGE_LIMITS_ENABLED = "true";
    resetEnvCache();
  });

  afterEach(() => {
    process.env.AIF_USAGE_LIMITS_ENABLED = previousUsageLimitsEnabled;
    resetEnvCache();
  });

  function seedGatedProfile(): string | null {
    const profile = createRuntimeProfile({
      projectId: "proj-1",
      name: "Gate profile",
      runtimeId: "claude",
      providerId: "anthropic",
      enabled: true,
    });
    if (!profile) return null;
    persistRuntimeProfileLimitSnapshot(
      profile.id,
      {
        ...makeLimitSnapshot(),
        profileId: profile.id,
      },
      "2026-04-17T10:00:05.000Z",
    );
    return profile.id;
  }

  it("blocks when the snapshot is provider-blocked and the reset hint is in the future", () => {
    const id = seedGatedProfile();
    const profile = toRuntimeProfileResponse(findRuntimeProfileById(id!)!);
    const decision = evaluateRuntimeLimitGate(profile, Date.parse("2026-04-17T12:00:00.000Z"));
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe("provider_blocked");
    expect(decision.snapshot?.providerId).toBe("anthropic");
    expect(decision.futureHint.resetAt).toBe("2026-04-17T15:00:00.000Z");
  });

  it("never blocks when usage limits are disabled", () => {
    const id = seedGatedProfile();
    process.env.AIF_USAGE_LIMITS_ENABLED = "false";
    resetEnvCache();
    const profile = toRuntimeProfileResponse(findRuntimeProfileById(id!)!);
    const decision = evaluateRuntimeLimitGate(profile, Date.parse("2026-04-17T12:00:00.000Z"));
    expect(decision.blocked).toBe(false);
    expect(decision.reason).toBe("none");
  });
});