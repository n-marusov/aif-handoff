/**
 * JSON-RPC клиент поверх stdio долгоживущего процесса `codex app-server`.
 *
 * Транспорт - newline-delimited JSON (JSONL): каждое сообщение это одна строка JSON,
 * завершенная переводом строки. Никакого Content-Length фрейминга, как в LSP, здесь
 * нет, поэтому весь разбор сводится к накоплению буфера и разрезанию его по строкам.
 *
 * Почему клиент устроен именно так:
 * - Строки приходят кусками. Чанк из stdout может оборваться на середине JSON или даже
 *   на середине UTF-8 последовательности, поэтому буфер склеивается до последнего
 *   полного перевода строки, а декодирование идет через StringDecoder: он умеет
 *   придерживать неполный многобайтовый символ до следующего чанка.
 * - Запросы коррелируются по id. Клиент сам генерирует монотонный id, кладет в
 *   pending-карту resolve/reject и таймер, а входящее сообщение с тем же id закрывает
 *   эту запись. Ответ на неизвестный id не роняет соединение, а только логируется:
 *   peer может прислать запоздавший ответ уже после собственного таймаута клиента.
 * - Протокол двунаправленный. Сервер тоже умеет присылать request с id и ждать ответа,
 *   поэтому входящие сообщения маршрутизируются в четыре ветки: server-request,
 *   notification, success, error. Порядок проверок важен: method + id это запрос,
 *   method без id это notification, и только затем разбираются result/error.
 * - Смерть процесса обязана разбудить всех ожидающих. Если дочерний процесс упал или
 *   завершился, висящие промисы иначе не завершатся никогда, и код вызывающей стороны
 *   навсегда останется в await. Поэтому error/exit вешают reject на всю pending-карту.
 * - Клиент одноразовый по жизни процесса. detach() снимает слушатели и помечает клиент
 *   закрытым; повторный вызов безопасен за счет флага closed.
 *
 * Инварианты:
 * - Любой путь завершения (close, exit, ошибка процесса, битый JSON) сначала отбивает
 *   pending-запросы, и только потом отключает слушатели. Обратный порядок оставил бы
 *   окно, в котором ответ уже некому отдать, а промис все еще ждет.
 * - В буфере stdout всегда лежит только незавершенный хвост строки, он не теряется
 *   между чанками и не смешивается с уже разобранными сообщениями.
 */

import { StringDecoder } from "node:string_decoder";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  JsonRpcErrorEnvelope,
  JsonRpcNotificationEnvelope,
  JsonRpcRequestEnvelope,
  JsonRpcSuccessEnvelope,
} from "./protocol.js";

// Логгер передается снаружи, и все его методы опциональны: адаптер может вообще не
// иметь логирования, и клиент не должен требовать его наличия.
export interface JsonlRpcClientLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

// Все, что нужно клиенту для работы, приходит снаружи: сам он не читает env и не знает
// про профили рантайма, что позволяет переиспользовать его в тестах с фейковым
// дочерним процессом.
//
// Опции описывают не только транспорт, но и обратные вызовы: клиент не знает, что
// делать с notification и server-request, - это политика адаптера.
export interface JsonlRpcClientOptions {
  runtimeId: string;
  profileId?: string | null;
  transport?: string;
  requestTimeoutMs?: number;
  logger?: JsonlRpcClientLogger;
  onNotification?: (notification: JsonRpcNotificationEnvelope) => void;
  onRequest?: (request: JsonRpcRequestEnvelope) => Promise<unknown> | unknown;
  // onProtocolError - сигнал уровня адаптера о том, что поток неисправимо испорчен:
  // после него клиент отсоединяется, потому что синхронизация по строкам потеряна.
  onProtocolError?: (error: Error) => void;
}

// PendingRequest - минимальная запись, достаточная, чтобы разрешить или отклонить
// ожидание и убрать за собой таймер.
interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

