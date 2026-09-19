/**
 * Центр переходов статусов задачи.
 *
 * Это единственная точка, где меняется статус в доменном конвейере задач.
 * Переход выполняется атомарно: проверка инвариантов, запись статуса и событие
 * аудита фиксируются одной транзакцией.
 *
 * Потенциальное улучшение: формализовать правила переходов в отдельный
 * policy-слой, чтобы уменьшить когнитивную нагрузку в этом модуле.
 */
import { and, asc, eq } from "drizzle-orm";
import {
  auditEvents,
  logger,
  participants,
  resolveTaskAction,
  taskAssignments,
  tasks,
  type AuditActor,
  type AutoReviewState,
  type ParticipantRole,
  type TaskActionContext,
  type TaskAssigneeSummary,
  type TaskEvent,
  type TaskRow,
  type TaskStatus,
  type TransitionPatch,
} from "@aif/shared";
import { getDb } from "./db.js";
import { createAuditEventValues } from "./audit.js";

// Логгер переходов статусов в слое данных.
const log = logger("data:task-transitions");

// Повторный вход improve -> plan_review сбрасывает метаданные plan review.
// Иначе новая версия плана будет смешана с прошлым решением гейта.
/**
 * При повторном входе в plan_review из improve (после перепланирования) метаданные ревью
 * плана сбрасываются, чтобы публикация начиналась с чистого состояния.
 */
function planReviewResetForReplan(
  fromStatus: TaskStatus,
  toStatus: TaskStatus,
): Partial<typeof tasks.$inferInsert> {
  // Сброс применяется только к improve -> plan_review.
  if (fromStatus === "improve" && toStatus === "plan_review") {
    return {
      planReviewState: null,
      planReviewCommitSha: null,
      planReviewPublishedAt: null,
      planReviewApprovedAt: null,
      planReviewFeedback: null,
    };
  }
  return {};
}

// Дополнительный patch перехода без служебных полей владения и идентичности.
export type TaskTransitionExtra = Partial<
  Omit<
    TaskRow,
    | "id"
    | "projectId"
    | "status"
    | "executionOwner"
    | "ownershipRevision"
    | "createdAt"
  >
> & {
  autoReviewState?: AutoReviewState | null;
};

// Структурированные коды отказа перехода (без классификации по message-тексту).
export type TaskTransitionConflictCode =
  | "not_found"
  | "status_conflict"
  | "action_not_allowed"
  | "actor_not_authorized"
  | "assignment_required"
  | "ai_handoff_required"
  | "blocked_status_missing";

// Ожидаемые доменные отказы возвращаются как union-результат.
// Исключения оставлены для инфраструктурных сбоев транзакции.
export type TaskTransitionResult =
  | { ok: true; task: TaskRow; fromStatus: TaskStatus; toStatus: TaskStatus }
  | {
      ok: false;
      code: TaskTransitionConflictCode;
      message: string;
      currentStatus?: TaskStatus;
    };

// expectedStatus задаёт CAS-предусловие: переход применим только к ожидаемому
// состоянию задачи.
export interface TransitionTaskStatusInput {
  taskId: string;
  status: TaskStatus;
  expectedStatus?: TaskStatus;
  extra?: TaskTransitionExtra;
  actor: AuditActor;
  action?: string;
  reason?: string | null;
  now?: Date;
}

// Пользовательский путь: входом служит событие задачи, а статус/patch решает
// общий конечный автомат resolveTaskAction.
export interface ApplyTaskActionInput {
  taskId: string;
  event: TaskEvent;
  participantsModeEnabled: boolean;
  actor: AuditActor;
  participantRole?: ParticipantRole | null;
  participantActive?: boolean;
  expectedStatus?: TaskStatus;
  extra?: TaskTransitionExtra;
  reason?: string | null;
  now?: Date;
}

// Нормализация patch к колонкам БД с повторным отсечением защищённых полей.
function normalizeExtra(
  extra: TaskTransitionExtra | Omit<TransitionPatch, "status">,
): Partial<typeof tasks.$inferInsert> {
  const {
    autoReviewState,
    executionOwner: _executionOwner,
    ownershipRevision: _ownershipRevision,
    status: _status,
    id: _id,
    projectId: _projectId,
    createdAt: _createdAt,
    ...rest
  } = extra as TaskTransitionExtra & {
    executionOwner?: unknown;
    ownershipRevision?: unknown;
    status?: unknown;
    id?: unknown;
    projectId?: unknown;
    createdAt?: unknown;
  };
  // autoReviewState сериализуется отдельно в autoReviewStateJson.
  return {
    ...rest,
    ...(autoReviewState === undefined
      ? {}
      : {
          autoReviewStateJson:
            autoReviewState === null ? null : JSON.stringify(autoReviewState),
        }),
  };
}

