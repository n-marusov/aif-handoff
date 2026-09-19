/**
 * DTO-контракты application use-case слоя @aif/api.
 *
 * Слой use cases — единственное место, где собираются бизнес-операции
 * (переход задачи, старт QA, синхронизация плана, генерация коммита).
 * Маршруты HTTP/WebSocket остаются тонкими контроллерами: они парсят вход,
 * зовут use case и переводят результат в транспортную форму (HTTP-код, WS-событие).
 *
 * Инвариант: типы в этом файле НЕ содержат транспортных понятий (HTTP-статусы,
 * hono Context). Семантический код результата (`code`) переносит бизнес-отказ,
 * а маппинг код → HTTP-статус живёт в маршруте.
 */

import type {
  AuditActor,
  ExecutionOwner,
  ParticipantRole,
  TaskActionContext,
  TaskEvent,
  TaskExecutorHistoryEntry,
  TaskOwnership,
  TaskStatus,
} from "@aif/shared";
import type { TaskFieldsUpdate } from "@aif/data";

// ── applyTaskEvent ───────────────────────────────────────────────────────────

/** Вход для применённого к задаче события. */
export interface ApplyTaskEventInput {
  taskId: string;
  event: TaskEvent;
  actor?: AuditActor;
  participantsModeEnabled?: boolean;
  participantRole?: ParticipantRole | null;
  participantActive?: boolean;
  /** deletePlanFile=true удаляет файл плана на терминальных/стартовых переходах. */
  deletePlanFile?: boolean;
}

/** Успешный результат применения события. */
export interface ApplyTaskEventOk {
  ok: true;
  task: {
    id: string;
    projectId: string;
    status: TaskStatus;
    autoQa?: boolean | null;
    worktreePath?: string | null;
    [key: string]: unknown;
  };
  broadcastType: "task:moved" | "task:updated";
}

/** Бизнес-отказ применения события без транспортного статуса. */
export interface ApplyTaskEventDenied {
  ok: false;
  /** Семантический код отказа (коды @aif/shared stateMachine). */
  code: string;
  error: string;
}

export type ApplyTaskEventResult = ApplyTaskEventOk | ApplyTaskEventDenied;

// ── startQaRun ───────────────────────────────────────────────────────────────

export interface StartQaRunInput {
  projectId: string;
  taskId: string;
  executionRoot: string;
  /** Длительность QA-лока; передаётся маршрутом из env-конфигурации. */
  lockDurationMs?: number;
}

export type StartQaRunResult =
  | { started: true }
  | { started: false; code: "ai_handoff_required" | "task_locked" | "already_running" };

// ── updateTaskPlan / syncTaskPlanFile ────────────────────────────────────────

export interface UpdateTaskPlanInput {
  taskId: string;
  planText: string | null;
  isFix: boolean;
  planPath?: string;
}

export type UpdateTaskPlanResult = { ok: true } | { ok: false; code: "task_or_project_not_found" };

export interface SyncTaskPlanFileInput {
  taskId: string;
}

export type SyncTaskPlanFileResult = { synced: true } | { synced: false; missing: true };

// ── generateCommit ───────────────────────────────────────────────────────────

export interface GenerateCommitInput {
  projectId: string;
  taskId?: string | null;
}

export type GenerateCommitResult =
  | { ok: true }
  | { ok: false; code?: "ai_handoff_required"; error: string };

// ── createTask ───────────────────────────────────────────────────────────────

/** Вложение задачи из тела запроса (совпадает с taskAttachmentSchema). */
export interface TaskAttachmentInput {
  name: string;
  mimeType: string;
  size: number;
  content: string | null;
  path?: string;
}

/** Вход для создания задачи. Поля соответствуют createTaskSchema (после zod-defaults). */
export interface CreateTaskInput {
  projectId: string;
  title: string;
  description: string;
  attachments: TaskAttachmentInput[];
  priority?: number;
  autoMode?: boolean;
  executionOwner?: "ai" | "human";
  assigneeIds: string[];
  isFix?: boolean;
  plannerMode: "fast" | "full";
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
  actionContext: TaskActionContext;
}

