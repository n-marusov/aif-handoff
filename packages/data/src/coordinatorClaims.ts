/**
 * Координаторские захваты: кандидаты, CAS-переходы, автоочередь, scheduled,
 * worktree/VCS-сверка.
 */
import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  min,
  ne,
  notLike,
  or,
  sql,
} from "drizzle-orm";
import {
  auditEvents,
  githubIssues,
  gitlabIssues,
  logger as createLogger,
  normalizeRuntimeLimitSnapshot,
  projects,
  tasks,
  type AutoQueueCommitStatus,
  type RuntimeLimitSnapshot,
  type TaskStatus,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { createAuditEventValues } from "./audit.js";
import { serializeRuntimeLimitSnapshot } from "./internal.js";
import type { ProjectRow, TaskRow } from "@aif/shared";

const log = createLogger("data");

export type CoordinatorStage =
  | "planner"
  | "improver"
  | "plan-checker"
  | "plan-publisher"
  | "implementer"
  | "reviewer"
  | "verifier"
  | "done-checker";

export interface CoordinatorTaskClaimInput {
  taskId: string;
  expectedProjectId: string;
  expectedStatus: TaskStatus;
  expectedAutoMode?: boolean;
  coordinatorId: string;
  lockDurationMs: number;
}

export function findCoordinatorTaskCandidate(stage: CoordinatorStage): TaskRow | undefined {
  return findCoordinatorTaskCandidates(stage, 1)[0];
}

function coordinatorStageFilter(stage: CoordinatorStage) {
  return stage === "implementer"
    ? or(
        eq(tasks.status, "implementing"),
        and(eq(tasks.status, "plan_review"), eq(tasks.autoMode, true)),
      )
    : stage === "improver"
      ? inArray(tasks.status, ["improve"])
      : stage === "plan-checker" || stage === "plan-publisher"
        ? inArray(tasks.status, ["plan_review"])
        : stage === "planner"
          ? inArray(tasks.status, ["planning"])
          : stage === "verifier"
            ? inArray(tasks.status, ["verify"])
            : stage === "done-checker"
              ? inArray(tasks.status, ["done"])
              : inArray(tasks.status, ["review"]);
}

function coordinatorAnyStageFilter() {
  return or(
    inArray(tasks.status, ["planning", "improve", "implementing", "verify", "review"]),
    and(eq(tasks.status, "plan_review"), eq(tasks.autoMode, true)),
  );
}

function unlockedCoordinatorTaskFilter(nowIso: string) {
  return and(
    eq(tasks.paused, false),
    or(sql`${tasks.lockedBy} IS NULL`, lte(tasks.lockedUntil, nowIso)),
  );
}

export function findCoordinatorTaskCandidates(stage: CoordinatorStage, limit: number): TaskRow[] {
  const nowIso = new Date().toISOString();

  return getDb()
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.executionOwner, "ai"),
        coordinatorStageFilter(stage),
        unlockedCoordinatorTaskFilter(nowIso),
      ),
    )
    .orderBy(asc(tasks.position), asc(tasks.createdAt))
    .limit(limit)
    .all();
}

export function findCoordinatorTaskCandidatesForProject(
  projectId: string,
  stage: CoordinatorStage,
  limit: number,
): TaskRow[] {
  const nowIso = new Date().toISOString();

  return getDb()
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.executionOwner, "ai"),
        coordinatorStageFilter(stage),
        unlockedCoordinatorTaskFilter(nowIso),
      ),
    )
    .orderBy(asc(tasks.position), asc(tasks.createdAt))
    .limit(limit)
    .all();
}

export function listCoordinatorActionableProjectIds(limit: number): string[] {
  const nowIso = new Date().toISOString();

  return getDb()
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(
      and(
        eq(tasks.executionOwner, "ai"),
        coordinatorAnyStageFilter(),
        unlockedCoordinatorTaskFilter(nowIso),
      ),
    )
    .groupBy(tasks.projectId)
    .orderBy(min(tasks.createdAt), asc(tasks.projectId))
    .limit(limit)
    .all()
    .map((row) => row.projectId);
}

