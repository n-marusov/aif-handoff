/**
 * Общие «управляемые» операции задачи в слое данных.
 *
 * Это единый контракт для операций с бизнес-правилами, которые раньше были
 * продублированы в `packages/api/src/use-cases/` и MCP-инструментах:
 *   - создание задачи с планировочными дефолтами (mode defaults, parallel-mode
 *     forcing, дефолтный planPath, валидация runtime-профиля);
 *   - обновление задачи с защитой полей владения (отказ вместо молчаливого
 *     отрезания) и заполнением mode defaults;
 *   - запись поля плана (для push-plan контракта).
 *
 * Почему они в `@aif/data`, а не в `@aif/api/src/use-cases/`: пакет `@aif/mcp`
 * разворачивается независимо от API (в Docker копируются только data/runtime/mcp
 * и нет зависимости на @aif/api), поэтому application-операции, нужные обоим
 * доставкам, живут в слое данных. API use-cases остаются оркестраторами
 * (участковая авторизация, вложения, WebSocket), а сами правила — здесь.
 *
 * Транспортных понятий (HTTP-статусы, hono) здесь нет: код отказа семантический,
 * а маппинг код → статус делают доставки.
 */
import { defaultsForMode, getProjectConfig, logger } from "@aif/shared";
import type { AuditActor, ExecutionOwner } from "@aif/shared";
import { findProjectById } from "./projects.js";
import { findRuntimeProfileById } from "./runtimeProfiles.js";
import { createTask, findTaskById, setTaskFields, updateTask } from "./tasks.js";
import type { HydratedTaskRow } from "./tasks.js";

const log = logger("data:task-operations");

/** Отказ валидации формы: текст + пофайловые ошибки (совпадает с api-контрактом). */
export interface TaskOperationValidationFailure {
  error: string;
  fieldErrors: Record<string, string[]>;
}

/**
 * Валидация выбора runtime-профиля с учётом области видимости проекта.
 * Правило одно на все доставки: глобальный профиль виден всем, профиль проекта —
 * только своему проекту; выключенный профиль — ошибка.
 */
export function validateProjectScopedRuntimeProfileSelections(input: {
  projectId?: string | null;
  selections: Record<string, string | null | undefined>;
}): TaskOperationValidationFailure | null {
  const fieldErrors: Record<string, string[]> = {};

  for (const [field, runtimeProfileId] of Object.entries(input.selections)) {
    if (runtimeProfileId === undefined || runtimeProfileId === null) continue;

    const profile = findRuntimeProfileById(runtimeProfileId);
    const isEnabled = profile != null && profile.enabled !== false;
    const isVisible =
      profile != null &&
      (profile.projectId == null ||
        (input.projectId != null && profile.projectId === input.projectId));

    if (!isVisible || !isEnabled) {
      const current = fieldErrors[field] ?? [];
      current.push(
        input.projectId == null
          ? "Must reference an enabled global runtime profile"
          : "Must reference an enabled global or same-project runtime profile",
      );
      fieldErrors[field] = current;
    }
  }

  if (Object.keys(fieldErrors).length === 0) {
    return null;
  }

  return {
    error: "Invalid runtime profile selection",
    fieldErrors,
  };
}

/** Поля владения/жизненного цикла, которые generic-обновление не принимает. */
const UPDATE_FORBIDDEN_FIELDS = [
  "executionOwner",
  "ownershipRevision",
  "assigneeIds",
  "participantId",
  "status",
] as const;

/**
 * Создание задачи с планировочными правилами. Выполняет:
 *   - валидацию runtime-профиля по области видимости проекта;
 *   - параллельный проект → принудительный full-режим;
 *   - fill недостающих planner-флагов из mode defaults;
 *   - дефолтный planPath из конфигурации проекта.
 * Возвращает задачу и корень проекта (для колбэка вложений API).
 */
export type CreateTaskManagedResult =
  | {
      ok: true;
      task: HydratedTaskRow;
      project: { rootPath: string } | null;
    }
  | {
      ok: false;
      code:
        | "invalid_runtime_profile"
        | "invalid_ownership"
        | "inactive_assignee"
        | "created_undefined";
      error: string;
      validation?: TaskOperationValidationFailure;
    };

