import { AlertTriangle } from "lucide-react";
import type { TaskLiveness } from "@/hooks/useTaskLiveness";

interface HeartbeatIndicatorProps {
  liveness: TaskLiveness;
}

/**
 * Lightweight running/stalled indicator. Uses opacity animation only
 * (`animate-pulse`) for the running dot; no box-shadow/backdrop-filter per
 * project UI rules. Stalled state renders a danger icon instead of a dot.
 */
export function HeartbeatIndicator({ liveness }: HeartbeatIndicatorProps) {
  if (liveness === "idle") return null;

  if (liveness === "stalled") {
    return (
      <span aria-label="Stalled" className="inline-flex shrink-0 text-destructive">
        <AlertTriangle className="h-3.5 w-3.5" />
      </span>
    );
  }

  return (
    <span
      aria-label="Running"
      className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500 animate-pulse"
    />
  );
}
