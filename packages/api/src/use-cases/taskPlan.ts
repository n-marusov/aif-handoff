/**
 * Use cases: чтение и запись плана задачи через канонический файл.
 *
 * Перенесено из packages/api/src/repositories/tasks.ts при clean-architecture
 * refactoring. Здесь собраны операции, которые раньше жили в HTTP-репозитории:
 * запись плана (updateTaskPlan), состояние файла (getTaskPlanFileStatus) и
 * обратная синхронизация файла в БД (syncTaskPlanFile). Маршрут остаётся тонким
 * контроллером и переводит результат в HTTP-статусы.
 *
 * Ключевые инварианты (без изменений относительно исходника):
 *  - корень исполнения = worktreePath задачи, а при его отсутствии — rootPath
 *    проекта; план всегда читается/пишется по этому корню;
 *  - канонический путь плана вычисляется только через getCanonicalPlanPath из
 *    @aif/shared (единый источник, которым пользуются агент и рантайм).
 */
import { existsSync, readFileSync } from "node:fs";
import { findProjectByTaskId, findTaskById, persistTaskPlanForTask } from "@aif/data";
import { getCanonicalPlanPath, logger, taskExecutionRoot } from "@aif/shared";
import type { SyncTaskPlanFileInput, UpdateTaskPlanInput, UpdateTaskPlanResult } from "./types.js";

const log = logger("use-case:task-plan");

/** Корень исполнения задачи: worktree при наличии, иначе корень проекта. */
function executionRootFor(
  taskId: string,
): { projectRoot: string; isFix: boolean; planPath?: string | null } | null {
  const task = findTaskById(taskId);
  if (!task) return null;
  const project = findProjectByTaskId(taskId);
  if (!project) return null;
  return {
    projectRoot: taskExecutionRoot({
      worktreePath: task.worktreePath,
      rootPath: project.rootPath,
    }),
    isFix: task.isFix,
    planPath: task.planPath,
  };
}

/** План-путь для записи: null не нужен БД (там nullable-колонка), но API-слой не принимает null. */
function planPathOrUndefined(planPath: string | null | undefined): string | undefined {
  return planPath ?? undefined;
}

/**
 * Запись плана, пришедшего извне (правка в UI). Задача обязана существовать
 * вместе со своим проектом: без проекта невозможно вычислить корень
 * исполнения, поэтому это единственное место, где возвращается отказ.
 */
export function updateTaskPlan(input: UpdateTaskPlanInput): UpdateTaskPlanResult {
  log.debug({ useCase: "updateTaskPlan", taskId: input.taskId }, "use case entry");
  const task = findTaskById(input.taskId);
  if (!task) return { ok: false, code: "task_or_project_not_found" };
  const project = findProjectByTaskId(input.taskId);
  if (!project) return { ok: false, code: "task_or_project_not_found" };
  const executionRoot = taskExecutionRoot({
    worktreePath: task.worktreePath,
    rootPath: project.rootPath,
  });

  persistTaskPlanForTask({
    taskId: input.taskId,
    planText: input.planText,
    projectRoot: executionRoot,
    isFix: input.isFix,
    planPath: input.planPath,
    updatedAt: new Date().toISOString(),
  });
  log.debug({ useCase: "updateTaskPlan", taskId: input.taskId, outcome: "ok" }, "use case exit");
  return { ok: true };
}

/**
 * Состояние файла плана нужно UI, чтобы показать расхождение между БД и
 * диском. Отсутствие задачи или проекта - не ошибка, а "нет данных":
 * возвращается null, и клиент просто скрывает индикатор.
 */
export function getTaskPlanFileStatus(taskId: string) {
  const task = findTaskById(taskId);
  if (!task) return null;

  const project = findProjectByTaskId(taskId);
  if (!project) return null;
  const executionRoot = taskExecutionRoot({
    worktreePath: task.worktreePath,
    rootPath: project.rootPath,
  });

  const canonicalPlanPath = getCanonicalPlanPath({
    projectRoot: executionRoot,
    isFix: task.isFix,
    planPath: task.planPath,
  });

  return {
    exists: existsSync(canonicalPlanPath),
    path: canonicalPlanPath,
  };
}

/**
 * Обратная синхронизация: файл плана перечитывается и переносится в БД.
 * Нужна после правок, сделанных агентом или человеком прямо в репозитории.
 * Отсутствие файла - штатная ситуация (synced: false, missing: true).
 */
export function syncTaskPlanFile(input: SyncTaskPlanFileInput) {
  const { taskId } = input;
  log.debug({ useCase: "syncTaskPlanFile", taskId }, "use case entry");
  const root = executionRootFor(taskId);
  if (!root) return null;

  const canonicalPlanPath = getCanonicalPlanPath({
    projectRoot: root.projectRoot,
    isFix: root.isFix,
    planPath: planPathOrUndefined(root.planPath),
  });
  if (!existsSync(canonicalPlanPath)) {
    log.debug({ useCase: "syncTaskPlanFile", taskId, outcome: "missing" }, "use case exit");
    return { synced: false, missing: true };
  }

  const filePlan = readFileSync(canonicalPlanPath, "utf8");
  // Пустой или состоящий из пробелов файл приводится к null: в БД нет смысла
  // хранить строку, которую UI отобразит как пустой план.
  const normalizedPlan = filePlan.trim().length > 0 ? filePlan : null;

  persistTaskPlanForTask({
    taskId,
    planText: normalizedPlan,
    projectRoot: root.projectRoot,
    isFix: root.isFix,
    planPath: planPathOrUndefined(root.planPath),
    updatedAt: new Date().toISOString(),
  });

  log.debug({ useCase: "syncTaskPlanFile", taskId, outcome: "synced" }, "use case exit");
  return { synced: true, missing: false };
}
