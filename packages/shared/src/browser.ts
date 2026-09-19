/**
 * Браузерная точка входа пакета (`@aif/shared/browser`).
 *
 * Публикуется только то, что безопасно для бандла фронтенда: типы, константы и чистые
 * функции без Node-зависимостей. Ничто отсюда не должно тянуть pino,
 * node:fs или node:child_process - иначе сборка web либо упадёт, либо утащит серверный код
 * в браузер. Это один из двух входов пакета наряду с основным (index.ts); драйвер SQLite
 * живёт в @aif/data (сабпуть @aif/data/db).
 */

// Типы существуют только на этапе компиляции и в бандл не попадают, поэтому
// перечислять их здесь дёшево. Наборы значений (TASK_STATUSES, PARTICIPANT_ROLES и
// другие) идут сюда потому, что UI должен валидировать данные теми же списками, что
// и сервер, а не дублировать их у себя.
export {
  TASK_STATUSES,
  type TaskStatus,
  PARTICIPANT_ROLES,
  type ParticipantRole,
  EXECUTION_OWNERS,
  type ExecutionOwner,
  AUDIT_ACTOR_KINDS,
  type AuditActorKind,
  type AutoQueueCommitStatus,
  AUTO_REVIEW_STRATEGIES,
  type AutoReviewStrategy,
  AUTO_REVIEW_FINDING_SOURCES,
  type AutoReviewFindingSource,
  type AutoReviewFinding,
  type AutoReviewState,
  PLAN_REVIEW_STATES,
  type PlanReviewState,
  PULL_REQUEST_MODES,
  type PullRequestMode,
  type Project,
  type GitHubEligibility,
  type GitHubRepositoryConnection,
  type GitHubIssueCommentSnapshot,
  type GitHubIssueSnapshot,
  type GitHubIssueLink,
  type GitLabEligibility,
  type GitLabRepositoryConnection,
  type GitLabIssueCommentSnapshot,
  type GitLabIssueSnapshot,
  type GitLabIssueLink,
  type UpdateProjectOrganizationInput,
  type CreateProjectInput,
  type AppSettings,
  type UpdateAppSettingsInput,
  type Task,
  type TaskListItem,
  type ParticipantSummary,
  type Participant,
  type AuthSessionState,
  type CreateParticipantInput,
  type UpdateParticipantInput,
  type ResetParticipantPasswordInput,
  type TaskAssigneeSummary,
  type TaskPermissions,
  type AuditActor,
  type AuditEvent,
  type TaskExecutorHistoryEntry,
  type TaskOwnership,
  type HandoffTaskInput,
  type TaskOwnershipConflictCode,
  type TaskOwnershipConflict,
  type ProjectTaskPreview,
  type ProjectTaskOverview,
  type CreateTaskInput,
  type UpdateTaskInput,
  type TaskComment,
  type TaskCommentAttachment,
  type CreateTaskCommentInput,
  TASK_EVENTS,
  type TaskEvent,
  type TaskEventInput,
  type ReorderTaskInput,
  type WsEventType,
  type WsEvent,
  type RoadmapCompletePayload,
  type RoadmapErrorPayload,
  type TaskCommitPayload,
  type TaskQaPayload,
  type RuntimeLimitBroadcastPayload,
  type ParticipantBroadcastPayload,
  type ParticipantSessionRevokedPayload,
  type TaskOwnershipBroadcastPayload,
  type TaskCommentBroadcastPayload,
  type TaskHeartbeatPayload,
  type TaskUsagePayload,
  type TaskCurrentTool,
  type ChatMessage,
  type ChatMessageAttachment,
  type ChatAttachment,
  type ChatRequest,
  type ChatStreamTokenPayload,
  type ChatDonePayload,
  type ChatErrorPayload,
  type ChatAction,
  type ChatActionCreateTask,
  isRuntimeTransport,
  RUNTIME_TRANSPORTS,
  RuntimeTransport,
  type RuntimeDescriptor,
  type RuntimeProfileUsage,
  type RuntimeProfile,
  type CreateRuntimeProfileInput,
  type UpdateRuntimeProfileInput,
  type EffectiveRuntimeProfileSource,
  type EffectiveRuntimeProfileSelection,
  RuntimeLimitSource,
  RuntimeLimitStatus,
  RuntimeLimitPrecision,
  RuntimeLimitScope,
  type RuntimeLimitWindow,
  type RuntimeLimitSnapshot,
  type RuntimeLimitEventPayload,
  type WarmupBroadcastPayload,
  type ChatSessionSource,
  type ChatSession,
  type CreateChatSessionInput,
  type UpdateChatSessionInput,
  type ChatSessionMessage,
} from "./types.js";

export {
  STATUS_CONFIG,
  ORDERED_STATUSES,
  WARMUP_TARGETS,
  WARMUP_WORKFLOW_KINDS,
  DEFAULT_WARMUP_TARGET,
  isWarmupWorkflowKind,
  type WarmupTarget,
  type WarmupWorkflowKind,
  type WarmupProfileMode,
} from "./constants.js";
// Правила авторизации и переходов - чистые функции без ввода-вывода, поэтому доска
// может заранее посчитать, какие действия доступны пользователю, не обращаясь к
// серверу за каждым решением.
export {
  resolveTaskAction,
  resolveTaskPermissions,
  HUMAN_ACTIONS_BY_STATUS,
  type TaskActionContext,
  type TaskActionDeniedCode,
  type TaskPolicyView,
  type TransitionPatch,
  type TransitionResult,
} from "./stateMachine.js";
export { withTimeout } from "./withTimeout.js";
// Санитизация и редакция данных о лимитах нужны и в UI: то, что показывается
// пользователю, обязано проходить те же преобразования, что на сервере, иначе на
// экран попадут служебные поля провайдера.
export {
  buildRuntimeLimitSignature,
  normalizeRuntimeLimitSnapshot,
  redactProviderText,
  redactProviderTextForLogs,
  resolveRuntimeLimitFutureHint,
  sanitizeRuntimeLimitSnapshotForExposure,
  sanitizeProviderMeta,
  selectViolatedWindowForExactThreshold,
  type RuntimeLimitFutureHint,
  type RuntimeLimitFutureHintSource,
  type RuntimeLimitSnapshotExposure,
  type SafeRuntimeErrorCategory,
  type SafeRuntimeErrorReason,
} from "./runtimeLimitUtils.js";

// Пути к планам нужны и в UI (показ ссылки на файл), поэтому модуль вынесен отдельно и
// сознательно не использует node:path.
export { slugify, generatePlanPath } from "./planPath.js";
export type { GeneratePlanPathOptions } from "./planPath.js";

// Из sync.ts берутся только типы: сам модуль создаёт логгер pino, который в браузерном
// бандле недопустим.
export type { SyncDirection, ConflictResolution, SyncEvent, PlanAnnotation } from "./sync.js";

// Флаги планирования по умолчанию нужны в UI, чтобы форма создания задачи показывала те
// же значения, которые применит сервер в выбранном режиме.
export { defaultsForMode } from "./plannerDefaults.js";
export type { PlannerMode, PlannerFlagDefaults } from "./plannerDefaults.js";
