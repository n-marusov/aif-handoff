/**
 * Task router домена задач: CRUD, lifecycle-события, handoff, комментарии,
 * вложения и WS-broadcast.
 *
 * Правила файла:
 * - переходы статусов идут через общий конечный автомат;
 * - доступ к БД только через @aif/data;
 * - handoff выполняется атомарно по ownershipRevision (CAS);
 * - мутации синхронизируются с WebSocket, чтобы UI видел актуальное состояние.
 *
 * Потенциальное улучшение: выделить единый слой policy для авторизации
 * route-мутаций и переиспользовать его между task-роутами.
 */
import { Hono, type Context } from "hono";
import { jsonValidator } from "../middleware/zodValidator.js";
import { internalBroadcastAuth } from "../middleware/internalBroadcastAuth.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  logger,
  parseAttachments,
  getProjectConfig,
  defaultsForMode,
  getEnv,
  type TaskActionContext,
} from "@aif/shared";
import {
  createTaskSchema,
  updateTaskSchema,
  taskEventSchema,
  createTaskCommentSchema,
  reorderTaskSchema,
  broadcastTaskSchema,
  handoffTaskSchema,
} from "../schemas.js";
import { broadcast } from "../ws.js";
import { handleTaskEvent } from "../services/taskEvents.js";
import {
  persistAttachments,
  cleanupReplacedAttachments,
} from "../services/attachmentPersistence.js";
import { readAttachment } from "../services/attachmentStorage.js";
import {
  findTaskById,
  listTaskListItems,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  listComments,
  createComment,
  updateComment,
  toTaskResponse,
  toTaskBroadcastPayload,
  toCommentResponse,
  toTaskListItem,
  getTaskPlanFileStatus,
  updateTaskPlan,
  syncTaskPlanFromFile,
} from "../repositories/tasks.js";
import {
  findProjectById,
  getAppDefaultRuntimeProfileId,
  resolveEffectiveRuntimeProfile,
  resolveEffectiveRuntimeProfilesForTasks,
  claimTask,
  releaseTaskClaim,
  updateTaskPositionOnly,
  tryStartQaRun,
  findParticipantById,
  getTaskOwnership,
  handoffTaskExecution,
  listTaskExecutorHistory,
  findGitHubIssueByTaskId,
  type TaskOwnershipFilters,
} from "@aif/data";
import { validateProjectScopedRuntimeProfileSelections } from "../services/runtimeProfileScope.js";
import { callAgentWorktreeCleanup } from "../services/agentInternal.js";
import { getParticipantAuth, type ParticipantApiEnv } from "../middleware/participantAuth.js";

const log = logger("tasks-route");
const QA_LOCK_DURATION_MS = Math.max(getEnv().AGENT_STAGE_RUN_TIMEOUT_MS, 60_000) + 5 * 60 * 1000;

export const tasksRouter = new Hono<ParticipantApiEnv>();

// Legacy action-context при выключенном participants mode.
const LEGACY_ACTION_CONTEXT: TaskActionContext = {
  participantsModeEnabled: false,
  actor: {
    kind: "anonymous",
    id: null,
    displayNameSnapshot: null,
  },
  participantRole: null,
  participantActive: true,
};

// Формирует TaskActionContext из сессии и текущего env-флага.
// При отсутствии сессии возвращается anonymous-актор.
function requestActionContext(c: Context<ParticipantApiEnv>): TaskActionContext {
  if (!getEnv().PARTICIPANTS_MODE_ENABLED) return LEGACY_ACTION_CONTEXT;
  const auth = getParticipantAuth(c);
  const participant = auth?.session?.participant;
  if (!participant) {
    return {
      participantsModeEnabled: true,
      actor: {
        kind: "anonymous",
        id: null,
        displayNameSnapshot: null,
      },
      participantRole: null,
      participantActive: false,
    };
  }
  return {
    participantsModeEnabled: true,
    actor: {
      kind: "participant",
      id: participant.id,
      displayNameSnapshot: participant.displayName,
    },
    participantRole: participant.role,
    participantActive: participant.active,
  };
}

// Мутации разрешены admin или активному assignee.
// Проверка ownership выполняется по актуальному состоянию БД.
function canMutateTask(c: Context<ParticipantApiEnv>, taskId: string): boolean {
  const context = requestActionContext(c);
  if (!context.participantsModeEnabled || context.participantRole === "admin") return true;

  const actorId = context.actor.id;
  const assigned = Boolean(
    actorId &&
    getTaskOwnership(taskId)?.assignees.some(
      (assignee) => assignee.participantId === actorId && assignee.active,
    ),
  );
  const details = { taskId, actorId, method: c.req.method, path: c.req.path };
  if (assigned) {
    log.debug(details, "Authorized assigned participant task mutation");
  } else {
    log.warn(details, "Rejected unauthorized task mutation");
  }
  return assigned;
}

// Парсит ownership-фильтры списка задач и валидирует комбинации параметров.
// assigneeId=me разрешается на уровне роута, где известен текущий актор.
function parseTaskOwnershipFilters(
  c: Context<ParticipantApiEnv>,
  context: TaskActionContext,
): { ok: true; filters: TaskOwnershipFilters } | { ok: false; error: string } {
  const owner = c.req.query("owner") ?? c.req.query("executionOwner");
  if (owner !== undefined && owner !== "ai" && owner !== "human") {
    return { ok: false, error: "owner must be ai or human" };
  }
  const assignee = c.req.query("assigneeId");
  const unassignedRaw = c.req.query("unassigned");
  if (unassignedRaw !== undefined && unassignedRaw !== "true" && unassignedRaw !== "false") {
    return { ok: false, error: "unassigned must be true or false" };
  }
  const unassigned = unassignedRaw === "true";
  if (unassigned && assignee) {
    return { ok: false, error: "assigneeId and unassigned=true cannot be combined" };
  }
  const assigneeId =
    assignee === "me"
      ? context.actor.kind === "participant"
        ? (context.actor.id ?? undefined)
        : undefined
      : assignee;
  if (assignee === "me" && !assigneeId) {
    return { ok: false, error: "assigneeId=me requires an authenticated participant" };
  }
  return {
    ok: true,
    filters: {
      executionOwner: owner,
      assigneeId,
      unassigned,
    },
  };
}

