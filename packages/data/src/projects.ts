/**
 * Репозиторий проектов: CRUD, организационные поля и агрегированные обзоры.
 */
import { asc, count, eq, max, sql } from "drizzle-orm";
import {
  TASK_STATUSES,
  logger as createLogger,
  projects,
  tasks,
  type ProjectTaskOverview,
  type TaskStatus,
  type UpdateProjectOrganizationInput,
} from "@aif/shared";
import { getDb } from "./db.js";

const log = createLogger("data");

// Приватный тип строки проекта: потребители @aif/data не зависят от формы
// строки БД — снаружи они получают hydrated/view-модельные формы.
type ProjectRow = typeof projects.$inferSelect;

export function listProjects(): ProjectRow[] {
  return getDb()
    .select()
    .from(projects)
    // Закреплённые проекты идут первыми, внутри группы — по времени закрепления.
    // Сортировка по имени задана с collate nocase: стандартное сравнение SQLite
    // учитывает регистр и поставило бы заглавные буквы отдельно от строчных,
    // что для человекочитаемого списка выглядит как беспорядок. Замыкающая
    // сортировка по id делает порядок полным и устойчивым при совпадении имён.
    .orderBy(
      sql`case when ${projects.pinnedAt} is null then 1 else 0 end`,
      asc(projects.pinnedAt),
      sql`${projects.name} collate nocase`,
      asc(projects.id),
    )
    .all();
}

function emptyStatusCounts(): Record<TaskStatus, number> {
  const counts = {} as Record<TaskStatus, number>;
  for (const status of TASK_STATUSES) {
    counts[status] = 0;
  }
  return counts;
}

function emptyStatusPreviews(): ProjectTaskOverview["statusPreviews"] {
  const previews = {} as ProjectTaskOverview["statusPreviews"];
  for (const status of TASK_STATUSES) {
    previews[status] = [];
  }
  return previews;
}

