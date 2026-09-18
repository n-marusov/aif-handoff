// Конечный автомат жизненного цикла задачи и правила авторизации действий.
//
// Жизненный цикл: Backlog - Planning - (Improve) - Plan Review - Implementing -
// (Verify) - Review - Done - Accepted. Этапы в скобках включаются не всегда: Improve -
// при запросе правок плана, Verify - для задач в режиме skills (useSubagents=false)
// или когда у задачи включён runPostVerify.
//
// Модуль намеренно не делает ввода-вывода и не обращается к базе: на входе снимок
// задачи и контекст актора, на выходе либо патч перехода, либо код отказа. Поэтому
// api, @aif/data и UI применяют одну и ту же политику, и решения о доступе не могут
// разойтись между сервером и интерфейсом.
//
// Здесь два семейства правил: legacy-набор (режим участников выключен, поведение
// сохранено для обратной совместимости) и owner-aware набор (участники включены,
// владелец задачи - человек).

import type {
  AuditActor,
  ParticipantRole,
  Task,
  TaskEvent,
  TaskPermissions,
  TaskStatus,
  UpdateTaskInput,
} from "./types.js";

// FR: REQ-FR-pipeline.gate.enforce-stage-transition-gate (criteria 2, 8) — гейт отдаёт патч перехода с целевым статусом.
// Патч перехода - ровно те поля, которые может менять смена статуса. Тип выведен из
// UpdateTaskInput через Pick: если поле не влияет на переход, его здесь нет.
export type TransitionPatch = Pick<
  UpdateTaskInput,
  | "blockedReason"
  | "blockedFromStatus"
  | "retryAfter"
  | "retryCount"
  | "reworkRequested"
  | "reviewIterationCount"
  | "manualReviewRequired"
  | "autoReviewState"
  | "scheduledAt"
> & { status: TaskStatus };

// FR: REQ-FR-pipeline.gate.enforce-stage-transition-gate (criteria 3, 9, 10, 11) — коды отказа заданы гейтом.
// Коды отказа - часть контракта: вызывающий код ветвится по ним, а текст ошибки
// предназначен только для человека. Новая причина требует нового кода, а не разбора
// сообщения.
export type TaskActionDeniedCode =
  | "action_not_allowed"
  | "actor_not_authorized"
  | "assignment_required"
  | "ai_handoff_required"
  | "blocked_status_missing";

// FR: REQ-FR-pipeline.manual-override.intervene-task-stage (criterion 8) — отказ возвращается значением с кодом.
// Размеченное объединение вместо исключений: недопустимый переход - обычный ожидаемый
// результат, а не сбой, поэтому он возвращается значением.
export type TransitionResult =
  | { ok: true; patch: TransitionPatch }
  | { ok: false; code: TaskActionDeniedCode; error: string };

// FR: REQ-FR-auth.roles.assign-participant-role (criterion 5) — RBAC проверяется в resolveTaskAction.
// Контекст актора, от которого зависит решение. Роль и активность передаются
// отдельно, потому что актор бывает и системным (без участия в проекте).
export interface TaskActionContext {
  participantsModeEnabled: boolean;
  actor: AuditActor;
  participantRole?: ParticipantRole | null;
  participantActive?: boolean;
}

// FR: REQ-FR-pipeline.gate.enforce-stage-transition-gate (criterion 2) — проверка идёт по снимку задачи.
export type TaskPolicyView = Pick<
  Task,
  | "status"
  | "autoMode"
  | "executionOwner"
  | "assignees"
  | "blockedFromStatus"
  | "skipReview"
  | "runPostVerify"
>;

/** Значения сброса по умолчанию, применяемые при выходе из состояний блокировки/повтора. */
// FR: REQ-FR-pipeline.stage.auto-advance-after-gate (criterion 6) — успешный переход применяет onSuccess.
// Сброс разворачивается в каждый успешный патч. Смысл: любая смена статуса выводит
// задачу из состояния ошибки, поэтому причины блокировки, счётчики повторов и флаги
// доработки не должны переезжать в новый статус.
export const CLEAN_STATE_RESET = {
  blockedReason: null,
  blockedFromStatus: null,
  retryAfter: null,
  retryCount: 0,
  reworkRequested: false,
  reviewIterationCount: 0,
  manualReviewRequired: false,
  autoReviewState: null,
  scheduledAt: null,
} as const satisfies Omit<TransitionPatch, "status">;

// Единая точка создания отказа: гарантирует, что код причины всегда заполнен.
function denied(code: TaskActionDeniedCode, error: string): TransitionResult {
  return { ok: false, code, error };
}