/**
 * Fire-and-forget запуск QA с гарантией терминального WS-события.
 * После task:qa_started всегда должен прийти task:qa_done или task:qa_failed.
 */
function dispatchQaRun(
  projectId: string,
  taskId: string,
  executionRoot: string,
  lockId: string,
): void {
  void (async () => {
    try {
      const { runQaQuery } = await import("../services/qaRunner.js");
      const result = await runQaQuery({ projectId, taskId, executionRoot });
      broadcast(
        result.ok
          ? { type: "task:qa_done", payload: { taskId, projectId, status: "done" } }
          : {
              type: "task:qa_failed",
              payload: { taskId, projectId, status: "failed", error: result.error },
            },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ taskId, projectId, error }, "QA dispatch failed before runner completed");
      // При сбое dispatch освобождаем QA running-slot,
      // иначе последующие старты QA будут заблокированы.
      try {
        updateTask(taskId, { qaStatus: "error" });
        const failedTask = findTaskById(taskId);
        if (failedTask) {
          broadcast({ type: "task:updated", payload: toTaskBroadcastPayload(failedTask) });
        }
      } catch (persistErr) {
        log.error(
          { persistErr, taskId },
          "Failed to persist QA error status after dispatch failure",
        );
      }
      broadcast({
        type: "task:qa_failed",
        payload: { taskId, projectId, status: "failed", error: message },
      });
    } finally {
      releaseTaskClaim(taskId, lockId);
    }
  })();
}

/**
 * Атомарный старт QA (manual + auto trigger).
 * CAS по qaStatus предотвращает двойной запуск конкурирующих запросов.
 */
function startQaRun(
  projectId: string,
  taskId: string,
  executionRoot: string,
):
  | { started: true }
  | { started: false; code: "ai_handoff_required" | "task_locked" | "already_running" } {
  const task = findTaskById(taskId);
  if (task?.executionOwner !== "ai") {
    return { started: false, code: "ai_handoff_required" };
  }
  const lockId = `qa:${crypto.randomUUID()}`;
  if (!claimTask(taskId, lockId, QA_LOCK_DURATION_MS)) {
    const current = findTaskById(taskId);
    return {
      started: false,
      code: current?.executionOwner === "human" ? "ai_handoff_required" : "task_locked",
    };
  }
  if (!tryStartQaRun(taskId)) {
    releaseTaskClaim(taskId, lockId);
    return { started: false, code: "already_running" };
  }
  const runningTask = findTaskById(taskId);
  if (runningTask) {
    broadcast({ type: "task:updated", payload: toTaskBroadcastPayload(runningTask) });
  }
  broadcast({ type: "task:qa_started", payload: { taskId, projectId, status: "started" } });
  dispatchQaRun(projectId, taskId, executionRoot, lockId);
  return { started: true };
}

// Обогащает ответ по задаче связью с GitHub и эффективным runtime-профилем.
// Для списков допускается передача заранее вычисленных значений runtime.
// Тип задачи выводится из updateTask (базовая строка БД) — row-типы не входят
// в публичный контракт @aif/data; гидратированные строки сюда присваиваются.
function toTaskRouteResponse(
  task: NonNullable<ReturnType<typeof updateTask>>,
  systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId("task"),
  effectiveRuntime = resolveEffectiveRuntimeProfile({
    taskId: task.id,
    projectId: task.projectId,
    mode: "task",
    systemDefaultRuntimeProfileId,
  }),
  actionContext: TaskActionContext = LEGACY_ACTION_CONTEXT,
) {
  const response = toTaskResponse(task, actionContext);

  return {
    ...response,
    github: findGitHubIssueByTaskId(task.id) ?? null,
    effectiveRuntime: {
      source: effectiveRuntime.source,
      profileId: effectiveRuntime.profile?.id ?? null,
      runtimeId: effectiveRuntime.profile?.runtimeId ?? null,
      providerId: effectiveRuntime.profile?.providerId ?? null,
      profileName: effectiveRuntime.profile?.name ?? null,
    },
  };
}

// Внутренний маршрут для рассылки WS-события из процесса агента.
// Защищён общим внутренним токеном, а не сессией участника.
tasksRouter.post(
  "/:id/broadcast",
  internalBroadcastAuth,
  jsonValidator(broadcastTaskSchema),
  async (c) => {
    const { id } = c.req.param();
    const { type, payload } = c.req.valid("json");
    const task = findTaskById(id);
    if (!task) return c.json({ error: "Task not found" }, 404);

    broadcast({ type, payload: payload ?? toTaskBroadcastPayload(task) });
    log.debug({ taskId: id, type }, "Task WS broadcast triggered");
    return c.json({ success: true });
  },
);