// Снимок исполнителей берётся в той же транзакции для согласованного аудита.
function listAssigneesInTransaction(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  taskId: string,
): TaskAssigneeSummary[] {
  return tx
    .select({
      participantId: participants.id,
      displayName: participants.displayName,
      role: participants.role,
      active: participants.active,
    })
    .from(taskAssignments)
    .innerJoin(participants, eq(taskAssignments.participantId, participants.id))
    .where(eq(taskAssignments.taskId, taskId))
    .orderBy(asc(participants.displayName), asc(participants.id))
    .all();
}

// Запись события аудита перехода в той же транзакции, что и смена статуса.
function appendTransitionAudit(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  input: {
    task: TaskRow;
    assignees: TaskAssigneeSummary[];
    fromStatus: TaskStatus;
    toStatus: TaskStatus;
    actor: AuditActor;
    action: string;
    reason: string | null;
    createdAt: string;
  },
): void {
  tx.insert(auditEvents)
    .values(
      createAuditEventValues({
        action: input.action,
        entityType: "task",
        entityId: input.task.id,
        taskId: input.task.id,
        taskTitleSnapshot: input.task.title,
        executionOwnerSnapshot: input.task.executionOwner,
        assigneesSnapshot: input.assignees,
        statusSnapshot: input.toStatus,
        actor: input.actor,
        reason: input.reason,
        // ownershipRevision фиксируется для трассировки handoff-поколения.
        metadata: {
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          ownershipRevision: input.task.ownershipRevision,
        },
        createdAt: input.createdAt,
      }),
    )
    .run();
}

// Стандартизированный ответ для CAS-конфликта статуса.
function statusConflict(task: TaskRow): TaskTransitionResult {
  return {
    ok: false,
    code: "status_conflict",
    message: "Task status changed before the transition could be applied",
    currentStatus: task.status,
  };
}

export function transitionTaskStatus(
  input: TransitionTaskStatusInput,
): TaskTransitionResult {
  const nowIso = (input.now ?? new Date()).toISOString();
  log.debug(
    {
      taskId: input.taskId,
      expectedStatus: input.expectedStatus ?? null,
      targetStatus: input.status,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      action: input.action ?? "task.status_changed",
    },
    "Evaluating atomic task status transition",
  );

  // Переход статуса, проверка и аудит выполняются одной транзакцией SQLite.
  try {
    return getDb().transaction((tx) => {
      // Чтение в транзакции исключает устаревшее состояние между проверкой и записью.
      const task = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
      if (!task) {
        return { ok: false, code: "not_found", message: "Task not found" } as const;
      }
      // CAS-проверка expectedStatus защищает от перезаписи более свежего состояния.
      if (input.expectedStatus !== undefined && task.status !== input.expectedStatus) {
        log.warn(
          {
            taskId: task.id,
            expectedStatus: input.expectedStatus,
            actualStatus: task.status,
            code: "status_conflict",
          },
          "Task status transition rejected",
        );
        return statusConflict(task);
      }
      // Участник не меняет status напрямую: для этого используется applyTaskAction.
      if (input.actor.kind === "participant") {
        return {
          ok: false,
          code: "actor_not_authorized",
          message: "Participant transitions must use an explicit task action",
          currentStatus: task.status,
        } as const;
      }
      // Агент может менять статус только у AI-owned задачи.
      if (input.actor.kind === "agent" && task.executionOwner !== "ai") {
        return {
          ok: false,
          code: "ai_handoff_required",
          message: "The task must be handed to AI before an agent can change its status",
          currentStatus: task.status,
        } as const;
      }

      // Снимок исполнителей фиксируется до изменения для корректного аудита.
      const assignees = listAssigneesInTransaction(tx, task.id);

      // Для improve -> plan_review добавляется сброс метаданных plan review.
      const planReviewReset = planReviewResetForReplan(task.status, input.status);

      // При смене статуса sessionId сбрасывается; lastHeartbeatAt обновляется.
      const updated = tx
        .update(tasks)
        .set({
          ...normalizeExtra(input.extra ?? {}),
          ...planReviewReset,
          status: input.status,
          sessionId: null,
          lastHeartbeatAt: nowIso,
          updatedAt: nowIso,
        })
        // Повторная CAS-проверка в WHERE гарантирует атомарность на уровне БД.
        .where(
          and(
            eq(tasks.id, task.id),
            eq(tasks.status, input.expectedStatus ?? task.status),
          ),
        )
        .returning()
        .get();
      // Нет обновлённой строки — CAS-конфликт, переход не применён.
      if (!updated) return statusConflict(task);

      // Аудит пишется до commit в той же транзакции, что и статус.
      appendTransitionAudit(tx, {
        task,
        assignees,
        fromStatus: task.status,
        toStatus: updated.status,
        actor: input.actor,
        action: input.action ?? "task.status_changed",
        reason: input.reason ?? null,
        createdAt: nowIso,
      });
      // Лог служит наблюдаемости; источником истины остаётся запись аудита.
      log.info(
        {
          taskId: task.id,
          fromStatus: task.status,
          toStatus: updated.status,
          actorKind: input.actor.kind,
          actorId: input.actor.id,
        },
        "Task status transition committed",
      );
      return {
        ok: true,
        task: updated,
        fromStatus: task.status,
        toStatus: updated.status,
      } as const;
    });
  } catch (error) {
    log.error(
      {
        error,
        taskId: input.taskId,
        expectedStatus: input.expectedStatus ?? null,
        targetStatus: input.status,
      },
      "Task status transition transaction failed",
    );
    // Ошибка транзакции пробрасывается вызывающему коду для решения о retry.
    throw error;
  }
}

