import { AlertTriangle } from "lucide-react";
import type { TaskProgress } from "@/hooks/useTaskProgress";

interface HeartbeatIndicatorProps {
  progress: TaskProgress;
}

/**
 * Лёгкий индикатор "работает/зависло".
 * Для рабочего состояния используется только анимация прозрачности
 * (`animate-pulse`) без box-shadow/backdrop-filter согласно правилам UI.
 * В состоянии зависания показывается предупреждающая иконка вместо точки.
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