export function createTaskManaged(input: {
  projectId: string;
  title: string;
  description: string;
  attachments?: unknown[];
  priority?: number;
  autoMode?: boolean;
  executionOwner?: ExecutionOwner;
  assigneeIds?: string[];
  actor?: AuditActor;
  isFix?: boolean;
  plannerMode?: "fast" | "full";
  planPath?: string;
  planDocs?: boolean;
  planTests?: boolean;
  skipReview?: boolean;
  useSubagents?: boolean;
  runPlanImprove?: boolean;
  runPostVerify?: boolean;
  autoQa?: boolean;
  maxReviewIterations?: number;
  paused?: boolean;
  runtimeProfileId?: string | null;
  modelOverride?: string | null;
  runtimeOptions?: Record<string, unknown> | null;
  roadmapAlias?: string;
  tags?: string[];
  scheduledAt?: string | null;
}): CreateTaskManagedResult {
  // Runtime-профиль проверяется на принадлежность проекту до создания задачи.
  const validation = validateProjectScopedRuntimeProfileSelections({
    projectId: input.projectId,
    selections: { runtimeProfileId: input.runtimeProfileId },
  });
  if (validation) {
    return { ok: false, code: "invalid_runtime_profile", error: validation.error, validation };
  }

  // Дефолтный planPath берётся из project config, иначе используется fallback.
  const project = findProjectById(input.projectId);
  const defaultPlanPath = project
    ? getProjectConfig(project.rootPath).paths.plan
    : ".ai-factory/PLAN.md";

  // Для parallel-enabled проекта принудительно используется plannerMode=full.
  let plannerMode = input.plannerMode ?? "fast";
  if (project?.parallelEnabled) {
    plannerMode = "full";
  }

  // Пропущенные planner-флаги заполняются mode-default значениями.
  const modeDefaults = defaultsForMode(plannerMode);
  const resolvedSkipReview = input.skipReview ?? modeDefaults.skipReview;
  const resolvedPlanDocs = input.planDocs ?? modeDefaults.planDocs;
  const resolvedPlanTests = input.planTests ?? modeDefaults.planTests;
  // Флаги runPlanImprove/runPostVerify применяются только в skills-mode.
  const resolvedRunPlanImprove = input.useSubagents ? false : input.runPlanImprove;
  const resolvedRunPostVerify = input.useSubagents ? false : input.runPostVerify;
  if (
    input.skipReview === undefined ||
    input.planDocs === undefined ||
    input.planTests === undefined
  ) {
    log.debug(
      {
        plannerMode,
        filled: {
          skipReview: input.skipReview === undefined,
          planDocs: input.planDocs === undefined,
          planTests: input.planTests === undefined,
        },
      },
      "Applied mode-driven task flag defaults",
    );
  }

  const created = createTask({
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    attachments: input.attachments ?? [],
    priority: input.priority,
    autoMode: input.autoMode,
    executionOwner: input.executionOwner,
    assigneeIds: input.assigneeIds ?? [],
    actor: input.actor,
    isFix: input.isFix,
    plannerMode,
    planPath: input.planPath ?? defaultPlanPath,
    planDocs: resolvedPlanDocs,
    planTests: resolvedPlanTests,
    skipReview: resolvedSkipReview,
    useSubagents: input.useSubagents,
    runPlanImprove: resolvedRunPlanImprove,
    runPostVerify: resolvedRunPostVerify,
    autoQa: input.autoQa,
    maxReviewIterations: input.maxReviewIterations,
    paused: input.paused,
    runtimeProfileId: input.runtimeProfileId,
    modelOverride: input.modelOverride,
    runtimeOptions: input.runtimeOptions,
    roadmapAlias: input.roadmapAlias,
    tags: input.tags,
    scheduledAt: input.scheduledAt ?? null,
  });
  if (!created) {
    // Инвариант владения: AI-задача с участниками — это invalid_ownership,
    // неактивный/отсутствующий assignee — inactive_assignee.
    if (input.executionOwner === "ai" && (input.assigneeIds ?? []).length > 0) {
      return {
        ok: false,
        code: "invalid_ownership",
        error: "AI-owned tasks cannot have participant assignees",
      };
    }
    return {
      ok: false,
      code: "inactive_assignee",
      error: "One or more assignees are inactive or missing",
    };
  }

  return {
    ok: true,
    task: created,
    project: project ? { rootPath: project.rootPath } : null,
  };
}

