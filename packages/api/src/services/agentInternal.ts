/**
 * Мост "API -> внутренний HTTP API агента" для операций с git-деревом задачи.
 *
 * Почему HTTP, а не прямой импорт: worktree и его git-регистрация принадлежат
 * процессу агента, и мутировать их из процесса API нельзя - два процесса,
 * пишущих в один .git, ломают блокировки. Поэтому API только оркестрирует:
 * отправляет запрос агенту и разбирает структурированный ответ.
 *
 * Ключевые инварианты:
 * - Все вызовы best-effort: переход задачи (удаление, merge) не должен падать
 *   из-за кратковременной недоступности агента, поэтому ошибки логируются и
 *   не пробрасываются наверх.
 * - Таймаут обязателен (AbortSignal): без него зависший агент подвесил бы
 *   HTTP-запрос пользователя.
 * - Ветка при очистке после merge сохраняется: PR/MR может ещё на неё
 *   ссылаться; удаляются только каталог и регистрация worktree.
 */

import { getEnv, logger } from "@aif/shared";

const log = logger("agent-internal");

export interface WorktreeCleanupRequest {
  taskId: string;
  projectId: string;
  projectRoot: string;
  branchName: string | null;
  worktreePath: string | null;
  reason: string;
}

export interface AgentWorktreeCleanupResult {
  ok: boolean;
  cleaned?: boolean;
  // Признак, что worktree оставлен из-за внешних ссылок (например, на задачу
  // ещё ссылается другая ветка процессов) - это не ошибка, а осознанный пропуск.
  skippedDueToReference?: boolean;
  stashSha?: string | null;
  /** Машиночитаемая причина no-op/пропуска. */
  reason?: string;
  /** Заполняется при структурированных сбоях (тело ошибки агента или сбой транспорта). */
  errorCode?: string;
  error?: string;
}

function internalApiHeaders(): Record<string, string> {
  // Токен опционален: в локальной разработке внутренний API слушает loopback
  // и может быть без токена. Оба заголовка ставим вместе, потому что
  // Authorization нужен прокси на пути, а X-Internal-Broadcast-Token - агенту.
  const token = getEnv().INTERNAL_BROADCAST_TOKEN?.trim() ?? "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-Internal-Broadcast-Token"] = token;
  }
  return headers;
}

/** Абсолютный URL внутреннего маршрута агента с учётом `AGENT_INTERNAL_URL`. */
export function buildAgentInternalUrl(path: string): string {
  // Нормализуем обе стороны склейки: хвостовой слэш у базы дал бы двойной слэш,
  // а путь без ведущего - слипание вида "hostworktrees/cleanup".
  const baseUrl = getEnv().AGENT_INTERNAL_URL.replace(/\/$/, "");
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Просит агент снять снапшот, спрятать в stash и удалить worktree задачи.
 * Git-эффект должен выполняться в процессе агента (ему принадлежит рабочее
 * дерево); API только оркестрирует, поэтому это HTTP-мост, а не импорт.
 *
 * Вызывающий код относится к этому как best-effort: удаление/merge не должны
 * падать из-за кратковременной недоступности агента.
 */
export async function callAgentWorktreeCleanup(
  input: WorktreeCleanupRequest,
  options: { timeoutMs?: number } = {},
): Promise<AgentWorktreeCleanupResult> {
  const url = buildAgentInternalUrl("/worktrees/cleanup");
  // Дефолт в минуту: перед удалением агент снимает snapshot и упаковывает
  // незакоммиченные изменения в stash, это не мгновенная операция.
  const timeoutMs = options.timeoutMs ?? 60_000;

  log.debug(
    {
      taskId: input.taskId,
      projectId: input.projectId,
      worktreePath: input.worktreePath,
      reason: input.reason,
    },
    "Requesting agent worktree cleanup",
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: internalApiHeaders(),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Недоступность агента - ожидаемый сценарий (рестарт, деплой), поэтому warn,
    // а не error. Наружу отдаём код, а не текст: текст нестабилен, код - контракт.
    const message = error instanceof Error ? error.message : String(error);
    log.warn(
      {
        taskId: input.taskId,
        status: null,
        code: "agent_internal_unavailable",
        reason: input.reason,
        err: message,
      },
      "Agent worktree cleanup call failed (unreachable)",
    );
    return { ok: false, errorCode: "agent_internal_unavailable", error: message };
  }

  // Тело может быть не JSON (прокси ответил HTML-страницей ошибки), поэтому
  // парсинг глушится, а тип явно допускает null - ниже все обращения через ?.
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    cleaned?: boolean;
    skippedDueToReference?: boolean;
    stashSha?: string | null;
    reason?: string;
    code?: string;
    error?: string;
  } | null;

  if (!response.ok) {
    // Код берём из тела ответа, а дефолт подставляем только как крайний случай:
    // агент знает причину точнее, чем HTTP-статус.
    const errorCode = payload?.code ?? "worktree_cleanup_failed";
    const error = payload?.error ?? `Agent worktree cleanup failed with status ${response.status}`;
    log.warn(
      { taskId: input.taskId, status: response.status, code: errorCode, reason: input.reason },
      "Agent worktree cleanup failed",
    );
    return { ok: false, cleaned: false, errorCode, error };
  }

  log.debug(
    {
      taskId: input.taskId,
      cleaned: payload?.cleaned ?? false,
      skippedDueToReference: payload?.skippedDueToReference ?? false,
    },
    "Agent worktree cleanup completed",
  );
  return {
    ok: true,
    // Поля нормализуем к false/null: вызывающий код не должен различать
    // "агент не прислал поле" и "агент прислал null" - это одна и та же ситуация.
    cleaned: payload?.cleaned ?? false,
    skippedDueToReference: payload?.skippedDueToReference ?? false,
    stashSha: payload?.stashSha ?? null,
    reason: payload?.reason,
  };
}

