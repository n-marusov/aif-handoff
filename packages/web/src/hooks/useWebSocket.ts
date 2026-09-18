import { useEffect, useRef, useCallback } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  AuthSessionState,
  WsEvent,
  Task,
  TaskListItem,
  TaskCurrentTool,
  TaskStatus,
  TaskOwnershipBroadcastPayload,
} from "@aif/shared/browser";
import { useNotificationSettings } from "./useNotificationSettings";
import {
  playStatusChangeBeep,
  showTaskAssignmentNotification,
  showTaskMovedNotification,
} from "@/lib/notifications";
import { invalidateProjectTaskOverviews } from "./useProjects";
import {
  api,
  reportWebSocketAuthenticationFailure,
  webSocketAuthenticationIsValid,
} from "@/lib/api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTaskPayload(value: unknown): value is Task {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "string"
  );
}

function hasIdPayload(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === "string";
}

function hasRuntimeLimitPayload(
  value: unknown,
): value is { projectId: string; runtimeProfileId?: string | null; taskId?: string | null } {
  return isRecord(value) && typeof value.projectId === "string";
}

function hasWarmupPayload(value: unknown): value is { projectId: string; status?: string } {
  return isRecord(value) && typeof value.projectId === "string";
}

function hasTaskOwnershipPayload(value: unknown): value is TaskOwnershipBroadcastPayload {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.projectId === "string" &&
    isRecord(value.ownership) &&
    (value.ownership.executionOwner === "ai" || value.ownership.executionOwner === "human") &&
    Array.isArray(value.ownership.assignees)
  );
}

function hasTaskIdPayload(value: unknown): value is { taskId: string } {
  return isRecord(value) && typeof value.taskId === "string";
}

function hasTaskHeartbeatPayload(
  value: unknown,
): value is { taskId: string; lastHeartbeatAt: string | null } {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    (value.lastHeartbeatAt === null || typeof value.lastHeartbeatAt === "string")
  );
}

function hasTaskUsagePayload(
  value: unknown,
): value is { taskId: string; projectId: string; usage: Record<string, unknown> } {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.projectId === "string" &&
    isRecord(value.usage)
  );
}

function hasTaskActivityPayload(value: unknown): value is {
  taskId: string;
  lastActivityAt: string | null;
  currentTool: TaskCurrentTool | null;
} {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    (value.lastActivityAt === null || typeof value.lastActivityAt === "string")
  );
}

function invalidateRuntimeLimitQueries(
  queryClient: QueryClient,
  payload: { projectId: string; taskId?: string | null },
): void {
  queryClient.invalidateQueries({ queryKey: ["runtimeProfiles"] });
  queryClient.invalidateQueries({ queryKey: ["effectiveChatRuntime"] });
  queryClient.invalidateQueries({ queryKey: ["effectiveTaskRuntime"] });
  queryClient.invalidateQueries({ queryKey: ["effectiveChatRuntime", payload.projectId] });
  if (typeof payload.taskId === "string" && payload.taskId.length > 0) {
    queryClient.invalidateQueries({ queryKey: ["task", payload.taskId] });
    queryClient.invalidateQueries({ queryKey: ["effectiveTaskRuntime", payload.taskId] });
  }
}

function resolveWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

  return `${protocol}//${window.location.host}/ws`;
}

/** Идентификатор клиента WebSocket, назначаемый сервером при подключении. */
let currentClientId: string | null = null;

export function getWsClientId(): string | null {
  return currentClientId;
}

