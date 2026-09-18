/**
 * Брокер device-auth входа Codex для Docker-сценария.
 *
 * Роль в домене: обеспечить аутентификацию runtime-адаптера без интерактивного
 * терминала внутри контейнера.
 *
 * Инварианты:
 * - одновременно активна только одна сессия входа;
 * - терминальный исход хранится отдельно от активной сессии;
 * - причина завершения передаётся как TerminalReason (структурированно);
 * - одноразовый код подтверждения маскируется в логах.
 *
 * Потенциальное улучшение: хранить историю terminal-result событий для
 * операционного аудита неудачных login-попыток.
 */

import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { logger } from "@aif/shared";

const log = logger("codex-login-broker");

// Порт по умолчанию выбран рядом с сервисами проекта и вне API-порта.
const DEFAULT_PORT = 3010;
// 0.0.0.0 обязателен для доступа к сервису с хоста через docker port mapping.
const DEFAULT_HOST = "0.0.0.0";

// Таймаут сессии ограничивает время жизни дочернего login-процесса.
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

// Адрес подтверждения фиксирован доменным контрактом device-auth потока.
const VERIFICATION_URL = "https://auth.openai.com/codex/device";
// ANSI-коды удаляются до разбора URL и кода подтверждения.
const ANSI_PATTERN = /\x1B\[[0-9;]*[A-Za-z]/g;
// Неглобальный regex используется для exec; глобальный — только для replace.
const USER_CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,}\b/;
const USER_CODE_PATTERN_GLOBAL = /\b[A-Z0-9]{4}-[A-Z0-9]{4,}\b/g;
// REDACTED_CODE не должен совпадать с шаблоном кода подтверждения.
const REDACTED_CODE = "***-*****";
// Ограничение длины записи о фрагменте сдерживает шум и размер логов.
const LOG_CHUNK_LIMIT = 200;

// Закрытый набор terminal причин, синхронизированный с API и UI.
export type TerminalReason =
  | "success"
  | "exit_nonzero"
  | "signal"
  | "timeout"
  | "parse_timeout"
  | "cancel"
  | "spawn_failed";

/**
 * Ошибка парсинга device-auth вывода со структурированной причиной.
 * Используется вместо классификации по тексту Error.message.
 */
class DeviceAuthParseError extends Error {
  // Здесь только причины парсинга/старта. timeout/cancel обрабатываются отдельно.
  constructor(
    public readonly reason: Extract<
      TerminalReason,
      "exit_nonzero" | "spawn_failed" | "parse_timeout"
    >,
    message: string,
    public readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = "DeviceAuthParseError";
  }
}

