/**
 * Периодический опрос координатора с защитой от наложения тиков.
 *
 * Действуют два независимых ограничения. Интервал не может быть меньше нижней
 * границы, иначе случайный ноль превратил бы опрос в busy-loop. Медленный тик не
 * накапливает очередь: пока предыдущий вызов не завершился, следующие
 * пропускаются. Оба правила нужны, чтобы один зависший проход не породил лавину
 * параллельных.
 */

const MIN_POLL_INTERVAL_MS = 10_000;

export interface PollScheduler {
  intervalMs: number;
  stop(): void;
}

export function normalizePollIntervalMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return MIN_POLL_INTERVAL_MS;
  }

  return Math.max(Math.floor(intervalMs), MIN_POLL_INTERVAL_MS);
}

export function startPollScheduler(
  callback: () => void | Promise<void>,
  intervalMs: number,
): PollScheduler {
  const normalizedIntervalMs = normalizePollIntervalMs(intervalMs);
  // Флаг перекрытия: пока предыдущий тик не завершился, новый не запускается.
  let isRunning = false;

  async function runTick(): Promise<void> {
    // Пропуск, а не очередь: догоняющие вызовы только усилили бы нагрузку.
    if (isRunning) return;
    isRunning = true;
    try {
      await callback();
    } finally {
      // Сброс в finally: упавший колбэк не должен навсегда заблокировать опрос.
      isRunning = false;
    }
  }

  // setInterval вместо рекурсивного setTimeout: интервал не зависит от длительности тика.
  const handle = setInterval(() => {
    // void - осознанный отказ от ожидания: setInterval не работает с async-колбэком.
    void runTick();
  }, normalizedIntervalMs);

  return {
    intervalMs: normalizedIntervalMs,
    stop() {
      clearInterval(handle);
    },
  };
}