export function claimTask(taskId: string, coordinatorId: string, lockDurationMs: number): boolean {
  const nowIso = new Date().toISOString();
  const lockedUntil = new Date(Date.now() + lockDurationMs).toISOString();

  // Захват выполняется одним UPDATE с условием на текущее состояние блокировки.
  // Сравнение дат идёт как сравнение строк: ISO-8601 в UTC сортируется
  // лексикографически так же, как хронологически, поэтому отдельная функция
  // преобразования не нужна. Просроченная блокировка (lockedUntil <= now)
  // считается свободной — так восстанавливаются задачи после падения ноды.
  const result = getDb()
    .update(tasks)
    .set({ lockedBy: coordinatorId, lockedUntil })
    .where(and(
      eq(tasks.id, taskId),
      eq(tasks.executionOwner, "ai"),
      or(
        sql`${tasks.lockedBy} IS NULL`,
        lte(tasks.lockedUntil, nowIso),
      ),
    ))
    .run();

  return result.changes > 0;
}

export function claimCoordinatorTaskIfEligible(
  input: CoordinatorTaskClaimInput,
): TaskRow | undefined {
  const nowIso = new Date().toISOString();
  const lockedUntil = new Date(Date.now() + input.lockDurationMs).toISOString();
  // Проверка ожидаемого статуса закрывает разрыв между выбором кандидата и
  // захватом: пока координатор шёл до записи, задачу мог продвинуть другой
  // процесс. Несовпадение ожиданий означает "кандидат устарел" — захват не состоялся.
  const conditions = [
    eq(tasks.id, input.taskId),
    eq(tasks.projectId, input.expectedProjectId),
    eq(tasks.status, input.expectedStatus),
    eq(tasks.executionOwner, "ai"),
    eq(tasks.paused, false),
    or(sql`${tasks.lockedBy} IS NULL`, lte(tasks.lockedUntil, nowIso)),
  ];
  if (input.expectedAutoMode != null) {
    conditions.push(eq(tasks.autoMode, input.expectedAutoMode));
  }

  return getDb()
    .update(tasks)
    .set({ lockedBy: input.coordinatorId, lockedUntil })
    .where(and(...conditions))
    .returning()
    .get();
}

export function blockTaskForRuntimeGateIfEligible(input: {
  taskId: string;
  expectedProjectId?: string | null;
  expectedStatus: TaskStatus;
  expectedAutoMode?: boolean;
  blockedFromStatus: TaskStatus;
  blockedReason: string;
  retryAfter: string | null;
  retryCount: number;
  snapshot: RuntimeLimitSnapshot | null;
  persistedAt?: string;
}): boolean {
  const nowIso = input.persistedAt ?? new Date().toISOString();
  const normalizedSnapshot = input.snapshot ? normalizeRuntimeLimitSnapshot(input.snapshot) : null;
  const conditions = [
    eq(tasks.id, input.taskId),
    eq(tasks.status, input.expectedStatus),
    eq(tasks.executionOwner, "ai"),
    eq(tasks.paused, false),
    or(sql`${tasks.lockedBy} IS NULL`, lte(tasks.lockedUntil, nowIso)),
  ];
  if (input.expectedProjectId != null) {
    conditions.push(eq(tasks.projectId, input.expectedProjectId));
  }
  if (input.expectedAutoMode != null) {
    conditions.push(eq(tasks.autoMode, input.expectedAutoMode));
  }

  return getDb().transaction((tx) => {
    const task = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
    if (!task) return false;
    const updated = tx
      .update(tasks)
      .set({
        status: "blocked_external",
        blockedFromStatus: input.blockedFromStatus,
        blockedReason: input.blockedReason,
        retryAfter: input.retryAfter,
        retryCount: input.retryCount,
        runtimeLimitSnapshotJson: serializeRuntimeLimitSnapshot(normalizedSnapshot),
        runtimeLimitUpdatedAt: nowIso,
        updatedAt: nowIso,
      })
      .where(and(...conditions))
      .returning({ status: tasks.status })
      .get();
    if (!updated) return false;
    // Аудит пишется в той же транзакции, что и смена статуса: либо есть и блокировка,
    // и её след в журнале, либо нет ни того, ни другого. fromStatus берётся из
    // строки, прочитанной до UPDATE, — это фактическое предыдущее состояние.
    tx.insert(auditEvents)
      .values(
        createAuditEventValues({
          action: "task.runtime_gate_blocked",
          entityType: "task",
          entityId: task.id,
          taskId: task.id,
          taskTitleSnapshot: task.title,
          executionOwnerSnapshot: task.executionOwner,
          assigneesSnapshot: [],
          statusSnapshot: updated.status,
          actor: {
            kind: "system",
            id: "runtime-gate",
            displayNameSnapshot: "Runtime Gate",
          },
          metadata: {
            fromStatus: task.status,
            toStatus: updated.status,
            ownershipRevision: task.ownershipRevision,
          },
          createdAt: nowIso,
        }),
      )
      .run();
    return true;
  });
}

