/**
 * Общие политики задач application-слоя.
 *
 * `canMutateTask` — единая авторизация мутаций задачи: admin всегда разрешён,
 * обычный участник — только активный assignee. Ownership читается по актуальному
 * состоянию БД. Раньше копия жила в routes/tasks.ts и в use-cases/updateTask.ts;
 * теперь это одно место для обеих доставок.
 *
 * Функция транспортно-нейтральна — принимает TaskActionContext и не знает про
 * Hono/HTTP.
 */
import { logger } from "@aif/shared";
import type { TaskActionContext } from "@aif/shared";
import { getTaskOwnership } from "@aif/data";

const log = logger("task-policy");

/**
 * Разрешена ли мутация задачи текущему участнику? Admin — всегда, обычный
 * участник — только если он активный assignee. Метаданные запроса (method/path)
 * передаются опционально для логов и не влияют на решение.
 */
export function canMutateTask(
  actionContext: TaskActionContext,
  taskId: string,
  requestMeta?: { method: string; path: string },
): boolean {
  if (!actionContext.participantsModeEnabled || actionContext.participantRole === "admin") {
    return true;
  }

  const actorId = actionContext.actor.id;
  const assigned = Boolean(
    actorId &&
    getTaskOwnership(taskId)?.assignees.some(
      (assignee) => assignee.participantId === actorId && assignee.active,
    ),
  );
  const details = { taskId, actorId, ...(requestMeta ?? {}) };
  if (assigned) {
    log.debug(details, "Authorized assigned participant task mutation");
  } else {
    log.warn(details, "Rejected unauthorized task mutation");
  }
  return assigned;
}