export function applyTaskAction(input: ApplyTaskActionInput): TaskTransitionResult {
  const nowIso = (input.now ?? new Date()).toISOString();
  log.debug(
    {
      taskId: input.taskId,
      event: input.event,
      expectedStatus: input.expectedStatus ?? null,
      participantsModeEnabled: input.participantsModeEnabled,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      participantRole: input.participantRole ?? null,
    },
    "Evaluating atomic task action",
  );

  try {
    return getDb().transaction((tx) => {
      const task = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
      if (!task) {
        return { ok: false, code: "not_found", message: "Task not found" } as const;
      }
      if (input.expectedStatus !== undefined && task.status !== input.expectedStatus) {
        return statusConflict(task);
      }

      const assignees = listAssigneesInTransaction(tx, task.id);
      // Контекст действия передаётся в автомат вместе с ролью/активностью актора.
      const context: TaskActionContext = {
        participantsModeEnabled: input.participantsModeEnabled,
        actor: input.actor,
        participantRole: input.participantRole,
        participantActive: input.participantActive,
      };
      // resolveTaskAction — единый автомат жизненного цикла для API и агента.
      const resolution = resolveTaskAction(
        {
          id: task.id,
          status: task.status,
          autoMode: task.autoMode,
          executionOwner: task.executionOwner,
          assignees,
          blockedFromStatus: task.blockedFromStatus,
          skipReview: task.skipReview,
          runPostVerify: task.runPostVerify,
        },
        input.event,
        context,
      );
      // Недопустимое действие возвращает доменный отказ без записи в БД.
      if (!resolution.ok) {
        log.warn(
          {
            taskId: task.id,
            event: input.event,
            status: task.status,
            executionOwner: task.executionOwner,
            actorKind: input.actor.kind,
            actorId: input.actor.id,
            code: resolution.code,
          },
          "Task action rejected",
        );
        return {
          ok: false,
          code: resolution.code,
          message: resolution.error,
          currentStatus: task.status,
        } as const;
      }

      // Патч автомата имеет приоритет над внешним extra.
      // activeRuntime* сбрасываются при обычном переходе, но сохраняются на retry_from_blocked.
      const updated = tx
        .update(tasks)
        .set({
          ...normalizeExtra(input.extra ?? {}),
          ...normalizeExtra(resolution.patch),
          status: resolution.patch.status,
          sessionId: null,
          ...(input.event === "retry_from_blocked"
            ? {}
            : {
                activeRuntimeStatus: null,
                activeRuntimeSelectionJson: null,
              }),
          lastHeartbeatAt: nowIso,
          updatedAt: nowIso,
        })
        // WHERE по прежнему статусу реализует атомарный CAS при переходе-действии.
        .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)))
        .returning()
        .get();
      // Если row не обновлена, аудит не пишется: переход не состоялся.
      if (!updated) return statusConflict(task);

      appendTransitionAudit(tx, {
        task,
        assignees,
        fromStatus: task.status,
        toStatus: updated.status,
        actor: input.actor,
        action: `task.action.${input.event}`,
        reason: input.reason ?? null,
        createdAt: nowIso,
      });
      // После commit лог отражает уже согласованное состояние status+audit.
      log.info(
        {
          taskId: task.id,
          event: input.event,
          fromStatus: task.status,
          toStatus: updated.status,
          actorKind: input.actor.kind,
          actorId: input.actor.id,
        },
        "Task action committed",
      );
      return {
        ok: true,
        task: updated,
        fromStatus: task.status,
        toStatus: updated.status,
      } as const;
    });
  } catch (error) {
    log.error(
      { error, taskId: input.taskId, event: input.event },
      "Task action transaction failed",
    );
    // Ошибка транзакции не маскируется доменным отказом.
    throw error;
  }
}

// Служебный audit-актор для решений Plan Review Gate.
const AGENT_ACTOR_DEFAULTS = {
  kind: "agent",
  id: "plan-review-gate",
  displayNameSnapshot: "Plan Review Gate",
} as const;

