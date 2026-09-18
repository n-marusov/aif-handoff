import { logger } from "@aif/shared";
import type { WsEventType } from "@aif/shared";

const log = logger("mcp:notifier");

type BroadcastType = Extract<
  WsEventType,
  | "task:created"
  | "task:updated"
  | "sync:task_created"
  | "sync:task_updated"
  | "sync:status_changed"
  | "sync:plan_pushed"
>;

/**
 * Рассылает событие задачи в WebSocket-систему API.
 * Best-effort: ошибки логируются, но не блокируют ответ MCP-инструмента.
 * Повторяет тот же образец, что и packages/agent/src/notifier.ts.
 */
export async function broadcastTaskEvent(
  apiUrl: string,
  taskId: string,
  type: BroadcastType = "task:updated",
): Promise<void> {
  const url = `${apiUrl}/tasks/${taskId}/broadcast`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    });

    if (!res.ok) {
      log.warn({ taskId, type, status: res.status }, "Broadcast request returned non-OK status");
      return;
    }

    log.info({ taskId, type }, "Broadcast sent successfully");
  } catch (error) {
    log.warn(
      { taskId, type, error: error instanceof Error ? error.message : String(error) },
      "Broadcast request error (non-blocking)",
    );
  }
}