// GET /tasks:
// - при наличии projectId: облегченный TaskListItem[];
// - без projectId: устаревший полный Task[] до миграции клиентов на /projects/overview.
tasksRouter.get("/", (c) => {
  const projectId = c.req.query("projectId") || undefined;
  const actionContext = requestActionContext(c);
  const ownershipFilters = parseTaskOwnershipFilters(c, actionContext);
  if (!ownershipFilters.ok) {
    return c.json({ error: ownershipFilters.error, code: "invalid_task_filter" }, 400);
  }

  // Устаревшая ветка без projectId сохранена до завершения миграции клиентов панели.
  if (!projectId) {
    const allTasks = listTasks(undefined, ownershipFilters.filters);
    const systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId("task");
    const effectiveRuntimeByTaskId = resolveEffectiveRuntimeProfilesForTasks(allTasks, {
      mode: "task",
      systemDefaultRuntimeProfileId,
    });
    log.debug({ count: allTasks.length, scope: "all" }, "Listed tasks (bare, legacy)");
    return c.json(
      allTasks.map((task) =>
        toTaskRouteResponse(
          task,
          systemDefaultRuntimeProfileId,
          effectiveRuntimeByTaskId.get(task.id),
          actionContext,
        ),
      ),
    );
  }

  // Быстрая валидация формата projectId до обращения к БД.
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    log.warn(
      { route: "GET /tasks", projectId },
      "Rejected task list request with invalid projectId",
    );
    return c.json({ error: "Invalid projectId format" }, 400);
  }

  const taskListRows = listTaskListItems(projectId, ownershipFilters.filters);
  const taskList = taskListRows.map((row) => toTaskListItem(row, row.assignees, actionContext));
  log.debug({ count: taskList.length, projectId, responseType: "TaskListItem" }, "Listed tasks");
  return c.json(taskList);
});

// Создание задачи: сначала авторизация и доменные инварианты,
// затем дорогие операции (БД/файловая система).
tasksRouter.post("/", jsonValidator(createTaskSchema), async (c) => {
  const body = c.req.valid("json");
  const actionContext = requestActionContext(c);
  const actor = actionContext.actor;
  // Участник с ролью member не назначает human-задачу на других при создании.
  if (
    actionContext.participantsModeEnabled &&
    actionContext.participantRole === "member" &&
    body.executionOwner === "human" &&
    (body.assigneeIds.length > 1 ||
      (body.assigneeIds.length === 1 && body.assigneeIds[0] !== actor.id))
  ) {
    return c.json(
      {
        error: "Members may create human tasks only unassigned or assigned to themselves",
        code: "forbidden",
      },
      403,
    );
  }
  // Задача, закреплённая за ИИ, не может содержать участников-исполнителей.
  if (body.executionOwner === "ai" && body.assigneeIds.length > 0) {
    return c.json(
      { error: "AI-owned tasks cannot have participant assignees", code: "invalid_ownership" },
      409,
    );
  }
  // Каждый assignee должен существовать и быть активным.
  for (const participantId of body.assigneeIds) {
    const participant = findParticipantById(participantId);
    if (!participant?.active) {
      return c.json(
        { error: "One or more assignees are inactive or missing", code: "inactive_assignee" },
        409,
      );
    }
  }
  // Runtime-профиль проверяется на принадлежность проекту перед созданием задачи.
  const runtimeValidation = validateProjectScopedRuntimeProfileSelections({
    projectId: body.projectId,
    selections: { runtimeProfileId: body.runtimeProfileId },
  });
  if (runtimeValidation) {
    log.warn(
      { projectId: body.projectId, fieldErrors: runtimeValidation.fieldErrors },
      "Rejected invalid task runtime selection",
    );
    return c.json(runtimeValidation, 400);
  }

  // Дефолтный planPath берётся из project config, иначе используется fallback.
  const project = findProjectById(body.projectId);
  const defaultPlanPath = project
    ? getProjectConfig(project.rootPath).paths.plan
    : ".ai-factory/PLAN.md";

  // Для parallel-enabled проекта принудительно используется plannerMode=full.
  if (project?.parallelEnabled) {
    body.plannerMode = "full";
  }

  // Пропущенные planner-флаги заполняются mode-default значениями.
  const modeDefaults = defaultsForMode(body.plannerMode);
  const resolvedSkipReview = body.skipReview ?? modeDefaults.skipReview;
  const resolvedPlanDocs = body.planDocs ?? modeDefaults.planDocs;
  const resolvedPlanTests = body.planTests ?? modeDefaults.planTests;
  // Флаги runPlanImprove/runPostVerify применяются только в skills-mode.
  const resolvedRunPlanImprove = body.useSubagents ? false : body.runPlanImprove;
  const resolvedRunPostVerify = body.useSubagents ? false : body.runPostVerify;
  if (
    body.skipReview === undefined ||
    body.planDocs === undefined ||
    body.planTests === undefined
  ) {
    log.debug(
      {
        plannerMode: body.plannerMode,
        filled: {
          skipReview: body.skipReview === undefined,
          planDocs: body.planDocs === undefined,
          planTests: body.planTests === undefined,
        },
      },
      "Applied mode-driven task flag defaults",
    );
  }

  // Двухфазная схема вложений: сначала create task, затем persist файлов,
  // затем update ссылок в задаче.
  const created = createTask({
    projectId: body.projectId,
    title: body.title,
    description: body.description,
    attachments: [],
    priority: body.priority,
    autoMode: body.autoMode,
    executionOwner: body.executionOwner,
    assigneeIds: body.assigneeIds,
    actor,
    isFix: body.isFix,
    plannerMode: body.plannerMode,
    planPath: body.planPath ?? defaultPlanPath,
    planDocs: resolvedPlanDocs,
    planTests: resolvedPlanTests,
    skipReview: resolvedSkipReview,
    useSubagents: body.useSubagents,
    runPlanImprove: resolvedRunPlanImprove,
    runPostVerify: resolvedRunPostVerify,
    autoQa: body.autoQa,
    maxReviewIterations: body.maxReviewIterations,
    paused: body.paused,
    runtimeProfileId: body.runtimeProfileId,
    modelOverride: body.modelOverride,
    runtimeOptions: body.runtimeOptions,
    roadmapAlias: body.roadmapAlias,
    tags: body.tags,
    scheduledAt: body.scheduledAt ?? null,
  });
  // null из createTask трактуется как нарушение ownership-инварианта (409).
  if (!created) {
    return c.json({ error: "Failed to create task ownership", code: "invalid_ownership" }, 409);
  }

  // Вложения сохраняются в файловом хранилище проекта и привязываются путями.
  if (body.attachments.length > 0) {
    if (project) {
      const persisted = await persistAttachments(body.attachments, {
        projectRoot: project.rootPath,
        taskId: created.id,
      });
      updateTask(created.id, { attachments: persisted });
    }
  }

  const final = findTaskById(created.id) ?? created;
  log.debug(
    {
      taskId: final.id,
      title: body.title,
      roadmapAlias: body.roadmapAlias,
      tagCount: body.tags?.length,
      attachmentCount: body.attachments.length,
    },
    "Task created",
  );

  // Рассылка выполняется после финального перечитывания строки,
  // чтобы WS и HTTP-ответ не расходились по составу данных.
  broadcast({
    type: "task:created",
    payload: toTaskBroadcastPayload(final, actor),
  });
  // Задача, закреплённая за ИИ, будит координатор для немедленной обработки.
  if (final.executionOwner === "ai") {
    broadcast({ type: "agent:wake", payload: { id: final.id } });
  }
  return c.json(toTaskRouteResponse(final, undefined, undefined, actionContext), 201);
});

