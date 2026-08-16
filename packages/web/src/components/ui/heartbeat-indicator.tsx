import { AlertTriangle } from "lucide-react";
import type { TaskProgress } from "@/hooks/useTaskProgress";

interface HeartbeatIndicatorProps {
  progress: TaskProgress;
}

/**
 * Lightweight working/hung indicator. Uses opacity animation only
 * (`animate-pulse`) for the working dot; no box-shadow/backdrop-filter per
 * project UI rules. Hung state renders a danger icon instead of a dot.
 */
export function HeartbeatIndicator({ progress }: HeartbeatIndicatorProps) {
  if (progress === "idle") return null;

  if (progress === "hung") {
    return (
      <span aria-label="Hung" className="inline-flex shrink-0 text-destructive">
        <AlertTriangle className="h-3.5 w-3.5" />
      </span>
    );
  }

  return (
    <span
      aria-label="Working"
      className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500 animate-pulse"
    />
  );
}
