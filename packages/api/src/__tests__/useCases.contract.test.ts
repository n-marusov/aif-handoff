/**
 * Контракты application use-case слоя (@aif/api).
 *
 * Задача 18 плана clean-architecture рефакторинга: зафиксировать тестами I/O DTO
 * и коды ошибок пяти use cases ДО их реализации. Тесты падают сейчас (модуль
 * ../use-cases/index.js не существует) и зеленеют после Task 19.
 *
 * Contract-тесты намеренно не проверяют реализацию: только публичную форму —
 * сигнатуры функций, типы результата и набор кодов отказа.
 */

import { describe, it, expect } from "vitest";

// Импорт из несуществующего модуля ниже падает с ERR_MODULE_NOT_FOUND, пока
// use-case слой не создан в Task 19 — это и есть красный гейт.
import {
  applyTaskEvent,
  startQaRun,
  updateTaskPlan,
  syncTaskPlanFile,
  generateCommit,
} from "../use-cases/index.js";

describe("use-cases: applyTaskEvent", () => {
  it("accepts a task event with optional actor and authorization context", () => {
    expect(typeof applyTaskEvent).toBe("function");
    void applyTaskEvent({
      taskId: "task-1",
      event: "start_ai",
      participantsModeEnabled: true,
      actor: { kind: "participant", id: "p-1", displayNameSnapshot: "Alice" },
      participantRole: "admin",
      participantActive: true,
      deletePlanFile: true,
    });
  });

  it("returns an ok result with the updated task and a broadcast type", async () => {
    const result = await applyTaskEvent({ taskId: "task-1", event: "start_ai" });
    if (result.ok) {
      expect(typeof result.task.id).toBe("string");
      expect(typeof result.task.status).toBe("string");
      expect(typeof result.broadcastType).toBe("string");
    } else {
      expect(typeof result.code).toBe("string");
      expect(typeof result.error).toBe("string");
    }
  });

  it("uses semantic denial codes, not HTTP numbers", async () => {
    const result = await applyTaskEvent({ taskId: "task-1", event: "request_plan_changes" });
    if (result.ok) {
      expect(result.ok).toBe(true);
    } else {
      expect(result.code).toMatch(
        /^(actor_not_authorized|assignment_required|invalid_transition|not_found|blocked)$/,
      );
    }
  });
});

describe("use-cases: startQaRun", () => {
  it("accepts project/task/execution-root and returns a started flag", () => {
    expect(typeof startQaRun).toBe("function");
    const result = startQaRun({ projectId: "p-1", taskId: "task-1", executionRoot: "/tmp/p1" });
    if (result.started) {
      expect(result.started).toBe(true);
    }
  });

  it("derives the QA lock duration from env config (single source of truth)", async () => {
    // Known issue: "`startQaRun` (use case): дефолт `lockDurationMs = 60s` расходится с
    // маршрутным значением". The use case owns the formula; the route no longer passes a value.
    const { resolveQaLockDurationMs } = await import("../use-cases/qaRun.js");
    const { getEnv } = await import("@aif/shared");
    const expected = Math.max(getEnv().AGENT_STAGE_RUN_TIMEOUT_MS, 60_000) + 5 * 60 * 1000;
    expect(typeof resolveQaLockDurationMs).toBe("function");
    expect(resolveQaLockDurationMs()).toBe(expected);
    // The old hidden default must never win again.
    expect(resolveQaLockDurationMs()).not.toBe(60_000);
  });

  it("denies with a bounded code set", () => {
    const denied = startQaRun({ projectId: "p-1", taskId: "task-1", executionRoot: "/tmp/p1" });
    if (!denied.started) {
      expect(["ai_handoff_required", "task_locked", "already_running"]).toContain(denied.code);
    }
  });
});

describe("use-cases: updateTaskPlan", () => {
  it("accepts a plan write and reports task/project lookup failure", () => {
    expect(typeof updateTaskPlan).toBe("function");
    const result = updateTaskPlan({
      taskId: "task-1",
      planText: "# Plan\\n- [ ] x",
      isFix: false,
    });
    if (!result.ok) {
      expect(result.code).toBe("task_or_project_not_found");
    }
  });
});

describe("use-cases: syncTaskPlanFile", () => {
  it("reports whether the canonical plan file synced or is missing", () => {
    expect(typeof syncTaskPlanFile).toBe("function");
    const result = syncTaskPlanFile({ taskId: "task-1" });
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect([true, false]).toContain(result.synced);
    }
  });
});

describe("use-cases: generateCommit", () => {
  it("accepts a project id and returns a structured commit result", async () => {
    expect(typeof generateCommit).toBe("function");
    const result = await generateCommit({ projectId: "p-1", taskId: "task-1" });
    expect(typeof result.ok).toBe("boolean");
    if (!result.ok && result.code) {
      expect(result.code).toBe("ai_handoff_required");
    }
  });
});
