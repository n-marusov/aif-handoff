// Node-точка входа пакета `@aif/shared` (основной подпуть `.`).
//
// Здесь собран публичный API, который импортируют api, agent и runtime: схема БД,
// типы домена, валидация окружения, правила состояний, работа с git.
// Файл почти целиком состоит из реэкспортов и служит картой публичной поверхности
// пакета: чтобы понять, что доступно потребителям, достаточно прочитать его.
//
// ВАЖНО: этот вход тянет Node-зависимости (pino, node:fs, git), поэтому фронтенду
// он недоступен. Браузерный код обязан импортировать `@aif/shared/browser`. Сам
// драйвер SQLite и миграции живут в @aif/data (сабпуть @aif/data/db) — общий вход
// `@aif/shared` больше не открывает доступ к базе.

// Схема БД
export {
  projects,
  appSettings,
  participants,
  participantSessions,
  tasks,
  taskComments,
  taskAssignments,
  taskExecutorHistory,
  auditEvents,
  githubRepositories,
  githubIssues,
  gitlabRepositories,
  gitlabIssues,
  runtimeProfiles,
  chatSessions,
  chatMessages,
  usageEvents,
  runtimeWarmupSessions,
  codexSessions,
  codexSessionFiles,
  codexLimitHeads,
  codexLimitHistory,
  codexIndexCursors,
} from "./schema.js";
// Отдельный блок типов строк: их выводит Drizzle из таблиц, поэтому они всегда
// соответствуют схеме и не пишутся руками. Потребители используют их при работе с
// результатами запросов.
export type {
  ProjectRow,
  NewProjectRow,
  AppSettingsRow,
  NewAppSettingsRow,
  ParticipantRow,
  NewParticipantRow,
  ParticipantSessionRow,
  NewParticipantSessionRow,
  TaskRow,
  NewTaskRow,
  TaskCommentRow,
  NewTaskCommentRow,
  TaskAssignmentRow,
  NewTaskAssignmentRow,
  TaskExecutorHistoryRow,
  NewTaskExecutorHistoryRow,
  AuditEventRow,
  NewAuditEventRow,
  GitHubRepositoryRow,
  NewGitHubRepositoryRow,
  GitHubIssueRow,
  NewGitHubIssueRow,
  GitLabRepositoryRow,
  NewGitLabRepositoryRow,
  GitLabIssueRow,
  NewGitLabIssueRow,
  RuntimeProfileRow,
  NewRuntimeProfileRow,
  ChatSessionRow,
  NewChatSessionRow,
  ChatMessageRow,
  NewChatMessageRow,
  UsageEventRow,
  NewUsageEventRow,
  RuntimeWarmupSessionStatus,
  RuntimeWarmupSessionRow,
  NewRuntimeWarmupSessionRow,
  CodexSessionRow,
  NewCodexSessionRow,
  CodexSessionFileRow,
  NewCodexSessionFileRow,
  CodexLimitHeadRow,
  NewCodexLimitHeadRow,
  CodexLimitHistoryRow,
  NewCodexLimitHistoryRow,
  CodexIndexCursorRow,
  NewCodexIndexCursorRow,
} from "./schema.js";

// Доменные типы и наборы допустимых значений (статусы, роли, владельцы, состояния
// ревью). Именно они, а не таблицы базы, являются контрактом между пакетами.
// Типы
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
  type TaskActiveRuntimeSelection,
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
  type ParticipantBroadcastPayload,
  type ParticipantSessionRevokedPayload,
  type TaskOwnershipBroadcastPayload,
  type TaskCommentBroadcastPayload,
  type TaskCurrentTool,
  type ChatMessage,
  type ChatMessageAttachment,
  type ChatRequest,
  type ChatStreamTokenPayload,
  type ChatDonePayload,
  type ChatErrorPayload,
  type ChatAction,
  type ChatActionCreateTask,
  isRuntimeTransport,
  RUNTIME_TRANSPORTS,
  RuntimeTransport,
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

// Окружение
// getEnv отдаёт уже проверенные и закэшированные переменные, а resetEnvCache нужен
// тестам: без него подменённое окружение не было бы перечитано.
export { getEnv, validateEnv, resetEnvCache } from "./env.js";
export type { Env } from "./env.js";

// Константы
// Единые подписи, цвета и порядок статусов: один источник правды и для сервера, и для UI.
export {
  STATUS_CONFIG,
  ORDERED_STATUSES,
  WARMUP_TARGETS,
  WARMUP_WORKFLOW_KINDS,
  DEFAULT_WARMUP_TARGET,
  NON_COMMIT_PATH_PATTERNS,
  isWarmupWorkflowKind,
  type WarmupTarget,
  type WarmupWorkflowKind,
  type WarmupProfileMode,
} from "./constants.js";
// Правила жизненного цикла: что можно сделать с задачей в текущем статусе и кто
// имеет на это право. Модуль экспортируется и в браузерный вход - доска считает
// доступные пользователю действия теми же функциями, что и сервер.
export {
  applyHumanTaskEvent,
  resolveTaskAction,
  resolveTaskPermissions,
  HUMAN_ACTIONS_BY_STATUS,
  CLEAN_STATE_RESET,
  type TaskActionContext,
  type TaskActionDeniedCode,
  type TaskPolicyView,
  type TransitionPatch,
  type TransitionResult,
} from "./stateMachine.js";

// Логгер
export { logger, rootLogger } from "./logger.js";

// Определение корня монорепозитория
export { findMonorepoRoot, findMonorepoRootFromUrl } from "./monorepoRoot.js";

// Инициализация проекта
export { initBaseProjectDirectory } from "./projectInit.js";
export {
  slugify,
  generatePlanPath,
  getCanonicalPlanPath,
  syncPlanTextToCanonicalFile,
} from "./planFile.js";
export type { GeneratePlanPathOptions } from "./planFile.js";

