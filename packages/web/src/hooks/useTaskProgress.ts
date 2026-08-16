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

/** Coarse ticking clock so staleness is recomputed without re-rendering every second. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}

/**
 * Live seconds elapsed since `startedAt` (per-second tick). Returns null when
 * `startedAt` is not set so consumers can render a number only while a tool is
 * actually in flight. Cleared on unmount / when startedAt becomes null.
 */
export function useInFlightSeconds(startedAt: string | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (!startedAt) return null;
  const ms = now - new Date(startedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  return Math.floor(ms / 1000);
}

/**
 * Derive a task's visual progress state from its activity freshness and any
 * in-flight tool. `lastActivityAt` is updated ONLY by activity events (tool
 * completion, subagent start, tool start) — the heartbeat does not count, so
 * an alive-but-hung task flips to "hung" after the silence threshold.
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
