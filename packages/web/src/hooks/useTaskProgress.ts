import { useEffect, useState } from "react";
import type { TaskCurrentTool, TaskStatus } from "@aif/shared/browser";
import { useSettings } from "./useSettings";

export type TaskProgress = "working" | "hung" | "idle";

const IN_PROGRESS_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "planning",
  "improve",
  "implementing",
  "review",
  "verify",
]);

const DEFAULT_ACTIVITY_SILENCE_MS = 5 * 60 * 1000;

/** Грубые тики: устаревание пересчитывается без перерисовки каждую секунду. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}

/**
 * Секунды с момента `startedAt` (тик раз в секунду). Возвращает null, когда
 * `startedAt` не задан, чтобы потребители показывали число только пока инструмент
 * действительно в работе. Сбрасывается при размонтировании / когда startedAt становится null.
 */
export function useInFlightSeconds(startedAt: string | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (!startedAt) return null;
  const ms = now - new Date(startedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  return Math.floor(ms / 1000);
}

/**
 * Вычисляет визуальное состояние прогресса задачи по свежести активности и
 * работающему инструменту. `lastActivityAt` обновляется ТОЛЬКО событиями активности
 * (завершение инструмента, старт субагента, старт инструмента) — хартбит не считается,
 * поэтому живая, но зависшая задача переходит в "hung" после порога тишины.
 */
export function useTaskProgress(
  status: TaskStatus,
  lastActivityAt: string | null | undefined,
  currentTool: TaskCurrentTool | null | undefined,
): TaskProgress {
  const { data: settings } = useSettings();
  const silenceMs = settings?.agentActivitySilenceMs ?? DEFAULT_ACTIVITY_SILENCE_MS;
  const now = useNow(60_000);

  if (!IN_PROGRESS_STATUSES.has(status)) return "idle";
  if (currentTool) return "working";
  if (!lastActivityAt) return "working";

  const activityMs = new Date(lastActivityAt).getTime();
  if (Number.isNaN(activityMs)) return "working";
  if (now - activityMs > silenceMs) return "hung";
  return "working";
}
