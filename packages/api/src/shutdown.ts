/**
 * Сборка обработчика штатного завершения процесса.
 *
 * Модуль намеренно не импортирует ни сервер, ни индексер: все действия
 * приходят параметрами. Благодаря этому порядок остановки можно проверить
 * в тесте без сокетов и файловой системы, а точка входа видит всю
 * последовательность в одном месте.
 *
 * Ключевые свойства:
 *
 * 1. Обработчик идемпотентен. ПОЛЬЗОВАТЕЛЬ может нажать Ctrl+C дважды, а
 *    tsx-watch может прислать SIGTERM вдогонку SIGINT. Повторный запуск
 *    остановки привел бы к повторному закрытию уже закрытых ресурсов.
 * 2. Остановка индексера выполняется по принципу best-effort. Его сбой логируется, но не мешает
 *    освободить порт и выйти: иначе процесс остался бы висеть из-за
 *    вспомогательной подсистемы.
 * 3. Код выхода всегда 0. Сигнал - это не ошибка приложения, а нормальный
 *    запрос на остановку, в том числе при перезапуске вотчера.
 */

export interface ShutdownLogger {
  info: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

// Обязателен только info: остальные уровни используются как необязательные,
// чтобы тесты и встраиваемые вызовы могли передать минимальную заглушку.
export interface GracefulShutdownOptions {
  logger: ShutdownLogger;
  stopCodexIndex: () => Promise<void>;
  closeWebSockets: () => void;
  closeServer: () => void;
  exitProcess: (code: number) => void;
}

// Фабрика, а не готовая функция: флаг "уже останавливаемся" замыкается на
// конкретный обработчик, поэтому два разных запуска сервера в одном процессе
// не мешают друг другу.
export function createGracefulShutdownHandler(
  options: GracefulShutdownOptions,
): (signal: string) => Promise<void> {
  let shuttingDown = false;

  return async (signal: string): Promise<void> => {
    // Повторный сигнал игнорируется молча: писать в лог о нем бессмысленно,
    // первая остановка уже печатает свой ход.
    if (shuttingDown) {
      return;
    }

    // Флаг выставляется до первого await, иначе два сигнала, пришедшие почти
    // одновременно, успели бы пройти проверку выше.
    shuttingDown = true;
    options.logger.info(
      { signal },
      "Shutdown signal received - stopping Codex indexer, terminating WS + exiting",
    );

    try {
      // Сначала останавливается фоновый индексер: он ходит в БД и файловую
      // систему, и его работа после закрытия сервера была бы гонкой.
      await options.stopCodexIndex();
      options.logger.debug?.({ signal }, "Codex indexer stopped during shutdown");
    } catch (error) {
      // Попадает сюда, но дальше не пробрасывается: освободить порт важнее,
      // чем дождаться корректной остановки индексора.
      options.logger.warn?.({ err: error, signal }, "Codex indexer shutdown failed");
    } finally {
      closeAndExit(options);
    }
  };
}

// Вложенные finally вместо последовательных вызовов: выход из процесса должен
// состояться даже если закрытие сокетов или сервера выбросит исключение,
// иначе зависший ресурс снова приведет к EADDRINUSE при перезапуске.
function closeAndExit(options: GracefulShutdownOptions): void {
  try {
    options.closeWebSockets();
  } finally {
    try {
      options.closeServer();
    } finally {
      options.exitProcess(0);
    }
  }
}