function emptyProjectTaskOverview(projectId: string): ProjectTaskOverview {
  return {
    projectId,
    lastActivityAt: null,
    totalTasks: 0,
    completedTasks: 0,
    acceptedTasks: 0,
    backlogTasks: 0,
    activeTasks: 0,
    blockedTasks: 0,
    autoModeTasks: 0,
    fixTasks: 0,
    totalRetries: 0,
    totalTokenInput: 0,
    totalTokenOutput: 0,
    totalTokenTotal: 0,
    totalCostUsd: 0,
    statusCounts: emptyStatusCounts(),
    statusPreviews: emptyStatusPreviews(),
  };
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

type ProjectTaskPreviewQueryRow = {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
};

export function listProjectTaskOverviews(previewLimit = 3): ProjectTaskOverview[] {
  const db = getDb();
  const normalizedPreviewLimit = Number.isFinite(previewLimit)
    ? Math.max(0, Math.trunc(previewLimit))
    : 0;
  const projectRows = listProjects();
  const overviewByProjectId = new Map(
    projectRows.map((project) => [project.id, emptyProjectTaskOverview(project.id)]),
  );

  const aggregateRows = db
    .select({
      projectId: tasks.projectId,
      status: tasks.status,
      taskCount: count(),
      autoModeTasks: sql<number>`coalesce(sum(case when ${tasks.autoMode} = 1 then 1 else 0 end), 0)`,
      fixTasks: sql<number>`coalesce(sum(case when ${tasks.isFix} = 1 then 1 else 0 end), 0)`,
      totalRetries: sql<number>`coalesce(sum(${tasks.retryCount}), 0)`,
      totalTokenInput: sql<number>`coalesce(sum(${tasks.tokenInput}), 0)`,
      totalTokenOutput: sql<number>`coalesce(sum(${tasks.tokenOutput}), 0)`,
      totalTokenTotal: sql<number>`coalesce(sum(${tasks.tokenTotal}), 0)`,
      totalCostUsd: sql<number>`coalesce(sum(${tasks.costUsd}), 0)`,
      lastActivityAt: max(tasks.updatedAt),
    })
    .from(tasks)
    .groupBy(tasks.projectId, tasks.status)
    .all();

  for (const row of aggregateRows) {
    const overview = overviewByProjectId.get(row.projectId);
    if (!overview) continue;

    const taskCount = toFiniteNumber(row.taskCount);
    const status = row.status;
    overview.totalTasks += taskCount;
    overview.statusCounts[status] = taskCount;
    overview.autoModeTasks += toFiniteNumber(row.autoModeTasks);
    overview.fixTasks += toFiniteNumber(row.fixTasks);
    overview.totalRetries += toFiniteNumber(row.totalRetries);
    overview.totalTokenInput += toFiniteNumber(row.totalTokenInput);
    overview.totalTokenOutput += toFiniteNumber(row.totalTokenOutput);
    overview.totalTokenTotal += toFiniteNumber(row.totalTokenTotal);
    overview.totalCostUsd += toFiniteNumber(row.totalCostUsd);
    if (
      row.lastActivityAt &&
      (!overview.lastActivityAt || row.lastActivityAt > overview.lastActivityAt)
    ) {
      overview.lastActivityAt = row.lastActivityAt;
    }

    if (status === "done" || status === "accepted") {
      overview.completedTasks += taskCount;
    }
    if (status === "accepted") {
      overview.acceptedTasks += taskCount;
    }
    if (status === "backlog") {
      overview.backlogTasks += taskCount;
    }
    if (status === "blocked_external") {
      overview.blockedTasks += taskCount;
    }
    if (status !== "backlog" && status !== "done" && status !== "accepted") {
      overview.activeTasks += taskCount;
    }
  }

  // Превью карточек собираются одним оконным запросом на все проекты и статусы
  // сразу. Альтернатива — запрос на каждую пару (проект, статус) — превратилась бы
  // в N+1. Оконная функция нумерует задачи внутри каждой такой пары, поэтому
  // rank <= предела отдаёт первые карточки колонки, а не случайные строки.
  if (normalizedPreviewLimit > 0) {
    const previewRows = db.all<ProjectTaskPreviewQueryRow>(sql`
      select
        id,
        project_id as "projectId",
        title,
        status
      from (
        select
          ${tasks.id} as id,
          ${tasks.projectId} as project_id,
          ${tasks.title} as title,
          ${tasks.status} as status,
          row_number() over (
            partition by ${tasks.projectId}, ${tasks.status}
            order by ${tasks.position} asc, ${tasks.id} asc
          ) as preview_rank
        from ${tasks}
      )
      where preview_rank <= ${normalizedPreviewLimit}
      order by project_id asc, status asc, preview_rank asc
    `);

    for (const row of previewRows) {
      const overview = overviewByProjectId.get(row.projectId);
      if (!overview) continue;

      const previews = overview.statusPreviews[row.status];
      previews.push({ id: row.id, title: row.title });
    }
  }

  log.debug(
    { projectCount: projectRows.length, projection: "project-task-overview" },
    "Listed project task overviews",
  );
  return projectRows.map((project) => overviewByProjectId.get(project.id)!);
}

export function findProjectById(id: string): ProjectRow | undefined {
  return getDb().select().from(projects).where(eq(projects.id, id)).get();
}

export function createProject(input: {
  name: string;
  rootPath: string;
  plannerMaxBudgetUsd?: number | null;
  planCheckerMaxBudgetUsd?: number | null;
  implementerMaxBudgetUsd?: number | null;
  reviewSidecarMaxBudgetUsd?: number | null;
  parallelEnabled?: boolean;
  defaultTaskRuntimeProfileId?: string | null;
  defaultPlanRuntimeProfileId?: string | null;
  defaultReviewRuntimeProfileId?: string | null;
  defaultChatRuntimeProfileId?: string | null;
}): ProjectRow | undefined {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  log.debug(
    {
      projectId: id,
      defaultTaskRuntimeProfileId: input.defaultTaskRuntimeProfileId ?? null,
      defaultPlanRuntimeProfileId: input.defaultPlanRuntimeProfileId ?? null,
      defaultReviewRuntimeProfileId: input.defaultReviewRuntimeProfileId ?? null,
      defaultChatRuntimeProfileId: input.defaultChatRuntimeProfileId ?? null,
    },
    "Creating project runtime defaults",
  );
  getDb()
    .insert(projects)
    .values({
      id,
      name: input.name,
      rootPath: input.rootPath,
      plannerMaxBudgetUsd: input.plannerMaxBudgetUsd ?? null,
      planCheckerMaxBudgetUsd: input.planCheckerMaxBudgetUsd ?? null,
      implementerMaxBudgetUsd: input.implementerMaxBudgetUsd ?? null,
      reviewSidecarMaxBudgetUsd: input.reviewSidecarMaxBudgetUsd ?? null,
      parallelEnabled: input.parallelEnabled ?? false,
      defaultTaskRuntimeProfileId: input.defaultTaskRuntimeProfileId ?? null,
      defaultPlanRuntimeProfileId: input.defaultPlanRuntimeProfileId ?? null,
      defaultReviewRuntimeProfileId: input.defaultReviewRuntimeProfileId ?? null,
      defaultChatRuntimeProfileId: input.defaultChatRuntimeProfileId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return findProjectById(id);
}

export function updateProject(
  id: string,
  input: {
    name: string;
    rootPath: string;
    plannerMaxBudgetUsd?: number | null;
    planCheckerMaxBudgetUsd?: number | null;
    implementerMaxBudgetUsd?: number | null;
    reviewSidecarMaxBudgetUsd?: number | null;
    parallelEnabled?: boolean;
    defaultTaskRuntimeProfileId?: string | null;
    defaultPlanRuntimeProfileId?: string | null;
    defaultReviewRuntimeProfileId?: string | null;
    defaultChatRuntimeProfileId?: string | null;
  },
): ProjectRow | undefined {
  const patch: Partial<ProjectRow> = {
    name: input.name,
    rootPath: input.rootPath,
    plannerMaxBudgetUsd: input.plannerMaxBudgetUsd ?? null,
    planCheckerMaxBudgetUsd: input.planCheckerMaxBudgetUsd ?? null,
    implementerMaxBudgetUsd: input.implementerMaxBudgetUsd ?? null,
    reviewSidecarMaxBudgetUsd: input.reviewSidecarMaxBudgetUsd ?? null,
    parallelEnabled: input.parallelEnabled ?? false,
    updatedAt: new Date().toISOString(),
  };
  if (input.defaultTaskRuntimeProfileId !== undefined) {
    patch.defaultTaskRuntimeProfileId = input.defaultTaskRuntimeProfileId;
  }
  if (input.defaultPlanRuntimeProfileId !== undefined) {
    patch.defaultPlanRuntimeProfileId = input.defaultPlanRuntimeProfileId;
  }
  if (input.defaultReviewRuntimeProfileId !== undefined) {
    patch.defaultReviewRuntimeProfileId = input.defaultReviewRuntimeProfileId;
  }
  if (input.defaultChatRuntimeProfileId !== undefined) {
    patch.defaultChatRuntimeProfileId = input.defaultChatRuntimeProfileId;
  }

  log.debug(
    {
      projectId: id,
      defaultTaskRuntimeProfileId: patch.defaultTaskRuntimeProfileId ?? null,
      defaultPlanRuntimeProfileId: patch.defaultPlanRuntimeProfileId ?? null,
      defaultReviewRuntimeProfileId: patch.defaultReviewRuntimeProfileId ?? null,
      defaultChatRuntimeProfileId: patch.defaultChatRuntimeProfileId ?? null,
    },
    "Updating project runtime defaults",
  );
  getDb()
    .update(projects)
    .set(patch)
    .where(eq(projects.id, id))
    .run();
  return findProjectById(id);
}

export function updateProjectOrganization(
  id: string,
  input: UpdateProjectOrganizationInput,
): ProjectRow | undefined {
  const existing = findProjectById(id);
  if (!existing) return undefined;

  const patch: Partial<ProjectRow> = { updatedAt: new Date().toISOString() };
  if (input.pinned !== undefined) {
    patch.pinnedAt = input.pinned ? (existing.pinnedAt ?? new Date().toISOString()) : null;
  }
  if (input.groupName !== undefined) {
    patch.groupName = input.groupName?.trim() || null;
  }

  log.debug(
    {
      projectId: id,
      pinned: patch.pinnedAt != null,
      groupName: patch.groupName,
    },
    "[FIX:147] Updating project organization",
  );
  getDb().update(projects).set(patch).where(eq(projects.id, id)).run();
  const updated = findProjectById(id);
  log.debug(
    { projectId: id, updated: updated != null },
    "[FIX:147] Project organization updated",
  );
  return updated;
}

export function deleteProject(id: string): void {
  getDb().delete(projects).where(eq(projects.id, id)).run();
}

export function updateProjectRuntimeDefaults(
  projectId: string,
  input: {
    defaultTaskRuntimeProfileId?: string | null;
    defaultPlanRuntimeProfileId?: string | null;
    defaultReviewRuntimeProfileId?: string | null;
    defaultChatRuntimeProfileId?: string | null;
  },
): ProjectRow | undefined {
  log.debug({ projectId, ...input }, "Updating project runtime default profiles");
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.defaultTaskRuntimeProfileId !== undefined) patch.defaultTaskRuntimeProfileId = input.defaultTaskRuntimeProfileId;
  if (input.defaultPlanRuntimeProfileId !== undefined) patch.defaultPlanRuntimeProfileId = input.defaultPlanRuntimeProfileId;
  if (input.defaultReviewRuntimeProfileId !== undefined) patch.defaultReviewRuntimeProfileId = input.defaultReviewRuntimeProfileId;
  if (input.defaultChatRuntimeProfileId !== undefined) patch.defaultChatRuntimeProfileId = input.defaultChatRuntimeProfileId;
  getDb().update(projects).set(patch).where(eq(projects.id, projectId)).run();
  return findProjectById(projectId);
}
