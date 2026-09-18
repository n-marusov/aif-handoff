import { useEffect } from "react";

interface ShortcutOptions {
  /** Код клавиши (например, "KeyK") или имя клавиши (например, "Escape") */
  key: string;
  /** Требовать Cmd (Mac) / Ctrl (Windows) */
  meta?: boolean;
  /** Требовать Shift */
  shift?: boolean;
  /** Активно только при true (по умолчанию: true) */
  enabled?: boolean;
}

/**
 * Регистрирует глобальный обработчик keydown для указанного сочетания.
 * При совпадении вызывает `preventDefault()`.
 */
export function useKeyboardShortcut(options: ShortcutOptions, handler: () => void) {
  const { key, meta = false, shift = false, enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (meta && !(event.metaKey || event.ctrlKey)) return;
      if (shift && !event.shiftKey) return;
      if (event.key !== key && event.code !== key) return;

      event.preventDefault();
      handler();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [key, meta, shift, enabled, handler]);
}