export interface TerminalResult {
  ok: boolean;
  sessionId: string;
  finishedAt: number;
  reason: TerminalReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface DeviceAuthInfo {
  verificationUrl: string;
  userCode: string;
}

// Состояние активной login-сессии, включая timeout handle для централизованной отмены.
export interface LoginSession {
  id: string;
  child: ChildProcessWithoutNullStreams;
  verificationUrl: string;
  userCode: string;
  startedAt: number;
  timeoutHandle: NodeJS.Timeout;
}

// Runtime-обёртка сервера с read-only доступом к текущему состоянию для тестов.
export interface BrokerRuntime {
  app: Hono;
  /** Внутренний доступ для тестов */
  getCurrentSession(): LoginSession | null;
  /** Внутренний доступ для тестов */
  getLastResult(): TerminalResult | null;
}

// Возврат старта брокера: runtime, server и фактический bind host/port.
export interface BrokerServer {
  runtime: BrokerRuntime;
  server: ServerType;
  port: number;
  host: string;
  close(): Promise<void>;
}

export interface BrokerOptions {
  port?: number;
  host?: string;
  codexCliPath?: string;
  /** Переопределение spawn для тестов */
  spawnFn?: typeof spawn;
}

// Контекст брокера: единое изменяемое состояние для route-handlers.
interface BrokerContext {
  currentSession: LoginSession | null;
  lastResult: TerminalResult | null;
  // Опции нормализуются один раз при инициализации runtime.
  options: Required<Omit<BrokerOptions, "spawnFn">> & {
    spawnFn: typeof spawn;
  };
}

/**
 * Извлекает адрес подтверждения и одноразовый код из stdout `codex login --device-auth`.
 * CLI печатает фиксированный адрес подтверждения и код вида
 * `XXXX-YYYYY`. ANSI-последовательности удаляются перед сопоставлением. Оба поля
 * должны присутствовать для успешного разбора — частичный вывод даёт null.
 */
export function extractDeviceAuth(buffered: string): DeviceAuthInfo | null {
  // Разбор выполняется по накопленному буферу: URL и код могут прийти в разных
  // фрагментах вывода.
  const cleaned = buffered.replace(ANSI_PATTERN, "");
  // Пока адрес подтверждения не обнаружен, сессия не готова выдать код.
  if (!cleaned.includes(VERIFICATION_URL)) return null;
  const codeMatch = USER_CODE_PATTERN.exec(cleaned);
  // Частичный разбор недопустим: возвращается либо полная пара, либо null.
  if (!codeMatch) return null;
  return { verificationUrl: VERIFICATION_URL, userCode: codeMatch[0] };
}

/** Маскирует код подтверждения в логах, оставляя последние 2 символа для сверки. */
export function maskUserCode(code: string): string {
  // Два последних символа упрощают ручную сверку без раскрытия секрета.
  if (code.length <= 2) return "***";
  // Длина маски сохраняет диагностическую ценность формата кода.
  return `${"*".repeat(code.length - 2)}${code.slice(-2)}`;
}

/** Скрывает токены формата device-code в сырых фрагментах stdout/stderr перед
 * логированием. */
export function redactChunkForLog(text: string): string {
  // Сначала маскирование, затем обрезка — иначе код попадёт в лог по частям.
  return text.replace(USER_CODE_PATTERN_GLOBAL, REDACTED_CODE).slice(0, LOG_CHUNK_LIMIT);
}

// Единая точка фиксации terminal результата сессии для согласованности /status.
function recordTerminalResult(ctx: BrokerContext, result: TerminalResult): void {
  ctx.lastResult = result;
  log.info(
    {
      sessionId: result.sessionId,
      ok: result.ok,
      reason: result.reason,
      exitCode: result.exitCode,
      signal: result.signal,
    },
    "[Broker.terminalResult] session ended",
  );
}

function terminateSession(
  ctx: BrokerContext,
  reason: Extract<TerminalReason, "timeout" | "cancel">,
): void {
  const session = ctx.currentSession;
  // Идемпотентность завершения: второй terminate вызов игнорируется.
  if (!session) return;
  log.info({ sessionId: session.id, reason }, "[Broker.terminateSession] ending session");
  // Таймер снимаем первым: иначе он сработает по уже завершенной сессии.
  clearTimeout(session.timeoutHandle);
  if (!session.child.killed) {
    try {
      // SIGTERM, а не SIGKILL: CLI успевает убрать за собой временные файлы и не
      // оставляет полузаписанный конфиг авторизации.
      session.child.kill("SIGTERM");
    } catch (err) {
      // Ошибка убийства не отменяет главного - исход сессии все равно фиксируется.
      log.warn({ err }, "[Broker.terminateSession] failed to kill child");
    }
  }
  // Результат пишется до обнуления сессии и до события exit: обработчик выхода увидит,
  // что сессия уже снята, и не перезатрет причину на основе кода выхода.
  recordTerminalResult(ctx, {
    ok: false,
    sessionId: session.id,
    finishedAt: Date.now(),
    reason,
    exitCode: null,
    signal: null,
  });
  ctx.currentSession = null;
}

// Отображение кода выхода и сигнала в причину завершения.
function classifyExit(code: number | null, signal: NodeJS.Signals | null): TerminalReason {
  // Сигнал проверяется первым: при убийстве процесса код выхода тоже может быть
  // выставлен, но причиной был именно сигнал, а не самостоятельное завершение.
  if (signal !== null) return "signal";
  if (code === 0) return "success";
  return "exit_nonzero";
}

// Сборка Hono-приложения. Состояние приходит снаружи, а не создается внутри: тот же ctx
// нужен startLoginBroker и тестовым аксессорам, а приложение остается функцией от
// состояния и легко инстанцируется в каждом тесте.
function createBrokerApp(ctx: BrokerContext): Hono {
  const app = new Hono();

  // /status работает в двух режимах: "идет вход" и "вход закончился". UI опрашивает его
  // поллингом, поэтому ответ всегда 200 - отсутствие сессии это нормальное состояние, а
  // не ошибка.
  app.get("/codex/login/status", (c) => {
    log.debug("[Broker.status] enter");
    const session = ctx.currentSession;
    if (session) {
      // Код отдается в открытом виде: браузер пользователя должен его показать.
      // Маскирование существует только для логов.
      return c.json({
        active: true,
        sessionId: session.id,
        verificationUrl: session.verificationUrl,
        userCode: session.userCode,
        startedAt: new Date(session.startedAt).toISOString(),
      });
    }
    if (ctx.lastResult) {
      // Ветка для уже закончившейся сессии. Формат намеренно совпадает с полем
      // lastResult из ответа об активной сессии, чтобы клиент читал один и тот же путь.
      return c.json({
        active: false,
        lastResult: {
          ok: ctx.lastResult.ok,
          sessionId: ctx.lastResult.sessionId,
          reason: ctx.lastResult.reason,
          exitCode: ctx.lastResult.exitCode,
          signal: ctx.lastResult.signal,
          finishedAt: new Date(ctx.lastResult.finishedAt).toISOString(),
        },
      });
    }
    return c.json({ active: false });
  });

  // Запуск новой сессии. Обработчик намеренно длинный: он держит весь жизненный цикл
  // дочернего процесса в одном месте, чтобы не разносить состояние по модулям и не
  // потерять порядок установки слушателей.
  app.post("/codex/login/start", async (c) => {
    log.debug("[Broker.start] enter");

    // Защита от второго параллельного логина. Ответ 409 несет уже выданные параметры
    // сессии, чтобы клиент мог вернуться к прерванному экрану входа, а не начинать с
    // нуля и не порождать второй процесс в общем конфиге Codex.
    if (ctx.currentSession) {
      log.warn(
        { sessionId: ctx.currentSession.id },
        "[Broker.start] rejected — session already active",
      );
      return c.json(
        {
          error: "session_already_active",
          sessionId: ctx.currentSession.id,
          verificationUrl: ctx.currentSession.verificationUrl,
          userCode: ctx.currentSession.userCode,
        },
        409,
      );
    }

    // Каждый новый запуск очищает предыдущий terminal-результат, чтобы /status во время
    // нового прогона отражал только текущую сессию.
    ctx.lastResult = null;

    const cliPath = ctx.options.codexCliPath;
    log.debug({ cliPath }, "[Broker.start] spawning codex login --device-auth");

    let child: ChildProcessWithoutNullStreams;
    try {
      // stdin тоже открыт, хотя мы в него не пишем: CLI считает, что запущен
      // интерактивно, и не пытается открыть /dev/tty, которого в контейнере может не быть.
      child = ctx.options.spawnFn(cliPath, ["login", "--device-auth"], {
        stdio: ["pipe", "pipe", "pipe"],
        // Копия окружения: дочерний процесс должен унаследовать переменные Codex
        // (путь к конфигу, прокси), но не получать ссылку на наш process.env.
        env: { ...process.env },
      });
    } catch (err) {
      // Синхронный бросок возможен при неверных аргументах; это не то же самое, что
      // асинхронная ошибка запуска, которая приходит событием error ниже.
      log.error({ err }, "[Broker.start] spawn failed");
      recordTerminalResult(ctx, {
        ok: false,
        // Идентификатор генерируется здесь же: сессии еще нет, но исход нужно к чему-то
        // привязать, чтобы UI сопоставил его с попыткой входа.
        sessionId: randomUUID(),
        finishedAt: Date.now(),
        reason: "spawn_failed",
        exitCode: null,
        signal: null,
      });
      return c.json({ error: "spawn_failed", message: String(err) }, 500);
    }

    const sessionId = randomUUID();
    const startedAt = Date.now();

    // Ожидание вывода CLI с тремя конкурирующими исходами: найденный код, выход процесса
    // и таймаут ожидания. Промис завершается ровно один раз - за этим следит флаг
    // settled, а не порядок событий, который зависит от планировщика.
    const parsePromise = new Promise<DeviceAuthInfo>((resolve, reject) => {
      let settled = false;
      // Буфер общий для stdout и stderr: CLI может писать в любой из них, а ссылка и
      // код в теории могут оказаться в разных потоках.
      let buffered = "";

      const tryParse = () => {
        const info = extractDeviceAuth(buffered);
        if (info && !settled) {
          settled = true;
          // Слушатели снимаются сразу: после успеха фрагменты больше не нужны, а
          // накопление буфера съедало бы память на долгой сессии.
          child.stdout.off("data", onData);
          child.stderr.off("data", onStderr);
          resolve(info);
        }
      };
      const onData = (data: Buffer) => {
        const text = data.toString("utf8");
        buffered += text;
        // В лог уходит только очищенный и обрезанный фрагмент: сырой буфер содержит
        // одноразовый код.
        log.debug({ chunk: redactChunkForLog(text) }, "[Broker.start] codex stdout");
        tryParse();
      };
      const onStderr = (data: Buffer) => {
        const text = data.toString("utf8");
        log.debug({ chunk: redactChunkForLog(text) }, "[Broker.start] codex stderr");
        buffered += text;
        tryParse();
      };
      const onExit = (code: number | null) => {
        // Выход раньше кода означает, что логин не состоится: ждать больше нечего,
        // поэтому промис отклоняется с кодом выхода для диагностики.
        if (!settled) {
          settled = true;
          reject(
            new DeviceAuthParseError(
              "exit_nonzero",
              `codex exited before printing device auth (code=${code})`,
              code,
            ),
          );
        }
      };
      const onError = (err: Error) => {
        // Событие error у уже созданного процесса означает сбой запуска бинарника,
        // поэтому и причина отдельная: на нее UI реагирует подсказкой про установку
        // Codex, а не сообщением о неудачном вводе кода.
        if (!settled) {
          settled = true;
          // `error`-события у запущенного процесса обычно означают, что бинарник не удалось
          // стартовать (ENOENT, EACCES и т.п.) — показывайте это как
          // spawn_failed, не сваливая в exit_nonzero.
          reject(new DeviceAuthParseError("spawn_failed", err.message));
        }
      };

      child.stdout.on("data", onData);
      child.stderr.on("data", onStderr);
      child.once("exit", onExit);
      child.once("error", onError);

      // Страховка на случай, когда CLI жив, но код так и не напечатал: завис на вводе,
      // потерял сеть, ждет недоступный сервис. Таймер не снимается при успехе - он
      // помечен unref и обезврежен флагом settled, поэтому отдельная очистка не нужна.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          child.stdout.off("data", onData);
          child.stderr.off("data", onStderr);
          reject(
            new DeviceAuthParseError(
              "parse_timeout",
              "timed out waiting for codex device auth output",
            ),
          );
        }
      }, 15_000).unref();
    });