// Передача исполнения атомарно меняет владельца и состав исполнителей.
// Для участника с ролью member разрешены только узкие сценарии самосервиса.
tasksRouter.post("/:id/handoff", jsonValidator(handoffTaskSchema), (c) => {
  const taskId = c.req.param("id");
  const body = c.req.valid("json");
  const task = findTaskById(taskId);
  if (!task) {
    return c.json({ error: "Task not found", code: "task_not_found" }, 404);
  }

  const actionContext = requestActionContext(c);
  const actorId = actionContext.actor.id;
  // Авторизация проверяется в маршруте; слой данных обеспечивает атомарность передачи.
  if (actionContext.participantsModeEnabled && actionContext.participantRole !== "admin") {
    const currentOwnership = getTaskOwnership(taskId);
    const assigned =
      actorId !== null &&
      Boolean(
        currentOwnership?.assignees.some(
          (assignee) => assignee.participantId === actorId && assignee.active,
        ),
      );
    // Self-assign допустим только для unassigned human-owned задачи.
    const selfAssign =
      task.executionOwner === "human" &&
      (currentOwnership?.assignees.length ?? 0) === 0 &&
      body.executionOwner === "human" &&
      body.assigneeIds.length === 1 &&
      body.assigneeIds[0] === actorId;
    const assignedHumanToAi =
      task.executionOwner === "human" &&
      assigned &&
      body.executionOwner === "ai" &&
      body.assigneeIds.length === 0;
    if (!selfAssign && !assignedHumanToAi) {
      log.warn(
        {
          taskId,
          actorId,
          currentOwner: task.executionOwner,
          requestedOwner: body.executionOwner,
        },
        "Rejected unauthorized task handoff",
      );
      return c.json(
        { error: "Participant is not allowed to hand off this task", code: "forbidden" },
        403,
      );
    }
  }

  // expected* поля реализуют CAS-предусловие handoff-операции.
  const result = handoffTaskExecution({
    taskId,
    executionOwner: body.executionOwner,
    assigneeIds: body.assigneeIds,
    expectedOwnershipRevision: body.expectedOwnershipRevision,
    expectedExecutionOwner: body.expectedExecutionOwner,
    expectedStatus: body.expectedStatus,
    actor: actionContext.actor,
    reason: body.reason,
    resumeAction: body.resumeAction,
  });
  // Ошибки handoff маппятся в стабильные code для клиентской логики.
  if (!result.ok) {
    const code = {
      not_found: "task_not_found",
      locked: "task_locked",
      revision_conflict: "ownership_revision_conflict",
      inactive_assignee: "inactive_assignee",
      invalid_transition: "invalid_ownership_transition",
    }[result.code] as
      | "task_not_found"
      | "task_locked"
      | "ownership_revision_conflict"
      | "inactive_assignee"
      | "invalid_ownership_transition";
    const status = result.code === "not_found" ? 404 : 409;
    log.warn(
      {
        taskId,
        code,
        actorId,
        requestedOwner: body.executionOwner,
      },
      "Task handoff rejected",
    );
    return c.json(
      {
        error: "Task ownership handoff could not be applied",
        code,
        ...(result.ownership ? { ownership: result.ownership } : {}),
      },
      status,
    );
  }

  // После handoff задача перечитывается для возврата актуальных вычисленных полей.
  const updated = findTaskById(taskId);
  if (!updated) {
    return c.json({ error: "Task not found after handoff", code: "task_not_found" }, 404);
  }
  const ownershipPayload = {
    taskId,
    projectId: updated.projectId,
    ownership: result.ownership,
    actor: actionContext.actor,
    responsibleParticipants: result.ownership.assignees,
  };
  // task:handoff и task:assignment_updated публикуются парой с одинаковым payload.
  broadcast({ type: "task:handoff", payload: ownershipPayload });
  broadcast({ type: "task:assignment_updated", payload: ownershipPayload });
  if (
    result.ownership.executionOwner === "ai" &&
    updated.status !== "done" &&
    updated.status !== "accepted"
  ) {
    broadcast({ type: "agent:wake", payload: { id: taskId } });
  }
  log.info(
    {
      taskId,
      actorId,
      executionOwner: result.ownership.executionOwner,
      ownershipRevision: result.ownership.ownershipRevision,
      assigneeCount: result.ownership.assignees.length,
    },
    "Task handoff completed",
  );
  return c.json({
    task: toTaskRouteResponse(updated, undefined, undefined, actionContext),
    ownership: result.ownership,
    history: result.history,
  });
});

