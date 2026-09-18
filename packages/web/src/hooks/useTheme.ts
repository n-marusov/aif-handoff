import { useCallback, useSyncExternalStore } from "react";
import { STORAGE_KEYS } from "../lib/storageKeys.js";
import { createExternalStore } from "../lib/createExternalStore.js";

type Theme = "dark" | "light";

const store = createExternalStore<Theme>(
  STORAGE_KEYS.THEME,
  "dark",
  (v) => v,
  (v) => (v === "light" ? "light" : "dark"),
);

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("light", theme === "light");
}

// Инициализация темы при загрузке.
if (typeof window !== "undefined") {
  applyTheme(store.get());
}

export function useTheme() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const theme: Theme = snapshot === "light" ? "light" : "dark";

  const toggleTheme = useCallback(() => {
    const next: Theme = store.get() === "dark" ? "light" : "dark";
    store.set(next);
    applyTheme(next);
  }, []);

  return { theme, toggleTheme } as const;
}
