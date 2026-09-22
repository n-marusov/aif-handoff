/**
 * Доставка уведомлений о событиях задачи и проекта во внешний API.
 *
 * Зачем отдельный модуль: стадии обработки задачи не должны знать о WebSocket,
 * Telegram и заголовках внутренней авторизации. Все исходящие уведомления собраны
 * здесь, чтобы политика best-effort соблюдалась единообразно.
 *
 * Инварианты и подводные камни:
 * - Транспорт всегда best-effort: недоступный API не должен валить стадию. Поэтому
 *   в postTaskBroadcast стоит catch, а ошибка уходит только в лог.
 * - Уведомления в Telegram намеренно отфильтрованы (только task:moved с реальной
 *   сменой статуса). Без фильтра лента превращается в шум, и люди отключают
 *   уведомления целиком.
 * - Заголовки собираются на каждый запрос, а не кешируются: токен читается из env
 *   динамически, чтобы работали тесты и переопределение конфигурации.
 */
import { findProjectByTaskId, findTaskById } from "@aif/data";
import {
  logger,
  getEnv,
  parseTaskCurrentTool,
  sendTelegramNotification,
  type TaskCurrentTool,
} from "@aif/shared";

const log = logger("agent-notifier");

type BroadcastType = "task:updated" | "task:moved" | "task:activity" | "task:scheduled_fired";

export interface TaskNotificationInfo {
  projectName?: string;
  title?: string;
  fromStatus?: string;
  toStatus?: string;
}

type ProjectBroadcastType = "project:auto_queue_mode_changed" | "project:auto_queue_advanced";
type RuntimeLimitBroadcastType = "project:runtime_limit_updated";

export function internalApiHeaders(): Record<string, string> {
  const token = getEnv().INTERNAL_BROADCAST_TOKEN?.trim() ?? "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-Internal-Broadcast-Token"] = token;
  } else if ((process.env.NODE_ENV ?? "").trim().toLowerCase() === "development") {
    // В разработке без токена маршрут может проверять источник по IP, поэтому
    // подставляем локальный адрес явно, чтобы запрос не отсеялся раньше времени.
    headers["X-Real-IP"] = "127.0.0.1";
  }
  return headers;
}

/** Project-scoped WS-вещание через API, best-effort. */
export async function notifyProjectBroadcast(
  projectId: string,
  type: ProjectBroadcastType,
  info: { taskId?: string } = {},
): Promise<void> {
  const baseUrl = getEnv().API_BASE_URL;
  const url = `${baseUrl}/projects/${projectId}/broadcast`;
  // Проектные трансляции уходят по одному адресу с разным type: ручка одна, а
  // клиенты фильтруют события по типу.
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: internalApiHeaders(),
      body: JSON.stringify({ type, taskId: info.taskId }),
    });
    if (res.ok) {
      log.info({ projectId, type, taskId: info.taskId }, "Project broadcast sent");
    } else {
      log.warn(
        { projectId, type, status: res.status, url },
        "Project broadcast request returned non-OK status",
      );
    }
  } catch (err) {
    log.warn({ projectId, type, err, url }, "Project broadcast request failed");
  }
}

export async function notifyProjectRuntimeLimitBroadcast(
  projectId: string,
  runtimeProfileId: string | null,
  info: { taskId?: string | null } = {},
): Promise<boolean> {
  const baseUrl = getEnv().API_BASE_URL;
  const type: RuntimeLimitBroadcastType = "project:runtime_limit_updated";
  const url = `${baseUrl}/projects/${projectId}/broadcast`;
  // Возвращаем boolean в отличие от остальных вещателей: вызывающему нужно знать,
  // доставлено ли событие, чтобы решить, повторять ли попытку позже.
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: internalApiHeaders(),
      body: JSON.stringify({
        type,
        taskId: info.taskId ?? null,
        runtimeProfileId,
      }),
    });
    if (res.ok) {
      log.info(
        { projectId, type, taskId: info.taskId ?? null, runtimeProfileId },
        "Runtime limit broadcast sent",
      );
      return true;
    } else {
      log.warn(
        { projectId, type, taskId: info.taskId ?? null, runtimeProfileId, status: res.status, url },
        "Runtime limit broadcast request returned non-OK status",
      );
      return false;
    }
  } catch (err) {
    log.warn(
      { projectId, type, taskId: info.taskId ?? null, runtimeProfileId, err, url },
      "Runtime limit broadcast request failed",
    );
    return false;
  }
}