export function useWebSocket(enabled = true) {
  const wsRef = useRef<WebSocket | null>(null);
  const queryClient = useQueryClient();
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const statusCacheRef = useRef<Map<string, TaskStatus>>(new Map());
  const intentionalCloseRef = useRef(false);
  const connectRef = useRef<() => void>(() => undefined);
  const invalidateTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingTaskIds = useRef<Set<string>>(new Set());
  const { settings } = useNotificationSettings();
  // Настройки храним в ref, чтобы их изменение не вызывало
  // переподключение WebSocket.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const findTaskInCache = useCallback(
    (taskId: string): Task | TaskListItem | null => {
      const detailed = queryClient.getQueryData<Task>(["task", taskId]);
      if (detailed) return detailed;

      const taskLists = queryClient.getQueriesData<TaskListItem[]>({ queryKey: ["tasks"] });
      for (const [, tasks] of taskLists) {
        if (!tasks) continue;
        const found = tasks.find((task) => task.id === taskId);
        if (found) return found;
      }

      return null;
    },
    [queryClient],
  );

  const connect = useCallback(() => {
    if (!enabled) return;
    if (!webSocketAuthenticationIsValid()) {
      reportWebSocketAuthenticationFailure();
      return;
    }
    const url = resolveWsUrl();

    console.debug("[ws] Connecting to", url);
    const ws = new WebSocket(url);
    intentionalCloseRef.current = false;

    ws.onopen = () => {
      console.debug("[ws] Connected");
    };

    ws.onmessage = (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch (error) {
        console.debug("[ws] Failed to parse message:", error);
        return;
      }

      if (!isRecord(raw) || typeof raw.type !== "string") {
        console.debug("[ws] Invalid event shape");
        return;
      }

      console.debug("[ws] Event received:", raw.type);

      if (
        raw.type === "participant:created" ||
        raw.type === "participant:updated" ||
        raw.type === "participant:deactivated"
      ) {
        queryClient.invalidateQueries({ queryKey: ["participants"] });
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
        return;
      }

      if (
        raw.type === "auth:session_revoked" &&
        isRecord(raw.payload) &&
        typeof raw.payload.participantId === "string"
      ) {
        const session = queryClient.getQueryData<AuthSessionState>(["auth", "session"]);
        if (session?.participant?.id === raw.payload.participantId) {
          reportWebSocketAuthenticationFailure();
          queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
        }
        return;
      }

      // Сохраняем clientId из служебного события ws:connected.
      if (
        raw.type === "ws:connected" &&
        isRecord(raw.payload) &&
        typeof (raw.payload as Record<string, unknown>).clientId === "string"
      ) {
        currentClientId = (raw.payload as Record<string, unknown>).clientId as string;
        console.debug("[ws] Assigned clientId:", currentClientId);
        return;
      }

      // Передаём события чата в DOM-канал для useChat.
      if (
        raw.type === "chat:token" ||
        raw.type === "chat:done" ||
        raw.type === "chat:error" ||
        raw.type === "chat:session_created" ||
        raw.type === "chat:session_deleted"
      ) {
        window.dispatchEvent(new CustomEvent(raw.type, { detail: raw.payload }));
        if (
          (raw.type === "chat:done" || raw.type === "chat:error") &&
          hasRuntimeLimitPayload(raw.payload)
        ) {
          invalidateRuntimeLimitQueries(queryClient, raw.payload);
        }
        return;
      }

      // События жизненного цикла коммита передаются в DOM для подписчиков
      // уведомлений и индикатора ожидания.
      if (
        raw.type === "task:commit_started" ||
        raw.type === "task:commit_done" ||
        raw.type === "task:commit_failed"
      ) {
        console.debug("[ws] commit event:", raw.type, raw.payload);
        window.dispatchEvent(new CustomEvent(raw.type, { detail: raw.payload }));
        return;
      }

      // Жизненный цикл QA: отправляем событие слушателям и повторно запрашиваем
      // задачу, чтобы вкладка QA получила актуальные qaStatus и артефакты.
      if (
        raw.type === "task:qa_started" ||
        raw.type === "task:qa_done" ||
        raw.type === "task:qa_failed"
      ) {
        window.dispatchEvent(new CustomEvent(raw.type, { detail: raw.payload }));
        if (isRecord(raw.payload) && typeof raw.payload.taskId === "string") {
          queryClient.invalidateQueries({ queryKey: ["task", raw.payload.taskId] });
        }
        return;
      }

      const data = raw as unknown as WsEvent;

      if (
        (data.type === "task:handoff" || data.type === "task:assignment_updated") &&
        hasTaskOwnershipPayload(data.payload)
      ) {
        const cachedTask = findTaskInCache(data.payload.taskId);
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
        queryClient.invalidateQueries({ queryKey: ["task", data.payload.taskId] });
        queryClient.invalidateQueries({
          queryKey: ["task-executor-history", data.payload.taskId],
        });
        invalidateProjectTaskOverviews(queryClient);
        if (data.type === "task:handoff" && settingsRef.current.desktop && cachedTask) {
          showTaskAssignmentNotification(
            data.payload.taskId,
            cachedTask.title,
            data.payload.ownership.executionOwner,
            data.payload.ownership.assignees,
          );
        }
        if (data.type === "task:handoff" && settingsRef.current.sound) {
          void playStatusChangeBeep().catch((error) => {
            console.debug("[ws] Failed to play assignment sound:", error);
          });
        }
        return;
      }

      if (data.type === "task:comment_created" && hasTaskIdPayload(data.payload)) {
        queryClient.invalidateQueries({ queryKey: ["task-comments", data.payload.taskId] });
        return;
      }

      if (data.type === "task:moved" && isTaskPayload(data.payload)) {
        const movedTask = data.payload;
        const cachedStatus = statusCacheRef.current.get(movedTask.id);
        const previousStatus = cachedStatus ?? findTaskInCache(movedTask.id)?.status ?? null;
        statusCacheRef.current.set(movedTask.id, movedTask.status);

        if (previousStatus && previousStatus !== movedTask.status) {
          if (settingsRef.current.desktop) {
            try {
              showTaskMovedNotification(
                movedTask.id,
                movedTask.title,
                previousStatus,
                movedTask.status,
              );
            } catch (error) {
              console.debug("[ws] Failed to show desktop notification:", error);
            }
          }
          if (settingsRef.current.sound) {
            void playStatusChangeBeep().catch((error) => {
              console.debug("[ws] Failed to play notification sound:", error);
            });
          }
        }
      }

      // Heartbeat обновляет lastHeartbeatAt локально, без полного
      // повторного запроса доски.
      if (data.type === "task:heartbeat" && hasTaskHeartbeatPayload(data.payload)) {
        const { taskId, lastHeartbeatAt } = data.payload;
        queryClient.setQueryData<Task>(["task", taskId], (current) =>
          current ? { ...current, lastHeartbeatAt } : current,
        );
        const taskLists = queryClient.getQueriesData<TaskListItem[]>({ queryKey: ["tasks"] });
        for (const [queryKey, list] of taskLists) {
          if (!list) continue;
          queryClient.setQueryData(
            queryKey,
            list.map((item) => (item.id === taskId ? { ...item, lastHeartbeatAt } : item)),
          );
        }
        return;
      }

      // Обновление usage: обновляем детали задачи и сигнализируем индикатору.
      if (data.type === "task:usage_updated" && hasTaskUsagePayload(data.payload)) {
        queryClient.invalidateQueries({ queryKey: ["task", data.payload.taskId] });
        window.dispatchEvent(new CustomEvent("task:usage_updated", { detail: data.payload }));
        return;
      }

      // Обновление активности: корректируем кеш прогресса и обновляем
      // детали задачи.
      if (data.type === "task:activity" && hasTaskActivityPayload(data.payload)) {
        const { taskId, lastActivityAt, currentTool } = data.payload;
        queryClient.setQueryData<Task>(["task", taskId], (current) =>
          current ? { ...current, lastActivityAt, currentTool } : current,
        );
        const taskLists = queryClient.getQueriesData<TaskListItem[]>({ queryKey: ["tasks"] });
        for (const [queryKey, list] of taskLists) {
          if (!list) continue;
          queryClient.setQueryData(
            queryKey,
            list.map((item) =>
              item.id === taskId ? { ...item, lastActivityAt, currentTool } : item,
            ),
          );
        }
        queryClient.invalidateQueries({ queryKey: ["task", taskId] });
        return;
      }

      // Изменение режима auto-queue требует обновления списка проектов,
      // чтобы переключатели интерфейса были синхронизированы.
      if (data.type === "project:auto_queue_mode_changed") {
        queryClient.invalidateQueries({ queryKey: ["projects"] });
        if (hasIdPayload(data.payload)) {
          queryClient.invalidateQueries({ queryKey: ["autoQueueMode", data.payload.id] });
        }
        return;
      }

      if (data.type === "project:organization_updated") {
        queryClient.invalidateQueries({ queryKey: ["projects"] });
        return;
      }

      if (data.type === "project:runtime_limit_updated" && hasRuntimeLimitPayload(data.payload)) {
        invalidateRuntimeLimitQueries(queryClient, data.payload);
        if (typeof data.payload.taskId === "string" && data.payload.taskId.length > 0) {
          pendingTaskIds.current.add(data.payload.taskId);
          queryClient.invalidateQueries({ queryKey: ["tasks"] });
        }
        // Обзор агрегирует usage-поля, поэтому обновляется после событий
        // лимитов и использования.
        invalidateProjectTaskOverviews(queryClient);
        return;
      }

      if (data.type === "project:warmup_updated" && hasWarmupPayload(data.payload)) {
        queryClient.invalidateQueries({ queryKey: ["projectWarmup", data.payload.projectId] });
        queryClient.invalidateQueries({ queryKey: ["projects"] });
        return;
      }

      if (data.type === "task:deleted" && hasIdPayload(data.payload)) {
        statusCacheRef.current.delete(data.payload.id);
        // Удаляем запрос задачи из кеша, а не инвалидируем,
        // чтобы не получить повторный запрос удалённой задачи (404).
        queryClient.removeQueries({
          queryKey: ["task", data.payload.id],
        });
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
        invalidateProjectTaskOverviews(queryClient);
        return;
      }

      // События roadmap передаются в DOM для внешних слушателей.
      if (data.type === "roadmap:complete" || data.type === "roadmap:error") {
        window.dispatchEvent(new CustomEvent(data.type, { detail: data.payload }));

        if (data.type === "roadmap:complete" && isRecord(data.payload)) {
          queryClient.invalidateQueries({ queryKey: ["tasks"] });
          invalidateProjectTaskOverviews(queryClient);
          const p = data.payload as { roadmapAlias?: string; created?: number };
          if (settingsRef.current.desktop && Notification.permission === "granted") {
            new Notification("Roadmap ready", {
              body: `${p.roadmapAlias}: ${p.created ?? 0} task(s) created`,
              tag: "roadmap-complete",
            });
          }
          if (settingsRef.current.sound) {
            void playStatusChangeBeep().catch(() => {});
          }
        }
      }

      // Задержка 150мс объединяет частые WS-события в одну пачку
      // инвалидирования кеша.
      if (hasIdPayload(data.payload)) {
        pendingTaskIds.current.add(data.payload.id);
      }
      clearTimeout(invalidateTimer.current);
      invalidateTimer.current = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
        invalidateProjectTaskOverviews(queryClient);
        for (const id of pendingTaskIds.current) {
          queryClient.invalidateQueries({ queryKey: ["task", id] });
        }
        pendingTaskIds.current.clear();
      }, 150);
    };

    ws.onclose = () => {
      if (intentionalCloseRef.current) {
        return;
      }
      void api.getAuthSession().then(
        (session) => {
          if (
            session.participantsModeEnabled &&
            (!session.authenticated || !webSocketAuthenticationIsValid())
          ) {
            reportWebSocketAuthenticationFailure();
            return;
          }
          console.debug("[ws] Disconnected, reconnecting in 3s...");
          reconnectTimer.current = setTimeout(() => connectRef.current(), 3000);
        },
        () => {
          if (!webSocketAuthenticationIsValid()) {
            reportWebSocketAuthenticationFailure();
            return;
          }
          console.debug("[ws] Session check unavailable, reconnecting in 3s...");
          reconnectTimer.current = setTimeout(() => connectRef.current(), 3000);
        },
      );
    };

    ws.onerror = (error) => {
      console.debug("[ws] Error:", error);
      ws.close();
    };

    wsRef.current = ws;
  }, [enabled, findTaskInCache, queryClient]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    if (!enabled) return;
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      clearTimeout(invalidateTimer.current);
      const ws = wsRef.current;
      if (!ws) return;

      intentionalCloseRef.current = true;

      // В StrictMode очистка может сработать в состоянии CONNECTING.
      // Закрытие откладывается до onopen, чтобы убрать шумные ошибки в консоли.
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener(
          "open",
          () => {
            ws.close();
          },
          { once: true },
        );
        return;
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [connect, enabled]);
}
