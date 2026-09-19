/**
 * Application use case «создать задачу».
 *
 * Вся бизнес-логика создания задачи живёт здесь: авторизация участника
 * (проверка роли member), инварианты владения (AI-задача без участников,
 * активные assignee), валидация runtime-профиля, заполнение mode-default
 * флагов, двухфазная персистенция вложений. Маршрут остаётся тонким
 * контроллером: парсит и валидирует вход, зовёт use case, рассылает WS и
 * формирует HTTP-ответ.
 *
 * Транспортных понятий (Hono, HTTP-статусы, hono Context) здесь нет:
 * семантический код отказа несёт бизнес-смысл, а маппинг код → статус живёт
 * в маршруте.
 */
import { defaultsForMode, getProjectConfig, logger } from "@aif/shared";
import {
  createTask,
  findParticipantById,
  findProjectById,
  findTaskById,
  updateTask,
} from "@aif/data";
import { persistAttachments } from "../services/attachmentPersistence.js";
import { validateProjectScopedRuntimeProfileSelections } from "../services/runtimeProfileScope.js";
import type { CreateTaskInput, CreateTaskResult } from "./types.js";

const log = logger("create-task-use-case");

/** Строка задачи: выводится из findTaskById (row-типы не входят в публичный контракт). */
export type PersistedTask = NonNullable<ReturnType<typeof findTaskById>>;

/**
 * Единственная точка входа: применяет все доменные правила и возвращает
 * задачу для broadcast/ответа либо семантический код отказа.
 */
export async function createTaskUseCase(input: CreateTaskInput): Promise<CreateTaskResult> {
  const actor = input.actionContext.actor;

  // Участник с ролью member не назначает human-задачу на других при создании.
  if (
    input.actionContext.participantsModeEnabled &&
    input.actionContext.participantRole === "member" &&
    input.executionOwner === "human" &&
    (input.assigneeIds.length > 1 ||
      (input.assigneeIds.length === 1 && input.assigneeIds[0] !== actor.id))
  ) {
    return {
      ok: false,
      code: "forbidden",
      error: "Members may create human tasks only unassigned or assigned to themselves",
    };
  }
  // Задача, закреплённая за ИИ, не может содержать участников-исполнителей.
  if (input.executionOwner === "ai" && input.assigneeIds.length > 0) {
    return {
      ok: false,
      code: "invalid_ownership",
      error: "AI-owned tasks cannot have participant assignees",
    };
  }
  // Каждый assignee должен существовать и быть активным.
  for (const participantId of input.assigneeIds) {
    const participant = findParticipantById(participantId);
    if (!participant?.active) {
      return {
        ok: false,
        code: "inactive_assignee",
        error: "One or more assignees are inactive or missing",
      };
    }
  }
  // Runtime-профиль проверяется на принадлежность проекту перед созданием задачи.
  const runtimeValidation = validateProjectScopedRuntimeProfileSelections({
    projectId: input.projectId,
    selections: { runtimeProfileId: input.runtimeProfileId },
  });
  if (runtimeValidation) {
    return {
      ok: false,
      code: "invalid_runtime_profile",
      error: runtimeValidation.error,
      details: runtimeValidation as Record<string, unknown>,
    };
  }

  // Дефолтный planPath берётся из project config, иначе используется fallback.
  const project = findProjectById(input.projectId);
  const defaultPlanPath = project
    ? getProjectConfig(project.rootPath).paths.plan
    : ".ai-factory/PLAN.md";

  // Для parallel-enabled проекта принудительно используется plannerMode=full.
  if (project?.parallelEnabled) {
    input.plannerMode = "full";
  }

  // Пропущенные planner-флаги заполняются mode-default значениями.
  const modeDefaults = defaultsForMode(input.plannerMode);
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
        plannerMode: input.plannerMode,
        filled: {
          skipReview: input.skipReview === undefined,
          planDocs: input.planDocs === undefined,
          planTests: input.planTests === undefined,
        },
      },
      "Applied mode-driven task flag defaults",
    );
  }

  // Двухфазная схема вложений: сначала create task, затем persist файлов,
  // затем update ссылок в задаче.
  const created = createTask({
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    attachments: [],
    priority: input.priority,
    autoMode: input.autoMode,
    executionOwner: input.executionOwner,
    assigneeIds: input.assigneeIds,
    actor,
    isFix: input.isFix,
    plannerMode: input.plannerMode,
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
  // null из createTask трактуется как нарушение ownership-инварианта.
  if (!created) {
    return { ok: false, code: "invalid_ownership", error: "Failed to create task ownership" };
  }

  // Вложения сохраняются в файловом хранилище проекта и привязываются путями.
  if (input.attachments.length > 0) {
    if (project) {
      const persisted = await persistAttachments(input.attachments, {
        projectRoot: project.rootPath,
        taskId: created.id,
      });
      updateTask(created.id, { attachments: persisted });
    }
  }

  const task = findTaskById(created.id) ?? created;
  return {
    ok: true,
    task,
    wakeAgent: task.executionOwner === "ai",
  };
}
