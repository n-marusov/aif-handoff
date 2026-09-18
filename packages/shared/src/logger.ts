/**
 * Логгер приложения: корневой pino-логгер и фабрика дочерних логгеров.
 *
 * Уровень и поток вывода настраиваются один раз здесь, а каждый сервис лишь помечает
 * свои записи именем компонента.
 *
 * Поток берётся из окружения, потому что для stdio-транспорта MCP логи обязаны идти в
 * stderr: stdout там занят потоком JSON-RPC, и любая запись в него ломает рукопожатие.
 */

import pino from "pino";
// Побочный импорт: гарантирует, что .env прочитан до первого обращения к
// process.env ниже. Порядок импортов здесь значим, менять его нельзя.
import "./loadEnv.js";

// По умолчанию debug: в разработке приложение должно быть разговорчивым, а в
// production уровень задаётся переменной окружения.
const level = process.env.LOG_LEVEL ?? "debug";

// Принимает и словесную форму ("stderr"), и числовую ("2"): значение задаётся из
// docker-compose, где нет смысла знать внутренние константы pino. Всё нераспознанное
// трактуется как stdout, потому что безопасны только эти два потока.
export function resolveLogDestination(env: NodeJS.ProcessEnv = process.env): 1 | 2 {
  const destination = env.LOG_DESTINATION?.trim().toLowerCase();
  return destination === "stderr" || destination === "2" ? 2 : 1;
}

// Синхронная запись включается вне production: при падении процесса буферизованный
// вывод может потеряться вместе с причиной падения, а в production важнее скорость.
export function resolveLogDestinationConfig(env: NodeJS.ProcessEnv = process.env): {
  dest: 1 | 2;
  sync: boolean;
} {
  return {
    dest: resolveLogDestination(env),
    sync: env.NODE_ENV !== "production",
  };
}

const rootLogger = pino({ level }, pino.destination(resolveLogDestinationConfig()));

/** Создаёт дочерний логгер с именем компонента. */
export function logger(component: string): pino.Logger {
  return rootLogger.child({ component });
}

export { rootLogger };