// Дефолт намеренно небольшой: локальный процесс app-server должен отвечать быстро, а
// зависший запрос лучше уронить раньше, чем держать всю цепочку задач.
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
// Отдельный тип ошибки, а не Error с текстом: вызывающий код должен уметь отличить
// "сервер ответил ошибкой" от "соединение умерло" без разбора строки сообщения.
export class JsonlRpcResponseError extends Error {
  public readonly rpcId: string;
  public readonly rpcMethod: string;
  public readonly rpcCode: number | null;
  public readonly rpcData: unknown;

  // Поля объявлены readonly и заполняются в конструкторе: ошибка неизменяема, ее можно
  // безопасно прокидывать вверх по стеку.
  constructor(input: {
    message: string;
    rpcId: string;
    rpcMethod: string;
    rpcCode?: number | null;
    rpcData?: unknown;
  }) {
    // name переопределяется, чтобы в логах и стектрейсах был виден конкретный класс,
    // а не абстрактный Error.
    super(input.message);
    this.name = "JsonlRpcResponseError";
    this.rpcId = input.rpcId;
    this.rpcMethod = input.rpcMethod;
    this.rpcCode = input.rpcCode ?? null;
    this.rpcData = input.rpcData;
  }
}

// Клиент привязан к конкретному дочернему процессу: переиспользовать его после смерти
// процесса нельзя, нужно поднимать новый процесс и новый клиент.
export class JsonlRpcClient {
  // Ссылки на процесс и коллбеки хранятся как readonly-поля: клиент не переиспользует
  // соединение и не подменяет обработчики на лету.
  private readonly childProcess: ChildProcessWithoutNullStreams;
  // Дефолт материализуется один раз в конструкторе, чтобы в горячем пути не
  // разбираться с undefined.
  private readonly requestTimeoutMs: number;
  // Логгер опционален: отсутствие логирования это норма, а не деградация.
  private readonly logger?: JsonlRpcClientLogger;
  // runtimeId/profileId/transport попадают в каждую запись лога: по ним записи
  // группируются, когда одновременно работают несколько профилей рантайма.
  private readonly runtimeId: string;
  private readonly profileId: string | null;
  private readonly transport: string;
  // Коллбеки вызываются синхронно из обработчика stdout: их не следует делать
  // тяжелыми, чтобы не блокировать разбор входящего потока.
  private readonly onNotification?: (notification: JsonRpcNotificationEnvelope) => void;
  private readonly onRequest?: (request: JsonRpcRequestEnvelope) => Promise<unknown> | unknown;
  private readonly onProtocolError?: (error: Error) => void;
  // pending - единственный источник правды о том, кто ждет ответа. Ключ это строковый
  // id, потому что JSON-RPC допускает и строковые, и числовые id.
  private readonly pending = new Map<string, PendingRequest>();
  // StringDecoder, а не chunk.toString(): последний срезал бы неполный UTF-8 символ на
  // границе чанка и превратил бы его в мусор.
  private readonly decoder = new StringDecoder("utf8");

  // nextId монотонно растет и никогда не переиспользуется: так запоздавший ответ на
  // старый запрос не может случайно закрыть новый.
  private nextId = 0;
  // stdoutBuffer хранит незавершенный хвост строки между чанками.
  private stdoutBuffer = "";
  // closed - признак того, что слушатели сняты и клиент больше не обслуживает запросы.
  private closed = false;

  constructor(childProcess: ChildProcessWithoutNullStreams, options: JsonlRpcClientOptions) {
    this.childProcess = childProcess;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.logger = options.logger;
    this.runtimeId = options.runtimeId;
    this.profileId = options.profileId ?? null;
    this.transport = options.transport ?? "app-server";
    this.onNotification = options.onNotification;
    this.onRequest = options.onRequest;
    this.onProtocolError = options.onProtocolError;

    // Подписки вешаются сразу в конструкторе: app-server может начать писать в stdout
    // раньше, чем мы отправим первый запрос, и эти сообщения нельзя потерять.
    childProcess.stdout.on("data", this.handleStdoutData);
    childProcess.on("error", this.handleChildError);
    childProcess.on("exit", this.handleChildExit);

    // Логируем параметры соединения, но не сам транспорт целиком: этого достаточно,
    // чтобы сопоставить клиента с профилем при разборе инцидентов.
    this.logger?.debug?.(
      {
        runtimeId: this.runtimeId,
        profileId: this.profileId,
        transport: this.transport,
        requestTimeoutMs: this.requestTimeoutMs,
      },
      "DEBUG [runtime:codex] Initialized stdio JSONL RPC client",
    );
  }