// Legacy-набор переходов: режим участников выключен. Понятия владельца-человека здесь
// нет, поэтому набор действий определяется только статусом задачи и флагами режима.
function resolveLegacyAction(
  task: Pick<
    TaskPolicyView,
    "status" | "autoMode" | "blockedFromStatus" | "executionOwner" | "runPostVerify"
  >,
  event: TaskEvent,
): TransitionResult {
  switch (event) {
    case "start_ai":
      return task.status === "backlog"
        ? { ok: true, patch: { ...CLEAN_STATE_RESET, status: "planning" } }
        : denied("action_not_allowed", "start_ai is only allowed from backlog");
    case "start_implementation":
      if (task.status !== "plan_review") {
        return denied(
          "action_not_allowed",
          "start_implementation is only allowed from plan_review",
        );
      }
      return task.autoMode
        ? denied("action_not_allowed", "start_implementation is not needed when autoMode=true")
        : { ok: true, patch: { ...CLEAN_STATE_RESET, status: "implementing" } };
    case "approve_plan":
      return task.status === "plan_review"
        ? { ok: true, patch: { ...CLEAN_STATE_RESET, status: "implementing" } }
        : denied("action_not_allowed", "approve_plan is only allowed from plan_review");
    case "request_plan_changes":
      return task.status === "plan_review"
        ? { ok: true, patch: { ...CLEAN_STATE_RESET, status: "improve" } }
        : denied("action_not_allowed", "request_plan_changes is only allowed from plan_review");
    case "request_replanning":
      if (task.status !== "plan_review") {
        return denied("action_not_allowed", "request_replanning is only allowed from plan_review");
      }
      return { ok: true, patch: { ...CLEAN_STATE_RESET, status: "improve" } };
    case "fast_fix":
      if (task.status !== "plan_review") {
        return denied("action_not_allowed", "fast_fix is only allowed from plan_review");
      }
      return { ok: true, patch: { ...CLEAN_STATE_RESET, status: "plan_review" } };
    case "approve_done":
      return task.status === "done"
        ? { ok: true, patch: { ...CLEAN_STATE_RESET, status: "accepted" } }
        : denied("action_not_allowed", "approve_done is only allowed from done");
    case "request_changes":
      // Доработка возвращает задачу сразу в implementing (минуя планирование) и поднимает
      // флаг reworkRequested, по которому исполнитель понимает, что это повторный заход,
      // а не новая работа.
      return task.status === "done"
        ? {
            ok: true,
            patch: {
              ...CLEAN_STATE_RESET,
              status: "implementing",
              reworkRequested: true,
            },
          }
        : denied("action_not_allowed", "request_changes is only allowed from done");
    case "retry_from_blocked":
      if (task.status !== "blocked_external") {
        return denied(
          "action_not_allowed",
          "retry_from_blocked is only allowed from blocked_external",
        );
      }
      // BR: BR-trigger.task-lifecycle.blocked (детализация, п. 2) — возобновление возвращает задачу на исходную стадию.
      // Возврат идёт в тот статус, из которого задача была заблокирована, а не в начало:
      // внешняя блокировка не должна обнулять проделанную работу. Если исходный статус
      // не сохранён, переход невозможен - отсюда отдельный код отказа.
      return task.blockedFromStatus
        ? {
            ok: true,
            patch: { ...CLEAN_STATE_RESET, status: task.blockedFromStatus },
          }
        : denied("blocked_status_missing", "blockedFromStatus is missing for retry_from_blocked");
    case "complete_review":
      // Завершить ревью может только задача, которой владеет человек: задачи под
      // управлением AI закрываются автоматическим конвейером.
      if (task.status !== "review" || task.executionOwner !== "human") {
        return denied(
          "action_not_allowed",
          "complete_review is only allowed from review for human-owned tasks",
        );
      }
      return {
        ok: true,
        patch: {
          ...CLEAN_STATE_RESET,
          status: "done",
        },
      };
    case "request_review_changes":
      if (task.status !== "review" || task.executionOwner !== "human") {
        return denied(
          "action_not_allowed",
          "request_review_changes is only allowed from review for human-owned tasks",
        );
      }
      return {
        ok: true,
        patch: {
          ...CLEAN_STATE_RESET,
          status: "implementing",
          reworkRequested: true,
        },
      };
    default:
      return denied("action_not_allowed", "Unknown task event");
  }
}

