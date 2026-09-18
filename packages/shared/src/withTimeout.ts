/**
 * Выполняет промис с внешним таймаутом.
 *
 * Контракт: таймер всегда очищается в finally и не удерживает цикл событий (unref).
 */

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  // timeoutId нужен вне коллбека для гарантированного clearTimeout в finally.
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
        // Таймер не должен блокировать завершение процесса.
        if (typeof timeoutId === "object" && "unref" in timeoutId) {
          timeoutId.unref();
        }
      }),
    ]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}
