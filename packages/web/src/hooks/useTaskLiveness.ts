import { useEffect, useState } from "react";
import type { TaskStatus } from "@aif/shared/browser";
import { useSettings } from "./useSettings";

export type TaskLiveness = "running" | "stalled" | "idle";

const IN_PROGRESS_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "planning",
  "improve",
  "implementing",
  "review",
  "verify",
]);

const DEFAULT_STALE_TIMEOUT_MS = 5_400_000;

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
 * Derive a task's visual liveness from its status and last heartbeat.
 * The pulse itself is a continuous CSS animation; this hook only decides
 * running/stalled/idle on a coarse tick.
 */
export function useTaskLiveness(
  status: TaskStatus,
  lastHeartbeatAt: string | null | undefined,
): TaskLiveness {
  const { data: settings } = useSettings();
  const staleTimeoutMs = settings?.agentStageStaleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  const now = useNow(60_000);

  if (!IN_PROGRESS_STATUSES.has(status)) return "idle";
  if (!lastHeartbeatAt) return "running";

  const heartbeatMs = new Date(lastHeartbeatAt).getTime();
  if (Number.isNaN(heartbeatMs)) return "running";
  if (now - heartbeatMs > staleTimeoutMs) return "stalled";
  return "running";
}