// История исполнителей для аудита владения задачей.
tasksRouter.get("/:id/executor-history", (c) => {
  const taskId = c.req.param("id");
  if (!findTaskById(taskId)) {
    return c.json({ error: "Task not found", code: "task_not_found" }, 404);
  }
  return c.json(listTaskExecutorHistory(taskId));
});

// GET /tasks/:id возвращает нормализованный detail-response через toTaskRouteResponse.
tasksRouter.get("/:id", (c) => {
  const { id } = c.req.param();
  const task = findTaskById(id);
  if (!task) {
    log.debug({ taskId: id }, "Task not found");
    return c.json({ error: "Task not found" }, 404);
  }

  log.debug({ taskId: id }, "Task fetched");
  return c.json(toTaskRouteResponse(task, undefined, undefined, requestActionContext(c)));
});

// Скачивание вложения задачи по имени файла.
tasksRouter.get("/:id/attachments/:filename", async (c) => {
  const { id, filename } = c.req.param();
  const task = findTaskById(id);
  if (!task) return c.json({ error: "Task not found" }, 404);

  const project = findProjectById(task.projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  // Сравнение по decodeURIComponent(filename): в URL имя закодировано процентами.
  const attachments = parseAttachments(task.attachments);
  // Ошибка чтения вложения превращается в 404 (файл может отсутствовать на диске).
  const attachment = attachments.find((a) => a.name === decodeURIComponent(filename));
  if (!attachment?.path) return c.json({ error: "Attachment not found" }, 404);

  try {
    const buffer = await readAttachment(project.rootPath, attachment.path);
    c.header("Content-Type", attachment.mimeType || "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${attachment.name}"`);
    c.header("Content-Length", String(buffer.length));
    return new Response(new Uint8Array(buffer), { headers: c.res.headers });
  } catch {
    return c.json({ error: "Attachment file not found on disk" }, 404);
  }
});

// Проверка статуса физического plan-файла задачи.
tasksRouter.get("/:id/plan-file-status", (c) => {
  const { id } = c.req.param();
  const status = getTaskPlanFileStatus(id);
  if (!status) {
    return c.json({ error: "Task or project not found" }, 404);
  }

  return c.json(status);
});

// Список комментариев через toCommentResponse (серверная нормализация автора/вложений).
tasksRouter.get("/:id/comments", (c) => {
  const { id } = c.req.param();
  const task = findTaskById(id);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  // При несуществующей задаче возвращается 404, а не пустой список комментариев.
  const comments = listComments(id);
  return c.json(comments.map(toCommentResponse));
});

// Скачивание вложения комментария задачи.
tasksRouter.get("/:id/comments/:commentId/attachments/:filename", async (c) => {
  const { id, commentId, filename } = c.req.param();
  const task = findTaskById(id);
  if (!task) return c.json({ error: "Task not found" }, 404);

  const project = findProjectById(task.projectId);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const comments = listComments(id);
  const comment = comments.find((cm) => cm.id === commentId);
  if (!comment) return c.json({ error: "Comment not found" }, 404);

  const attachments = parseAttachments(comment.attachments);
  // Вложение ищется в пределах комментария текущей задачи.
  const attachment = attachments.find((a) => a.name === decodeURIComponent(filename));
  if (!attachment?.path) return c.json({ error: "Attachment not found" }, 404);

  try {
    const buffer = await readAttachment(project.rootPath, attachment.path);
    c.header("Content-Type", attachment.mimeType || "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${attachment.name}"`);
    c.header("Content-Length", String(buffer.length));
    return new Response(new Uint8Array(buffer), { headers: c.res.headers });
  } catch {
    return c.json({ error: "Attachment file not found on disk" }, 404);
  }
});

// Создание комментария: автор определяется по сессии, не по телу запроса.
tasksRouter.post("/:id/comments", jsonValidator(createTaskCommentSchema), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid("json");
  const actionContext = requestActionContext(c);
  const task = findTaskById(id);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  // Файлы кладутся в каталог с реальным commentId, поэтому порядок такой:
  // строка в БД, запись на диск, обновление строки. Сбой на диске оставит
  // комментарий без вложений, а не с битой ссылкой.
  // Сначала создаём комментарий, чтобы получить его id, назначенный БД
  const created = createComment({
    taskId: id,
    participantId: actionContext.actor.kind === "participant" ? actionContext.actor.id : null,
    message: body.message,
    attachments: [],
  });
  if (!created) return c.json({ error: "Failed to create comment" }, 500);

  // Сохраняем вложения в файлы проекта по настоящему id комментария, затем обновляем
  let finalComment = created;
  if (body.attachments.length > 0) {
    const project = findProjectById(task.projectId);
    if (project) {
      const persisted = await persistAttachments(body.attachments, {
        projectRoot: project.rootPath,
        taskId: id,
        commentId: created.id,
      });
      const updated = updateComment(created.id, { attachments: persisted });
      finalComment = updated ?? created;
    }
  }

  // Это же значение уходит в broadcast: HTTP-ответ и WS-событие обязаны
  // совпадать по форме, иначе карточка и модалка покажут разное.
  const response = toCommentResponse(finalComment);
  broadcast({
    type: "task:comment_created",
    payload: {
      taskId: id,
      projectId: task.projectId,
      comment: response,
      actor: actionContext.actor,
      responsibleParticipants: response.participant ? [response.participant] : [],
    },
  });
  log.info(
    {
      taskId: id,
      commentId: response.id,
      participantId: response.participantId,
      attachmentCount: response.attachments.length,
    },
    "Task comment created",
  );
  return c.json(response, 201);
});