    let info: DeviceAuthInfo;
    try {
      info = await parsePromise;
    } catch (err) {
      log.error({ err }, "[Broker.start] failed to parse device auth output");
      try {
        // Процесс обязательно гасится: иначе брошенный CLI остался бы ждать ввода
        // вечно, а контейнер копил бы лишние процессы.
        child.kill("SIGTERM");
      } catch {
        // Процесс мог уже завершиться сам - это не ошибка.
        // игнорируем
      }
      // Тип проверяется явно: в промис мог попасть и обычный Error. Для неизвестной
      // ошибки берется консервативный код выхода с самого процесса.
      const parseErr = err instanceof DeviceAuthParseError ? err : null;
      recordTerminalResult(ctx, {
        ok: false,
        sessionId,
        finishedAt: Date.now(),
        reason: parseErr?.reason ?? "exit_nonzero",
        exitCode: parseErr?.exitCode ?? child.exitCode,
        signal: null,
      });
      return c.json({ error: "device_auth_parse_failed", message: String(err) }, 500);
    }

    // Служебный лог получает только маску: полный код уходит исключительно в HTTP-ответ,
    // который читает браузер пользователя.
    log.debug({ userCodeMasked: maskUserCode(info.userCode) }, "[Broker.start] device auth parsed");

    // Общий таймаут сессии стартует только после успешного разбора: до этого момента
    // за время ожидания отвечает таймаут парсинга выше.
    const timeoutHandle = setTimeout(() => {
      log.warn({ sessionId }, "[Broker.start] session timed out");
      terminateSession(ctx, "timeout");
    }, SESSION_TIMEOUT_MS);
    timeoutHandle.unref();