// Owner-aware набор: задача принадлежит человеку, и он проходит этапы сам. Отличия от
// legacy-набора - явные шаги mark_plan_ready и submit_implementation, а также то, что
// AI-специфичные действия делегируются в legacy только там, где они допустимы.
function resolveHumanOwnerAction(task: TaskPolicyView, event: TaskEvent): TransitionResult {
  switch (event) {
    case "start_human_work":
      return task.status === "backlog"
        ? { ok: true, patch: { ...CLEAN_STATE_RESET, status: "planning" } }
        : denied("action_not_allowed", "start_human_work is only allowed from backlog");
    case "mark_plan_ready":
      // Готовым план можно объявить и из planning, и из improve: Improve - это цикл правок
      // плана, после которого план снова уходит на ревью.
      return task.status === "planning" || task.status === "improve"
        ? { ok: true, patch: { ...CLEAN_STATE_RESET, status: "plan_review" } }
        : denied("action_not_allowed", "mark_plan_ready is only allowed from planning or improve");
    case "start_implementation":
      if (task.status !== "plan_review") {
        return denied(
          "action_not_allowed",
          "start_implementation is only allowed from plan_review",
        );
      }
      return { ok: true, patch: { ...CLEAN_STATE_RESET, status: "implementing" } };
    case "submit_implementation": {
      if (task.status !== "implementing") {
        return denied(
          "action_not_allowed",
          "submit_implementation is only allowed from implementing",
        );
      }
      const status = "verify";
      return { ok: true, patch: { ...CLEAN_STATE_RESET, status } };
    }
    case "complete_review":
      if (task.status !== "review") {
        return denied("action_not_allowed", "complete_review is only allowed from review");
      }
      // Если у задачи включён runPostVerify, ревью ведёт в verify, а не сразу в done:
      // дополнительная проверка поставлена после ревью намеренно.
      return {
        ok: true,
        patch: {
          ...CLEAN_STATE_RESET,
          status: task.runPostVerify ? "verify" : "done",
        },
      };
    case "request_review_changes":
      return task.status === "review"
        ? {
            ok: true,
            patch: {
              ...CLEAN_STATE_RESET,
              status: "implementing",
              reworkRequested: true,
            },
          }
        : denied("action_not_allowed", "request_review_changes is only allowed from review");
    case "pass_verification":
      if (task.status !== "verify") {
        return denied("action_not_allowed", "pass_verification is only allowed from verify");
      }
      return {
        ok: true,
        patch: {
          ...CLEAN_STATE_RESET,
          status: "review",
        },
      };
    case "fail_verification":
      return task.status === "verify"
        ? {
            ok: true,
            patch: {
              ...CLEAN_STATE_RESET,
              status: "implementing",
              reworkRequested: true,
            },
          }
        : denied("action_not_allowed", "fail_verification is only allowed from verify");
    case "approve_done":
    case "request_changes":
    case "retry_from_blocked":
      return resolveLegacyAction(task, event);
    case "start_ai":
    case "request_replanning":
    case "fast_fix":
    case "approve_plan":
    case "request_plan_changes":
      // BR: BR-constraint.ownership.handoff (детализация, п. 4) — AI-действия доступны лишь после передачи задачи AI.
      // Эти действия осмысленны только для AI-исполнителя: человеку, владеющему задачей,
      // нужно сначала передать её AI, отсюда отдельный код отказа.
      return denied("ai_handoff_required", `${event} requires the task to be handed to AI`);
    default:
      return denied("action_not_allowed", "Unknown task event");
  }
}

// Проверка полномочий участника. Возврат null означает "проверка пройдена".
//
// Ключевой инвариант проекта: участник-человек не может действовать над задачей,
// которой владеет AI-исполнитель (Members cannot act on AI-owned tasks). Исключение -
// администратор. Кроме того, участник должен быть назначен на задачу.
function resolveParticipantAuthorization(
  task: TaskPolicyView,
  context: TaskActionContext,
): TransitionResult | null {
  // В режиме без участников проверка неприменима.
  if (!context.participantsModeEnabled) return null;
  if (
    context.actor.kind !== "participant" ||
    !context.actor.id ||
    context.participantActive === false ||
    !context.participantRole
  ) {
    return denied("actor_not_authorized", "An active participant is required");
  }
  // Администратор проходит без дальнейших проверок.
  if (context.participantRole === "admin") return null;
  // BR: BR-constraint.auth.task-isolation (детализация, п. 1) — участник не действует над задачей под владением AI.
  if (task.executionOwner !== "human") {
    return denied("actor_not_authorized", "Members cannot act on AI-owned tasks");
  }
  // BR: BR-constraint.auth.member-scope (детализация, п. 1) — право даёт только активное назначение.
  // Учитываются только активные назначения: снятое назначение прав не даёт.
  const assigned = task.assignees.some(
    (assignee) => assignee.participantId === context.actor.id && assignee.active,
  );
  return assigned
    ? null
    : denied("assignment_required", "The participant must be assigned before acting on this task");
}

// FR: REQ-FR-pipeline.gate.enforce-stage-transition-gate (criterion 1) — единый вход гейта для Coordinator и API.
// BR: BR-constraint.task-lifecycle.transitions (условие 3) — авторизация проверяется первой, причина отказа точнее.
// Порядок проверок важен: сначала авторизация (право вообще действовать), затем выбор
// набора правил по владельцу задачи. Так отказ по полномочиям не маскируется отказом по
// статусу, и пользователь получает точную причину.
/**
 * Вычисляет видимое пользователю действие над задачей по неизменяемому
 * контексту задачи и актора. Функция не выполняет I/O, поэтому мапперы
 * ответов API, data и UI используют ровно одну и ту же политику.
 */
