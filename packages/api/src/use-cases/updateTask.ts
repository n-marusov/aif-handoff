/**
 * Application use case «обновить задачу».
 *
 * Вся бизнес-логика правки задачи: авторизация участника (canMutateTask),
 * валидация runtime-профиля, запрет fast-режима в параллельных проектах,
 * заполнение mode-default флагов при смене plannerMode, составные операции
 * «файл плана» и «вложения». Маршрут остаётся тонким контроллером: парсит
 * вход, зовёт use case, рассылает WS и формирует ответ.
 *
 * Никаких транспортных понятий (Hono, HTTP-статусы) здесь нет — код отказа
 * семантический, маппинг код → статус делает маршрут.
 */
import { defaultsForMode, parseAttachments, logger } from "@aif/shared";
import type { TaskActionContext } from "@aif/shared";
import { findProjectById, findTaskById, getTaskOwnership, updateTask } from "@aif/data";
import {
  cleanupReplacedAttachments,
  persistAttachments,
} from "../services/attachmentPersistence.js";
import { validateProjectScopedRuntimeProfileSelections } from "../services/runtimeProfileScope.js";
import { updateTaskPlan as updateTaskPlanUseCase } from "./taskPlan.js";
import type { UpdateTaskInput, UpdateTaskResult } from "./types.js";

const log = logger("update-task-use-case");

/** Строка задачи: выводится из findTaskById (row-типы не входят в публичный контракт). */
export type PersistedTask = NonNullable<ReturnType<typeof findTaskById>>;

/**
 * Авторизация мутации: admin всегда разрешён, обычный участник — только для
 * активного assignee. Ownership читается по актуальному состоянию БД.
 */
function canMutateTask(actionContext: TaskActionContext, taskId: string): boolean {
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
  return assigned;
}

/**
 * Единственная точка входа: применяет все доменные правила правки и возвращает
 * свежую строку задачи либо семантический код отказа.
 */
export async function updateTaskUseCase(input: UpdateTaskInput): Promise<UpdateTaskResult> {
  const { taskId, patch, actionContext } = input;
  const existing = findTaskById(taskId);
  if (!existing) {
    return { ok: false, code: "task_not_found", error: "Task not found" };
  }
  if (!canMutateTask(actionContext, taskId)) {
    return { ok: false, code: "forbidden", error: "Task assignment or admin role required" };
  }

  // Профиль времени выполнения проверяется тем же сервисом, что и при создании:
  // правка не должна обходить проектные ограничения на выбор runtime.
  const runtimeValidation = validateProjectScopedRuntimeProfileSelections({
    projectId: existing.projectId,
    selections: { runtimeProfileId: patch.runtimeProfileId },
  });
  if (runtimeValidation) {
    return {
      ok: false,
      code: "invalid_runtime_profile",
      error: runtimeValidation.error,
      details: runtimeValidation as Record<string, unknown>,
    };
  }

  // Проекты с параллельным выполнением принудительно получают полный режим.
  const project = findProjectById(existing.projectId);
  if (project?.parallelEnabled && patch.plannerMode === "fast") {
    return {
      ok: false,
      code: "parallel_mode_required",
      error: "Parallel-enabled projects require full planner mode",
    };
  }

  const effectiveUseSubagents = patch.useSubagents ?? existing.useSubagents;
  if (effectiveUseSubagents) {
    patch.runPlanImprove = false;
    patch.runPostVerify = false;
  }

  // Зеркало POST /tasks: при смене plannerMode недостающие флаги берутся из значений режима.
  if (patch.plannerMode !== undefined) {
    const modeDefaults = defaultsForMode(patch.plannerMode as "fast" | "full");
    const filled = {
      skipReview: patch.skipReview === undefined,
      planDocs: patch.planDocs === undefined,
      planTests: patch.planTests === undefined,
    };
    patch.skipReview = patch.skipReview ?? modeDefaults.skipReview;
    patch.planDocs = patch.planDocs ?? modeDefaults.planDocs;
    patch.planTests = patch.planTests ?? modeDefaults.planTests;
    if (filled.skipReview || filled.planDocs || filled.planTests) {
      log.debug(
        { taskId, plannerMode: patch.plannerMode, filled },
        "Applied mode-driven task flag defaults on update",
      );
    }
  }

  // Составная операция «план»: hasOwnProperty, а не проверка на undefined —
  // null это валидное значение "очистить план". Здесь решение принимается по
  // присутствию поля в DTO-входе (маршрут вынимает plan из body до вызова).
  // planPath берётся из текущей строки задачи, как и в исходном обработчике:
  // правка planPath попадает в updateTask ниже отдельным полем.
  if (input.plan !== undefined) {
    const planUpdate = updateTaskPlanUseCase({
      taskId,
      planText: input.plan,
      isFix: existing.isFix as boolean,
      planPath: existing.planPath,
    });
    if (!planUpdate.ok) {
      return { ok: false, code: "task_not_found", error: "Project not found for task" };
    }
  }

  // Составная операция «вложения»: сохраняем новые в файлы проекта и убираем заменённые.
  if (input.attachments !== undefined) {
    if (project) {
      const oldAttachments = parseAttachments(existing.attachments);
      cleanupReplacedAttachments(project.rootPath, oldAttachments, input.attachments);
      patch.attachments = await persistAttachments(input.attachments, {
        projectRoot: project.rootPath,
        taskId,
      });
    }
  }

  const updated = updateTask(taskId, patch);
  if (!updated) {
    return { ok: false, code: "task_not_found", error: "Task not found after update" };
  }
  return { ok: true, task: updated };
}
