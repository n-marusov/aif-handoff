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

import type { AuditActor, TaskEvent, TaskStatus } from "@aif/shared";
import type { ParticipantRole } from "@aif/shared";

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