export function claimBacklogTaskForAdvance(
  taskId: string,
  autoQueueCommit?: {
    status: Extract<AutoQueueCommitStatus, "pending" | "not_applicable">;
    baseSha: string | null;
  },
): boolean {
  const nowIso = new Date().toISOString();
  return getDb().transaction((tx) => {
    const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) return false;
    const updated = tx
      .update(tasks)
      .set({
        status: "planning",
        // Перенос в планирование обнуляет всё, что относится к предыдущему кругу
        // работы: причину блокировки, счётчики повторов и итераций ревью, а также
        // флаг повторной доработки. Иначе задача унаследовала бы устаревшие
        // состояния и, например, сразу считалась бы выбившейся из лимита ревью.
        scheduledAt: null,
        blockedReason: null,
        blockedFromStatus: null,
        retryAfter: null,
        retryCount: 0,
        reworkRequested: false,
        reviewIterationCount: 0,
        manualReviewRequired: false,
        autoReviewStateJson: null,
        ...(autoQueueCommit
          ? {
              autoQueueCommitStatus: autoQueueCommit.status,
              autoQueueCommitBaseSha: autoQueueCommit.baseSha,
              commitSha: null,
              autoQueueCommitError: null,
              autoQueueCommitCompletedAt: null,
            }
          : {}),
        lastHeartbeatAt: nowIso,
        updatedAt: nowIso,
      })
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.status, "backlog"),
          eq(tasks.paused, false),
          eq(tasks.executionOwner, "ai"),
        ),
      )
      .returning({ status: tasks.status })
      .get();
    if (!updated) return false;
    tx.insert(auditEvents)
      .values(
        createAuditEventValues({
          action: "task.automation_advanced",
          entityType: "task",
          entityId: task.id,
          taskId: task.id,
          taskTitleSnapshot: task.title,
          executionOwnerSnapshot: task.executionOwner,
          assigneesSnapshot: [],
          statusSnapshot: updated.status,
          actor: {
            kind: "system",
            id: "task-automation",
            displayNameSnapshot: "Task Automation",
          },
          metadata: {
            fromStatus: task.status,
            toStatus: updated.status,
            ownershipRevision: task.ownershipRevision,
          },
          createdAt: nowIso,
        }),
      )
      .run();
    return true;
  });
}

export function hasBlockingAutoQueueCommitForProject(projectId: string): boolean {
  const row = getDb()
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.executionOwner, "ai"),
        or(
          eq(tasks.autoQueueCommitStatus, "failed"),
          and(
            inArray(tasks.status, ["done", "accepted"]),
            inArray(tasks.autoQueueCommitStatus, ["pending", "running"]),
          ),
        ),
      ),
    )
    .limit(1)
    .get();
  return row != null;
}

export function countActivePipelineTasksForProject(projectId: string): number {
  const row = getDb()
    .select({ cnt: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.executionOwner, "ai"),
        inArray(tasks.status, [
          "planning",
          "improve",
          "plan_review",
          "implementing",
          "review",
          "verify",
          "blocked_external",
        ]),
      ),
    )
    .get();
  return row?.cnt ?? 0;
}

export function hasActiveBranchBoundTasksForProject(projectId: string): boolean {
  const row = getDb()
    .select({ cnt: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        isNotNull(tasks.branchName),
        isNull(tasks.worktreePath),
        inArray(tasks.status, [
          "backlog",
          "planning",
          "improve",
          "plan_review",
          "implementing",
          "review",
          "verify",
          "blocked_external",
        ]),
      ),
    )
    .get();
  return (row?.cnt ?? 0) > 0;
}

export function hasActiveLockedTaskForProject(projectId: string): boolean {
  const nowIso = new Date().toISOString();
  const row = getDb()
    .select({ cnt: count() })
    .from(tasks)
    .where(and(
      eq(tasks.projectId, projectId),
      eq(tasks.executionOwner, "ai"),
      isNotNull(tasks.lockedBy),
      gt(tasks.lockedUntil, nowIso),
    ))
    .get();
  return (row?.cnt ?? 0) > 0;
}