  // Проверка закрытости до генерации id: после detach() писать в stdin уже нельзя, и
  // лучше упасть понятной ошибкой, чем зависнуть в ожидании ответа, которого не будет.
  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) {
      throw new Error("JSONL RPC client is closed");
    }

    // Id строковый, чтобы сравнение с входящими id не зависело от того, число там или
    // строка.
    const id = String(++this.nextId);
    // Вызывающий может запросить свой таймаут: длинные операции живут дольше дефолта.
    const effectiveTimeoutMs = timeoutMs ?? this.requestTimeoutMs;
    const payload: JsonRpcRequestEnvelope = {
      id,
      method,
      params,
    };

    this.logger?.debug?.(
      {
        runtimeId: this.runtimeId,
        profileId: this.profileId,
        transport: this.transport,
        method,
        id,
        timeoutMs: effectiveTimeoutMs,
      },
      "DEBUG [runtime:codex] Sending JSONL RPC request",
    );

    // Каждому запросу выдается собственный таймер: ответ обязан прийти до его
    // срабатывания, иначе pending-запись снимается и промис падает.
    return await new Promise<unknown>((resolve, reject) => {
      // Таймер удаляет запись из карты сам: иначе она висела бы до конца жизни клиента
      // и позже получила бы повторный reject при failPendingRequests.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for JSONL RPC response (${method})`));
      }, effectiveTimeoutMs);

      // Регистрация в карте происходит до записи в stdin: иначе ответ мог бы прийти
      // быстрее, чем мы успели бы зарегистрировать ожидание.
      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
      });

      // Если запись в stdin сорвется, промис нужно отклонить и подчистить карту, иначе
      // запрос остался бы висеть до таймаута впустую.
      this.writeMessage(payload).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  // Notification - это запрос без id: ответа на него не будет, поэтому в pending
  // ничего не кладется и таймаут не заводится.
  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) {
      throw new Error("JSONL RPC client is closed");
    }

    // Отличие от request только в отсутствии id в конверте.
    const payload: JsonRpcNotificationEnvelope = {
      method,
      params,
    };
    await this.writeMessage(payload);
  }

  // Явное закрытие: сначала будим ожидающих, потом снимаем слушатели, и только затем
  // закрываем stdin, чтобы уже начатая запись не упала в никуда.
  close(reason = "client closed"): void {
    // Порядок важен: failPendingRequests должен отработать, пока слушатели еще живы.
    this.failPendingRequests(new Error(reason));
    this.detach();
    // stdin.end() может бросить, если процесс уже умер: это ожидаемо и не должно
    // мешать закрытию клиента.
    try {
      this.childProcess.stdin.end();
    } catch {
      // игнорируем
    }
  }

  // Разбор потока: накопили буфер, забрали все полные строки, хвост оставили до
  // следующего чанка. Цикл, а не один проход, потому что один чанк часто содержит
  // несколько сообщений сразу.
  private readonly handleStdoutData = (chunk: Buffer | string): void => {
    // После detach() данные еще могут прилететь из уже поставленного в очередь
    // коллбека.
    if (this.closed) {
      return;
    }

    // decoder.write возвращает только полностью декодированную часть, придерживая
    // недособранный символ внутри себя до следующего вызова.
    this.stdoutBuffer += this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    // Внутри цикла буфер переписывается, поэтому индекс пересчитывается заново.
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    // slice, а не split: split создавал бы массив всех строк и лишние аллокации на
    // каждый чанк, тогда как нам нужна ровно одна строка за шаг.
    while (newlineIndex !== -1) {
      // trim отсекает "\r" (CRLF) и случайные пробелы по краям.
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      // Хвост буфера переносится в начало: следующий чанк допишется к нему в конец.
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      // Пустые строки это обычный шум транспорта, их молча пропускаем.
      if (line) {
        this.handleLine(line);
      }
      // Индекс ищется заново по изменившемуся буферу, а не сдвигается на длину строки:
      // так разбор не зависит от того, как именно переписался буфер.
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  };

  // Ошибка процесса (например, ENOENT при запуске) не гарантирует события exit,
  // поэтому ожидающие запросы надо отклонить именно здесь.
  private readonly handleChildError = (error: Error): void => {
    this.logger?.error?.(
      {
        runtimeId: this.runtimeId,
        profileId: this.profileId,
        transport: this.transport,
        error: error.message,
      },
      "ERROR [runtime:codex] JSONL RPC child process emitted error",
    );
    // Клиент не пытается перезапустить процесс: это задача адаптера, а здесь важно
    // лишь не оставить висящих ожиданий.
    this.failPendingRequests(error);
    this.detach();
  };

  // Выход процесса рвет все ожидания: сам процесс уже не ответит, и единственный
  // корректный исход - отклонить pending-запросы с диагностичной ошибкой.
  private readonly handleChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    // Код и сигнал попадают в текст ошибки, потому что это часто единственная зацепка
    // при разборе падений app-server.
    const error = new Error(
      `Codex app-server process exited while RPC requests were pending (code=${code ?? "null"}, signal=${signal ?? "null"})`,
    );
    this.logger?.warn?.(
      {
        runtimeId: this.runtimeId,
        profileId: this.profileId,
        transport: this.transport,
        pendingRequestCount: this.pending.size,
        code,
        signal,
      },
      "WARN [runtime:codex] JSONL RPC child process exited",
    );
    // Слушатели снимаются после отклонения запросов, чтобы клиент не остался живым в
    // полузакрытом состоянии.
    this.failPendingRequests(error);
    this.detach();
  };

  // Маршрутизация одного сообщения. JSON.parse - единственное место, где мы доверяем
  // формату строки, и единственное, где битый ввод считается фатальным.
  private handleLine(line: string): void {
    // parsed объявлен снаружи try, чтобы разбирать его после блока.
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
      // Нечитаемый JSON означает, что мы потеряли границу сообщения: продолжать разговор
      // по этому потоку нельзя. Поэтому битый payload считается протокольной ошибкой и
      // рвет соединение, а не игнорируется как незнакомая форма.
    } catch (error) {
      this.logger?.warn?.(
        {
          runtimeId: this.runtimeId,
          profileId: this.profileId,
          transport: this.transport,
          parseError: error instanceof Error ? error.message : String(error),
        },
        "WARN [runtime:codex] Failed to parse JSONL RPC message",
      );
      // Сначала будим ожидающих, потом уведомляем адаптер, потом отключаемся - именно
      // в этом порядке, чтобы ни один слушатель не остался ждать навсегда.
      const protocolError = new Error("Malformed JSONL RPC payload from Codex app-server");
      this.failPendingRequests(protocolError);
      this.onProtocolError?.(protocolError);
      this.detach();
      return;
    }

    // Валидный JSON может быть примитивом (null, число, строка): сообщением это не
    // является, но и соединение не портит - просто игнорируем.
    if (!parsed || typeof parsed !== "object") {
      this.logger?.warn?.(
        {
          runtimeId: this.runtimeId,
          profileId: this.profileId,
          transport: this.transport,
          payloadType: typeof parsed,
        },
        "WARN [runtime:codex] Ignoring non-object JSONL RPC payload",
      );
      return;
    }

    // Читаем поля через readString: id и method приходят из недоверенного источника.
    const message = parsed as Record<string, unknown>;
    const method = readString(message.method);
    const id = message.id;

    // Порядок веток задан протоколом: наличие method однозначно говорит о запросе или
    // notification, и только при его отсутствии имеет смысл смотреть на result/error.
    if (method && id != null) {
      this.handleServerRequest(message as unknown as JsonRpcRequestEnvelope);
      return;
    }
    // method без id - это notification: ответ не подразумевается.
    if (method) {
      this.onNotification?.(message as unknown as JsonRpcNotificationEnvelope);
      return;
    }
    // hasOwnProperty, а не truthiness: валидный ответ может нести result: null, и
    // проверка на "message.result" ошибочно пропустила бы его. Наличие ключа и есть
    // признак success.
    if (Object.prototype.hasOwnProperty.call(message, "result") && id != null) {
      this.handleSuccess(message as unknown as JsonRpcSuccessEnvelope);
      return;
    }
    // Симметрично success: ошибка опознается по самому наличию поля error.
    if (Object.prototype.hasOwnProperty.call(message, "error") && id != null) {
      this.handleError(message as unknown as JsonRpcErrorEnvelope);
      return;
    }

    // Сообщение с id, но без method/result/error не подходит ни под одну форму - это
    // повод для предупреждения, но не для разрыва соединения.
    this.logger?.warn?.(
      {
        runtimeId: this.runtimeId,
        profileId: this.profileId,
        transport: this.transport,
        keys: Object.keys(message),
      },
      "WARN [runtime:codex] Ignoring unknown JSONL RPC payload shape",
    );
  }

  // Сервер инициировал запрос к нам (например, запрос разрешения). Ответ обязателен:
  // без него peer будет ждать до своего таймаута.
  private handleServerRequest(message: JsonRpcRequestEnvelope): void {
    this.logger?.warn?.(
      {
        runtimeId: this.runtimeId,
        profileId: this.profileId,
        transport: this.transport,
        method: message.method,
        id: message.id,
      },
      "WARN [runtime:codex] Received server-initiated JSONL RPC request",
    );

    // Если адаптер не умеет обрабатывать такие запросы, отвечаем штатной JSON-RPC
    // ошибкой "method not found" со стандартным кодом -32601, а не молчанием.
    if (!this.onRequest) {
      void this.writeMessage({
        id: message.id,
        error: {
          code: -32601,
          message: "Server-initiated request handler is not configured",
        },
      }).catch((error) => this.logServerRequestResponseError(message, error));
      return;
    }

    // Promise.resolve() разворачивает возможный синхронный throw из onRequest в обычное
    // отклонение промиса: иначе исключение вылетело бы прямо из обработчика события.
    // result ?? {} - JSON-RPC требует наличия поля result даже когда handler вернул
    // undefined, и клиент не должен из-за этого ломаться.
    Promise.resolve()
      .then(() => this.onRequest?.(message))
      .then((result) =>
        this.writeMessage({
          id: message.id,
          result: result ?? {},
        }),
      )
      // Ошибка handler превращается в -32000 (server error), текст передается как есть.
      .catch((error) =>
        this.writeMessage({
          id: message.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      )
      // Последний catch страхует саму отправку ответа: сбой записи в stdin уже некому
      // сообщить, остается только залогировать.
      .catch((error) => this.logServerRequestResponseError(message, error));
  }

  // Успешный ответ закрывает ровно одну запись pending: id уже сопоставлен, осталось
  // снять таймер и разрешить промис.
  private handleSuccess(message: JsonRpcSuccessEnvelope): void {
    // Приведение к строке: id в конверте может быть числом, а ключи карты строковые.
    const id = String(message.id);
    const pending = this.pending.get(id);
    // Неизвестный id - не ошибка протокола, а скорее запоздавший ответ после таймаута
    // клиента: логируем и продолжаем, ронять соединение из-за этого нельзя.
    if (!pending) {
      this.logger?.warn?.(
        {
          runtimeId: this.runtimeId,
          profileId: this.profileId,
          transport: this.transport,
          id,
        },
        "WARN [runtime:codex] Received JSONL RPC response for unknown request id",
      );
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(message.result);
  }

  // Ошибка ответа отличается от success только тем, что промис отклоняется, а не
  // разрешается: структурированные поля ошибки сохраняются в JsonlRpcResponseError.
  private handleError(message: JsonRpcErrorEnvelope): void {
    const id = String(message.id);
    const pending = this.pending.get(id);
    if (!pending) {
      this.logger?.warn?.(
        {
          runtimeId: this.runtimeId,
          profileId: this.profileId,
          transport: this.transport,
          id,
          errorCode: message.error?.code ?? null,
        },
        "WARN [runtime:codex] Received JSONL RPC error for unknown request id",
      );
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);

    // Если сервер не дал текст, подставляем свой с именем метода: так ошибку можно
    // опознать в логах без дополнительного контекста.
    const errorMessage =
      message.error?.message ?? `Codex app-server JSONL RPC request failed (${pending.method})`;
    pending.reject(
      new JsonlRpcResponseError({
        message: errorMessage,
        rpcId: id,
        rpcMethod: pending.method,
        rpcCode: message.error?.code,
        rpcData: message.error?.data,
      }),
    );
  }

  // Запись - единственное место, где мы трогаем stdin. Промис завершается коллбеком,
  // так что вызывающий видит реальный результат записи, а не просто факт постановки в
  // буфер.
  private async writeMessage(message: unknown): Promise<void> {
    if (this.closed) {
      throw new Error("JSONL RPC client is closed");
    }
    // Обязательный перевод строки в конце - это и есть фрейминг JSONL.
    const payload = `${JSON.stringify(message)}\n`;
    // Коллбек записи получает ошибку только при сбое конкретной записи, в отличие от
    // события "error" у потока, которое не привязано к конкретному вызову.
    await new Promise<void>((resolve, reject) => {
      this.childProcess.stdin.write(payload, "utf8", (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  // Единая точка логирования сбоев отправки ответа на server-request: после провала
  // записи в stdin сделать уже ничего нельзя.
  private logServerRequestResponseError(message: JsonRpcRequestEnvelope, error: unknown): void {
    this.logger?.error?.(
      {
        runtimeId: this.runtimeId,
        profileId: this.profileId,
        transport: this.transport,
        method: message.method,
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "ERROR [runtime:codex] Failed to send JSONL RPC response for server request",
    );
  }

  // Общий выход для всех аварийных сценариев: отклонить всех ожидающих ровно один раз
  // и очистить карту, чтобы повторный вызов ничего не делал.
  private failPendingRequests(error: Error): void {
    // Быстрый выход: в нормальном режиме карта пуста большую часть времени.
    if (this.pending.size === 0) {
      return;
    }
    // Итерация по карте, а не по значениям: id нужен в тексте ошибки, чтобы вызывающая
    // сторона понимала, какой именно запрос не дождался ответа.
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`[request:${id}] ${error.message}`));
    }
    // clear после reject: если обработчик отклонения синхронно дернет клиент еще раз,
    // карта уже пуста и повторных отклонений не будет.
    this.pending.clear();
  }

  // Идемпотентное отключение: снимает всех слушателей и закрывает клиент. Флаг closed
  // защищает от повторного снятия и от гонки между exit и error.
  private detach(): void {
    if (this.closed) {
      return;
    }
    // Флаг ставится до off(): обработчик может быть уже в очереди событий, и он должен
    // увидеть закрытое состояние.
    this.closed = true;
    // Снимаем ровно те же ссылки на стрелочные функции-поля, что и вешали в
    // конструкторе: привязка через bind() здесь не сработала бы.
    this.childProcess.stdout.off("data", this.handleStdoutData);
    this.childProcess.off("error", this.handleChildError);
    this.childProcess.off("exit", this.handleChildExit);
  }
}

// Нормализация строковых полей из недоверенного ввода: пустая строка и строка из
// пробелов считаются отсутствием значения.
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
