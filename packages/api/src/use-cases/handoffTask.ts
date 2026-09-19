/**
 * Application use case «передать исполнение задачи» (handoff).
 *
 * Вся бизнес-логика передачи: авторизация участника (admin или узкие
 * сценарии самосервиса member), CAS-предусловия через expected* поля и
 * атомарное обновление владения в @aif/data. Маршрут остаётся тонким
 * контроллером: парсит вход, зовёт use case, рассылает WS и формирует ответ.
 *
 * Транспортных понятий здесь нет — код отказа семантический, а маппинг
 * код → HTTP-статус живёт в маршруте.
 */
import { logger } from "@aif/shared";
import { findTaskById, getTaskOwnership, handoffTaskExecution } from "@aif/data";
import type { HandoffTaskInput, HandoffTaskResult } from "./types.js";

const log = logger("handoff-task-use-case");

/**
 * Единственная точка входа: проверяет право участника, применяет CAS-handoff
 * и возвращает владение + историю либо семантический код отказа.
 */
export function handoffTaskUseCase(input: HandoffTaskInput): HandoffTaskResult {
  const { taskId, actionContext } = input;
  const task = findTaskById(taskId);
  if (!task) {
    return { ok: false, code: "not_found", error: "Task not found" };
  }

  const actorId = actionContext.actor.id;
  // Авторизация проверяется здесь; слой данных обеспечивает атомарность передачи.
  if (actionContext.participantsModeEnabled && actionContext.participantRole !== "admin") {
    const currentOwnership = getTaskOwnership(taskId);
    const assigned =
      actorId !== null &&
      Boolean(
        currentOwnership?.assignees.some(
          (assignee) => assignee.participantId === actorId && assignee.active,
        ),
      );
    // Self-assign допустим только для unassigned human-owned задачи.
    const selfAssign =
      task.executionOwner === "human" &&
      (currentOwnership?.assignees.length ?? 0) === 0 &&
      input.executionOwner === "human" &&
      input.assigneeIds.length === 1 &&
      input.assigneeIds[0] === actorId;
    const assignedHumanToAi =
      task.executionOwner === "human" &&
      assigned &&
      input.executionOwner === "ai" &&
      input.assigneeIds.length === 0;
    if (!selfAssign && !assignedHumanToAi) {
      log.warn(
        {
          taskId,
          actorId,
          currentOwner: task.executionOwner,
          requestedOwner: input.executionOwner,
        },
        "Rejected unauthorized task handoff",
      );
      return {
        ok: false,
        code: "forbidden",
        error: "Participant is not allowed to hand off this task",
      };
    }
  }

  // expected* поля реализуют CAS-предусловие handoff-операции.
  const result = handoffTaskExecution({
    taskId,
    executionOwner: input.executionOwner,
    assigneeIds: input.assigneeIds,
    expectedOwnershipRevision: input.expectedOwnershipRevision,
    expectedExecutionOwner: input.expectedExecutionOwner,
    expectedStatus: input.expectedStatus,
    actor: actionContext.actor,
    reason: input.reason,
    resumeAction: input.resumeAction,
  });
  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      error: "Task ownership handoff could not be applied",
      ...(result.ownership ? { ownership: result.ownership } : {}),
    };
  }
  return { ok: true, ownership: result.ownership, history: result.history };
}