export function resolveTaskAction(
  task: TaskPolicyView,
  event: TaskEvent,
  context: TaskActionContext,
): TransitionResult {
  const authorization = resolveParticipantAuthorization(task, context);
  if (authorization) return authorization;
  if (!context.participantsModeEnabled) {
    return resolveLegacyAction(task, event);
  }
  return task.executionOwner === "human"
    ? resolveHumanOwnerAction(task, event)
    : resolveLegacyAction(task, event);
}

// FR: REQ-FR-pipeline.gate.enforce-stage-transition-gate (criterion 1) — совместимый вход гейта без контекста актора.
/** Разрешение в отключённом режиме для обратной совместимости со старыми вызовами. */
// Оставлено для обратной совместимости: вызывающие коды, не передающие контекст актора,
// получают политику без учёта владельца.
export function applyHumanTaskEvent(
  task: Pick<
    Task,
    "status" | "autoMode" | "blockedFromStatus" | "executionOwner" | "runPostVerify"
  >,
  event: TaskEvent,
): TransitionResult {
  return resolveLegacyAction(task, event);
}

// FR: REQ-FR-auth.roles.assign-participant-role (criterion 6) — сводка прав canAssign/canHandoff/... для UI.
// Сводка прав для интерфейса: набор флагов плюс список доступных действий. Список
// строится перебором всех известных событий через resolveTaskAction, поэтому UI не может
// показать кнопку, которую сервер затем отклонит: источник правил один.
export function resolveTaskPermissions(
  task: TaskPolicyView,
  context: TaskActionContext,
): TaskPermissions {
  const activeParticipant =
    context.actor.kind === "participant" &&
    Boolean(context.actor.id) &&
    context.participantActive !== false;
  const admin =
    context.participantsModeEnabled && activeParticipant && context.participantRole === "admin";
  const assigned =
    activeParticipant &&
    task.assignees.some(
      (assignee) => assignee.participantId === context.actor.id && assignee.active,
    );
  // Задачу, принадлежащую человеку и никому не назначенную, участник может взять себе
  // сам - это и есть сценарий самостоятельного назначения.
  const humanUnassigned = task.executionOwner === "human" && task.assignees.length === 0;
  const permittedActions = (Object.keys(TASK_ACTION_LOOKUP) as TaskEvent[]).filter(
    (event) => resolveTaskAction(task, event, context).ok,
  );

  if (!context.participantsModeEnabled) {
    return {
      canAssign: true,
      canHandoff: true,
      canSelfAssign: false,
      canAct: permittedActions.length > 0,
      canComment: true,
      permittedActions,
    };
  }

  return {
    canAssign: admin,
    canHandoff: admin || (task.executionOwner === "human" && assigned),
    canSelfAssign: activeParticipant && context.participantRole === "member" && humanUnassigned,
    canAct: permittedActions.length > 0,
    canComment: activeParticipant,
    permittedActions,
  };
}

// Перечень всех известных событий. Запись Record<TaskEvent, true> заставляет
// компилятор сообщить об ошибке, если в TaskEvent появится новое значение, а здесь оно
// не перечислено: забытый переход видно сразу при сборке.
const TASK_ACTION_LOOKUP: Record<TaskEvent, true> = {
  start_ai: true,
  start_human_work: true,
  mark_plan_ready: true,
  start_implementation: true,
  approve_plan: true,
  request_plan_changes: true,
  submit_implementation: true,
  complete_review: true,
  request_review_changes: true,
  pass_verification: true,
  fail_verification: true,
  request_replanning: true,
  fast_fix: true,
  approve_done: true,
  request_changes: true,
  retry_from_blocked: true,
};

// FR: REQ-FR-pipeline.manual-override.intervene-task-stage (criterion 3) — таблица статус → допустимые действия.
/** Legacy-действия только по статусу; права с учётом владельца для UI даёт resolveTaskPermissions(). */
// Таблица соответствует порядку статусов из constants.ts. Существует только для
// legacy-режима: при включённых участниках права считает resolveTaskPermissions().
export const HUMAN_ACTIONS_BY_STATUS: Record<TaskStatus, TaskEvent[]> = {
  backlog: ["start_ai"],
  planning: [],
  improve: [],
  plan_review: ["start_implementation", "request_replanning", "fast_fix"],
  implementing: [],
  review: [],
  verify: [],
  blocked_external: ["retry_from_blocked"],
  done: ["approve_done", "request_changes"],
  accepted: [],
};