const NON_TERMINAL_WORKTREE_STATUSES: TaskStatus[] = [
  "backlog",
  "planning",
  "improve",
  "plan_review",
  "implementing",
  "review",
  "verify",
  "blocked_external",
];

export interface WorktreeReferenceQuery {
  projectId: string;
  branchName: string | null;
  worktreePath: string;
  excludeTaskId: string;
}

export function countOtherLiveTasksReferencingWorktree(input: WorktreeReferenceQuery): number {
  const row = getDb()
    .select({ cnt: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, input.projectId),
        eq(tasks.worktreePath, input.worktreePath),
        ne(tasks.id, input.excludeTaskId),
        inArray(tasks.status, NON_TERMINAL_WORKTREE_STATUSES),
      ),
    )
    .get();
  return row?.cnt ?? 0;
}

export interface ActiveTaskWorktreeRow {
  id: string;
  projectId: string;
  branchName: string | null;
  worktreePath: string;
  status: TaskStatus;
}

export function listActiveTasksWithWorktrees(projectId: string): ActiveTaskWorktreeRow[] {
  const rows = getDb()
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      branchName: tasks.branchName,
      worktreePath: tasks.worktreePath,
      status: tasks.status,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        isNotNull(tasks.worktreePath),
        inArray(tasks.status, NON_TERMINAL_WORKTREE_STATUSES),
      ),
    )
    .all();

  return rows.flatMap((row) =>
    row.worktreePath
      ? [
          {
            id: row.id,
            projectId: row.projectId,
            branchName: row.branchName,
            worktreePath: row.worktreePath,
            status: row.status,
          },
        ]
      : [],
  );
}

export interface ClearDanglingVcsLinksResult {
  githubLinksCleared: number;
  gitlabLinksCleared: number;
}

export function clearDanglingVcsIssueLinks(): ClearDanglingVcsLinksResult {
  const db = getDb();
  const existingTaskIds = new Set(db.select({ id: tasks.id }).from(tasks).all().map((row) => row.id));

  let githubLinksCleared = 0;
  const githubRows = db
    .select({
      projectId: githubIssues.projectId,
      issueNumber: githubIssues.issueNumber,
      taskId: githubIssues.taskId,
    })
    .from(githubIssues)
    .where(isNotNull(githubIssues.taskId))
    .all();
  for (const row of githubRows) {
    if (!row.taskId || existingTaskIds.has(row.taskId)) continue;
    db.update(githubIssues)
      .set({ taskId: null })
      .where(
        and(
          eq(githubIssues.projectId, row.projectId),
          eq(githubIssues.issueNumber, row.issueNumber),
        ),
      )
      .run();
    githubLinksCleared += 1;
  }

  let gitlabLinksCleared = 0;
  const gitlabRows = db
    .select({ projectId: gitlabIssues.projectId, iid: gitlabIssues.iid, taskId: gitlabIssues.taskId })
    .from(gitlabIssues)
    .where(isNotNull(gitlabIssues.taskId))
    .all();
  for (const row of gitlabRows) {
    if (!row.taskId || existingTaskIds.has(row.taskId)) continue;
    db.update(gitlabIssues)
      .set({ taskId: null })
      .where(and(eq(gitlabIssues.projectId, row.projectId), eq(gitlabIssues.iid, row.iid)))
      .run();
    gitlabLinksCleared += 1;
  }

  return { githubLinksCleared, gitlabLinksCleared };
}

export function renewTaskClaim(taskId: string, coordinatorId: string, lockDurationMs: number): void {
  const lockedUntil = new Date(Date.now() + lockDurationMs).toISOString();
  getDb()
    .update(tasks)
    .set({ lockedUntil })
    .where(and(eq(tasks.id, taskId), eq(tasks.lockedBy, coordinatorId)))
    .run();
}

export function releaseTaskClaim(taskId: string, coordinatorId?: string): void {
  const conditions = [eq(tasks.id, taskId)];
  if (coordinatorId != null) {
    conditions.push(eq(tasks.lockedBy, coordinatorId));
  }
  getDb()
    .update(tasks)
    .set({ lockedBy: null, lockedUntil: null })
    .where(and(...conditions))
    .run();
}

