// Доменный контракт между пакетами api/agent/runtime/web.
//
// Файл задаёт общие формы данных и допустимые значения без runtime-логики.
// Подход as const + (typeof X)[number] удерживает синхронность списка и типа.
//
// Необязательные поля нужно трактовать как "значение может отсутствовать в конкретной
// выборке", а не только как "NULL в БД".

export const TASK_STATUSES = [
  "backlog",
  "planning",
  "improve",
  "plan_review",
  "implementing",
  "review",
  "verify",
  "blocked_external",
  "done",
  "accepted",
] as const;

// Порядок статусов = порядок доменного конвейера и колонок Kanban.
export type TaskStatus = (typeof TASK_STATUSES)[number];

// Роли участников: администрирование проекта и исполнение задач.
export const PARTICIPANT_ROLES = ["admin", "member"] as const;

export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

// Владелец задачи определяет контур автоматизации и разрешения действий.
export const EXECUTION_OWNERS = ["ai", "human"] as const;

export type ExecutionOwner = (typeof EXECUTION_OWNERS)[number];

// Тип актора аудита: участник, агент, система или неаутентифицированный источник.
export const AUDIT_ACTOR_KINDS = ["participant", "agent", "system", "anonymous"] as const;

export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

// Состояние Auto-queue commit gate; not_applicable не является ошибкой.
export type AutoQueueCommitStatus =
  | "pending"
  | "running"
  | "committed"
  | "no_changes"
  | "not_applicable"
  | "failed";

// Стратегии Auto Review Gate: полный пересмотр или приоритет закрытия старых finding'ов.
export const AUTO_REVIEW_STRATEGIES = ["full_re_review", "closure_first"] as const;

export type AutoReviewStrategy = (typeof AUTO_REVIEW_STRATEGIES)[number];

export const AUTO_REVIEW_FINDING_SOURCES = [
  "code_review",
  "security_audit",
  "review_gate",
] as const;

export type AutoReviewFindingSource = (typeof AUTO_REVIEW_FINDING_SOURCES)[number];

// Finding авто-ревью хранит источник для UI и правил блокировки.
export interface AutoReviewFinding {
  id: string;
  text: string;
  source: AutoReviewFindingSource;
}

// Снимок Auto Review Gate: стратегия, итерация, набор finding'ов.
export interface AutoReviewState {
  strategy: AutoReviewStrategy;
  iteration: number;
  findings: AutoReviewFinding[];
}

/** Жизненный цикл Plan Review Gate для задач с VCS-связью. */
export const PLAN_REVIEW_STATES = ["published", "approved", "changes_requested"] as const;

export type PlanReviewState = (typeof PLAN_REVIEW_STATES)[number];

/** Режим тела PR/MR: черновик plan review или финальная сводка реализации. */
export const PULL_REQUEST_MODES = ["plan_review", "implementation"] as const;

export type PullRequestMode = (typeof PULL_REQUEST_MODES)[number];

// Проект в доменной модели: настройки автоматизации конвейера, значения runtime
// по умолчанию и связи с VCS.
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  plannerMaxBudgetUsd: number | null;
  planCheckerMaxBudgetUsd: number | null;
  implementerMaxBudgetUsd: number | null;
  reviewSidecarMaxBudgetUsd: number | null;
  pinnedAt: string | null;
  groupName: string | null;
  parallelEnabled: boolean;
  autoQueueMode: boolean;
  defaultTaskRuntimeProfileId?: string | null;
  defaultPlanRuntimeProfileId?: string | null;
  defaultReviewRuntimeProfileId?: string | null;
  defaultChatRuntimeProfileId?: string | null;
  /** Агрегированное использование по всем источникам: задачи, чат, коммит, roadmap. */
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  costUsd?: number;
  createdAt: string;
  updatedAt: string;
}

// Контракты интеграции с GitHub: элигибилити, связь с репозиторием, снимки issue и PR.
// У типов GitLab ниже сохранена та же структура для симметрии.
export interface GitHubEligibility {
  labels: string[];
  assignee: string | null;
  milestone: string | null;
}

