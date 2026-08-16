import { useEffect, useRef, useState } from "react";
import { Bot } from "lucide-react";

const BLINK_RESET_MS = 800;

/**
 * Small "robot" activity indicator. Blinks (opacity pulse) briefly when a
 * `task:usage_updated` WebSocket event is observed, signaling that token/cost
 * counters just updated without animating the numbers themselves.
 */
export function RobotBlink() {
  const [active, setActive] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = () => {
      setActive(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setActive(false), BLINK_RESET_MS);
    };
    window.addEventListener("task:usage_updated", handler);
    return () => {
      window.removeEventListener("task:usage_updated", handler);
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  return (
    <span
      aria-label={active ? "Usage updated" : "Activity"}
      className={`inline-flex h-5 w-5 items-center justify-center rounded-full border border-border text-muted-foreground ${
        active ? "animate-pulse" : "opacity-60"
      }`}
    >
      <Bot className="h-3 w-3" />
    </span>
  );
}
