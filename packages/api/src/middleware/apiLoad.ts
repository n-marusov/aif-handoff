/**
 * Учет текущей нагрузки на HTTP API: сколько запросов выполняется прямо сейчас
 * и когда завершился последний из них.
 *
 * Зачем так: фоновые задачи API (например, backfill индекса Codex-сессий) не
 * должны работать, пока сервер занят пользовательскими запросами. Состояние
 * хранится в модульных переменных, потому что сервер однопроцессный и внешнее
 * хранилище добавило бы связность без пользы.
 */
import type { MiddlewareHandler } from "hono";

// Число незавершенных запросов: растет на входе, убывает в finally.
let activeRequests = 0;
// Время завершения последнего запроса; 0 означает, что запросов еще не было.
let lastRequestFinishedAt = 0;

// Счетчик меняется именно в try/finally: при исключении внутри next() он тоже
// вернется назад, иначе сервер навсегда остался бы "занятым".
export const trackApiLoad: MiddlewareHandler = async (_c, next) => {
  activeRequests += 1;
  try {
    await next();
  } finally {
    // Нижняя граница 0 страхует от двойного декремента и ухода в минус.
    activeRequests = Math.max(0, activeRequests - 1);
    lastRequestFinishedAt = Date.now();
  }
};

// "Простой" означает: нет активных запросов и с момента завершения последнего
// прошло не меньше minIdleMs. Пауза нужна, чтобы не судить по одиночному запросу.
export function isApiIdle(minIdleMs = 1000): boolean {
  return activeRequests === 0 && Date.now() - lastRequestFinishedAt >= minIdleMs;
}

// Снимок состояния для диагностики: значения на момент вызова.
export function readApiLoadState(): {
  activeRequests: number;
  lastRequestFinishedAt: number;
} {
  return {
    activeRequests,
    lastRequestFinishedAt,
  };
}