/** Результат создания задачи: задача-строка для широковещательной рассылки и ответа. */
export interface CreateTaskOk {
  ok: true;
  task: {
    id: string;
    projectId: string;
    executionOwner?: string | null;
    status: TaskStatus;
    [key: string]: unknown;
  };
  /** Поле для agent:wake после создания AI-задачи. */
  wakeAgent: boolean;
}

/** Отказ создания задачи: семантический код + детали для формирования ответа. */
export interface CreateTaskDenied {
  ok: false;
  /** Семантический код отказа (не HTTP-статус). */
  code: string;
  error: string;
  /** Дополнительные детали (например, fieldErrors валидации runtime). */
  details?: Record<string, unknown>;
}

export type CreateTaskResult = CreateTaskOk | CreateTaskDenied;

// ── updateTask ───────────────────────────────────────────────────────────────

/** Вход для обновления задачи: id + patch-поля (после zod-парсинга). */
export interface UpdateTaskInput {
  taskId: string;
  /** Поля обновления БЕЗ составных операций plan/attachments. */
  patch: TaskFieldsUpdate;
  /** Составная операция «записать файл плана». undefined = не трогать. */
  plan?: string | null;
  /** Составная операция «записать вложения». undefined = не трогать. */
  attachments?: TaskAttachmentInput[];
  /** Актор участника для авторизации мутации. */
  actionContext: TaskActionContext;
}

/** Результат обновления задачи: свежая строка для ответа и broadcast. */
export interface UpdateTaskOk {
  ok: true;
  task: {
    id: string;
    projectId: string;
    status: TaskStatus;
    [key: string]: unknown;
  };
}

/** Отказ обновления: задача не найдена или участник не авторизован. */
export interface UpdateTaskDenied {
  ok: false;
  code: "task_not_found" | "forbidden" | "parallel_mode_required" | "invalid_runtime_profile";
  error: string;
  details?: Record<string, unknown>;
}

export type UpdateTaskResult = UpdateTaskOk | UpdateTaskDenied;

// ── handoffTask ─────────────────────────────────────────────────────────────

/** Вход передачи исполнения: id + запрошенное владение + CAS-ожидания. */
export interface HandoffTaskInput {
  taskId: string;
  executionOwner: ExecutionOwner;
  assigneeIds: string[];
  expectedOwnershipRevision: number;
  expectedExecutionOwner?: ExecutionOwner;
  expectedStatus?: TaskStatus;
  reason?: string | null;
  resumeAction?: TaskEvent;
  actionContext: TaskActionContext;
}

/** Результат передачи исполнения: владение + история (строки @aif/data). */
export interface HandoffTaskOk {
  ok: true;
  ownership: TaskOwnership;
  history: TaskExecutorHistoryEntry;
}

/** Отказ передачи: CAS-конфликт, блокировка, неавторизованность и т.п. */
export interface HandoffTaskDenied {
  ok: false;
  /** Коды HandoffTaskExecutionResult: not_found/locked/revision_conflict/inactive_assignee/invalid_transition. */
  code: string;
  error: string;
  ownership?: TaskOwnership | null;
}

export type HandoffTaskResult = HandoffTaskOk | HandoffTaskDenied;

// ── deleteTask ───────────────────────────────────────────────────────────────

/** Вход удаления задачи: только id — работа с worktree полностью внутренняя. */
export interface DeleteTaskInput {
  taskId: string;
  /** Вызывается сразу после удаления строки БД, до долгой уборки worktree. */
  onTaskDeleted?: () => void;
}

/** Результат удаления: строка уже удалена; broadcast остаётся маршруту. */
export type DeleteTaskResult = { ok: true } | { ok: false; code: "task_not_found"; error: string };
