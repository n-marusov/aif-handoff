import type { CSSProperties } from "react";
import { STATUS_CONFIG, type TaskStatus } from "@aif/shared/browser";

/**
 * Возвращает inline-стили для бейджа статуса: полупрозрачный фон, рамка и цвет текста.
 */
export function statusColorStyle(status: TaskStatus): CSSProperties {
  const color = STATUS_CONFIG[status].color;
  return {
    backgroundColor: `${color}20`,
    color,
    borderColor: `${color}40`,
  };
}

/**
 * Возвращает hex-цвет для заданного статуса.
 */
export function statusHex(status: TaskStatus): string {
  return STATUS_CONFIG[status].color;
}

const KIND_BADGES: Record<string, { label: string; className: string }> = {
  tool: {
    label: "TOOL",
    className: "border-cyan-500/35 bg-cyan-500/10 text-cyan-300",
  },
  agent: {
    label: "AGENT",
    className: "border-violet-500/35 bg-violet-500/10 text-violet-300",
  },
  error: {
    label: "ERROR",
    className: "border-red-500/35 bg-red-500/10 text-red-300",
  },
};

const DEFAULT_KIND_BADGE = {
  label: "INFO",
  className: "border-border bg-secondary text-muted-foreground",
};

/**
 * Сопоставляет вид активности подписи бейджа + className.
 */
export function kindBadgeStyle(kind: string): {
  label: string;
  className: string;
} {
  return KIND_BADGES[kind] ?? DEFAULT_KIND_BADGE;
}
