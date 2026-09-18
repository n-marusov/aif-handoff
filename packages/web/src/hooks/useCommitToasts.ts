import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/toast";
import type { TaskCommitPayload } from "@aif/shared/browser";

// Окно дедупликации для пар (taskId, type). Двойной маунт StrictMode,
// временные двойные WS-соединения при реконнекте и ретрансляции сервера
// могут доставить одно и то же событие коммита несколько раз. 2 с хватает,
// чтобы поглотить такие повторы, и мало, чтобы настоящий повтор
// (напр. второе ручное подтверждение) снова дал свежий тост.
const DEDUPE_WINDOW_MS = 2000;

/**
 * Глобальный слушатель WS-событий `task:commit_*`. Монтируется один раз (в <App/>)
 * и превращает поток событий в тосты, чтобы пользователь всегда получал отклик
 * по потоку approve-done auto-commit — независимо от того, открыта ли модалка
 * деталей задачи.
 */
export function useCommitToasts() {
  const { toast } = useToast();
  const lastSeenRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const seen = lastSeenRef.current;
    const shouldSkip = (type: string, taskId: string | undefined): boolean => {
      const key = `${type}:${taskId ?? "unknown"}`;
      const now = Date.now();
      const prev = seen.get(key);
      if (prev && now - prev < DEDUPE_WINDOW_MS) return true;
      seen.set(key, now);
      return false;
    };

    const onStarted = (e: Event) => {
      const detail = (e as CustomEvent<TaskCommitPayload>).detail;
      if (shouldSkip("started", detail?.taskId)) return;
      console.debug("[commit-toast] started", detail);
      toast("Creating commit…", "info", 6000);
    };
    const onDone = (e: Event) => {
      const detail = (e as CustomEvent<TaskCommitPayload>).detail;
      if (shouldSkip("done", detail?.taskId)) return;
      console.debug("[commit-toast] done", detail);
      toast("Commit created", "success", 4000);
    };
    const onFailed = (e: Event) => {
      const detail = (e as CustomEvent<TaskCommitPayload>).detail;
      if (shouldSkip("failed", detail?.taskId)) return;
      console.debug("[commit-toast] failed", detail);
      toast(`Commit failed: ${detail?.error ?? "unknown error"}`, "error", 8000);
    };

    window.addEventListener("task:commit_started", onStarted);
    window.addEventListener("task:commit_done", onDone);
    window.addEventListener("task:commit_failed", onFailed);

    return () => {
      window.removeEventListener("task:commit_started", onStarted);
      window.removeEventListener("task:commit_done", onDone);
      window.removeEventListener("task:commit_failed", onFailed);
    };
  }, [toast]);
}