// Валидация путей
export { validateProjectRootPath } from "./pathValidation.js";

// Утилиты изоляции задач через git/worktree (только Node)
// Изоляция задач по git-worktree: каждая задача получает собственную рабочую копию и
// ветку, поэтому параллельные исполнители не мешают друг другу. Модуль серверный -
// использует node:child_process.
export {
  BranchIsolationError,
  applyGitIdentity,
  assertCurrentBranch,
  assertWorkingTreeClean,
  branchExists,
  buildBranchName,
  buildProjectWorktreeSegment,
  buildTaskWorktreePath,
  countCommitsBetween,
  describeDirtyWorkingTree,
  ensureFeatureBranch,
  ensureTaskWorktree,
  getCurrentBranch,
  getHeadCommitSha,
  isBranchIsolationError,
  isGitRepo,
  isWorktreeUsable,
  listChangedFiles,
  listCommitFiles,
  listWorktrees,
  projectSupportsTaskWorktrees,
  projectUsesSharedBranchIsolation,
  pruneWorktrees,
  removeWorktreeForce,
  resolveWorktreeRoot,
  restorePersistedBranch,
  slugifyTitle,
  validateBranchName,
  workingTreeClean,
  pullDefaultBranch,
  type BuildTaskWorktreePathInput,
  type EnsureFeatureBranchInput,
  type EnsureFeatureBranchResult,
  type EnsureTaskWorktreeInput,
  type EnsureTaskWorktreeResult,
  type RestorePersistedBranchInput,
  type WorktreeEntry,
} from "./gitIsolation.js";

export { buildAutoQueueCommitPrompt, buildCommitPrompt } from "./commitWorkflow.js";

// Работа с вложениями
// Разбор вложений из JSON-колонки и подготовка их текста для промпта агента.
export {
  parseAttachments,
  isFileBackedAttachment,
  formatAttachmentsForPrompt,
  extractHeadings,
  looksLikeFullPlanUpdate,
  type ParsedAttachment,
} from "./attachments.js";

// Метрики расхода токенов задач
// Приведение отчётов SDK о токенах к единому виду: разные рантаймы присылают данные
// в snake_case и camelCase.
export { parseTaskTokenUsage, type TaskTokenUsage } from "./taskUsage.js";

// Утилиты синхронизации
// Разметка плана ссылками на задачи: аннотации переживают правки Markdown.
export {
  type SyncDirection,
  type ConflictResolution,
  type SyncEvent,
  type PlanAnnotation,
  parsePlanAnnotations,
  insertPlanAnnotation,
} from "./sync.js";

// Конфигурация проекта (config.yaml)
// Разрешённая конфигурация проекта: умолчания плюс значения из config.yaml.
export {
  getProjectConfig,
  clearProjectConfigCache,
  type AifProjectConfig,
  type AifProjectPaths,
  type AifProjectWorkflow,
  type AifProjectGit,
  type AifProjectLanguage,
} from "./projectConfig.js";

// Единое правило корня исполнения задачи (worktree ?? project.rootPath).
export { taskExecutionRoot, type TaskExecutionRootFields } from "./taskExecutionRoot.js";

// Уведомления Telegram
export {
  escapeMarkdown,
  sendTelegramNotification,
  type TelegramNotificationOptions,
} from "./telegram.js";

// Значения по умолчанию режимов планировщика
// Набор флагов планирования по режиму (full/fast): одинаков для UI и для сервера.
export { defaultsForMode } from "./plannerDefaults.js";
export type { PlannerMode, PlannerFlagDefaults } from "./plannerDefaults.js";

// Утилиты
export { withTimeout } from "./withTimeout.js";
export { parseMcpPortSetting, type ParsedMcpPortSetting } from "./mcpPort.js";

// Общие утилиты лимитов runtime
// Нормализация, подписывание и санитизация данных о лимитах рантайма. Функции
// редакции (redact*, sanitize*) обязательны перед записью в логи или отдачей в UI:
// в исходных данных встречаются служебные поля провайдера.
export {
  buildRuntimeLimitSignature,
  mapSafeRuntimeErrorReason,
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

// Классификация для обнаружения циклов
// Импорт и реэкспорт разделены намеренно: так видно, что значения объявлены в другом
// модуле, а здесь только публикуются.
import { isReadOnlyToolCall, READ_ONLY_TOOLS, READ_ONLY_BASH_PATTERNS } from "./loopDetection.js";
export { isReadOnlyToolCall, READ_ONLY_TOOLS, READ_ONLY_BASH_PATTERNS };

// Доменная политика runtime-limit gate и приоритетов runtime-профиля (только Node)
// Чистые решения без доступа к БД: применяются data/api/agent через импорт.
export {
  evaluateRuntimeLimitGate,
  getProjectRuntimeProfileId,
  isRuntimeLimitAwarenessEnabled,
  type RuntimeLimitGateDecision,
} from "./runtimeLimitGate.js";

// Презентационные мапперы (только Node)
// Преобразование строк БД в view-модели для HTTP/WebSocket/MCP. Модуль серверный:
// использует pino и не входит в браузерный вход @aif/shared/browser.
export {
  parseRuntimeLimitSnapshot,
  parseRuntimeObject,
  parseTaskCurrentTool,
  toAppSettingsResponse,
  toChatMessageResponse,
  toChatSessionResponse,
  toCommentResponse,
  toRuntimeProfileResponse,
  toTaskListItem,
  toTaskResponse,
  toTaskSummary,
  type RuntimeProfileUsageState,
  type TaskListItemRow,
  type TaskSummaryRow,
} from "./presenters.js";