async function postTaskBroadcast(
  taskId: string,
  body: Record<string, unknown>,
  context: Record<string, unknown> = {},
): Promise<void> {
  const baseUrl = getEnv().API_BASE_URL;
  const url = `${baseUrl}/tasks/${taskId}/broadcast`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: internalApiHeaders(),
      body: JSON.stringify(body),
    });

    // Успех тоже логируем: по этим строчкам восстанавливают порядок событий
    // в UI, когда клиент жалуется на «застрявшую» карточку.
    if (res.ok) {
      log.info({ taskId, type: body.type, ...context }, "Task broadcast sent");
    } else if (res.status === 404) {
      // Задачу могли удалить между сменой статуса и best-effort broadcast.
      // Для гонки удаления это ожидаемый идемпотентный исход, а не ошибка.
      log.info(
        { taskId, type: body.type, status: res.status, reason: "already_deleted", url },
        "Task broadcast skipped for already deleted task",
      );
    } else {
      log.warn(
        { taskId, type: body.type, status: res.status, url },
        "Task broadcast request returned non-OK status",
      );
    }
  } catch (err) {
    // Broadcast — best-effort. Обработка задачи агентом не должна падать из-за недоступного API.
    log.warn({ taskId, type: body.type, err, url }, "Task broadcast request failed");
  }
}

export async function notifyTaskBroadcast(
  taskId: string,
  type: BroadcastType = "task:updated",
  info: TaskNotificationInfo = {},
): Promise<void> {
  await postTaskBroadcast(taskId, { type }, { toStatus: info.toStatus });

  // Telegram-уведомление — best-effort, fire-and-forget.
  // Пропускаем activity-only трансляции (слишком шумно).
  // Пропускаем события расписания (последующий task:moved несёт больше данных).
  // Пропускаем, если статус реально не менялся (например, implementing → implementing).
  if (type === "task:activity" || type === "task:scheduled_fired") return;
  // Условие читается наоборот к названию: шлём только когда статус действительно
  // изменился. Повторное событие с тем же статусом не несёт информации.
  if (type === "task:moved" && (!info.fromStatus || info.fromStatus !== info.toStatus)) {
    void sendTelegramNotification({
      taskId,
      projectName: info.projectName,
      resolveProjectName: () => findProjectByTaskId(taskId)?.name,
      title: info.title,
      fromStatus: info.fromStatus,
      toStatus: info.toStatus,
    });
  }
}

export async function notifyTaskHeartbeat(taskId: string, lastHeartbeatAt: string): Promise<void> {
  // Отдельный тип события вместо task:updated: клиент использует heartbeat, чтобы
  // показать «жизнь» процесса, не перерисовывая карточку целиком.
  await postTaskBroadcast(
    taskId,
    { type: "task:heartbeat", payload: { taskId, lastHeartbeatAt } },
    { lastHeartbeatAt },
  );
}

export interface TaskUsageNotification {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export async function notifyTaskUsageBroadcast(
  taskId: string,
  projectId: string,
  usage: TaskUsageNotification,
): Promise<void> {
  // Событие расхода живёт на уровне задачи, поэтому идёт через task-канал, хотя
  // агрегируется потом по проекту.
  await postTaskBroadcast(
    taskId,
    { type: "task:usage_updated", payload: { taskId, projectId, usage } },
    { projectId, usage },
  );
}

export interface TaskActivityProgress {
  taskId: string;
  lastActivityAt: string | null;
  currentTool: TaskCurrentTool | null;
}

export async function notifyTaskProgress(
  taskId: string,
  progress: Omit<TaskActivityProgress, "taskId">,
): Promise<void> {
  const payload: TaskActivityProgress = { taskId, ...progress };
  // payload и context намеренно почти дублируются: payload уходит клиентам,
  // context - только в лог, чтобы не раздувать логи полным объектом прогресса.
  await postTaskBroadcast(
    taskId,
    { type: "task:activity", payload },
    { lastActivityAt: payload.lastActivityAt, currentTool: payload.currentTool },
  );
}

/** Читает текущее состояние активности задачи и рассылает его как task:activity. */
export function broadcastTaskActivityProgress(taskId: string): void {
  // Синхронная обёртка: читает текущее состояние из БД и отправляет асинхронно,
  // не заставляя вызывающих стадий ждать сеть.
  const task = findTaskById(taskId);
  void notifyTaskProgress(taskId, {
    lastActivityAt: task?.lastActivityAt ?? null,
    currentTool: task ? parseTaskCurrentTool(task.currentToolJson) : null,
  });
}
