/**
 * Лимитер запросов с фиксированным окном, рассчитанный на один процесс.
 *
 * Зачем так: счетчики живут в памяти и не переживают перезапуск, зато не требуют
 * Redis и не добавляют задержек в горячий путь. Это осознанный компромисс для
 * одного узла API: при горизонтальном масштабировании лимит становится
 * приблизительным, а не строгим, потому что каждый узел считает свои запросы.
 */
import type { Context, MiddlewareHandler } from "hono";

// Окно фиксированное: считаем запросы до момента resetAt, затем счетчик сбрасывается.
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// Фабрика на маршрут: своя Map и свое окно у каждого лимитера, поэтому
// лимиты разных маршрутов не смешиваются.
export function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  key?: (c: Context) => string;
  skip?: (c: Context) => boolean;
  onLimit?: (c: Context, resetAt: number) => Response | Promise<Response>;
}): MiddlewareHandler {
  const { windowMs, maxRequests } = options;
  // Ключ - идентификатор клиента (обычно IP), значение - его окно.
  const clients = new Map<string, RateLimitEntry>();

  // Периодическая уборка не дает Map расти бесконечно; unref не мешает
  // процессу завершиться, когда сервер останавливают.
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of clients) {
      if (entry.resetAt <= now) clients.delete(key);
    }
  }, windowMs).unref();

  return async (c, next) => {
    // skip проверяется до учета: служебный трафик не должен расходовать лимит.
    if (options.skip?.(c)) {
      await next();
      return;
    }
    // Своего IP у сервера за прокси нет, поэтому читаются заголовки: первый
    // адрес в x-forwarded-for - исходный клиент, остальные - промежуточные узлы.
    const clientIp = options.key
      ? options.key(c)
      : (c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
        c.req.header("x-real-ip") ??
        "unknown");

    const now = Date.now();
    const entry = clients.get(clientIp);

    // Окно истекло или клиент встречен впервые: этот запрос открывает новое окно.
    if (!entry || entry.resetAt <= now) {
      clients.set(clientIp, { count: 1, resetAt: now + windowMs });
      await next();
      return;
    }

    // Инкремент до сравнения с порогом: maxRequests - это число разрешенных
    // запросов, поэтому ровно maxRequests проходит, а следующий получает 429.
    entry.count += 1;
    if (entry.count > maxRequests) {
      // Хук позволяет отдать свой ответ, например с заголовком Retry-After.
      if (options.onLimit) {
        return options.onLimit(c, entry.resetAt);
      }
      return c.json({ error: "Too many requests, please try again later" }, 429);
    }

    await next();
  };
}
