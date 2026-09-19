/**
 * Application use case «обновить задачу».
 *
 * Оркестратор поверх общего контракта `updateTaskManaged` (@aif/data):
 * участковая авторизация (canMutateTask), составные операции «файл плана» и
 * «вложения» остаются здесь, а общие правила (отказ полей владения, валидация
 * runtime-профиля, запрет fast-режима в параллельных проектах, заполнение
 * mode-default флагов) делегированы в слой данных — туда же обращаются
 * MCP-инструменты.
 */
import { parseAttachments } from "@aif/shared";
import type { TaskActionContext } from "@aif/shared";
import { findProjectById, findTaskById, getTaskOwnership, updateTaskManaged } from "@aif/data";
import {
  cleanupReplacedAttachments,
  persistAttachments,
} from "../services/attachmentPersistence.js";
import { updateTaskPlan as updateTaskPlanUseCase } from "./taskPlan.js";
import type { UpdateTaskInput, UpdateTaskResult } from "./types.js";

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
 * Единственная точка входа: применяет авторизацию, зовёт составные операции
 * плана и вложений, затем единый общий контракт обновления. Возвращает свежую
 * строку задачи либо семантический код отказа.
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

  const project = findProjectById(existing.projectId);

  // Составная операция «план»: присутствие поля в DTO-входе (маршрут вынимает
  // plan из body до вызова). planPath берётся из текущей строки задачи, как и в
  // исходном обработчике: правка planPath попадает в updateTask отдельным полем.
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

  // Составная операция «вложения»: сохраняем новые в файлы проекта и убираем
  // заменённые; persisted-список подмешивается в единый финальный патч.
  let finalPatch: Record<string, unknown> = { ...(patch as Record<string, unknown>) };
  if (input.attachments !== undefined) {
    if (project) {
      const oldAttachments = parseAttachments(existing.attachments);
      cleanupReplacedAttachments(project.rootPath, oldAttachments, input.attachments);
      finalPatch.attachments = await persistAttachments(input.attachments, {
        projectRoot: project.rootPath,
        taskId,
      });
    }
  }

  // Единственная запись в таблицу: общий контракт применяет правила и пишет
  // плоский набор колонок (план и вложения уже разложены выше).
  const result = updateTaskManaged({
    taskId,
    patch: finalPatch,
    plannerMode: patch.plannerMode,
    useSubagents: patch.useSubagents,
    skipReview: patch.skipReview,
    planDocs: patch.planDocs,
    planTests: patch.planTests,
    runPlanImprove: patch.runPlanImprove,
    runPostVerify: patch.runPostVerify,
  });
  if (!result.ok) {
    if (result.code === "invalid_runtime_profile") {
      return {
        ok: false,
        code: "invalid_runtime_profile",
        error: result.error,
        details: result.validation as unknown as Record<string, unknown>,
      };
    }
    return {
      ok: false,
      code: result.code === "forbidden_fields" ? "forbidden" : result.code,
      error: result.error,
    };
  }

  const updated = findTaskById(taskId);
  if (!updated) {
    return { ok: false, code: "task_not_found", error: "Task not found after update" };
  }
  return { ok: true, task: updated };
}
