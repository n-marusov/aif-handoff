/**
 * Репозиторий задач уровня API.
 *
 * Назначение: дополнить слой @aif/data тем, что относится именно к HTTP API -
 * синхронизацией плана между БД и файлом, формой полезной нагрузки для
 * WebSocket и удобными обертками для комментариев. Прямой доступ к БД из
 * пакета api запрещен линтером, поэтому все мутации делегируются в @aif/data,
 * а здесь остаются только правила и вычисления.
 *
 * Ключевые инварианты:
 *
 * 1. Корень исполнения задачи равен worktreePath, а при его отсутствии -
 *    rootPath проекта. План всегда читается и пишется по этому корню, иначе
 *    задача в git-worktree и задача без него увидели бы разные файлы плана.
 * 2. Канонический путь плана вычисляется только через getCanonicalPlanPath из
 *    @aif/shared. Собственная сборка пути здесь разошлась бы с той, которой
 *    пользуются агент и рантайм.
 * 3. Полезная нагрузка для WebSocket не должна содержать ключи со значением
 *    undefined: клиент применяет частичное обновление, и явный undefined мог
 *    бы затереть поля владения, уже известные UI.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  getCanonicalPlanPath,
  toCommentResponse,
  toTaskListItem,
  toTaskResponse,
} from "@aif/shared";
import type { AuditActor, ExecutionOwner, TaskAssigneeSummary, TaskStatus } from "@aif/shared";
import {
  createTask,
  createTaskComment,
  updateTaskComment,
  deleteTask,
  findProjectByTaskId,
  findTaskById,
  listTaskListItems,
  listTaskComments as listComments,
  listTasks,
  persistTaskPlanForTask,
  updateTask,
} from "@aif/data";

// Урезанная форма задачи для широковещательной рассылки. Полный ответ
// строится отдельно (toTaskResponse) и содержит тяжелые поля, которые незачем
// гонять по WebSocket на каждое изменение.
export function toTaskBroadcastPayload(
  task: {
    id: string;
    title: string;
    status: TaskStatus;
    executionOwner?: ExecutionOwner;
    ownershipRevision?: number;
    assignees?: TaskAssigneeSummary[];
  },
  actor?: AuditActor,
) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    // Поля добавляются условно, а не как "executionOwner: undefined": иначе
    // JSON.stringify отбросил бы ключ только на верхнем уровне, а вложенные
    // структуры разошлись бы с ожиданиями клиента.
    ...(task.executionOwner === undefined ? {} : { executionOwner: task.executionOwner }),
    ...(task.ownershipRevision === undefined ? {} : { ownershipRevision: task.ownershipRevision }),
    ...(task.assignees === undefined ? {} : { assignees: task.assignees }),
    ...(actor === undefined ? {} : { actor }),
  };
}

// Запись плана, пришедшего извне (правка в UI). Задача обязана существовать
// вместе со своим проектом: без проекта невозможно вычислить корень
// исполнения, поэтому это единственное место, где выбрасывается исключение.
export function updateTaskPlan(
  taskId: string,
  planText: string | null,
  isFix: boolean,
  planPath?: string,
): void {
  const project = findProjectByTaskId(taskId);
  if (!project) throw new Error("Project not found for task");
  const task = findTaskById(taskId);
  // Задача может исчезнуть между запросами, поэтому обращение безопасное.
  // Пустой worktreePath трактуется как его отсутствие.
  const executionRoot = task?.worktreePath ?? project.rootPath;

  persistTaskPlanForTask({
    taskId,
    planText,
    projectRoot: executionRoot,
    isFix,
    planPath,
    updatedAt: new Date().toISOString(),
  });
}

// Состояние файла плана нужно UI, чтобы показать расхождение между БД и
// диском. Отсутствие задачи или проекта - не ошибка, а "нет данных":
// возвращается null, и клиент просто скрывает индикатор.
export function getTaskPlanFileStatus(taskId: string) {
  const task = findTaskById(taskId);
  if (!task) return null;

  const project = findProjectByTaskId(taskId);
  if (!project) return null;
  const executionRoot = task.worktreePath ?? project.rootPath;

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

// Обратная синхронизация: файл плана перечитывается и переносится в БД.
// Нужна после правок, сделанных агентом или человеком прямо в репозитории.
// Отсутствие файла - штатная ситуация (synced: false), а не исключение.
export function syncTaskPlanFromFile(taskId: string): { synced: boolean } | null {
  const task = findTaskById(taskId);
  if (!task) return null;

  const project = findProjectByTaskId(taskId);
  if (!project) return null;
  const executionRoot = task.worktreePath ?? project.rootPath;

  const canonicalPlanPath = getCanonicalPlanPath({
    projectRoot: executionRoot,
    isFix: task.isFix,
    planPath: task.planPath,
  });
  if (!existsSync(canonicalPlanPath)) {
    return { synced: false };
  }

  const filePlan = readFileSync(canonicalPlanPath, "utf8");
  // Пустой или состоящий из пробелов файл приводится к null: в БД нет смысла
  // хранить строку, которую UI отобразит как пустой план.
  const normalizedPlan = filePlan.trim().length > 0 ? filePlan : null;

  persistTaskPlanForTask({
    taskId,
    planText: normalizedPlan,
    projectRoot: executionRoot,
    isFix: task.isFix,
    planPath: task.planPath,
    updatedAt: new Date().toISOString(),
  });

  return { synced: true };
}

// Сквозной реэкспорт: маршруты импортируют чтение и мутации задач из одного
// модуля, чтобы HTTP-слой не разбирался, где заканчивается API и начинается
// слой данных.
export {
  toTaskResponse,
  toCommentResponse,
  toTaskListItem,
  findTaskById,
  listTaskListItems,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  listComments,
};

// Обертка над createTaskComment фиксирует авторство человека: агент создает
// комментарии через свои внутренние пути, а этот вызов приходит только из
// пользовательского API, поэтому тип автора здесь не параметр, а константа.
// Тип результата выводится из createTaskComment — комментарий-строка не входит
// в публичный контракт @aif/data.
export function createComment(input: {
  taskId: string;
  participantId?: string | null;
  message: string;
  attachments?: unknown[];
}): ReturnType<typeof createTaskComment> {
  return createTaskComment({
    taskId: input.taskId,
    // Участник передается отдельно от автора: автор - категория (человек или
    // агент), участник - конкретная личность для истории изменений.
    author: "human",
    participantId: input.participantId,
    message: input.message,
    attachments: input.attachments,
  });
}

// Редактировать разрешено только вложения. Текст комментария неизменяем,
// потому что на него ссылаются записи аудита и история обсуждения задачи.
export function updateComment(
  commentId: string,
  patch: { attachments?: unknown[] },
): ReturnType<typeof updateTaskComment> {
  return updateTaskComment(commentId, patch);
}