export interface TaskWorktreeSnapshot {
  taskId: string;
  projectId: string;
  projectRoot: string | null;
  branchName: string | null;
  worktreePath: string | null;
}

/** Снимок git-идентичности задачи до перехода, который может её изменить или обнулить. */
export function snapshotTaskWorktree(
  task: { id: string; projectId: string; branchName?: string | null; worktreePath?: string | null },
  projectRoot: string | null,
): TaskWorktreeSnapshot {
  // Снимок нужен именно до перехода: сам переход может очистить branchName и
  // worktreePath у задачи, и тогда чистить было бы уже нечего.
  return {
    taskId: task.id,
    projectId: task.projectId,
    projectRoot,
    branchName: task.branchName ?? null,
    worktreePath: task.worktreePath ?? null,
  };
}

/**
 * Уборка worktree best-effort сразу после того, как смерженный PR/MR перевёл
 * задачу в `verified`. Ветка сохраняется (PR/MR может на неё ссылаться);
 * удаляются только папка и её регистрация. Никогда не бросает — переход merge
 * не должен падать из-за кратковременной недоступности агента.
 */
export async function requestWorktreeCleanupAfterMerge(
  snapshot: TaskWorktreeSnapshot,
  reference: string,
): Promise<void> {
  if (!snapshot.worktreePath || !snapshot.projectRoot) {
    // Нормальный случай, а не ошибка: задача могла выполняться без worktree
    // (скиллс-режим, задачи без ветки), тогда чистить просто нечего.
    log.warn(
      { taskId: snapshot.taskId, reference },
      "Worktree cleanup after merge skipped: no worktree recorded",
    );
    return;
  }
  log.info(
    { taskId: snapshot.taskId, reference, worktreePath: snapshot.worktreePath },
    "Worktree cleanup requested after merge",
  );
  try {
    const result = await callAgentWorktreeCleanup({
      taskId: snapshot.taskId,
      projectId: snapshot.projectId,
      projectRoot: snapshot.projectRoot,
      branchName: snapshot.branchName,
      worktreePath: snapshot.worktreePath,
      reason: `pr_merge:${reference}`,
    });
    if (!result.ok) {
      log.warn(
        { taskId: snapshot.taskId, reference, code: result.errorCode, reason: result.reason },
        "Worktree cleanup after merge did not complete",
      );
    }
  } catch (error) {
    // Вторая линия защиты: callAgentWorktreeCleanup уже не бросает, но прерывание
    // по сигналу или сбой сети всё равно не должны ронять уже применённый переход.
    log.warn(
      { taskId: snapshot.taskId, reference, err: error },
      "Worktree cleanup after merge threw; transition already applied",
    );
  }
}
