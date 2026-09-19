/**
 * Пакет @aif/data: единственный разрешённый слой доступа к базе данных.
 *
 * Пакеты api, agent и runtime не имеют права импортировать drizzle-orm напрямую - запрет
 * проверяется правилом ESLint. Поэтому любое чтение и любая запись в SQLite проходят через
 * функции этого пакета, и здесь же сосредоточены знания о схеме и о том, какие изменения
 * должны быть атомарными.
 *
 * Модуль построен по принципу "одна функция = одно намерение": вызывающий код не собирает
 * SQL-фрагменты сам, а выбирает подходящую операцию.
 *
 * Это баррель: вся реализация разложена по тематическим модулям (tasks, comments,
 * projects, settings, chat, runtimeProfiles, runtimeLimits, codexIndex, usage,
 * coordinatorClaims). Внутренние помощники живут в internal.ts и не реэкспортируются,
 * чтобы публичная поверхность пакета не расширялась.
 */

// Реэкспорты ниже собирают публичную поверхность пакета из тематических модулей,
// чтобы внешние пакеты импортировали всё из одной точки (@aif/data) и не зависели
// от внутренней раскладки файлов.
// Позиции карточек в бэклоге нормализуются отдельным модулем: это пересчёт всего
// списка, а не точечная мутация.
export * from "./normalizeBacklogPositions.js";
// Интеграции с внешними трекерами вынесены отдельно: они ходят по сети и их
// отказы не должны заражать транзакции локальной БД.
export * from "./github.js";
export * from "./gitlab.js";
export {
  appendAuditEvent,
  listAuditEvents,
  type AppendAuditEventInput,
} from "./audit.js";
export {
  authenticateParticipant,
  createParticipantSession,
  expireParticipantSessions,
  hashParticipantPassword,
  isParticipantSessionActive,
  normalizeParticipantUsername,
  resolveParticipantSession,
  revokeAllParticipantSessions,
  revokeParticipantSession,
  verifyParticipantPassword,
  verifyParticipantPasswordOrDummy,
  verifyParticipantSessionCsrf,
  type AuthenticateParticipantResult,
  type CreatedParticipantSession,
  type ResolvedParticipantSession,
} from "./authSessions.js";
export {
  countParticipants,
  changeParticipantPassword,
  createParticipant,
  deactivateParticipant,
  findParticipantById,
  findParticipantByUsername,
  listParticipants,
  resetParticipantPassword,
  updateParticipant,
  type ParticipantMutationResult,
  type ParticipantRepositoryErrorCode,
} from "./participants.js";
export {
  getTaskOwnership,
  handoffTaskExecution,
  listTaskAssigneesByTaskIds,
  listTaskExecutorHistory,
  type HandoffTaskExecutionConflictCode,
  type HandoffTaskExecutionInput,
  type HandoffTaskExecutionResult,
  type TaskOwnershipFilters,
} from "./taskOwnership.js";
export {
  applyTaskAction,
  transitionTaskStatus,
  markTaskPlanPublished,
  markTaskPlanApproved,
  markTaskPlanChangesRequested,
  recordTaskPlanReviewFeedback,
  type ApplyTaskActionInput,
  type TaskTransitionConflictCode,
  type TaskTransitionExtra,
  type TaskTransitionResult,
  type TransitionTaskStatusInput,
} from "./taskTransitions.js";

// Тематические репозитории (clean-architecture сплит index.ts).
export * from "./tasks.js";
export * from "./comments.js";
export * from "./projects.js";
export * from "./settings.js";
export * from "./chat.js";
export * from "./runtimeProfiles.js";
export * from "./runtimeLimits.js";
export * from "./codexIndex.js";
export * from "./coordinatorClaims.js";
// usage.ts дополнительно экспортирует внутренние помощники для sibling-модулей
// (findLatestRuntimeProfileUsageByIds, RuntimeProfileUsageState) — они не входят
// в публичную поверхность и потому перечисляются здесь явно.
export {
  createDbUsageSink,
  incrementChatSessionTokenUsage,
  incrementProjectTokenUsage,
  incrementTaskTokenUsage,
  recordUsageEvent,
  type CreateDbUsageSinkOptions,
  type DbUsageEvent,
  type DbUsageSink,
} from "./usage.js";