// Обновление полей. Часть правил намеренно повторяет POST /tasks (заполнение
// флагов от plannerMode, запрет fast-режима в параллельных проектах): набор
// правил один, а точка входа может быть любой.
// PUT /tasks/:id — обновить поля
tasksRouter.put("/:id", jsonValidator(updateTaskSchema), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid("json");
  const existing = findTaskById(id);
  if (!existing) {
    return c.json({ error: "Task not found" }, 404);
  }
  if (!canMutateTask(c, id)) {
    return c.json({ error: "Task assignment or admin role required", code: "forbidden" }, 403);
  }

  // Профиль времени выполнения проверяется тем же сервисом, что и при создании:
  // правка не должна обходить проектные ограничения на выбор runtime.
  const runtimeValidation = validateProjectScopedRuntimeProfileSelections({
    projectId: existing.projectId,
    selections: { runtimeProfileId: body.runtimeProfileId },
  });
  if (runtimeValidation) {
    log.warn(
      { taskId: id, projectId: existing.projectId, fieldErrors: runtimeValidation.fieldErrors },
      "Rejected invalid task runtime selection",
    );
    return c.json(runtimeValidation, 400);
  }

  // Проекты с параллельным выполнением принудительно получают полный режим
  const project = findProjectById(existing.projectId);
  if (project?.parallelEnabled) {
    if (body.plannerMode === "fast") {
      return c.json({ error: "Parallel-enabled projects require full planner mode" }, 400);
    }
  }

  // plan и attachments вынимаются из payload отдельно: это не колонки таблицы,
  // а составные операции (файл плана на диске, файловая система вложений).
  const { plan, attachments: incomingAttachments, ...updatePayload } = body;
  const effectiveUseSubagents = updatePayload.useSubagents ?? existing.useSubagents;
  if (effectiveUseSubagents) {
    updatePayload.runPlanImprove = false;
    updatePayload.runPostVerify = false;
  }

  // Зеркало POST /tasks: при смене plannerMode недостающие флаги берутся из значений режима.
  if (updatePayload.plannerMode !== undefined) {
    const modeDefaults = defaultsForMode(updatePayload.plannerMode);
    const filled = {
      skipReview: updatePayload.skipReview === undefined,
      planDocs: updatePayload.planDocs === undefined,
      planTests: updatePayload.planTests === undefined,
    };
    updatePayload.skipReview = updatePayload.skipReview ?? modeDefaults.skipReview;
    updatePayload.planDocs = updatePayload.planDocs ?? modeDefaults.planDocs;
    updatePayload.planTests = updatePayload.planTests ?? modeDefaults.planTests;
    if (filled.skipReview || filled.planDocs || filled.planTests) {
      log.debug(
        { taskId: id, plannerMode: updatePayload.plannerMode, filled },
        "Applied mode-driven task flag defaults on update",
      );
    }
  }

  // hasOwnProperty, а не проверка на undefined: null - валидное значение,
  // означающее "очистить план", и его нельзя спутать с "поле не прислали".
  const hasPlanUpdate = Object.prototype.hasOwnProperty.call(body, "plan");
  if (hasPlanUpdate) {
    try {
      updateTaskPlan(id, plan ?? null, existing.isFix, existing.planPath);
    } catch {
      return c.json({ error: "Project not found for task" }, 404);
    }
  }

  // Сохраняем новые вложения в файлы проекта и убираем заменённые
  // undefined здесь значит "не трогать вложения", а пустой массив - "удалить все".
  // Освобождение диска от замененных файлов идет до записи новых, чтобы
  // перезапись одноименных вложений не удалила только что сохраненное.
  if (incomingAttachments !== undefined) {
    const project = findProjectById(existing.projectId);
    if (project) {
      const oldAttachments = parseAttachments(existing.attachments);
      cleanupReplacedAttachments(project.rootPath, oldAttachments, incomingAttachments);
      (updatePayload as Record<string, unknown>).attachments = await persistAttachments(
        incomingAttachments,
        { projectRoot: project.rootPath, taskId: id },
      );
    }
  }

  // Единственная запись в таблицу: составные части (план, вложения) уже
  // разложены выше, поэтому остаток payload - плоский набор колонок.
  const updated = updateTask(id, updatePayload);
  if (!updated) return c.json({ error: "Task not found after update" }, 500);
  log.debug({ taskId: id, fields: Object.keys(body) }, "Task updated");

  // Событие после ответа от репозитория: обновлять карточку нужно у всех
  // открытых окон, а не только у инициатора запроса.
  broadcast({ type: "task:updated", payload: toTaskBroadcastPayload(updated) });
  return c.json(toTaskRouteResponse(updated, undefined, undefined, requestActionContext(c)));
});

// Ручная синхронизация: файл плана - источник правды, а БД может отстать,
// если план правили в редакторе или агентом в обход API. Роут перечитывает файл.
// POST /tasks/:id/sync-plan — синхронизировать план в БД с физическим файлом плана
tasksRouter.post("/:id/sync-plan", (c) => {
  const { id } = c.req.param();
  const existing = findTaskById(id);
  if (!existing) {
    return c.json({ error: "Task or project not found" }, 404);
  }
  if (!canMutateTask(c, id)) {
    return c.json({ error: "Task assignment or admin role required", code: "forbidden" }, 403);
  }
  // Различаем "нет задачи или проекта" и "нет файла плана": клиенту важно
  // понять, надо ли создать план или чинить конфигурацию проекта.
  const result = syncTaskPlanFromFile(id);
  if (!result) {
    return c.json({ error: "Task or project not found" }, 404);
  }
  if (!result.synced) {
    return c.json({ error: "Plan file not found" }, 404);
  }

  // Синхронизация уже записала поля, поэтому payload пустой: нужна свежая
  // строка для ответа и WS-события, а не повторная запись тех же значений.
  const updated = updateTask(id, {});
  if (!updated) return c.json({ error: "Task not found after sync" }, 500);
  log.debug({ taskId: id }, "Task plan synced from physical file");

  // Здесь видят результат все окна, а не только тот, где нажали синхронизацию.
  broadcast({ type: "task:updated", payload: toTaskBroadcastPayload(updated) });
  return c.json(toTaskRouteResponse(updated, undefined, undefined, requestActionContext(c)));
});

