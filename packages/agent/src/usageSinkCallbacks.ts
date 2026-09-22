import type { DbUsageEvent } from "@aif/data";
import { notifyProjectRuntimeLimitBroadcast, notifyTaskUsageBroadcast } from "./notifier.js";

/**
 * Единая обработка usage-события из runtime usage sink.
 *
 * Выделено в отдельный модуль, чтобы одинаково использовать в composition root
 * (координаторный путь) и в тестовых/injected реестрах (non-coordinator путь).
 */
export function handleUsageSinkRecorded(event: DbUsageEvent): void {
  if (event.context.taskId && event.context.projectId && event.usage) {
    void notifyTaskUsageBroadcast(event.context.taskId, event.context.projectId, event.usage);
  }

  if (!event.context.projectId || !event.profileId) return;

  // Уведомление об исчерпании лимита относится к профилю проекта,
  // поэтому taskId здесь факультативный.
  void notifyProjectRuntimeLimitBroadcast(event.context.projectId, event.profileId, {
    taskId: event.context.taskId ?? null,
  });
}