export interface GitHubRepositoryConnection {
  projectId: string;
  owner: string;
  name: string;
  htmlUrl: string;
  defaultBranch: string;
  tokenEnvVar: string;
  eligibility: GitHubEligibility;
  enabled: boolean;
  tokenConfigured: boolean;
  lastSyncedAt: string | null;
  syncError: string | null;
  gitPreparedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubIssueCommentSnapshot {
  id: number;
  author: string;
  body: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubIssueSnapshot {
  title: string;
  body: string;
  author: string;
  labels: string[];
  assignees: string[];
  milestone: string | null;
  comments: GitHubIssueCommentSnapshot[];
}

// Связь задачи с issue/PR и состоянием проверок.
// lastReviewId защищает от повторной обработки одного ревью-события.
export interface GitHubIssueLink {
  projectId: string;
  issueNumber: number;
  taskId: string | null;
  nodeId: string;
  htmlUrl: string;
  state: "open" | "closed";
  metadata: GitHubIssueSnapshot;
  sourceUpdatedAt: string;
  lastSyncedAt: string;
  syncError: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prState: "open" | "closed" | "merged" | null;
  prChecksStatus: "pending" | "success" | "failure" | null;
  prMode: PullRequestMode | null;
  reviewState: "pending" | "approved" | "changes_requested" | null;
  lastReviewId: number | null;
  createdAt: string;
  updatedAt: string;
}

// Зеркальный контракт eligibility для GitLab.
export interface GitLabEligibility {
  labels: string[];
  assignee: string | null;
  milestone: string | null;
}

export interface GitLabRepositoryConnection {
  projectId: string;
  namespace: string;
  name: string;
  webUrl: string;
  defaultBranch: string;
  tokenEnvVar: string;
  eligibility: GitLabEligibility;
  enabled: boolean;
  tokenConfigured: boolean;
  lastSyncedAt: string | null;
  syncError: string | null;
  gitPreparedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitLabIssueCommentSnapshot {
  id: number;
  author: string;
  body: string;
  webUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitLabIssueSnapshot {
  title: string;
  body: string;
  author: string;
  labels: string[];
  assignees: string[];
  milestone: string | null;
  comments: GitLabIssueCommentSnapshot[];
}

// Зеркало GitHubIssueLink для GitLab (issue плюс merge request).
export interface GitLabIssueLink {
  projectId: string;
  iid: number;
  taskId: string | null;
  globalId: string;
  webUrl: string;
  state: "open" | "closed";
  metadata: GitLabIssueSnapshot;
  sourceUpdatedAt: string;
  lastSyncedAt: string;
  syncError: string | null;
  mrIid: number | null;
  mrUrl: string | null;
  mrState: "open" | "closed" | "merged" | null;
  mrChecksStatus: "pending" | "success" | "failure" | null;
  mrMode: PullRequestMode | null;
  reviewState: "pending" | "approved" | null;
  lastReviewNoteId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  rootPath?: string;
  plannerMaxBudgetUsd?: number;
  planCheckerMaxBudgetUsd?: number;
  implementerMaxBudgetUsd?: number;
  reviewSidecarMaxBudgetUsd?: number;
  parallelEnabled?: boolean;
  autoQueueMode?: boolean;
  defaultTaskRuntimeProfileId?: string | null;
  defaultPlanRuntimeProfileId?: string | null;
  defaultReviewRuntimeProfileId?: string | null;
  defaultChatRuntimeProfileId?: string | null;
}

export interface UpdateProjectOrganizationInput {
  pinned?: boolean;
  groupName?: string | null;
}

export interface AppSettings {
  id: number;
  defaultTaskRuntimeProfileId: string | null;
  defaultPlanRuntimeProfileId: string | null;
  defaultReviewRuntimeProfileId: string | null;
  defaultChatRuntimeProfileId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateAppSettingsInput {
  defaultTaskRuntimeProfileId?: string | null;
  defaultPlanRuntimeProfileId?: string | null;
  defaultReviewRuntimeProfileId?: string | null;
  defaultChatRuntimeProfileId?: string | null;
}

export interface TaskCommentAttachment {
  name: string;
  mimeType: string;
  size: number;
  /** Инлайн-содержимое (текст или base64). Устарело для бинарных файлов — используйте `path`. */
  content: string | null;
  /** Относительный путь в каталоге storage/. Присутствует у вложений, хранящихся файлом. */
  path?: string;
}

export interface ParticipantSummary {
  id: string;
  displayName: string;
  role: ParticipantRole;
  active: boolean;
}

export interface Participant extends ParticipantSummary {
  username: string;
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
}

export interface AuthSessionState {
  participantsModeEnabled: boolean;
  authenticated: boolean;
  participant: ParticipantSummary | null;
  csrfToken: string | null;
  expiresAt: string | null;
}

export interface CreateParticipantInput {
  username: string;
  displayName: string;
  password: string;
  role?: ParticipantRole;
}

export interface UpdateParticipantInput {
  displayName?: string;
  role?: ParticipantRole;
}

export interface ResetParticipantPasswordInput {
  password: string;
}

export interface TaskAssigneeSummary {
  participantId: string;
  displayName: string;
  role: ParticipantRole;
  active: boolean;
}

// Права актора на задачу в терминах интерфейса: что можно сделать кнопками, а не как
// именно это проверяется. Набор вычисляется функцией resolveTaskPermissions.
export interface TaskPermissions {
  canAssign: boolean;
  canHandoff: boolean;
  canSelfAssign: boolean;
  canAct: boolean;
  canComment: boolean;
  permittedActions: TaskEvent[];
}

export interface AuditActor {
  kind: AuditActorKind;
  id: string | null;
  displayNameSnapshot: string | null;
}

export interface TaskExecutorHistoryEntry {
  id: string;
  taskId: string;
  taskTitleSnapshot: string;
  ownershipRevision: number;
  executionOwner: ExecutionOwner;
  assignees: TaskAssigneeSummary[];
  statusSnapshot: TaskStatus;
  actor: AuditActor;
  reason: string | null;
  createdAt: string;
}

// Событие журнала аудита со снимками состояния. Снимки денормализованы: история
// должна читаться без обращения к живым таблицам, которые могли измениться или исчезнуть.
export interface AuditEvent {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  taskId: string | null;
  taskTitleSnapshot: string | null;
  participantId: string | null;
  participantDisplayNameSnapshot: string | null;
  executionOwnerSnapshot: ExecutionOwner | null;
  assigneesSnapshot: TaskAssigneeSummary[] | null;
  statusSnapshot: TaskStatus | null;
  actor: AuditActor;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// Текущее владение задачей: владелец, ревизия и состав назначений. Ревизия служит
// оптимистичной проверкой при передаче владения.
export interface TaskOwnership {
  executionOwner: ExecutionOwner;
  ownershipRevision: number;
  assignees: TaskAssigneeSummary[];
}

// Вход передачи владения. Поля expected* - это предварительное условие (optimistic
// locking): передача выполняется только если фактическое состояние совпадает с тем,
// которое видел вызывающий. Иначе возвращается конфликт, а не молчаливая перезапись.
export interface HandoffTaskInput {
  executionOwner: ExecutionOwner;
  assigneeIds: string[];
  expectedOwnershipRevision: number;
  expectedExecutionOwner?: ExecutionOwner;
  expectedStatus?: TaskStatus;
  reason?: string;
  resumeAction?: TaskEvent;
}

// Причины отказа при передаче владения. Коды - часть контракта: вызывающий код
// различает их, а текст сообщения служит только для человека.
export type TaskOwnershipConflictCode =
  | "task_not_found"
  | "task_locked"
  | "ownership_revision_conflict"
  | "inactive_assignee"
  | "invalid_ownership_transition"
  | "ai_handoff_required";

export interface TaskOwnershipConflict {
  code: TaskOwnershipConflictCode;
  message: string;
  ownership?: TaskOwnership;
}

// Задача в доменной модели. Объединяет бизнес-поля и служебные: прогресс этапа,
// блокировки параллельного исполнения, выбранный рантайм, состояние гейтов автоматизации.
// Необязательные поля (runtimeLimitSnapshot, github, gitlab, planReview*) заполняются
// только там, где нужны, поэтому читатель обязан обрабатывать их отсутствие.
export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  attachments?: TaskCommentAttachment[];
  autoMode: boolean;
  executionOwner: ExecutionOwner;
  ownershipRevision: number;
  assignees: TaskAssigneeSummary[];
  permissions?: TaskPermissions;
  isFix: boolean;
  plannerMode: string;
  planPath: string;
  planDocs: boolean;
  planTests: boolean;
  skipReview: boolean;
  useSubagents: boolean;
  runPlanImprove: boolean;
  runPostVerify: boolean;
  autoQa: boolean;
  qaChangeSummary: string | null;
  qaTestPlan: string | null;
  qaTestCases: string | null;
  qaStatus: "idle" | "running" | "done" | "error";
  status: TaskStatus;
  priority: number;
  position: number;
  plan: string | null;
  implementationLog: string | null;
  reviewComments: string | null;
  agentActivityLog: string | null;
  blockedReason: string | null;
  blockedFromStatus: TaskStatus | null;
  retryAfter: string | null;
  retryCount: number;
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  costUsd?: number;
  roadmapAlias: string | null;
  tags: string[];
  reworkRequested: boolean;
  reviewIterationCount: number;
  maxReviewIterations: number;
  manualReviewRequired: boolean;
  autoReviewState: AutoReviewState | null;
  paused: boolean;
  lastHeartbeatAt: string | null;
  lastActivityAt?: string | null;
  currentTool?: TaskCurrentTool | null;
  lastSyncedAt: string | null;
  runtimeProfileId?: string | null;
  modelOverride?: string | null;
  runtimeOptions?: Record<string, unknown> | null;
  sessionId: string | null;
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
  runtimeLimitUpdatedAt?: string | null;
  scheduledAt: string | null;
  branchName: string | null;
  worktreePath: string | null;
  autoQueueCommitStatus?: AutoQueueCommitStatus | null;
  autoQueueCommitBaseSha?: string | null;
  commitSha?: string | null;
  autoQueueCommitError?: string | null;
  autoQueueCommitCompletedAt?: string | null;
  planReviewState?: PlanReviewState | null;
  planReviewCommitSha?: string | null;
  planReviewPublishedAt?: string | null;
  planReviewApprovedAt?: string | null;
  planReviewFeedback?: string | null;
  createdAt: string;
  updatedAt: string;
  github?: GitHubIssueLink | null;
  gitlab?: GitLabIssueLink | null;
}

export interface TaskListItem {
  id: string;
  projectId: string;
  title: string;
  description: string;
  autoMode: boolean;
  executionOwner: ExecutionOwner;
  ownershipRevision: number;
  assignees: TaskAssigneeSummary[];
  permissions?: TaskPermissions;
  isFix: boolean;
  status: TaskStatus;
  priority: number;
  position: number;
  blockedReason: string | null;
  blockedFromStatus: TaskStatus | null;
  retryAfter: string | null;
  retryCount: number;
  tokenInput?: number;
  tokenOutput?: number;
  tokenTotal?: number;
  costUsd?: number;
  roadmapAlias: string | null;
  tags: string[];
  reworkRequested: boolean;
  reviewIterationCount: number;
  maxReviewIterations: number;
  manualReviewRequired: boolean;
  paused: boolean;
  lastSyncedAt: string | null;
  lastHeartbeatAt?: string | null;
  lastActivityAt?: string | null;
  currentTool?: TaskCurrentTool | null;
  runtimeProfileId?: string | null;
  modelOverride?: string | null;
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
  runtimeLimitUpdatedAt?: string | null;
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
  hasPlan: boolean;
}

export interface ProjectTaskPreview {
  id: string;
  title: string;
}

export interface ProjectTaskOverview {
  projectId: string;
  lastActivityAt: string | null;
  totalTasks: number;
  completedTasks: number;
  acceptedTasks: number;
  backlogTasks: number;
  activeTasks: number;
  blockedTasks: number;
  autoModeTasks: number;
  fixTasks: number;
  totalRetries: number;
  totalTokenInput: number;
  totalTokenOutput: number;
  totalTokenTotal: number;
  totalCostUsd: number;
  statusCounts: Record<TaskStatus, number>;
  statusPreviews: Record<TaskStatus, ProjectTaskPreview[]>;
}

export interface TaskActiveRuntimeSelection {
  status: TaskStatus;
  profileMode: "task" | "plan" | "review";
  source: string;
  profileId: string | null;
  runtimeId: string;
  providerId: string;
  transport: RuntimeTransport;
  model: string | null;
  baseUrl: string | null;
  apiKeyEnvVar: string | null;
  headers: Record<string, string>;
  options: Record<string, unknown>;
  pinnedAt: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  author: "human" | "agent";
  participantId: string | null;
  participant: ParticipantSummary | null;
  message: string;
  attachments: TaskCommentAttachment[];
  createdAt: string;
}

/** Тело POST /tasks/:id/comments */
export interface CreateTaskCommentInput {
  message: string;
  attachments?: TaskCommentAttachment[];
}

/** Тело POST /tasks */
export interface CreateTaskInput {
  projectId: string;
  title: string;
  description: string;
  priority?: number;
  autoMode?: boolean;
  executionOwner?: ExecutionOwner;
  assigneeIds?: string[];
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
}

/** Тело PUT /tasks/:id */
export interface UpdateTaskInput {
  title?: string;
  description?: string;
  attachments?: TaskCommentAttachment[];
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
  plan?: string | null;
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
  scheduledAt?: string | null;
}

// Действия над задачей. Список закрытый и является основой конечного автомата: каждое
// действие обрабатывается отдельной ветвью в stateMachine.ts.
export const TASK_EVENTS = [
  "start_ai",
  "start_human_work",
  "mark_plan_ready",
  "start_implementation",
  "approve_plan",
  "request_plan_changes",
  "submit_implementation",
  "complete_review",
  "request_review_changes",
  "pass_verification",
  "fail_verification",
  "request_replanning",
  "fast_fix",
  "approve_done",
  "request_changes",
  "retry_from_blocked",
] as const;

export type TaskEvent = (typeof TASK_EVENTS)[number];

/** Тело POST /tasks/:id/events */
export interface TaskEventInput {
  event: TaskEvent;
  deletePlanFile?: boolean;
  commitOnApprove?: boolean;
}

/** Тело PATCH /tasks/:id/position */
export interface ReorderTaskInput {
  position: number;
}

/** Типы событий WebSocket */
export type WsEventType =
  | "project:created"
  | "project:organization_updated"
  | "participant:created"
  | "participant:updated"
  | "participant:deactivated"
  | "auth:session_revoked"
  | "task:created"
  | "task:updated"
  | "task:deleted"
  | "task:moved"
  | "task:assignment_updated"
  | "task:handoff"
  | "task:comment_created"
  | "agent:wake"
  | "roadmap:complete"
  | "roadmap:error"
  | "chat:token"
  | "chat:done"
  | "chat:error"
  | "chat:session_created"
  | "chat:session_deleted"
  | "sync:task_created"
  | "sync:task_updated"
  | "sync:status_changed"
  | "sync:plan_pushed"
  | "task:activity"
  | "task:scheduled_fired"
  | "project:auto_queue_mode_changed"
  | "project:auto_queue_advanced"
  | "project:runtime_limit_updated"
  | "project:warmup_updated"
  | "task:commit_started"
  | "task:commit_done"
  | "task:commit_failed"
  | "task:qa_started"
  | "task:qa_done"
  | "task:qa_failed"
  | "task:heartbeat"
  | "task:usage_updated";

export interface RoadmapCompletePayload {
  projectId: string;
  roadmapAlias: string;
  created: number;
  skipped: number;
  taskIds: string[];
  byPhase: Record<number, { created: number; skipped: number }>;
}

export interface RoadmapErrorPayload {
  projectId: string;
  roadmapAlias: string;
  error: string;
  code: string;
}

/**
 * Событие отправляется, когда при approve-done включён флаг "create commit".
 * Нужен для отображения жизненного цикла fire-and-forget запуска `/aif-commit` в UI.
 * Поле `status` частично дублирует `type`, но делает payload самодостаточным.
 */
export interface TaskCommitPayload {
  taskId: string;
  projectId: string;
  status: "started" | "done" | "failed";
  error?: string;
}

/**
 * Жизненный цикл запусков `/aif-qa`:
 * ручной (`POST /tasks/:id/run-qa`) или автостарт при `approve_done`,
 * если `task.autoQa = true`.
 */
export interface TaskQaPayload {
  taskId: string;
  projectId: string;
  status: "started" | "done" | "failed";
  error?: string;
}

export interface RuntimeLimitBroadcastPayload {
  projectId: string;
  runtimeProfileId: string | null;
  taskId?: string | null;
}

export interface WarmupBroadcastPayload {
  projectId: string;
  status: "ready" | "failed" | "partial" | "cleared" | "expired";
}

export interface ParticipantBroadcastPayload {
  participant: ParticipantSummary;
  actor: AuditActor;
}

export interface ParticipantSessionRevokedPayload {
  participantId: string;
}

export interface TaskOwnershipBroadcastPayload {
  taskId: string;
  projectId: string;
  ownership: TaskOwnership;
  actor: AuditActor;
  responsibleParticipants?: TaskAssigneeSummary[];
}

export interface TaskCommentBroadcastPayload {
  taskId: string;
  projectId: string;
  comment: TaskComment;
  actor: AuditActor;
  responsibleParticipants?: ParticipantSummary[];
}

export interface WsEvent {
  type: WsEventType;
  payload:
    | Task
    | Project
    | { id: string }
    | RoadmapCompletePayload
    | RoadmapErrorPayload
    | ChatStreamTokenPayload
    | ChatDonePayload
    | ChatErrorPayload
    | ChatSession
    | TaskCommitPayload
    | TaskQaPayload
    | RuntimeLimitBroadcastPayload
    | WarmupBroadcastPayload
    | ParticipantBroadcastPayload
    | ParticipantSessionRevokedPayload
    | TaskOwnershipBroadcastPayload
    | TaskCommentBroadcastPayload
    | TaskHeartbeatPayload
    | TaskUsagePayload;
}

// Способы подключения к рантайму. Значения строковые, потому что они попадают в
// конфигурацию и в JSON: SDK - библиотека в процессе, CLI - внешний исполняемый файл,
// APP_SERVER - отдельный серверный процесс, API - прямой HTTP-вызов провайдера.
export const RuntimeTransport = {
  /** Agent SDK — запрос в том же процессе */
  SDK: "sdk",
  /** Дочерний процесс CLI — запуск бинарника и разбор stdout */
  CLI: "cli",
  /** Дочерний процесс Codex app-server поверх stdio JSONL */
  APP_SERVER: "app-server",
  /** HTTP API — POST на удалённый эндпоинт runtime */
  API: "api",
} as const;

export type RuntimeTransport = (typeof RuntimeTransport)[keyof typeof RuntimeTransport];

/** Все известные значения транспорта для валидации и списков выбора UI. */
export const RUNTIME_TRANSPORTS: readonly RuntimeTransport[] = Object.values(RuntimeTransport);

export function isRuntimeTransport(value: unknown): value is RuntimeTransport {
  return typeof value === "string" && RUNTIME_TRANSPORTS.includes(value as RuntimeTransport);
}

/** Дескриптор runtime, возвращаемый GET /runtime-profiles/runtimes */
export interface RuntimeDescriptor {
  id: string;
  providerId: string;
  displayName: string;
  description?: string | null;
  capabilities: Record<string, boolean>;
  defaultTransport?: string | null;
  defaultApiKeyEnvVar?: string | null;
  defaultBaseUrlEnvVar?: string | null;
  defaultBaseUrl?: string | null;
  defaultModelPlaceholder?: string | null;
  supportedTransports?: string[];
}

export interface RuntimeProfileUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number | null;
}

// Профиль рантайма: рантайм, провайдер, транспорт, модель и заголовки запросов. Профиль
// может принадлежать проекту или быть глобальным; снимок лимитов хранится здесь же,
// чтобы интерфейс показывал остаток без обращения к провайдеру.
export interface RuntimeProfile {
  id: string;
  projectId: string | null;
  name: string;
  runtimeId: string;
  providerId: string;
  transport: string | null;
  baseUrl: string | null;
  apiKeyEnvVar: string | null;
  defaultModel: string | null;
  headers: Record<string, string>;
  options: Record<string, unknown>;
  enabled: boolean;
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
  runtimeLimitUpdatedAt?: string | null;
  lastUsage?: RuntimeProfileUsage | null;
  lastUsageAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRuntimeProfileInput {
  projectId?: string | null;
  name: string;
  runtimeId: string;
  providerId: string;
  transport?: string | null;
  baseUrl?: string | null;
  apiKeyEnvVar?: string | null;
  defaultModel?: string | null;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  enabled?: boolean;
}

export interface UpdateRuntimeProfileInput {
  projectId?: string | null;
  name?: string;
  runtimeId?: string;
  providerId?: string;
  transport?: string | null;
  baseUrl?: string | null;
  apiKeyEnvVar?: string | null;
  defaultModel?: string | null;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  enabled?: boolean;
}

export type EffectiveRuntimeProfileSource =
  | "task_override"
  | "project_default"
  | "system_default"
  | "none";

export interface EffectiveRuntimeProfileSelection {
  source: EffectiveRuntimeProfileSource;
  profile: RuntimeProfile | null;
  taskRuntimeProfileId: string | null;
  projectRuntimeProfileId: string | null;
  systemRuntimeProfileId: string | null;
}

// Поля лимитов объявлены объектами-перечислениями: они попадают в JSON и в интерфейс,
// поэтому значения строковые, а не числовые.
export const RuntimeLimitSource = {
  PROVIDER_API: "provider_api",
  SDK_EVENT: "sdk_event",
  API_HEADERS: "api_headers",
  TURN_USAGE: "turn_usage",
} as const;

export type RuntimeLimitSource = (typeof RuntimeLimitSource)[keyof typeof RuntimeLimitSource];

// Состояние лимита: warning - пройден порог предупреждения, blocked - расход исчерпан.
// Решение принимается по остатку в процентах, а не по абсолютным значениям.
export const RuntimeLimitStatus = {
  OK: "ok",
  WARNING: "warning",
  BLOCKED: "blocked",
  UNKNOWN: "unknown",
} as const;

export type RuntimeLimitStatus = (typeof RuntimeLimitStatus)[keyof typeof RuntimeLimitStatus];

// Точность данных важна для решений: exact берётся из ответов API, heuristic рассчитан
// из событий использования и годится только для отображения.
export const RuntimeLimitPrecision = {
  EXACT: "exact",
  HEURISTIC: "heuristic",
} as const;

export type RuntimeLimitPrecision =
  (typeof RuntimeLimitPrecision)[keyof typeof RuntimeLimitPrecision];

// Что именно ограничивает провайдер: запросы, токены, время, деньги или использование
// конкретной модели либо инструмента.
export const RuntimeLimitScope = {
  REQUESTS: "requests",
  TOKENS: "tokens",
  TIME: "time",
  SPEND: "spend",
  TURN_USAGE: "turn_usage",
  MODEL_USAGE: "model_usage",
  TOOL_USAGE: "tool_usage",
  OTHER: "other",
} as const;

export type RuntimeLimitScope = (typeof RuntimeLimitScope)[keyof typeof RuntimeLimitScope];

// Одно окно лимита с его границами и остатком. Числовые поля необязательны, потому что
// провайдеры отдают разные подмножества: где-то есть только остаток, где-то только
// использованное количество.
export interface RuntimeLimitWindow {
  scope: RuntimeLimitScope;
  name?: string | null;
  unit?: string | null;
  limit?: number | null;
  remaining?: number | null;
  used?: number | null;
  percentUsed?: number | null;
  percentRemaining?: number | null;
  resetAt?: string | null;
  retryAfterSeconds?: number | null;
  warningThreshold?: number | null;
}

// Снимок лимитов на момент checkedAt. Хранится в задаче и в профиле рантайма, чтобы
// интерфейс показывал остаток без обращения к провайдеру. providerMeta - произвольные
// метаданные провайдера, которые перед выдачей проходят санитизацию (runtimeLimitUtils).
export interface RuntimeLimitSnapshot {
  source: RuntimeLimitSource;
  status: RuntimeLimitStatus;
  precision: RuntimeLimitPrecision;
  checkedAt: string;
  providerId: string;
  runtimeId?: string | null;
  profileId?: string | null;
  primaryScope?: RuntimeLimitScope | null;
  resetAt?: string | null;
  retryAfterSeconds?: number | null;
  warningThreshold?: number | null;
  windows: RuntimeLimitWindow[];
  providerMeta?: Record<string, unknown> | null;
}

export interface RuntimeLimitEventPayload {
  snapshot: RuntimeLimitSnapshot;
  rawType?: string | null;
}

// ── Типы сессий чата ──────────────────────────────────────

// Источник чат-сессии: из интерфейса или из другого канала. Влияет на то, какие
// действия предлагаются пользователю.
export type ChatSessionSource = "web" | "cli" | "agent";

// Чат-сессия: переписка с рантаймом вне контекста задачи. Хранит профиль рантайма и
// идентификатор сессии провайдера, чтобы продолжить диалог после перезапуска.
export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  agentSessionId: string | null;
  runtimeProfileId?: string | null;
  runtimeSessionId?: string | null;
  source: ChatSessionSource;
  createdAt: string;
  updatedAt: string;
}

export interface CreateChatSessionInput {
  projectId: string;
  title?: string;
  runtimeProfileId?: string | null;
  runtimeSessionId?: string | null;
}

export interface UpdateChatSessionInput {
  title?: string;
  agentSessionId?: string | null;
  runtimeProfileId?: string | null;
  runtimeSessionId?: string | null;
}

export interface ChatMessageAttachment {
  name: string;
  mimeType: string;
  size: number;
  path?: string;
}

export interface ChatSessionMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  attachments?: ChatMessageAttachment[];
  createdAt: string;
}

// ── Типы чата ──────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  attachments?: ChatMessageAttachment[];
}

export interface ChatAttachment {
  name: string;
  mimeType: string;
  size: number;
  content: string | null;
}

export interface ChatRequest {
  projectId: string;
  message: string;
  clientId?: string;
  conversationId?: string;
  sessionId?: string;
  explore?: boolean;
  /** ID открытой сейчас задачи — даёт контекст чат-агенту */
  taskId?: string;
  attachments?: ChatAttachment[];
}

// ── Действия чата (структурные блоки в ответах ИИ) ───────

export interface ChatActionCreateTask {
  type: "create_task";
  title: string;
  description: string;
  isFix?: boolean;
}

export type ChatAction = ChatActionCreateTask;

export interface ChatStreamTokenPayload {
  conversationId: string;
  token: string;
}

/**
 * Расход токенов за один ход, отправляемый на фронтенд вместе с событием
 * `chat:done`. Структурно совпадает с `RuntimeUsage` из `@aif/runtime`, но
 * продублирован здесь, чтобы `@aif/shared` не зависел от слоя runtime.
 */
export interface ChatDoneUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface ChatDonePayload {
  conversationId: string;
  /** Null, если адаптер/транспорт не сообщает расход за этот ход. */
  usage?: ChatDoneUsage | null;
  projectId?: string;
  taskId?: string | null;
  runtimeProfileId?: string | null;
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
}

/** Облегчённый хартбит задачи, рассылаемый в UI доски/деталей. */
export interface TaskHeartbeatPayload {
  taskId: string;
  lastHeartbeatAt: string | null;
}

/** Инструмент, который агент запустил, но ещё не завершил (в процессе). */
export interface TaskCurrentTool {
  name: string;
  detail?: string;
  startedAt: string;
}

/** Дельта расхода по задаче, рассылаемая на границе запуска. */
export interface TaskUsagePayload {
  taskId: string;
  projectId: string;
  usage: ChatDoneUsage;
}

export interface ChatErrorPayload {
  conversationId: string;
  message: string;
  code?: string;
  projectId?: string;
  taskId?: string | null;
  runtimeProfileId?: string | null;
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
}