    // Сессия собирается уже после разбора, поэтому она всегда содержит валидную пару
    // "ссылка + код" - состояния "сессия без кода" не существует.
    const session: LoginSession = {
      id: sessionId,
      child,
      verificationUrl: info.verificationUrl,
      userCode: info.userCode,
      startedAt,
      timeoutHandle,
    };

    // Слушатель выхода вешается только на успешно разобранную сессию. Это осознанное
    // разделение: ранний выход до печати кода уже обработан в parsePromise, а здесь
    // фиксируется исход полноценного входа, который пользователь видел в браузере.
    child.once("exit", (code, signal) => {
      log.info({ sessionId, code, signal }, "[Broker.childExit] codex exited");
      // Если сессия уже была очищена terminateSession (cancel/timeout),
      // сохраняем тот terminal-результат — terminateSession записала причину
      // до подачи сигнала процессу.
      // Сверка идентификатора - единственный способ отличить самостоятельный выход
      // процесса от того, что мы уже закрыли сессию сами. Без нее позднее событие
      // перезаписало бы причину cancel/timeout на exit_nonzero.
      if (ctx.currentSession?.id !== sessionId) return;
      clearTimeout(session.timeoutHandle);
      const reason = classifyExit(code, signal);
      recordTerminalResult(ctx, {
        ok: reason === "success",
        sessionId,
        finishedAt: Date.now(),
        reason,
        exitCode: code,
        signal,
      });
      ctx.currentSession = null;
    });

