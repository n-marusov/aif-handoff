/**
 * Репозиторий задач: чтение, создание, обновление, пагинация, сессии, пульс,
 * выбор активного рантайма и сопутствующие операции над таблицей tasks.
 * Вынесен из единого модуля index.ts (clean-architecture сплит).
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  like,
  max,
  min,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  AUTO_REVIEW_FINDING_SOURCES,
  AUTO_REVIEW_STRATEGIES,
  TASK_STATUSES,
  auditEvents,
  generatePlanPath,
  getProjectConfig,
  isRuntimeTransport,
  logger as createLogger,
  normalizeRuntimeLimitSnapshot,
  participants,
  sanitizeRuntimeLimitSnapshotForExposure,
  taskAssignments,
  taskComments,
  taskExecutorHistory,
  tasks,
  type AuditActor,
  type AutoReviewState,
  type ExecutionOwner,
  type ProjectRow,
  type RuntimeLimitSnapshot,
  type TaskActiveRuntimeSelection,
  type TaskAssigneeSummary,
  type TaskCurrentTool,
  type TaskListItemRow,
  type TaskStatus,
  type TaskSummaryRow,
} from "@aif/shared";
import { getDb } from "./db.js";
import { persistTaskPlan } from "./taskPlan.js";
import {
  buildTaskOwnershipConditions,
  listTaskAssigneesByTaskIds,
  type TaskOwnershipFilters,
} from "./taskOwnership.js";
import { transitionTaskStatus as transitionTaskStatusAtomic } from "./taskTransitions.js";
import { createAuditEventValues } from "./audit.js";
import { findProjectById } from "./projects.js";
import {
  parseRuntimeLimitSnapshot,
  parseRuntimeObject,
  serializeRuntimeLimitSnapshot,
} from "./internal.js";

const log = createLogger("data");
// Множества-справочники нужны для проверки значений, пришедших из JSON-колонок.
// В SQLite такие колонки не типизированы, поэтому валидность приходится
// восстанавливать вручную при чтении, а не полагаться на схему таблицы.
const AUTO_REVIEW_STRATEGY_SET = new Set<string>(AUTO_REVIEW_STRATEGIES);
const AUTO_REVIEW_FINDING_SOURCE_SET = new Set<string>(AUTO_REVIEW_FINDING_SOURCES);

// Базовый тип строки задачи приватный для data-слоя: потребители не должны
// зависеть от внутренней формы строки БД. Наружу отдаются гидратированные
// проекции (HydratedTaskRow) и view-модели (@aif/shared presenters).
type TaskRow = typeof tasks.$inferSelect;

export type HydratedTaskRow = TaskRow & {
  assignees: TaskAssigneeSummary[];
  autoReviewState?: AutoReviewState | null;
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
};

export type TaskFieldsPatch = Partial<
  Omit<
    TaskRow,
    | "id"
    | "projectId"
    | "createdAt"
    | "status"
    | "executionOwner"
    | "ownershipRevision"
  >
> & {
  autoReviewState?: AutoReviewState | null;
};

export type TaskFieldsUpdate = {
  title?: string;
  description?: string;
  attachments?: unknown[];
  priority?: number;
  autoMode?: boolean;
  isFix?: boolean;
  plannerMode?: string;
  planPath?: string;
  planDocs?: boolean;
  planTests?: boolean;
  skipReview?: boolean;
  useSubagents?: boolean;
  runPlanImprove?: boolean;
  runPostVerify?: boolean;
  autoQa?: boolean;
  qaChangeSummary?: string | null;
  qaTestPlan?: string | null;
  qaTestCases?: string | null;
  qaStatus?: "idle" | "running" | "done" | "error";
  implementationLog?: string | null;
  reviewComments?: string | null;
  agentActivityLog?: string | null;
  blockedReason?: string | null;
  blockedFromStatus?: TaskStatus | null;
  retryAfter?: string | null;
  retryCount?: number;
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  costUsd?: number;
  roadmapAlias?: string | null;
  tags?: string[];
  reworkRequested?: boolean;
  reviewIterationCount?: number;
  maxReviewIterations?: number;
  manualReviewRequired?: boolean;
  autoReviewState?: AutoReviewState | null;
  paused?: boolean;
  lastHeartbeatAt?: string | null;
  runtimeProfileId?: string | null;
  modelOverride?: string | null;
  runtimeOptions?: Record<string, unknown> | null;
  position?: number;
  scheduledAt?: string | null;
  worktreePath?: string | null;
};

function parseTaskRuntimeLimitSnapshot(
  raw: string | null | undefined,
  taskId: string,
): RuntimeLimitSnapshot | null {
  const snapshot = parseRuntimeLimitSnapshot(raw, "task", taskId);
  return snapshot ? sanitizeRuntimeLimitSnapshotForExposure(snapshot, "task") : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseStringRecord(value: unknown): Record<string, string> | null {
  const record = asRecord(value);
  if (!record) return null;

  const result: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(record)) {
    if (typeof entryValue !== "string") {
      return null;
    }
    result[key] = entryValue;
  }
  return result;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | null | undefined {
  const raw = value[key];
  if (raw === null) return null;
  if (raw === undefined) return undefined;
  return typeof raw === "string" ? raw : undefined;
}

function parseTaskActiveRuntimeSelection(
  raw: string | null | undefined,
): TaskActiveRuntimeSelection | null {
  const parsed = parseRuntimeObject(raw);
  if (!parsed) return null;

  const status = parsed.status;
  const profileMode = parsed.profileMode;
  const source = parsed.source;
  const profileId = readOptionalString(parsed, "profileId");
  const runtimeId = parsed.runtimeId;
  const providerId = parsed.providerId;
  const transport = parsed.transport;
  const model = readOptionalString(parsed, "model");
  const baseUrl = readOptionalString(parsed, "baseUrl");
  const apiKeyEnvVar = readOptionalString(parsed, "apiKeyEnvVar");
  const headers = parseStringRecord(parsed.headers);
  const options = asRecord(parsed.options);
  const pinnedAt = parsed.pinnedAt;

  if (
    typeof status !== "string" ||
    (profileMode !== "task" && profileMode !== "plan" && profileMode !== "review") ||
    typeof source !== "string" ||
    profileId === undefined ||
    typeof runtimeId !== "string" ||
    typeof providerId !== "string" ||
    !isRuntimeTransport(transport) ||
    model === undefined ||
    baseUrl === undefined ||
    apiKeyEnvVar === undefined ||
    !headers ||
    !options ||
    typeof pinnedAt !== "string"
  ) {
    return null;
  }

  return {
    status: status as TaskStatus,
    profileMode,
    source,
    profileId,
    runtimeId,
    providerId,
    transport,
    model,
    baseUrl,
    apiKeyEnvVar,
    headers,
    options,
    pinnedAt,
  };
}

function parseAutoReviewState(raw: string | null | undefined): AutoReviewState | null {
  if (!raw) return null;

  const warnMalformed = (reason: string, extra: Record<string, unknown> = {}) => {
    log.warn({ reason, rawLength: raw.length, ...extra }, "Malformed persisted auto-review payload");
  };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnMalformed("root_not_object");
      return null;
    }

    const candidate = parsed as Record<string, unknown>;

    const strategy =
      typeof candidate.strategy === "string" &&
      AUTO_REVIEW_STRATEGY_SET.has(candidate.strategy)
        ? candidate.strategy
        : null;
    const iteration =
      typeof candidate.iteration === "number" &&
      Number.isFinite(candidate.iteration) &&
      Number.isInteger(candidate.iteration) &&
      candidate.iteration >= 0
        ? candidate.iteration
        : null;
    const findings = Array.isArray(candidate.findings) ? candidate.findings : null;

    if (!strategy || iteration == null || !findings) {
      warnMalformed("missing_required_fields", {
        hasStrategy: Boolean(strategy),
        hasIteration: iteration != null,
        hasFindings: Boolean(findings),
      });
      return null;
    }

    const normalizedFindings: AutoReviewState["findings"] = [];
    for (const item of findings) {
      if (!item || typeof item !== "object") {
        warnMalformed("invalid_finding_shape");
        return null;
      }

      const finding = item as Record<string, unknown>;
      if (
        typeof finding.id !== "string" ||
        typeof finding.text !== "string" ||
        typeof finding.source !== "string" ||
        !AUTO_REVIEW_FINDING_SOURCE_SET.has(finding.source)
      ) {
        warnMalformed("invalid_finding_fields", {
          findingId: finding.id,
          findingSource: finding.source,
        });
        return null;
      }

      normalizedFindings.push({
        id: finding.id,
        text: finding.text,
        source: finding.source as AutoReviewState["findings"][number]["source"],
      });
    }

    if (normalizedFindings.length !== findings.length) {
      warnMalformed("dropped_invalid_findings", {
        expectedCount: findings.length,
        actualCount: normalizedFindings.length,
      });
      return null;
    }

    return {
      strategy: strategy as AutoReviewState["strategy"],
      iteration,
      findings: normalizedFindings,
    };
  } catch (error) {
    warnMalformed("json_parse_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function hydrateTaskRows(rows: TaskRow[]): HydratedTaskRow[] {
  const assigneesByTaskId = listTaskAssigneesByTaskIds(rows.map((row) => row.id));
  return rows.map((row) => ({
    ...row,
    assignees: assigneesByTaskId.get(row.id) ?? [],
    autoReviewState: parseAutoReviewState(row.autoReviewStateJson),
    runtimeLimitSnapshot: parseTaskRuntimeLimitSnapshot(row.runtimeLimitSnapshotJson, row.id),
  }));
}

export function findTaskById(id: string): HydratedTaskRow | undefined {
  const row = getDb().select().from(tasks).where(eq(tasks.id, id)).get();
  if (!row) return undefined;
  return hydrateTaskRows([row])[0];
}

export function listTasks(
  projectId?: string,
  ownershipFilters: TaskOwnershipFilters = {},
): HydratedTaskRow[] {
  const db = getDb();
  // Фильтр по проекту опционален, поэтому undefined отбрасывается до сборки
  // условия: drizzle иначе добавил бы пустое условие в and().
  const conditions = [
    projectId ? eq(tasks.projectId, projectId) : undefined,
    ...buildTaskOwnershipConditions(ownershipFilters),
  ].filter((condition) => condition !== undefined);
  const rows = db
    .select()
    .from(tasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(tasks.status), asc(tasks.position))
    .all();
  return hydrateTaskRows(rows);
}

// TaskListItemRow импортируется из @aif/shared: единое определение проекции списка
// (известная проблема «Дублирование типов-проекций строк…»), data не переобъявляет Pick.

const TASK_LIST_COLUMNS = {
  id: tasks.id,
  projectId: tasks.projectId,
  title: tasks.title,
  description: tasks.description,
  status: tasks.status,
  priority: tasks.priority,
  position: tasks.position,
  autoMode: tasks.autoMode,
  executionOwner: tasks.executionOwner,
  ownershipRevision: tasks.ownershipRevision,
  skipReview: tasks.skipReview,
  runPostVerify: tasks.runPostVerify,
  isFix: tasks.isFix,
  paused: tasks.paused,
  roadmapAlias: tasks.roadmapAlias,
  tags: tasks.tags,
  runtimeProfileId: tasks.runtimeProfileId,
  modelOverride: tasks.modelOverride,
  blockedReason: tasks.blockedReason,
  blockedFromStatus: tasks.blockedFromStatus,
  retryAfter: tasks.retryAfter,
  retryCount: tasks.retryCount,
  reworkRequested: tasks.reworkRequested,
  reviewIterationCount: tasks.reviewIterationCount,
  maxReviewIterations: tasks.maxReviewIterations,
  manualReviewRequired: tasks.manualReviewRequired,
  runtimeLimitSnapshotJson: tasks.runtimeLimitSnapshotJson,
  runtimeLimitUpdatedAt: tasks.runtimeLimitUpdatedAt,
  tokenInput: tasks.tokenInput,
  tokenOutput: tasks.tokenOutput,
  tokenTotal: tasks.tokenTotal,
  costUsd: tasks.costUsd,
  lastSyncedAt: tasks.lastSyncedAt,
  lastHeartbeatAt: tasks.lastHeartbeatAt,
  lastActivityAt: tasks.lastActivityAt,
  currentToolJson: tasks.currentToolJson,
  scheduledAt: tasks.scheduledAt,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  hasPlan: sql<number>`case when length(trim(coalesce(${tasks.plan}, ''))) > 0 then 1 else 0 end`,
} as const;

export type ListTaskListItemRow = TaskListItemRow & {
  assignees: TaskAssigneeSummary[];
};

const TASK_STATUS_ORDER = new Map<TaskStatus, number>(
  TASK_STATUSES.map((status, index) => [status, index]),
);

function compareTaskListRows(a: TaskListItemRow, b: TaskListItemRow): number {
  const statusOrder =
    (TASK_STATUS_ORDER.get(a.status) ?? TASK_STATUSES.length) -
    (TASK_STATUS_ORDER.get(b.status) ?? TASK_STATUSES.length);
  if (statusOrder !== 0) return statusOrder;
  return a.position - b.position;
}

export function listTaskListItems(
  projectId: string,
  ownershipFilters: TaskOwnershipFilters = {},
): ListTaskListItemRow[] {
  const conditions = [
    eq(tasks.projectId, projectId),
    ...buildTaskOwnershipConditions(ownershipFilters),
  ];
  const rows = getDb()
    .select(TASK_LIST_COLUMNS)
    .from(tasks)
    .where(and(...conditions))
    // SQL сортирует только по позиции; порядок статусов задан порядком колонок
    // на доске и не выражается средствами ORDER BY, поэтому финальная сортировка
    // выполняется в памяти уже после выборки и объединения с исполнителями.
    .orderBy(asc(tasks.position))
    .all();
  const assigneesByTaskId = listTaskAssigneesByTaskIds(rows.map((row) => row.id));

  rows.sort(compareTaskListRows);
  log.debug({ projectId, count: rows.length, projection: "task-list" }, "Listed task list items");
  return rows.map((row) => ({
    ...row,
    assignees: assigneesByTaskId.get(row.id) ?? [],
  }));
}

export function getMinBacklogPosition(projectId: string): number | null {
  const row = getDb()
    .select({ minPos: min(tasks.position) })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, "backlog")))
    .get();
  return row?.minPos == null ? null : Number(row.minPos);
}

export function getMaxBacklogPosition(projectId: string): number | null {
  const row = getDb()
    .select({ maxPos: max(tasks.position) })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, "backlog")))
    .get();
  return row?.maxPos == null ? null : Number(row.maxPos);
}

// TaskSummaryRow определён в @aif/shared и реэкспортируется как result-shape data-слоя.
export type { TaskSummaryRow };

const SUMMARY_COLUMNS = {
  id: tasks.id,
  projectId: tasks.projectId,
  title: tasks.title,
  status: tasks.status,
  priority: tasks.priority,
  position: tasks.position,
  autoMode: tasks.autoMode,
  executionOwner: tasks.executionOwner,
  ownershipRevision: tasks.ownershipRevision,
  skipReview: tasks.skipReview,
  runPostVerify: tasks.runPostVerify,
  isFix: tasks.isFix,
  paused: tasks.paused,
  roadmapAlias: tasks.roadmapAlias,
  tags: tasks.tags,
  runtimeProfileId: tasks.runtimeProfileId,
  modelOverride: tasks.modelOverride,
  blockedReason: tasks.blockedReason,
  blockedFromStatus: tasks.blockedFromStatus,
  retryAfter: tasks.retryAfter,
  retryCount: tasks.retryCount,
  reworkRequested: tasks.reworkRequested,
  reviewIterationCount: tasks.reviewIterationCount,
  maxReviewIterations: tasks.maxReviewIterations,
  manualReviewRequired: tasks.manualReviewRequired,
  runtimeLimitSnapshotJson: tasks.runtimeLimitSnapshotJson,
  runtimeLimitUpdatedAt: tasks.runtimeLimitUpdatedAt,
  tokenTotal: tasks.tokenTotal,
  costUsd: tasks.costUsd,
  lastSyncedAt: tasks.lastSyncedAt,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
} as const;

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export function listTasksPaginated(options: {
  projectId?: string;
  status?: string;
  limit?: number;
  offset?: number;
} & TaskOwnershipFilters): PaginatedResult<TaskSummaryRow> {
  const db = getDb();
  const lim = Math.min(options.limit ?? 20, 100);
  const off = options.offset ?? 0;

  const conditions = [];
  if (options.projectId) conditions.push(eq(tasks.projectId, options.projectId));
  if (options.status) conditions.push(eq(tasks.status, options.status as any));
  conditions.push(...buildTaskOwnershipConditions(options));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const total = db
    .select({ count: count() })
    .from(tasks)
    .where(where)
    .get()?.count ?? 0;

  const items = db
    .select(SUMMARY_COLUMNS)
    .from(tasks)
    .where(where)
    .orderBy(asc(tasks.status), asc(tasks.position))
    .limit(lim)
    .offset(off)
    .all();
  const assigneesByTaskId = listTaskAssigneesByTaskIds(items.map((row) => row.id));

  return {
    items: items.map((row) => ({
      ...row,
      assignees: assigneesByTaskId.get(row.id) ?? [],
    })),
    total,
    limit: lim,
    offset: off,
  };
}

export function searchTasksPaginated(options: {
  query: string;
  projectId?: string;
  limit?: number;
  offset?: number;
} & TaskOwnershipFilters): PaginatedResult<TaskSummaryRow> {
  const db = getDb();
  const lim = Math.min(options.limit ?? 20, 50);
  const off = options.offset ?? 0;
  const pattern = `%${options.query}%`;

  const conditions = [
    or(like(tasks.title, pattern), like(tasks.description, pattern)),
  ];
  if (options.projectId) conditions.push(eq(tasks.projectId, options.projectId));
  conditions.push(...buildTaskOwnershipConditions(options));

  const where = and(...conditions);

  const total = db
    .select({ count: count() })
    .from(tasks)
    .where(where)
    .get()?.count ?? 0;

  const items = db
    .select(SUMMARY_COLUMNS)
    .from(tasks)
    .where(where)
    .orderBy(desc(tasks.updatedAt))
    .limit(lim)
    .offset(off)
    .all();
  const assigneesByTaskId = listTaskAssigneesByTaskIds(items.map((row) => row.id));

  return {
    items: items.map((row) => ({
      ...row,
      assignees: assigneesByTaskId.get(row.id) ?? [],
    })),
    total,
    limit: lim,
    offset: off,
  };
}

export function createTask(input: {
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
  plannerMode?: string;
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
  position?: number;
}): HydratedTaskRow | undefined {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const executionOwner = input.executionOwner ?? "ai";
  const assigneeIds = [...new Set(input.assigneeIds ?? [])];
  const actor = input.actor ?? {
    kind: "system",
    id: null,
    displayNameSnapshot: "System",
  };

  // Для полного режима путь к плану вычисляется автоматически, если он не задан явно:
  // в этом режиме у каждой задачи отдельный файл плана.
  let resolvedPlanPath = input.planPath;
  if (input.plannerMode === "full") {
    const project = findProjectById(input.projectId);
    const projectRoot = project?.rootPath ?? process.cwd();
    const cfg = getProjectConfig(projectRoot);
    const defaultPlanPath = cfg.paths.plan;

    if (resolvedPlanPath === undefined || resolvedPlanPath === defaultPlanPath) {
      resolvedPlanPath = generatePlanPath(input.title, "full", {
        plansDir: cfg.paths.plans,
        defaultPlanPath,
      });
      log.debug("Auto-generated plan path for full mode: %s", resolvedPlanPath);
    }
  }

  const assignees =
    assigneeIds.length === 0
      ? []
      : db
          .select({
            participantId: participants.id,
            displayName: participants.displayName,
            role: participants.role,
            active: participants.active,
          })
          .from(participants)
          .where(inArray(participants.id, assigneeIds))
          .orderBy(asc(participants.displayName), asc(participants.id))
          .all();
  // Инвариант владения: задачу в AI-исполнении нельзя одновременно назначить
  // участникам, а исполнители должны существовать и быть активными. Здесь это
  // проверяется до открытия транзакции, потому что отказ не должен оставлять
  // после себя ни задачи, ни записей в истории.
  const hasInvalidAssignees =
    assignees.length !== assigneeIds.length ||
    assignees.some((participant) => !participant.active);
  if (
    hasInvalidAssignees ||
    (executionOwner === "ai" && assigneeIds.length > 0)
  ) {
    log.warn(
      {
        projectId: input.projectId,
        executionOwner,
        requestedAssigneeCount: assigneeIds.length,
        activeAssigneeCount: assignees.filter((participant) => participant.active).length,
      },
      "Rejected task creation ownership",
    );
    return undefined;
  }
  // Позиция в бэклоге задаётся с шагом 100 — это оставляет место для вставки
  // карточки между соседями без пересчёта всего списка. Отсутствие максимума
  // трактуется как пустой бэклог, поэтому отсчёт начинается с 1000.
  const position =
    input.position ??
    (() => {
      const maxPosition = getMaxBacklogPosition(input.projectId);
      return (maxPosition ?? 1000) + 100;
    })();

  // Четыре вставки ниже образуют одно неделимое действие: сама задача, её
  // исполнители, запись в истории исполнителей и событие аудита. Без транзакции
  // сбой на любом из шагов оставил бы задачу без истории или без аудита.
  db.transaction((tx) => {
    tx.insert(tasks)
      .values({
      id,
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      attachments: JSON.stringify(input.attachments ?? []),
      priority: input.priority,
      autoMode: input.autoMode,
      executionOwner,
      ownershipRevision: 0,
      isFix: input.isFix,
      plannerMode: input.plannerMode,
      planPath: resolvedPlanPath,
      planDocs: input.planDocs,
      planTests: input.planTests,
      skipReview: input.skipReview,
      useSubagents: input.useSubagents,
      runPlanImprove: input.runPlanImprove,
      runPostVerify: input.runPostVerify,
      autoQa: input.autoQa,
      maxReviewIterations: input.maxReviewIterations,
      paused: input.paused,
      runtimeProfileId: input.runtimeProfileId ?? null,
      modelOverride: input.modelOverride ?? null,
      runtimeOptionsJson:
        input.runtimeOptions === undefined ? null : JSON.stringify(input.runtimeOptions),
      roadmapAlias: input.roadmapAlias ?? null,
      tags: JSON.stringify(input.tags ?? []),
      scheduledAt: input.scheduledAt ?? null,
      reworkRequested: false,
      manualReviewRequired: false,
      status: "backlog",
      position,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
    if (executionOwner === "human" && assignees.length > 0) {
      tx.insert(taskAssignments)
        .values(
          assignees.map((assignee) => ({
            taskId: id,
            participantId: assignee.participantId,
            assignedByKind: actor.kind,
            assignedById: actor.id,
            assignedByDisplayNameSnapshot: actor.displayNameSnapshot,
            createdAt: now,
          })),
        )
        .run();
    }
    // Историческая запись хранит снимки title, статуса и состава исполнителей,
    // а не ссылки на текущие значения: история исполнительства должна читаться
    // корректно даже после переименования задачи или деактивации участника.
    tx.insert(taskExecutorHistory)
      .values({
        id: crypto.randomUUID(),
        taskId: id,
        taskTitleSnapshot: input.title,
        ownershipRevision: 0,
        executionOwner,
        assigneesSnapshotJson: JSON.stringify(executionOwner === "human" ? assignees : []),
        statusSnapshot: "backlog",
        actorKind: actor.kind,
        actorId: actor.id,
        actorDisplayNameSnapshot: actor.displayNameSnapshot,
        reason: "task_created",
        createdAt: now,
      })
      .run();
    tx.insert(auditEvents)
      .values(
        createAuditEventValues({
          action: "task.created",
          entityType: "task",
          entityId: id,
          taskId: id,
          taskTitleSnapshot: input.title,
          executionOwnerSnapshot: executionOwner,
          assigneesSnapshot: executionOwner === "human" ? assignees : [],
          statusSnapshot: "backlog",
          actor,
          metadata: { ownershipRevision: 0 },
          createdAt: now,
        }),
      )
      .run();
  });

  return findTaskById(id);
}

export function updateTask(id: string, fields: TaskFieldsUpdate): TaskRow | undefined {
  // Поля владения вырезаются из патча намеренно: они меняются только через
  // специализированные операции (handoff, transition), где контролируются
  // ожидаемая ревизия и права актора.
  const {
    attachments,
    tags,
    runtimeOptions,
    autoReviewState,
    executionOwner: _executionOwner,
    ownershipRevision: _ownershipRevision,
    assigneeIds: _assigneeIds,
    ...rest
  } = fields as TaskFieldsUpdate & {
    executionOwner?: unknown;
    ownershipRevision?: unknown;
    assigneeIds?: unknown;
  };
  const patch: TaskFieldsPatch = { ...rest, updatedAt: new Date().toISOString() };
  // JSON-колонки сериализуются здесь, на границе слоя данных: вызывающий код
  // работает с доменными типами (массив вложений, список тегов), а не со строками.
  if (attachments !== undefined) {
    patch.attachments = JSON.stringify(attachments);
  }
  if (tags !== undefined) {
    patch.tags = JSON.stringify(tags);
  }
  if (runtimeOptions !== undefined) {
    patch.runtimeOptionsJson = runtimeOptions === null ? null : JSON.stringify(runtimeOptions);
  }
  if (autoReviewState !== undefined) {
    patch.autoReviewStateJson =
      autoReviewState === null ? null : JSON.stringify(autoReviewState);
  }
  if (fields.runtimeProfileId !== undefined || fields.modelOverride !== undefined) {
    log.debug(
      {
        taskId: id,
        runtimeProfileId: fields.runtimeProfileId ?? null,
        modelOverride: fields.modelOverride ?? null,
      },
      "Updated task runtime metadata",
    );
  }
  getDb().update(tasks).set(patch).where(eq(tasks.id, id)).run();
  return findTaskById(id);
}

export function tryStartQaRun(id: string): boolean {
  const result = getDb()
    .update(tasks)
    .set({ qaStatus: "running", updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.executionOwner, "ai"),
        ne(tasks.qaStatus, "running"),
      ),
    )
    .run();
  return result.changes > 0;
}

export function resetStaleQaRuns(): number {
  const result = getDb()
    .update(tasks)
    .set({ qaStatus: "error", updatedAt: new Date().toISOString() })
    .where(eq(tasks.qaStatus, "running"))
    .run();
  return result.changes;
}

export function updateTaskPositionOnly(id: string, position: number): void {
  getDb().update(tasks).set({ position }).where(eq(tasks.id, id)).run();
}

export function setTaskFields(id: string, fields: TaskFieldsPatch): void {
  const {
    autoReviewState,
    // Статус и владение отбрасываются: их смена должна идти через переходы
    // состояния и handoff, иначе будут нарушены инварианты жизненного цикла.
    status: _status,
    executionOwner: _executionOwner,
    ownershipRevision: _ownershipRevision,
    ...rest
  } = fields as TaskFieldsPatch & {
    status?: unknown;
    executionOwner?: unknown;
    ownershipRevision?: unknown;
  };
  const patch: Partial<TaskRow> & { autoReviewStateJson?: string | null } = { ...rest };
  if (autoReviewState !== undefined) {
    patch.autoReviewStateJson =
      autoReviewState === null ? null : JSON.stringify(autoReviewState);
  }
  // Пустой патч не отправляется в БД: это защищает updatedAt и ревизии от
  // бессмысленного "обновления", которое могло бы сбить оптимистичные проверки.
  if (Object.keys(patch).length === 0) {
    log.warn({ taskId: id }, "Ignored task field update with no mutable fields");
    return;
  }
  getDb().update(tasks).set(patch).where(eq(tasks.id, id)).run();
}

export function persistTaskRuntimeLimitSnapshot(
  taskId: string,
  snapshot: RuntimeLimitSnapshot,
  persistedAt = new Date().toISOString(),
): TaskRow | undefined {
  const normalizedSnapshot = normalizeRuntimeLimitSnapshot(snapshot);
  log.info(
    {
      taskId,
      status: normalizedSnapshot.status,
      source: normalizedSnapshot.source,
      precision: normalizedSnapshot.precision,
      resetAt: normalizedSnapshot.resetAt ?? null,
      persistedAt,
    },
    "Persisting task runtime limit snapshot",
  );
  getDb()
    .update(tasks)
    .set({
      runtimeLimitSnapshotJson: serializeRuntimeLimitSnapshot(normalizedSnapshot),
      runtimeLimitUpdatedAt: persistedAt,
    })
    .where(eq(tasks.id, taskId))
    .run();
  return findTaskById(taskId);
}

export function clearTaskRuntimeLimitSnapshot(
  taskId: string,
  persistedAt = new Date().toISOString(),
): TaskRow | undefined {
  log.debug({ taskId, persistedAt }, "Clearing task runtime limit snapshot");
  getDb()
    .update(tasks)
    .set({
      runtimeLimitSnapshotJson: null,
      runtimeLimitUpdatedAt: persistedAt,
    })
    .where(eq(tasks.id, taskId))
    .run();
  return findTaskById(taskId);
}

export function deleteTask(id: string): void {
  const db = getDb();
  db.delete(tasks).where(eq(tasks.id, id)).run();
  db.delete(taskComments).where(eq(taskComments.taskId, id)).run();
}

export function findProjectByTaskId(taskId: string): ProjectRow | undefined {
  const task = findTaskById(taskId);
  if (!task) return undefined;
  return findProjectById(task.projectId);
}

export function persistTaskPlanForTask(input: {
  taskId: string;
  planText: string | null;
  updatedAt?: string;
  projectRoot?: string;
  isFix?: boolean;
  planPath?: string;
}): { updatedAt: string } {
  return persistTaskPlan({
    db: getDb(),
    taskId: input.taskId,
    planText: input.planText,
    updatedAt: input.updatedAt,
    projectRoot: input.projectRoot,
    isFix: input.isFix,
    planPath: input.planPath,
  });
}

export function appendTaskActivityLog(taskId: string, newLines: string): void {
  const task = findTaskById(taskId);
  const currentLog = task?.agentActivityLog ?? "";
  const updatedLog = currentLog ? `${currentLog}\n${newLines}` : newLines;
  const nowIso = new Date().toISOString();

  setTaskFields(taskId, {
    agentActivityLog: updatedLog,
    lastHeartbeatAt: nowIso,
    lastActivityAt: nowIso,
    updatedAt: nowIso,
  });
}

export function setTaskInFlightTool(taskId: string, tool: TaskCurrentTool | null): void {
  const nowIso = new Date().toISOString();
  if (tool) {
    setTaskFields(taskId, {
      currentToolJson: JSON.stringify(tool),
      lastActivityAt: nowIso,
      updatedAt: nowIso,
    });
  } else {
    setTaskFields(taskId, {
      currentToolJson: null,
      updatedAt: nowIso,
    });
  }
}

export function updateTaskHeartbeat(taskId: string): string {
  const nowIso = new Date().toISOString();
  setTaskFields(taskId, { lastHeartbeatAt: nowIso, updatedAt: nowIso });
  return nowIso;
}

export function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  extra: Omit<TaskFieldsPatch, "status" | "lastHeartbeatAt" | "updatedAt"> = {},
  actor: AuditActor = {
    kind: "system",
    id: null,
    displayNameSnapshot: "System",
  },
): void {
  const result = transitionTaskStatusAtomic({
    taskId,
    status,
    extra,
    actor,
  });
  if (!result.ok && result.code !== "not_found") {
    log.warn(
      {
        taskId,
        status,
        code: result.code,
        currentStatus: result.currentStatus ?? null,
        actorKind: actor.kind,
        actorId: actor.id,
      },
      "Task status update rejected",
    );
  }
}

export function saveTaskSessionId(taskId: string, sessionId: string): void {
  setTaskFields(taskId, { sessionId });
}

export function getTaskSessionId(taskId: string): string | null {
  const task = findTaskById(taskId);
  return task?.sessionId ?? null;
}

export function saveTaskActiveRuntimeSelection(
  taskId: string,
  selection: TaskActiveRuntimeSelection,
): void {
  setTaskFields(taskId, {
    activeRuntimeStatus: selection.status,
    activeRuntimeSelectionJson: JSON.stringify(selection),
  });
}

export function getTaskActiveRuntimeSelection(
  taskId: string,
): TaskActiveRuntimeSelection | null {
  const task = findTaskById(taskId);
  if (!task?.activeRuntimeSelectionJson) return null;

  const selection = parseTaskActiveRuntimeSelection(task.activeRuntimeSelectionJson);
  if (!selection) {
    log.warn({ taskId }, "Ignoring malformed task active runtime selection");
    return null;
  }

  if (task.activeRuntimeStatus && task.activeRuntimeStatus !== selection.status) {
    log.warn(
      { taskId, activeRuntimeStatus: task.activeRuntimeStatus, selectionStatus: selection.status },
      "Ignoring mismatched task active runtime selection",
    );
    return null;
  }

  return selection;
}

export function clearTaskActiveRuntimeSelection(taskId: string): void {
  setTaskFields(taskId, {
    activeRuntimeStatus: null,
    activeRuntimeSelectionJson: null,
  });
}

export function searchTasks(
  query: string,
  projectId?: string,
  ownershipFilters: TaskOwnershipFilters = {},
): HydratedTaskRow[] {
  const db = getDb();
  const pattern = `%${query}%`;
  const conditions = [
    or(
      like(tasks.title, pattern),
      like(tasks.description, pattern),
    ),
  ];
  if (projectId) {
    conditions.push(eq(tasks.projectId, projectId));
  }
  conditions.push(...buildTaskOwnershipConditions(ownershipFilters));
  const rows = db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.updatedAt))
    .limit(50)
    .all();
  return hydrateTaskRows(rows);
}

export function touchLastSyncedAt(taskId: string): void {
  const nowIso = new Date().toISOString();
  setTaskFields(taskId, { lastSyncedAt: nowIso });
}

export function findTasksByRoadmapAlias(projectId: string, alias: string): TaskRow[] {
  return getDb()
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.roadmapAlias, alias)))
    .all();
}

export function updateTaskRuntimeOverride(
  taskId: string,
  input: {
    runtimeProfileId?: string | null;
    modelOverride?: string | null;
    runtimeOptions?: Record<string, unknown> | null;
  },
): TaskRow | undefined {
  const patch: Partial<TaskRow> = {
    updatedAt: new Date().toISOString(),
  };

  if (input.runtimeProfileId !== undefined) patch.runtimeProfileId = input.runtimeProfileId;
  if (input.modelOverride !== undefined) patch.modelOverride = input.modelOverride;
  if (input.runtimeOptions !== undefined) {
    patch.runtimeOptionsJson =
      input.runtimeOptions === null ? null : JSON.stringify(input.runtimeOptions);
  }

  log.debug(
    {
      taskId,
      runtimeProfileId: input.runtimeProfileId ?? null,
      modelOverride: input.modelOverride ?? null,
      hasRuntimeOptions: input.runtimeOptions !== undefined,
    },
    "Updating task runtime override",
  );
  getDb().update(tasks).set(patch).where(eq(tasks.id, taskId)).run();
  return findTaskById(taskId);
}