export function releaseStaleTaskClaims(): number {
  const nowIso = new Date().toISOString();
  // Пульс старше 5 минут означает, что процесс мёртв.
  const heartbeatDeadline = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const result = getDb()
    .update(tasks)
    .set({ lockedBy: null, lockedUntil: null })
    .where(and(
      isNotNull(tasks.lockedBy),
      or(
        // Захват с истёкшим TTL
        lte(tasks.lockedUntil, nowIso),
        // Процесс умер: пульс устарел, задача всё ещё в работе, и это не QA-захват
        // (у QA-прогонов нет пульса, они живут до истечения TTL).
        and(
          inArray(tasks.status, ["planning", "improve", "implementing", "review", "verify"]),
          notLike(tasks.lockedBy, "qa:%"),
          or(
            sql`${tasks.lastHeartbeatAt} IS NULL`,
            lte(tasks.lastHeartbeatAt, heartbeatDeadline),
          ),
        ),
      ),
    ))
    .run();
  return result.changes;
}

export function listDueBlockedExternalTasks(nowIso: string): TaskRow[] {
  return getDb()
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "blocked_external"),
        eq(tasks.executionOwner, "ai"),
        eq(tasks.paused, false),
        isNotNull(tasks.retryAfter),
        lte(tasks.retryAfter, nowIso),
        isNotNull(tasks.blockedFromStatus),
      ),
    )
    .all();
}

export function listDueScheduledTasks(nowIso: string): TaskRow[] {
  log.debug({ nowIso }, "Scanning for due scheduled tasks");
  const rows = getDb()
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "backlog"),
        eq(tasks.executionOwner, "ai"),
        eq(tasks.paused, false),
        isNotNull(tasks.scheduledAt),
        lte(tasks.scheduledAt, nowIso),
      ),
    )
    .all();
  log.debug({ dueCount: rows.length }, "Due scheduled tasks resolved");
  return rows;
}

export function clearScheduledAt(taskId: string): void {
  log.debug({ taskId }, "Clearing scheduledAt");
  const nowIso = new Date().toISOString();
  getDb()
    .update(tasks)
    .set({ scheduledAt: null, updatedAt: nowIso })
    .where(eq(tasks.id, taskId))
    .run();
}

export function updateScheduledAt(taskId: string, scheduledAt: string | null): void {
  log.debug({ taskId, scheduledAt }, "Updating scheduledAt");
  const nowIso = new Date().toISOString();
  getDb()
    .update(tasks)
    .set({ scheduledAt, updatedAt: nowIso })
    .where(eq(tasks.id, taskId))
    .run();
}

export function getAutoQueueMode(projectId: string): boolean {
  const row = getDb()
    .select({ autoQueueMode: projects.autoQueueMode })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  return Boolean(row?.autoQueueMode);
}

export function listAutoQueueProjects(): ProjectRow[] {
  return getDb().select().from(projects).where(eq(projects.autoQueueMode, true)).all();
}

export function setAutoQueueMode(projectId: string, enabled: boolean): void {
  log.info({ projectId, enabled }, "Setting auto-queue mode");
  const nowIso = new Date().toISOString();
  getDb()
    .update(projects)
    .set({ autoQueueMode: enabled, updatedAt: nowIso })
    .where(eq(projects.id, projectId))
    .run();
}

export function nextBacklogTaskByPosition(projectId: string): TaskRow | undefined {
  const nowIso = new Date().toISOString();
  return getDb()
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.status, "backlog"),
        eq(tasks.executionOwner, "ai"),
        eq(tasks.paused, false),
        or(
          isNull(tasks.scheduledAt),
          lte(tasks.scheduledAt, nowIso),
        ),
      ),
    )
    .orderBy(asc(tasks.position), asc(tasks.createdAt), asc(tasks.id))
    .limit(1)
    .get();
}

export function listStaleInProgressTasks(): TaskRow[] {
  const nowIso = new Date().toISOString();
  return getDb()
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ["planning", "improve", "implementing", "review", "verify"]),
        eq(tasks.executionOwner, "ai"),
        eq(tasks.paused, false),
        // Пропускаем задачи с активным (не истёкшим) захватом: их уже обрабатывают.
        or(
          sql`${tasks.lockedBy} IS NULL`,
          lte(tasks.lockedUntil, nowIso),
        ),
      ),
    )
    .all();
}
