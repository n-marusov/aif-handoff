/**
 * Запуск HTTP-сервера поверх адаптера @hono/node-server.
 *
 * Модуль вынесен из точки входа ради двух вещей, которые легко потерять при
 * прямом вызове createAdaptorServer:
 *
 * 1. Различение ошибок старта и ошибок времени работы. Пока сервер не поднял
 *    порт, любая ошибка почти всегда означает занятый порт или неверный
 *    hostname, и процесс обязан завершиться с кодом 1. После listen та же
 *    ошибка - уже рантайм-сбой, о котором достаточно сообщить в лог.
 * 2. Единый логгер. Адаптер ничего не знает о pino, поэтому все сообщения о
 *    старте и ошибках идут через переданный logger.
 */

import { createAdaptorServer } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type pino from "pino";
import type { WebSocketServer } from "ws";

// Не полный pino.Logger, а только нужные методы: тесты и встраиваемые
// вызовы могут передать упрощенную заглушку вместо настроенного логгера.
type StartupLogger = Pick<pino.Logger, "debug" | "error" | "info">;
// Тип fetch выводится из сигнатуры адаптера: так при обновлении версии
// @hono/node-server расхождение поймает компилятор, а не рантайм.
type StartupFetch = Parameters<typeof createAdaptorServer>[0]["fetch"];

// webSocketServer и injectWebSocket нужны только при работе с WebSocket,
// поэтому оба необязательны: тот же стартовый код используется в тестах и
// в сценариях без сокета.
interface StartServerOptions {
  fetch: StartupFetch;
  port: number;
  hostname?: string;
  webSocketServer?: WebSocketServer;
  injectWebSocket?: (server: ServerType) => void;
  onStarted?: () => void;
  logger: StartupLogger;
}

// Фаза сервера - единственное состояние, отличимое в обработчике ошибок.
// before-ready означает "порт еще не занят нами".
type StartupPhase = "before-ready" | "after-ready";

// Сообщение об EADDRINUSE дополняется номером порта и подсказкой: без этого
// в логе оказывается голый системный код, по которому непонятно, что делать.
function formatStartupErrorMessage(error: NodeJS.ErrnoException, port: number): string {
  if (error.code === "EADDRINUSE") {
    return `Failed to start API server: port ${port} is already in use. Stop the existing process or set PORT to a different value.`;
  }

  return "Failed to start API server.";
}

// Создает сервер, но не начинает прослушивание: вызывающий код получает
// экземпляр и сам решает, когда закрывать его при завершении процесса.
export function startServer({
  fetch,
  port,
  hostname,
  webSocketServer,
  injectWebSocket,
  onStarted,
  logger,
}: StartServerOptions): ServerType {
  const server = createAdaptorServer({
    fetch,
    hostname,
    // Ключ websocket добавляется только при наличии сервера сокета: передача
    // undefined в опции ломает проверку на exactOptionalPropertyTypes.
    ...(webSocketServer ? { websocket: { server: webSocketServer } } : {}),
  });
  // Апгрейд должен быть привязан до listen, иначе первые соединения успеют
  // прийти на http-сервер без обработчика upgrade и будут закрыты.
  injectWebSocket?.(server);
  let startupPhase: StartupPhase = "before-ready";

  server.on("error", (error: Error) => {
    const startupError = error as NodeJS.ErrnoException;

    if (startupPhase === "before-ready") {
      // Код возврата выставляется, а не process.exit: даем текущему стеку
      // завершиться и не обрываем уже начатые записи в лог.
      logger.error(
        { error, hostname, port, startupPhase },
        formatStartupErrorMessage(startupError, port),
      );
      process.exitCode = 1;
      return;
    }

    // После старта сервер продолжает жить: падение отдельного запроса не
    // должно останавливать весь API.
    logger.error({ error, hostname, port, startupPhase }, "API server error.");
  });

  if (webSocketServer || injectWebSocket) {
    logger.debug({ hostname, port }, "WebSocket configured for server");
  }

  server.listen(port, hostname, () => {
    // Смена фазы происходит именно в колбэке прослушивания: до него список
    // ошибок по-прежнему относится к старту.
    startupPhase = "after-ready";
    logger.info({ hostname, port }, "API server started");
    // Хук вызывается после успешного listen, поэтому фоновая инициализация
    // (индексер Codex) не стартует при занятом порте.
    onStarted?.();
  });

  return server;
}
