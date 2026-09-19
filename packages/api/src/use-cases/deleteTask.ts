/**
 * Application use case «удалить задачу».
 *
 * Удаление состоит из двух разных по природе шагов: снятие git-снимка и
 * удаление строки БД (атомарно), затем best-effort уборка worktree через
 * внутренний HTTP агента. Порядок критичен: после deleteTask восстановить
 * branchName/worktreePath уже неоткуда.
 *
 * Маршрут остаётся тонким: парсит id, зовёт use case, рассылает WS и
 * формирует ответ. Транспортных понятий здесь нет.
 */
import { logger } from "@aif/shared";
import { deleteTask, findProjectById, findTaskById } from "@aif/data";
import { callAgentWorktreeCleanup } from "../services/agentInternal.js";
import type { DeleteTaskInput, DeleteTaskResult } from "./types.js";

const log = logger("delete-task-use-case");

/**
 * Единственная точка входа: удаляет строку задачи и запускает best-effort
 * уборку worktree. Возвращает успех либо «задача не найдена».
 */
export async function deleteTaskUseCase(input: DeleteTaskInput): Promise<DeleteTaskResult> {
  const { taskId } = input;
  const existing = findTaskById(taskId);
  if (!existing) {
    return { ok: false, code: "task_not_found", error: "Task not found" };
  }

  // Снимок git-идентичности ДО исчезновения строки БД: уборке нужны имена
  // ветки/worktree плюс корень проекта, чтобы удалить правильную папку.
  const project = findProjectById(existing.projectId);
  const worktreeSnapshot = {
    taskId: existing.id,
    projectId: existing.projectId,
    projectRoot: project?.rootPath ?? "",
    branchName: existing.branchName ?? null,
    worktreePath: existing.worktreePath ?? null,
  };

  // Строка удаляется в БД-транзакции, а файловые операции вынесены наружу:
  // они не транзакционны и должны быть идемпотентными.
  deleteTask(taskId);
  log.debug({ taskId }, "Task deleted");

  // WS-событие уходит сразу после удаления строки, до уборки worktree: клиенты
  // не должны ждать медленную файловую операцию, чтобы убрать карточку.
  input.onTaskDeleted?.();

  // Уборка worktree best-effort: удаление уже состоялось, и недоступный агент
  // не должен превращать его в ошибку.
  if (worktreeSnapshot.worktreePath && worktreeSnapshot.projectRoot) {
    try {
      const cleanupResult = await callAgentWorktreeCleanup({
        ...worktreeSnapshot,
        reason: "task_delete",
      });
      if (!cleanupResult.ok) {
        log.warn(
          { taskId, code: cleanupResult.errorCode },
          "Worktree cleanup after delete did not complete",
        );
      }
    } catch (error) {
      log.warn(
        { taskId, err: error },
        "Worktree cleanup after delete threw; delete already succeeded",
      );
    }
  }

  return { ok: true };
}