    ctx.currentSession = session;
    // Публикация сессии происходит последним шагом: пока она не видна в ctx, /status и
    // /cancel ее не заметят, а значит не смогут вмешаться в инициализацию.
    log.info(
      { sessionId, userCodeMasked: maskUserCode(info.userCode) },
      "[Broker.start] session started",
    );
    return c.json({
      sessionId,
      verificationUrl: info.verificationUrl,
      userCode: info.userCode,
      startedAt: new Date(startedAt).toISOString(),
    });
  });

  app.post("/codex/login/cancel", (c) => {
    log.debug("[Broker.cancel] enter");
    const session = ctx.currentSession;
    // Идемпотентный ответ на отмену без активной сессии: клиент может повторить запрос,
    // и для него это не ошибка, а просто нечего отменять.
    if (!session) return c.json({ ok: true, cancelled: false });
    terminateSession(ctx, "cancel");
    // Возвращается идентификатор именно той сессии, которую закрыли, - чтобы клиент не
    // спутал ответ с результатом другого запуска.
    return c.json({ ok: true, cancelled: true, sessionId: session.id });
  });

  return app;
}

// Сборка runtime-объекта без сети - удобно для тестов и для встраивания приложения в
// другой сервер. Здесь же единственный раз применяются значения по умолчанию.
export function createBrokerRuntime(options: BrokerOptions = {}): BrokerRuntime {
  const ctx: BrokerContext = {
    currentSession: null,
    lastResult: null,
    options: {
      port: options.port ?? DEFAULT_PORT,
      host: options.host ?? DEFAULT_HOST,
      // Имя бинарника вместо абсолютного пути: в контейнере он берется из PATH, а
      // снаружи конфигурация может подставить свой путь.
      codexCliPath: options.codexCliPath ?? "codex",
      spawnFn: options.spawnFn ?? spawn,
    },
  };

  const app = createBrokerApp(ctx);
  // Аксессоры возвращают ссылки на текущее состояние, а не снимок: тест видит
  // изменения сразу после обработки запроса.
  return {
    app,
    getCurrentSession: () => ctx.currentSession,
    getLastResult: () => ctx.lastResult,
  };
}

// Запуск настоящего HTTP-сервера. Runtime и сервер разделены, потому что поднятие
// порта - побочный эффект, который не нужен тестам на маршруты.
export async function startLoginBroker(options: BrokerOptions = {}): Promise<BrokerServer> {
  const runtime = createBrokerRuntime(options);
  // Дефолты берутся из options повторно, а не из runtime: наружу нужно вернуть
  // фактически занятые host и port, которые использует docker-compose.
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;

  const server = serve({ fetch: runtime.app.fetch, port, hostname: host });
  log.info({ host, port }, "[CodexLoginBroker] listening");

  return {
    runtime,
    server,
    port,
    host,
    close: () =>
      // Промис завершается по коллбеку close: вызывающий должен дождаться реального
      // освобождения порта, иначе повторный старт в том же процессе упадет с EADDRINUSE.
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
