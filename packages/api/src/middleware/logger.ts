/**
 * Минимальное логирование HTTP-запросов: метод, URL, статус и длительность.
 *
 * Зачем на уровне debug: логи пишутся в горячем пути, а уровень выставляется
 * через LOG_LEVEL, поэтому по умолчанию сервер не засоряет вывод. Измерения
 * нужны для диагностики зависаний и оценки реальной нагрузки.
 */
import type { MiddlewareHandler } from "hono";
import { logger as createLogger } from "@aif/shared";

// Именованный логгер: префикс "api" отделяет записи сервера от агента.
const log = createLogger("api");

export const requestLogger: MiddlewareHandler = async (c, next) => {
  // Отметка берется до next(), чтобы длительность включала всех обработчиков.
  const start = Date.now();
  const { method, url } = c.req.raw;

  log.debug({ method, url }, "Incoming request");

  // Единственная точка продолжения цепочки: статус ответа доступен только после нее.
  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  // Уровень debug осознанный: горячий путь не должен писать в лог по умолчанию.
  log.debug({ method, url, status, duration }, "Request completed");
};
