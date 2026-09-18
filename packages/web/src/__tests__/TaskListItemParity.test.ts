import { describe, it, expect } from "vitest";
import type { TaskListItem } from "@aif/shared/browser";

/**
 * Страж паритетности проекции TaskListItem.
 *
 * TaskListItem — облегчённая проекция Task для рендера доски/списка (Board,
 * TaskCard, TaskListTable). Если поле, потребляемое этими компонентами, позже
 * исчезнет из TaskListItem, доска молча сломается в рантайме, хотя TypeScript
 * будет молчать (потребитель читает `undefined`).
 *
 * Этот тест закрепляет набор полей, нужный доске, и проверяет их наличие на
 * TaskListItem. Новое поле, потребляемое доской, без расширения TaskListItem
 * явно валит этот тест.
 */

// Поля, которые доска/карточка/таблица читают из задачи на `main`. Источник —
// использование в TaskCard.tsx + Board.tsx + TaskListTable.tsx. Синхронизируй,
// когда доска начнёт потреблять новое поле.
const BOARD_CONSUMED_FIELDS = [
  "id",
  "projectId",
  "title",
  "description",
  "status",
  "priority",
  "position",
  "tags",
  "autoMode",
  "isFix",
  "paused",
  "blockedReason",
  "blockedFromStatus",
  "manualReviewRequired",
  "reworkRequested",
  "reviewIterationCount",
  "maxReviewIterations",
  "retryCount",
  "retryAfter",
  "scheduledAt",
  "roadmapAlias",
  "hasPlan",
  // Плашка runtime-бюджета для blocked_external (гейтится флагом usageLimits).
  "runtimeLimitSnapshot",
  "runtimeLimitUpdatedAt",
  "updatedAt",
  "createdAt",
] as const;

describe("TaskListItem parity with board consumers", () => {
  it("every field the board consumes is present on TaskListItem", () => {
    // Фикстура со всеми полями, чтобы keys() был исчерпывающим.
    const fixture: TaskListItem = {
      id: "t1",
      projectId: "p1",
      title: "T",
      description: "D",
      autoMode: false,
      executionOwner: "ai",
      ownershipRevision: 0,
      assignees: [],
      isFix: false,
      status: "backlog",
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
      maxReviewIterations: 0,
      manualReviewRequired: false,
      paused: false,
      lastSyncedAt: null,
      runtimeLimitSnapshot: null,
      runtimeLimitUpdatedAt: null,
      scheduledAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      hasPlan: false,
    };

    const itemKeys = new Set(Object.keys(fixture));
    const missing = BOARD_CONSUMED_FIELDS.filter((f) => !itemKeys.has(f));

    expect(missing, `TaskListItem dropped board-consumed fields: ${missing.join(", ")}`).toEqual(
      [],
    );
  });
});
