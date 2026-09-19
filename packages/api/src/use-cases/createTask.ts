/**
 * Application use case «создать задачу».
 *
 * Оркестратор поверх общего контракта `createTaskManaged` (@aif/data):
 * участковая авторизация (роль member) и вложения остаются здесь, а
 * планировочные правила (mode defaults, parallel-mode, дефолтный planPath,
 * валидация runtime-профиля) делегированы в слой данных — туда же обращаются
 * MCP-инструменты, поэтому правило живёт один раз.
 *
 * Транспортных понятий (Hono, HTTP-статусы) здесь нет: код отказа
 * семантический, маппинг код → статус делает маршрут.
 */
import { createTaskManaged, updateTask } from "@aif/data";
import { logger } from "@aif/shared";
import { persistAttachments } from "../services/attachmentPersistence.js";
import type { CreateTaskInput, CreateTaskResult } from "./types.js";

const log = logger("create-task-use-case");

/**
 * Единственная точка входа: применяет участковую авторизацию, зовёт общий
 * контракт создания и персистит вложения. Возвращает задачу для
 * broadcast/ответа либо семантический код отказа.
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

  // Планировочные правила и создание строки — общий контракт слоя данных.
  const result = createTaskManaged({
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
    planPath: input.planPath,
    planDocs: input.planDocs,
    planTests: input.planTests,
    skipReview: input.skipReview,
    useSubagents: input.useSubagents,
    runPlanImprove: input.runPlanImprove,
    runPostVerify: input.runPostVerify,
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
  if (!result.ok) {
    if (result.code === "invalid_runtime_profile") {
      return {
        ok: false,
        code: "invalid_runtime_profile",
        error: result.error,
        details: result.validation as unknown as Record<string, unknown>,
      };
    }
    return { ok: false, code: result.code, error: result.error };
  }

  // Вложения сохраняются в файловом хранилище проекта и привязываются путями.
  const project = result.project;
  if (input.attachments.length > 0 && project) {
    const persisted = await persistAttachments(input.attachments, {
      projectRoot: project.rootPath,
      taskId: result.task.id,
    });
    updateTask(result.task.id, { attachments: persisted });
  }

  log.debug(
    {
      taskId: result.task.id,
      title: input.title,
      roadmapAlias: input.roadmapAlias,
      tagCount: input.tags?.length,
      attachmentCount: input.attachments.length,
    },
    "Task created",
  );

  return {
    ok: true,
    task: result.task,
    wakeAgent: result.task.executionOwner === "ai",
  };
}
