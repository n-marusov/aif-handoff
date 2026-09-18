// Схема базы данных (SQLite через drizzle-orm).
//
// Здесь описаны все таблицы приложения и типы строк, выведенные из них. Схема -
// источник истины по структуре хранения: миграции в db.ts приводят уже существующие
// базы к этому виду, а слой доступа (@aif/data) строит на ней запросы.
//
// Соглашения:
// - имена колонок в базе в snake_case, поля объектов - в camelCase;
// - идентификаторы - UUID, генерируются приложением, а не базой;
// - временные метки - строки ISO-8601 в UTC;
// - структурированные данные (вложения, снимки, состояния) лежат JSON-текстом в
//   колонках с суффиксом Json: отдельного типа JSON у SQLite нет.
//
// Внешние ключи описаны обычными текстовыми колонками: SQLite не форсирует их по
// умолчанию, поэтому целостность обеспечивают код и триггеры каскадного удаления.

import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type {
  AuditActorKind,
  AutoQueueCommitStatus,
  ExecutionOwner,
  ParticipantRole,
  PlanReviewState,
  PullRequestMode,
  TaskStatus,
} from "./types.js";

// Проект: корневой каталог на диске плюс настройки автоматизации (параллельное
// исполнение, профили рантайма по умолчанию, привязка к VCS).
export const projects = sqliteTable("projects", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  rootPath: text("root_path").notNull(),
  plannerMaxBudgetUsd: real("planner_max_budget_usd"),
  planCheckerMaxBudgetUsd: real("plan_checker_max_budget_usd"),
  implementerMaxBudgetUsd: real("implementer_max_budget_usd"),
  reviewSidecarMaxBudgetUsd: real("review_sidecar_max_budget_usd"),
  pinnedAt: text("pinned_at"),
  groupName: text("group_name"),
  parallelEnabled: integer("parallel_enabled", { mode: "boolean" }).notNull().default(false),
  autoQueueMode: integer("auto_queue_mode", { mode: "boolean" }).notNull().default(false),
  defaultTaskRuntimeProfileId: text("default_task_runtime_profile_id"),
  defaultPlanRuntimeProfileId: text("default_plan_runtime_profile_id"),
  defaultReviewRuntimeProfileId: text("default_review_runtime_profile_id"),
  defaultChatRuntimeProfileId: text("default_chat_runtime_profile_id"),
  tokenInput: integer("token_input").notNull().default(0),
  tokenOutput: integer("token_output").notNull().default(0),
  tokenTotal: integer("token_total").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;

// Глобальные настройки приложения. Таблица-синглтон: в ней всегда ровно одна строка,
// поэтому чтение и обновление не требуют идентификатора.
export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey().notNull().default(1),
  defaultTaskRuntimeProfileId: text("default_task_runtime_profile_id"),
  defaultPlanRuntimeProfileId: text("default_plan_runtime_profile_id"),
  defaultReviewRuntimeProfileId: text("default_review_runtime_profile_id"),
  defaultChatRuntimeProfileId: text("default_chat_runtime_profile_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type AppSettingsRow = typeof appSettings.$inferSelect;
export type NewAppSettingsRow = typeof appSettings.$inferInsert;

// Участники (режим Participants Mode): учётные записи, роли и признак активности.
// Имя хранится в двух видах - исходное и нормализованное, чтобы проверять
// уникальность без учёта регистра.
export const participants = sqliteTable("participants", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  username: text("username").notNull(),
  normalizedUsername: text("normalized_username").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").$type<ParticipantRole>().notNull().default("member"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  deactivatedAt: text("deactivated_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type ParticipantRow = typeof participants.$inferSelect;
export type NewParticipantRow = typeof participants.$inferInsert;

// Сессии участников. В базе лежит дайджест токена, а не сам токен: утечка таблицы не
// даёт возможности войти в систему. CSRF-секрет привязан к сессии.
export const participantSessions = sqliteTable("participant_sessions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  participantId: text("participant_id")
    .notNull()
    .references(() => participants.id, { onDelete: "cascade" }),
  tokenDigest: text("token_digest").notNull().unique(),
  csrfTokenDigest: text("csrf_token_digest").notNull(),
  expiresAt: text("expires_at").notNull(),
  lastSeenAt: text("last_seen_at"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type ParticipantSessionRow = typeof participantSessions.$inferSelect;
export type NewParticipantSessionRow = typeof participantSessions.$inferInsert;

// Задачи - центральная таблица. Одна строка содержит и бизнес-поля (заголовок, план,
// статус), и служебные: прогресс этапа, блокировки параллельного исполнения,
// выбранный рантайм, состояние гейтов автоматизации. Флаги режима дублируются здесь
// на момент запуска задачи, чтобы изменение настроек проекта не меняло ход уже
// начатой работы.
export const tasks = sqliteTable("tasks", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  attachments: text("attachments").notNull().default("[]"),
  autoMode: integer("auto_mode", { mode: "boolean" }).notNull().default(true),
  // Владелец задачи и ревизия владения. Ревизия увеличивается при каждой передаче
  // владения и служит оптимистичной проверкой: исполнитель меняет задачу только
  // зная актуальную ревизию, иначе он работал бы по устаревшему состоянию.
  executionOwner: text("execution_owner").$type<ExecutionOwner>().notNull().default("ai"),
  ownershipRevision: integer("ownership_revision").notNull().default(0),
  isFix: integer("is_fix", { mode: "boolean" }).notNull().default(false),
  plannerMode: text("planner_mode").notNull().default("fast"),
  planPath: text("plan_path").notNull().default(".ai-factory/PLAN.md"),
  planDocs: integer("plan_docs", { mode: "boolean" }).notNull().default(false),
  planTests: integer("plan_tests", { mode: "boolean" }).notNull().default(false),
  skipReview: integer("skip_review", { mode: "boolean" }).notNull().default(false),
  useSubagents: integer("use_subagents", { mode: "boolean" }).notNull().default(false),
  runPlanImprove: integer("run_plan_improve", { mode: "boolean" }).notNull().default(false),
  runPostVerify: integer("run_post_verify", { mode: "boolean" }).notNull().default(false),
  autoQa: integer("auto_qa", { mode: "boolean" }).notNull().default(false),
  qaChangeSummary: text("qa_change_summary"),
  qaTestPlan: text("qa_test_plan"),
  qaTestCases: text("qa_test_cases"),
  qaStatus: text("qa_status")
    .$type<"idle" | "running" | "done" | "error">()
    .notNull()
    .default("idle"),
  status: text("status").$type<TaskStatus>().notNull().default("backlog"),
  priority: integer("priority").notNull().default(0),
  // Разрежённая позиция в колонке: шаг 1000 оставляет место для вставки между соседями
  // без переписывания всей колонки.
  position: real("position").notNull().default(1000.0),
  plan: text("plan"),
  implementationLog: text("implementation_log"),
  reviewComments: text("review_comments"),
  agentActivityLog: text("agent_activity_log"),
  blockedReason: text("blocked_reason"),
  // Статус, из которого задача была заблокирована: после разблокировки возврат идёт
  // именно туда, а не в начало цикла.
  blockedFromStatus: text("blocked_from_status").$type<TaskStatus | null>(),
  retryAfter: text("retry_after"),
  retryCount: integer("retry_count").notNull().default(0),
  tokenInput: integer("token_input").notNull().default(0),
  tokenOutput: integer("token_output").notNull().default(0),
  tokenTotal: integer("token_total").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  roadmapAlias: text("roadmap_alias"),
  tags: text("tags").notNull().default("[]"),
  reworkRequested: integer("rework_requested", { mode: "boolean" }).notNull().default(false),
  reviewIterationCount: integer("review_iteration_count").notNull().default(0),
  maxReviewIterations: integer("max_review_iterations").notNull().default(3),
  manualReviewRequired: integer("manual_review_required", { mode: "boolean" })
    .notNull()
    .default(false),
  // Снимок состояния авто-ревью: стратегия, число попыток и найденные замечания.
  autoReviewStateJson: text("auto_review_state_json"),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  lastHeartbeatAt: text("last_heartbeat_at"),
  lastActivityAt: text("last_activity_at"),
  currentToolJson: text("current_tool_json"),
  lastSyncedAt: text("last_synced_at"),
  runtimeProfileId: text("runtime_profile_id"),
  modelOverride: text("model_override"),
  runtimeOptionsJson: text("runtime_options_json"),
  // Идентификатор сессии рантайма и статус, под который она поднята. Нужны, чтобы
  // продолжить прерванный этап в той же сессии, а не начинать работу заново.
  sessionId: text("session_id"),
  activeRuntimeStatus: text("active_runtime_status").$type<TaskStatus | null>(),
  activeRuntimeSelectionJson: text("active_runtime_selection_json"),
  runtimeLimitSnapshotJson: text("runtime_limit_snapshot_json"),
  runtimeLimitUpdatedAt: text("runtime_limit_updated_at"),
  // Блокировка для параллельного исполнения: задачу захватывает один воркер, а
  // lockedUntil не даёт зависшей блокировке остаться навсегда.
  lockedBy: text("locked_by"),
  lockedUntil: text("locked_until"),
  scheduledAt: text("scheduled_at"),
  branchName: text("branch_name"),
  worktreePath: text("worktree_path"),
  autoQueueCommitStatus: text("auto_queue_commit_status").$type<AutoQueueCommitStatus | null>(),
  autoQueueCommitBaseSha: text("auto_queue_commit_base_sha"),
  commitSha: text("commit_sha"),
  autoQueueCommitError: text("auto_queue_commit_error"),
  autoQueueCommitCompletedAt: text("auto_queue_commit_completed_at"),
  // Состояние гейта ревью плана: план публикуется отдельным PR/MR и ждёт решения
  // человека, поэтому прогресс фиксируется здесь, а не только в статусе задачи.
  planReviewState: text("plan_review_state").$type<PlanReviewState | null>(),
  planReviewCommitSha: text("plan_review_commit_sha"),
  planReviewPublishedAt: text("plan_review_published_at"),
  planReviewApprovedAt: text("plan_review_approved_at"),
  planReviewFeedback: text("plan_review_feedback"),
  // Время ставит база, а не приложение: единый источник времени для всех процессов.
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// Типы строк выводятся из таблиц: Row описывает прочитанную строку, NewRow - данные для
// вставки, где поля со значением по умолчанию становятся необязательными. Приём
// повторяется для каждой таблицы и не требует ручной синхронизации с колонками.
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;

// Комментарии к задачам. Вложения лежат JSON-текстом в отдельной колонке: у SQLite
// нет отдельного типа для списков.
export const taskComments = sqliteTable("task_comments", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  taskId: text("task_id").notNull(),
  author: text("author").$type<"human" | "agent">().notNull().default("human"),
  participantId: text("participant_id").references(() => participants.id, {
    onDelete: "set null",
  }),
  message: text("message").notNull(),
  attachments: text("attachments").notNull().default("[]"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export type TaskCommentRow = typeof taskComments.$inferSelect;
export type NewTaskCommentRow = typeof taskComments.$inferInsert;

// Назначения участников на задачи. Составной первичный ключ запрещает дублирование
// пары задача-участник, а признак active позволяет снять назначение, не теряя историю.
export const taskAssignments = sqliteTable(
  "task_assignments",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    participantId: text("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    assignedByKind: text("assigned_by_kind").$type<AuditActorKind>().notNull(),
    assignedById: text("assigned_by_id"),
    assignedByDisplayNameSnapshot: text("assigned_by_display_name_snapshot"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.participantId] })],
);

export type TaskAssignmentRow = typeof taskAssignments.$inferSelect;
export type NewTaskAssignmentRow = typeof taskAssignments.$inferInsert;

// История исполнителей по ревизиям владения: кто и на какой ревизии получил задачу.
// Вместе с журналом аудита это след, по которому восстанавливается картина передач.
export const taskExecutorHistory = sqliteTable("task_executor_history", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  taskId: text("task_id").notNull(),
  taskTitleSnapshot: text("task_title_snapshot").notNull(),
  ownershipRevision: integer("ownership_revision").notNull(),
  executionOwner: text("execution_owner").$type<ExecutionOwner>().notNull(),
  assigneesSnapshotJson: text("assignees_snapshot_json").notNull().default("[]"),
  statusSnapshot: text("status_snapshot").$type<TaskStatus>().notNull(),
  actorKind: text("actor_kind").$type<AuditActorKind>().notNull(),
  actorId: text("actor_id"),
  actorDisplayNameSnapshot: text("actor_display_name_snapshot"),
  reason: text("reason"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type TaskExecutorHistoryRow = typeof taskExecutorHistory.$inferSelect;
export type NewTaskExecutorHistoryRow = typeof taskExecutorHistory.$inferInsert;

// Журнал аудита: append-only таблица событий со снимками состояния задачи. Снимки
// денормализованы намеренно - история должна читаться без обращения к живым таблицам,
// которые могли измениться или быть удалены.
export const auditEvents = sqliteTable("audit_events", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  taskId: text("task_id"),
  taskTitleSnapshot: text("task_title_snapshot"),
  participantId: text("participant_id"),
  participantDisplayNameSnapshot: text("participant_display_name_snapshot"),
  executionOwnerSnapshot: text("execution_owner_snapshot").$type<ExecutionOwner | null>(),
  assigneesSnapshotJson: text("assignees_snapshot_json"),
  statusSnapshot: text("status_snapshot").$type<TaskStatus | null>(),
  actorKind: text("actor_kind").$type<AuditActorKind>().notNull(),
  actorId: text("actor_id"),
  actorDisplayNameSnapshot: text("actor_display_name_snapshot"),
  reason: text("reason"),
  metadataJson: text("metadata_json"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;

// Связь проекта с репозиторием GitHub: адрес, состояние подготовки и синхронизации.
// Одна строка на проект в рамках провайдера.
export const githubRepositories = sqliteTable("github_repositories", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  htmlUrl: text("html_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  tokenEnvVar: text("token_env_var").notNull().default("GITHUB_TOKEN"),
  eligibilityJson: text("eligibility_json").notNull().default("{}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastSyncedAt: text("last_synced_at"),
  syncError: text("sync_error"),
  gitPreparedAt: text("git_prepared_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type GitHubRepositoryRow = typeof githubRepositories.$inferSelect;
export type NewGitHubRepositoryRow = typeof githubRepositories.$inferInsert;

// Связь задачи с issue и pull request на GitHub: номера, состояние проверок, состояние
// ревью и отметка последнего обработанного комментария ревью (защита от повторной
// обработки одного и того же решения).
export const githubIssues = sqliteTable(
  "github_issues",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    issueNumber: integer("issue_number").notNull(),
    taskId: text("task_id")
      .unique()
      .references(() => tasks.id, { onDelete: "set null" }),
    nodeId: text("node_id").notNull(),
    htmlUrl: text("html_url").notNull(),
    state: text("state").$type<"open" | "closed">().notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    sourceUpdatedAt: text("source_updated_at").notNull(),
    lastSyncedAt: text("last_synced_at").notNull(),
    syncError: text("sync_error"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    prState: text("pr_state").$type<"open" | "closed" | "merged" | null>(),
    prChecksStatus: text("pr_checks_status").$type<"pending" | "success" | "failure" | null>(),
    prMode: text("pr_mode").$type<PullRequestMode | null>(),
    reviewState: text("review_state").$type<"pending" | "approved" | "changes_requested" | null>(),
    lastReviewId: integer("last_review_id"),
    reviewFingerprint: text("review_fingerprint"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.issueNumber] })],
);

export type GitHubIssueRow = typeof githubIssues.$inferSelect;
export type NewGitHubIssueRow = typeof githubIssues.$inferInsert;

// Зеркало githubRepositories для GitLab: та же структура и те же инварианты, чтобы код
// обоих провайдеров оставался симметричным.
export const gitlabRepositories = sqliteTable("gitlab_repositories", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  namespace: text("namespace").notNull(),
  name: text("name").notNull(),
  webUrl: text("web_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  tokenEnvVar: text("token_env_var").notNull().default("GITLAB_TOKEN"),
  eligibilityJson: text("eligibility_json").notNull().default("{}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastSyncedAt: text("last_synced_at"),
  syncError: text("sync_error"),
  gitPreparedAt: text("git_prepared_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type GitLabRepositoryRow = typeof gitlabRepositories.$inferSelect;
export type NewGitLabRepositoryRow = typeof gitlabRepositories.$inferInsert;

// Зеркало githubIssues для GitLab: issue плюс merge request.
export const gitlabIssues = sqliteTable(
  "gitlab_issues",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    iid: integer("iid").notNull(),
    taskId: text("task_id")
      .unique()
      .references(() => tasks.id, { onDelete: "set null" }),
    globalId: text("global_id").notNull(),
    webUrl: text("web_url").notNull(),
    state: text("state").$type<"open" | "closed">().notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    sourceUpdatedAt: text("source_updated_at").notNull(),
    lastSyncedAt: text("last_synced_at").notNull(),
    syncError: text("sync_error"),
    mrIid: integer("mr_iid"),
    mrUrl: text("mr_url"),
    mrState: text("mr_state").$type<"open" | "closed" | "merged" | null>(),
    mrChecksStatus: text("mr_checks_status").$type<"pending" | "success" | "failure" | null>(),
    mrMode: text("mr_mode").$type<PullRequestMode | null>(),
    reviewState: text("review_state").$type<"pending" | "approved" | null>(),
    reviewFingerprint: text("review_fingerprint"),
    lastReviewNoteId: integer("last_review_note_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.iid] })],
);

export type GitLabIssueRow = typeof gitlabIssues.$inferSelect;
export type NewGitLabIssueRow = typeof gitlabIssues.$inferInsert;

// Профили рантайма: рантайм, провайдер, транспорт, модель и заголовки запросов. Профиль
// принадлежит проекту или является глобальным; снимок лимитов хранится здесь же,
// чтобы интерфейс показывал остаток без обращения к провайдеру.
export const runtimeProfiles = sqliteTable("runtime_profiles", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id"),
  name: text("name").notNull(),
  runtimeId: text("runtime_id").notNull(),
  providerId: text("provider_id").notNull(),
  transport: text("transport"),
  baseUrl: text("base_url"),
  apiKeyEnvVar: text("api_key_env_var"),
  defaultModel: text("default_model"),
  headersJson: text("headers_json").notNull().default("{}"),
  optionsJson: text("options_json").notNull().default("{}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  runtimeLimitSnapshotJson: text("runtime_limit_snapshot_json"),
  runtimeLimitUpdatedAt: text("runtime_limit_updated_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type RuntimeProfileRow = typeof runtimeProfiles.$inferSelect;
export type NewRuntimeProfileRow = typeof runtimeProfiles.$inferInsert;

// Чат-сессии: переписка пользователя с рантаймом вне контекста задачи. Сессия
// привязана к профилю рантайма и может нести идентификатор сессии провайдера
// для продолжения диалога после перезапуска.
export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull(),
  title: text("title").notNull().default("New Chat"),
  agentSessionId: text("agent_session_id"),
  runtimeProfileId: text("runtime_profile_id"),
  runtimeSessionId: text("runtime_session_id"),
  tokenInput: integer("token_input").notNull().default(0),
  tokenOutput: integer("token_output").notNull().default(0),
  tokenTotal: integer("token_total").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type ChatSessionRow = typeof chatSessions.$inferSelect;
export type NewChatSessionRow = typeof chatSessions.$inferInsert;

// Сообщения чат-сессии в порядке добавления. Вложения - JSON-текст.
export const chatMessages = sqliteTable("chat_messages", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id").notNull(),
  role: text("role").$type<"user" | "assistant">().notNull(),
  content: text("content").notNull(),
  attachments: text("attachments"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type NewChatMessageRow = typeof chatMessages.$inferInsert;

/**
 * Журнал расхода токенов только с дозаписью. Каждый успешный вызов LLM,
 * проходящий через обёртку реестра runtime, оставляет здесь одну строку.
 * Агрегатные счётчики по сущностям (в tasks / projects / chat_sessions)
 * обновляются в той же транзакции, чтобы чтения оставались дешёвыми, но
 * источником истины для аудита и разбивки по источникам является эта таблица.
 * Поля области могут быть null: у запуска чата есть `chat_session_id`, но нет
 * `task_id`, у запуска сабагента есть `task_id`, но нет `chat_session_id`, у
 * коммита — только `project_id`, и так далее.
 */
export const usageEvents = sqliteTable("usage_events", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  source: text("source").notNull(),
  projectId: text("project_id"),
  taskId: text("task_id"),
  chatSessionId: text("chat_session_id"),
  runtimeId: text("runtime_id").notNull(),
  providerId: text("provider_id").notNull(),
  profileId: text("profile_id"),
  transport: text("transport"),
  workflowKind: text("workflow_kind"),
  usageReporting: text("usage_reporting").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  costUsd: real("cost_usd"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type UsageEventRow = typeof usageEvents.$inferSelect;
export type NewUsageEventRow = typeof usageEvents.$inferInsert;

export type RuntimeWarmupSessionStatus = "creating" | "ready" | "failed" | "cleared" | "expired";

/**
 * Переиспользуемые стартовые сессии, создаваемые до начала выполнения задачи.
 * Готовую строку могут форкнуть совместимые runtime, пока не истечёт её TTL
 * или пока более новый разогрев не очистит её в той же области runtime/профиля/модели.
 */
export const runtimeWarmupSessions = sqliteTable("runtime_warmup_sessions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull(),
  runtimeProfileId: text("runtime_profile_id"),
  runtimeId: text("runtime_id").notNull(),
  providerId: text("provider_id").notNull(),
  transport: text("transport"),
  model: text("model"),
  sourceSessionId: text("source_session_id"),
  status: text("status").$type<RuntimeWarmupSessionStatus>().notNull().default("creating"),
  ttlSeconds: integer("ttl_seconds").notNull(),
  expiresAt: text("expires_at").notNull(),
  summary: text("summary"),
  errorMessage: text("error_message"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type RuntimeWarmupSessionRow = typeof runtimeWarmupSessions.$inferSelect;
export type NewRuntimeWarmupSessionRow = typeof runtimeWarmupSessions.$inferInsert;

/**
 * Восстанавливаемый индекс сессий Codex для горячих путей запросов.
 * Источником истины остаются файлы на диске (~/.codex/sessions/*.jsonl).
 */
export const codexSessions = sqliteTable("codex_sessions", {
  sessionId: text("session_id").primaryKey(),
  filePath: text("file_path").notNull().unique(),
  title: text("title"),
  projectRoot: text("project_root"),
  accountFingerprint: text("account_fingerprint"),
  sourceCreatedAt: text("source_created_at"),
  sourceUpdatedAt: text("source_updated_at"),
  messageCount: integer("message_count").notNull().default(0),
  previewText: text("preview_text"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  mtimeMs: integer("mtime_ms").notNull().default(0),
  lastIndexedAt: text("last_indexed_at").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type CodexSessionRow = typeof codexSessions.$inferSelect;
export type NewCodexSessionRow = typeof codexSessions.$inferInsert;

/**
 * Отслеживает «грязность» и курсоры на уровне файлов для проходов сверки сессий Codex.
 */
export const codexSessionFiles = sqliteTable("codex_session_files", {
  filePath: text("file_path").primaryKey(),
  sessionId: text("session_id"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  mtimeMs: integer("mtime_ms").notNull().default(0),
  parsedOffset: integer("parsed_offset").notNull().default(0),
  pendingTail: text("pending_tail").notNull().default(""),
  missing: integer("missing", { mode: "boolean" }).notNull().default(false),
  importVersion: integer("import_version").notNull().default(1),
  lastSeenAt: text("last_seen_at").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type CodexSessionFileRow = typeof codexSessionFiles.$inferSelect;
export type NewCodexSessionFileRow = typeof codexSessionFiles.$inferInsert;

/**
 * Последний известный снапшот лимитов использования Codex по области аккаунт/проект/лимит.
 */
export const codexLimitHeads = sqliteTable("codex_limit_heads", {
  headKey: text("head_key").primaryKey(),
  accountFingerprint: text("account_fingerprint").notNull(),
  projectRoot: text("project_root"),
  limitId: text("limit_id").notNull(),
  model: text("model"),
  source: text("source").notNull().default("codex"),
  snapshotJson: text("snapshot_json").notNull(),
  observedAt: text("observed_at").notNull(),
  sessionId: text("session_id"),
  filePath: text("file_path"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type CodexLimitHeadRow = typeof codexLimitHeads.$inferSelect;
export type NewCodexLimitHeadRow = typeof codexLimitHeads.$inferInsert;

/**
 * Ограниченный набор последних снапшотов лимитов Codex для диагностики и истории.
 */
export const codexLimitHistory = sqliteTable("codex_limit_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  headKey: text("head_key").notNull(),
  accountFingerprint: text("account_fingerprint").notNull(),
  projectRoot: text("project_root"),
  limitId: text("limit_id").notNull(),
  model: text("model"),
  snapshotJson: text("snapshot_json").notNull(),
  observedAt: text("observed_at").notNull(),
  sessionId: text("session_id"),
  filePath: text("file_path"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type CodexLimitHistoryRow = typeof codexLimitHistory.$inferSelect;
export type NewCodexLimitHistoryRow = typeof codexLimitHistory.$inferInsert;

/**
 * Общее состояние курсора/водораздела индекса для конвейера сверки Codex.
 */
export const codexIndexCursors = sqliteTable("codex_index_cursors", {
  cursorKey: text("cursor_key").primaryKey(),
  cursorValue: text("cursor_value"),
  cursorJson: text("cursor_json"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type CodexIndexCursorRow = typeof codexIndexCursors.$inferSelect;
export type NewCodexIndexCursorRow = typeof codexIndexCursors.$inferInsert;