// Явный actor имеет приоритет; иначе используется системный actor гейта.
function resolvePlanReviewActor(actor: AuditActor | undefined): AuditActor {
  return actor ?? { ...AGENT_ACTOR_DEFAULTS };
}

/**
 * Отметка плана как опубликованного без изменения статуса `plan_review`.
 *
 * Повторная публикация после перепланирования перезаписывает предыдущий коммит плана и
 * очищает устаревшие одобрение и отзыв.
 */
export function markTaskPlanPublished(input: {
  taskId: string;
  commitSha: string | null;
  actor?: AuditActor;
  now?: Date;
}): TaskTransitionResult {
  // now можно задать явно для тестов и репроцессинга внешних VCS-событий.
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  // В логах сохраняем метаданные, но не содержимое review-текста.
  log.info(
    {
      taskId: input.taskId,
      commitSha: input.commitSha,
      action: "task.plan_review.published",
    },
    "Marking task plan published",
  );
  // Публикация плана не меняет status (plan_review -> plan_review),
  // но проходит через общий transition для CAS и аудита.
  return transitionTaskStatus({
    taskId: input.taskId,
    status: "plan_review",
    expectedStatus: "plan_review",
    actor: resolvePlanReviewActor(input.actor),
    action: "task.plan_review.published",
    reason: "Change plan committed and published for plan review",
    extra: {
      planReviewState: "published",
      planReviewCommitSha: input.commitSha,
      planReviewPublishedAt: nowIso,
      planReviewApprovedAt: null,
      planReviewFeedback: null,
    },
    now,
  });
}

/**
 * Принятие одобренного плана: задача переводится из `plan_review` в `implementing`, и
 * фиксируется время одобрения.
 */
export function markTaskPlanApproved(input: {
  taskId: string;
  actor?: AuditActor;
  now?: Date;
}): TaskTransitionResult {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  log.info({ taskId: input.taskId, action: "task.plan_review.approved" }, "Marking task plan approved");
  // Одобрение плана переводит plan_review -> implementing только при CAS-совпадении.
  return transitionTaskStatus({
    taskId: input.taskId,
    status: "implementing",
    expectedStatus: "plan_review",
    actor: resolvePlanReviewActor(input.actor),
    action: "task.plan_review.approved",
    reason: "Change plan approved in VCS; implementation may start",
    extra: {
      planReviewState: "approved",
      planReviewApprovedAt: nowIso,
    },
    now,
  });
}

/**
 * Обработка запроса изменений от VCS: задача возвращается в `planning` на перепланирование
 * с сохранением связи с веткой и PR.
 *
 * Отзыв ревьюера сохраняется для следующего запуска планировщика; в лог попадает только
 * длина отзыва, но не его текст.
 */
export function markTaskPlanChangesRequested(input: {
  taskId: string;
  feedback: string | null;
  actor?: AuditActor;
  now?: Date;
}): TaskTransitionResult {
  const now = input.now ?? new Date();
  // Логируем длину feedback, не его содержимое.
  log.info(
    {
      taskId: input.taskId,
      feedbackLength: input.feedback?.length ?? 0,
      action: "task.plan_review.changes_requested",
    },
    "Plan changes requested; returning task to planning",
  );
  // Changes requested возвращает задачу в planning для полного перепланирования.
  return transitionTaskStatus({
    taskId: input.taskId,
    status: "planning",
    expectedStatus: "plan_review",
    actor: resolvePlanReviewActor(input.actor),
    action: "task.plan_review.changes_requested",
    reason: "VCS reviewer requested plan changes",
    extra: {
      planReviewState: "changes_requested",
      planReviewApprovedAt: null,
      planReviewFeedback: input.feedback,
    },
    now,
  });
}

/**
 * Сохранение накопленного отзыва по плану без изменения статуса задачи.
 *
 * Используется, когда в PR/MR режима плана приходят новые комментарии ревью, ещё не
 * меняющие решение гейта. Возвращается обновлённая строка задачи.
 */
export function recordTaskPlanReviewFeedback(input: {
  taskId: string;
  feedback: string | null;
  now?: Date;
}): TaskRow | undefined {
  const nowIso = (input.now ?? new Date()).toISOString();
  // Feedback-only update не меняет статус, поэтому не требует transition-аудита.
  getDb()
    .update(tasks)
    .set({ planReviewFeedback: input.feedback, updatedAt: nowIso })
    .where(eq(tasks.id, input.taskId))
    .run();
  log.info(
    {
      taskId: input.taskId,
      feedbackLength: input.feedback?.length ?? 0,
      action: "task.plan_review.feedback_recorded",
    },
    "Plan review feedback recorded",
  );
  // Возвращаем перечитанную строку задачи после update.
  return getDb().select().from(tasks).where(eq(tasks.id, input.taskId)).get();
}