// Удаление задачи. Порядок шагов критичен: сначала снимок git-идентичности,
// потом удаление строки, и только затем best-effort уборка worktree. После
// deleteTask восстановить branchName/worktreePath уже неоткуда.
// DELETE /tasks/:id
tasksRouter.delete("/:id", async (c) => {
  const { id } = c.req.param();
  const existing = findTaskById(id);
  if (!existing) {
    return c.json({ error: "Task not found" }, 404);
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
  deleteTask(id);
  log.debug({ taskId: id }, "Task deleted");

  // Событие уходит сразу после удаления строки, до уборки worktree: клиенты не
  // должны ждать медленную файловую операцию, чтобы убрать карточку с доски.
  broadcast({ type: "task:deleted", payload: { id } });

  // Уборка worktree best-effort: удаление уже состоялось, и недоступный агент
  // не должен превращать его в ошибку. Резервный вариант — сверочный проход.
  // Чистим worktree только когда он был заведен (обе записи непустые): у задач
  // без отдельного дерева чистить нечего, а пустой путь увел бы удаление в
  // корень проекта.
  if (worktreeSnapshot.worktreePath && worktreeSnapshot.projectRoot) {
    try {
      const cleanupResult = await callAgentWorktreeCleanup({
        ...worktreeSnapshot,
        reason: "task_delete",
      });
      if (!cleanupResult.ok) {
        log.warn(
          { taskId: id, code: cleanupResult.errorCode },
          "Worktree cleanup after delete did not complete",
        );
      }
    } catch (error) {
      log.warn(
        { taskId: id, err: error },
        "Worktree cleanup after delete threw; delete already succeeded",
      );
    }
  }

  return c.json({ success: true });
});

// Главная точка жизненного цикла: сюда приходят действия пользователя
// (start, approve, reject, move). Роут не меняет статус сам - он отдает событие
// общему автомату (@aif/shared stateMachine) через handleTaskEvent.
// Это единственный легальный путь смены статуса: прямая запись поля в обход
// автомата запрещена, иначе распадется вся цепочка стадий и очередей.
// POST /tasks/:id/events — применить действие человека через автомат состояний
tasksRouter.post("/:id/events", jsonValidator(taskEventSchema), async (c) => {
  const { id } = c.req.param();
  const { event, deletePlanFile, commitOnApprove } = c.req.valid("json");
  const actionContext = requestActionContext(c);
  const existing = findTaskById(id);
  if (!existing) {
    return c.json({ error: "Task not found" }, 404);
  }
  // Исключения из автомата превращаем в 500 с логом: наружу не должны
  // утекать детали реализации, но потерять след сбоя тоже нельзя.
  try {
    const handled = await handleTaskEvent({
      taskId: id,
      event,
      deletePlanFile,
      participantsModeEnabled: actionContext.participantsModeEnabled,
      actor: actionContext.actor,
      participantRole: actionContext.participantRole,
      participantActive: actionContext.participantActive,
    });
    if (!handled.ok) {
      return c.json(
        {
          error: handled.error,
          ...(handled.code ? { code: handled.code } : {}),
        },
        handled.status as ContentfulStatusCode,
      );
    }

    // Логируем именно переход (from -> to): по этим записям восстанавливают
    // историю, если WS-события были потеряны.
    log.debug(
      { taskId: id, from: existing.status, to: handled.task.status, event },
      "Task state transition applied",
    );
    broadcast({
      type: handled.broadcastType,
      payload: toTaskBroadcastPayload(handled.task),
    });
    // Разбудить координатор, когда переход задачи может потребовать обработки агентом
    // task:moved может вывести задачу на AI-стадию, поэтому координатор будится
    // здесь: иначе задача ждала бы следующего тика опроса очереди.
    if (handled.broadcastType === "task:moved") {
      broadcast({ type: "agent:wake", payload: { id: handled.task.id } });
    }

    // Fire-and-forget: запустить /aif-commit при утверждении с чекбоксом коммита.
    // Жизненный цикл рассылается по WS, чтобы UI показал спиннер/тост и модалка
    // подтверждения не закрылась без обратной связи.
    // Коммит запускается только по явному чекбоксу в модалке подтверждения:
    // само по себе approve_done не трогает git.
    if (event === "approve_done" && commitOnApprove) {
      const taskId = handled.task.id;
      const projectId = handled.task.projectId;
      log.info({ taskId, projectId }, "Approve-done commit flow started");
      broadcast({
        type: "task:commit_started",
        payload: { taskId, projectId, status: "started" },
      });
      void (async () => {
        const { runCommitQuery } = await import("../services/commitGeneration.js");
        // Сервис возвращает результат-объект, а не бросает, чтобы обе ветки
        // завершились терминальным WS-событием и спиннер в UI не завис.
        const result = await runCommitQuery({ projectId, taskId });
        if (result.ok) {
          log.info({ taskId, projectId }, "Approve-done commit flow succeeded");
          broadcast({
            type: "task:commit_done",
            payload: { taskId, projectId, status: "done" },
          });
        } else {
          log.error({ taskId, projectId, error: result.error }, "Approve-done commit flow failed");
          broadcast({
            type: "task:commit_failed",
            payload: { taskId, projectId, status: "failed", error: result.error },
          });
        }
      })();
    }

    // Fire-and-forget: запустить /aif-qa при утверждении, если у задачи включён autoQa.
    // approve_done переводит задачу done -> verified; QA идёт асинхронно после.
    // Под флагом AIF_QA_PIPELINE_ENABLED (по умолчанию выключен).
    // Флаг проверяется здесь, а не внутри startQaRun: нужно отличить в логах
    // "фича выключена" от "прогон уже идет".
    if (event === "approve_done" && handled.task.autoQa && !getEnv().AIF_QA_PIPELINE_ENABLED) {
      log.debug(
        { taskId: handled.task.id },
        "Auto QA skipped — AIF_QA_PIPELINE_ENABLED is disabled",
      );
    } else if (event === "approve_done" && handled.task.autoQa) {
      // Задачи без ветки (быстрый режим) допущены: раннер узнаёт ветку через
      // `git branch --show-current`, повторяя поведение скилла aif-qa.
      // Execution root: worktree задачи, если он есть, иначе корень проекта -
      // QA должен видеть тот же код, что и остальные стадии пайплайна.
      const { id: taskId, projectId, worktreePath } = handled.task;
      const project = findProjectById(projectId);
      if (!project) {
        log.error({ taskId, projectId }, "Auto QA skipped — project not found");
      } else {
        const executionRoot = worktreePath ?? project.rootPath;
        log.info({ taskId }, "Auto QA triggered (autoQa=true)");
        // Старт QA атомарен: при проигранной гонке (ручной запуск параллельно)
        // получаем started=false и просто пишем предупреждение.
        const { started } = startQaRun(projectId, taskId, executionRoot);
        if (!started) {
          log.warn({ taskId }, "Auto QA skipped — QA already running");
        }
      }
    }

    return c.json(toTaskRouteResponse(handled.task, undefined, undefined, actionContext));
  } catch (error) {
    log.error({ taskId: id, event, error }, "Task event handling failed");
    return c.json({ error: "Internal server error" }, 500);
  }
});

// Ручной запуск QA. Отвечает 202 сразу, потому что прогон длится минуты;
// результат приезжает по WS (task:qa_done / task:qa_failed).
// POST /tasks/:id/run-qa — вручную запустить конвейер aif-qa (fire-and-forget)
tasksRouter.post("/:id/run-qa", (c) => {
  const { id } = c.req.param();
  const task = findTaskById(id);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }
  // Ручной запуск - мутация: доступен админу или исполнителю задачи.
  if (!canMutateTask(c, id)) {
    return c.json({ error: "Task assignment or admin role required", code: "forbidden" }, 403);
  }
  // В отличие от авто-ветки, здесь выключенный пайплайн - явная ошибка
  // пользователя (403 feature_disabled), а не тихий пропуск в лог.
  if (!getEnv().AIF_QA_PIPELINE_ENABLED) {
    log.warn({ taskId: id }, "QA cannot run — AIF_QA_PIPELINE_ENABLED is disabled");
    return c.json({ error: "QA pipeline is disabled", code: "feature_disabled" }, 403);
  }
  const project = findProjectById(task.projectId);
  if (!project) {
    log.error({ taskId: id, projectId: task.projectId }, "QA cannot run — project not found");
    return c.json({ error: "Project not found" }, 404);
  }

  // Тот же выбор корня, что и в авто-ветке: QA прогоняется по коду worktree,
  // если задача изолирована в отдельном дереве.
  const executionRoot = task.worktreePath ?? project.rootPath;
  log.info({ taskId: id, branchName: task.branchName }, "run-qa requested for task");
  // Атомарный захват слота «выполняется»: второй параллельный POST проигрывает
  // compare-and-set и получает 409 вместо дублирующего запуска runtime.
  const startResult = startQaRun(task.projectId, id, executionRoot);
  const { started } = startResult;
  if (!started) {
    if (startResult.code === "ai_handoff_required") {
      log.warn({ taskId: id }, "QA rejected for human-owned task");
      return c.json(
        {
          error: "The task must be handed to AI before QA can run",
          code: "ai_handoff_required",
        },
        409,
      );
    }
    log.warn({ taskId: id }, "QA already running for task, skipping");
    return c.json(
      {
        error:
          startResult.code === "task_locked"
            ? "Task is locked by another runtime operation"
            : "QA already running",
        code: startResult.code,
      },
      409,
    );
  }

  return c.json({ status: "accepted" }, 202);
});

// Изменение позиции карточки в колонке. Порядок не влияет на жизненный цикл,
// поэтому роут не трогает статус и не участвует в правилах переходов.
// PATCH /tasks/:id/position — перестановка в пределах колонки
tasksRouter.patch("/:id/position", jsonValidator(reorderTaskSchema), async (c) => {
  const { id } = c.req.param();
  const { position } = c.req.valid("json");
  const existing = findTaskById(id);
  if (!existing) {
    return c.json({ error: "Task not found" }, 404);
  }
  if (!canMutateTask(c, id)) {
    return c.json({ error: "Task assignment or admin role required", code: "forbidden" }, 403);
  }

  updateTaskPositionOnly(id, position);
  const updated = findTaskById(id);
  if (!updated) return c.json({ error: "Task not found after reorder" }, 500);
  log.debug({ taskId: id, position }, "Task reordered");

  // Событие обязательно: без него карточка останется на старой позиции
  // у всех, кроме автора перетаскивания.
  broadcast({ type: "task:updated", payload: toTaskBroadcastPayload(updated) });
  return c.json(toTaskRouteResponse(updated, undefined, undefined, requestActionContext(c)));
});