/**
 * Обновление задачи с бизнес-правилами. Отдельный от raw `updateTask` контракт:
 *   - отклоняет поля владения/жизненного цикла явным отказом, а не молчаливым
 *     отрезанием (MCP-инструмент раньше делал это локально — правило теперь одно);
 *   - при явном useSubagents сбрасывает runPlanImprove/runPostVerify;
 *   - при смене plannerMode заполняет недостающие флаги mode defaults.
 */
export type UpdateTaskManagedResult =
  | { ok: true; task: NonNullable<ReturnType<typeof updateTask>> }
  | {
      ok: false;
      code:
        | "task_not_found"
        | "forbidden_fields"
        | "parallel_mode_required"
        | "invalid_runtime_profile";
      error: string;
      validation?: TaskOperationValidationFailure;
    };

export function updateTaskManaged(input: {
  taskId: string;
  patch: Record<string, unknown>;
  plannerMode?: string;
  useSubagents?: boolean;
  skipReview?: boolean;
  planDocs?: boolean;
  planTests?: boolean;
  runPlanImprove?: boolean;
  runPostVerify?: boolean;
}): UpdateTaskManagedResult {
  const existing = findTaskById(input.taskId);
  if (!existing) {
    return { ok: false, code: "task_not_found", error: "Task not found" };
  }

  // Поля владения не принимает ни один generic-обновлятор.
  const forbidden = UPDATE_FORBIDDEN_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(input.patch, field),
  );
  if (forbidden.length > 0) {
    return {
      ok: false,
      code: "forbidden_fields",
      error: "Ownership or lifecycle fields cannot be updated through this operation",
    };
  }

  // Runtime-профиль проверяется на принадлежность проекту, как и при создании.
  const validation = validateProjectScopedRuntimeProfileSelections({
    projectId: existing.projectId,
    selections: {
      runtimeProfileId:
        typeof input.patch.runtimeProfileId === "string" ||
        input.patch.runtimeProfileId === null ||
        input.patch.runtimeProfileId === undefined
          ? (input.patch.runtimeProfileId as string | null | undefined)
          : undefined,
    },
  });
  if (validation) {
    return {
      ok: false,
      code: "invalid_runtime_profile",
      error: validation.error,
      validation,
    };
  }

  const patch = { ...input.patch };

  // Проекты с параллельным выполнением принудительно получают полный режим.
  const project = findProjectById(existing.projectId);
  if (project?.parallelEnabled && input.plannerMode === "fast") {
    return {
      ok: false,
      code: "parallel_mode_required",
      error: "Parallel-enabled projects require full planner mode",
    };
  }

  const effectiveUseSubagents = input.useSubagents ?? existing.useSubagents;
  if (effectiveUseSubagents) {
    patch.runPlanImprove = false;
    patch.runPostVerify = false;
  }

  // Зеркало POST /tasks: при смене plannerMode недостающие флаги берутся из значений режима.
  if (input.plannerMode !== undefined) {
    const modeDefaults = defaultsForMode(input.plannerMode as "fast" | "full");
    patch.skipReview = input.skipReview ?? modeDefaults.skipReview;
    patch.planDocs = input.planDocs ?? modeDefaults.planDocs;
    patch.planTests = input.planTests ?? modeDefaults.planTests;
  }

  const updated = updateTask(input.taskId, patch);
  if (!updated) {
    return { ok: false, code: "task_not_found", error: "Task not found after update" };
  }
  return { ok: true, task: updated };
}

/**
 * Запись содержимого плана в поле задачи (push-plan контракт). Отделена от
 * записи файла плана (`persistTaskPlanForTask`), потому что push-plan
 * доставляет план из внешней системы в поле, а не в файл.
 */
export type SetTaskPlanContentResult =
  | { ok: true; task: HydratedTaskRow }
  | { ok: false; code: "task_not_found"; error: string };

export function setTaskPlanContentManaged(
  taskId: string,
  planContent: string,
): SetTaskPlanContentResult {
  const existing = findTaskById(taskId);
  if (!existing) {
    return { ok: false, code: "task_not_found", error: "Task not found" };
  }
  setTaskFields(taskId, { plan: planContent, updatedAt: new Date().toISOString() });
  const updated = findTaskById(taskId);
  return { ok: true, task: updated ?? existing };
}