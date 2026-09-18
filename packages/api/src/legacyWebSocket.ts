/**
 * Мост между пакетом ws и контрактом Hono для WebSocket (defineWebSocketHelper).
 *
 * Зачем он нужен: встроенный WebSocket-путь node-адаптера Hono включается
 * флагом AIF_API_NODE_SERVER_V2_WEBSOCKET_ENABLED. Когда флаг выключен,
 * HTTP-часть приложения остается прежней, а обмен по сокету продолжает старый
 * клиент - его нельзя оборвать без синхронного обновления фронтенда, поэтому
 * совместимость поддерживается здесь, а не в ws.ts.
 *
 * Как это работает: апгрейд перехватывает сам http-сервер (в ws он поднят в
 * режиме noServer), затем запрос прогоняется через обычный app.request, чтобы
 * отработали маршруты, middleware и авторизация. Если маршрут согласился на
 * апгрейд, рукопожатие завершает ws, и только тогда создается WSContext.
 *
 * На что обращать внимание при правках:
 *
 * 1. Связь между HTTP-запросом и соединением ws устанавливается через
 *    символ в env и карту по IncomingMessage. Символ обязателен: по одному
 *    объекту запроса может пройти несколько попыток, и разрешать чужое
 *    соединение нельзя.
 * 2. Апгрейд и создание WSContext асинхронны и не удерживают HTTP-ответ:
 *    обработчик возвращает Response сразу, а жизненный цикл сокета
 *    продолжается в отсоединенной задаче.
 * 3. Ошибки пользовательских обработчиков не выбрасываются наружу: у моста
 *    нет вызывающей стороны, которая могла бы их поймать.
 */

import type { ServerType } from "@hono/node-server";
import type { Env, Hono } from "hono";
import {
  defineWebSocketHelper,
  WSContext,
  type UpgradeWebSocket,
  type WSMessageReceive,
  type WSReadyState,
} from "hono/ws";
import { STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

export interface LegacyWebSocketBridge {
  injectWebSocket(server: ServerType): void;
  upgradeWebSocket: UpgradeWebSocket<WebSocket, { onError?: (error: unknown) => void }>;
}

// Символ вместо строкового ключа: в env могут лежать и другие привязки, и
// коллизия имен молча сломала бы сопоставление запроса с соединением.
const LEGACY_CONNECTION_SYMBOL: unique symbol = Symbol("legacy-websocket-connection");

// Форма env, которую ожидает Hono на Node: incoming - исходный запрос,
// outgoing всегда undefined, потому что ответ формирует адаптер, а не мост.
interface LegacyWebSocketBindings {
  incoming: IncomingMessage;
  outgoing: undefined;
  [LEGACY_CONNECTION_SYMBOL]?: symbol;
}

// Ожидание соединения ws, начатое во время обработки маршрута и завершаемое
// из события "connection": к моменту его прихода готового сокета еще нет.
interface PendingWebSocket {
  connectionSymbol: symbol;
  resolve: (webSocket: WebSocket) => void;
}

// ws отдает числа состояний 0..3, а тип Hono допускает только 0..3 без
// значения 3 по умолчанию; неизвестные значения приводятся к CLOSED, чтобы
// наружу не утекло невалидное число.
function toReadyState(value: number): WSReadyState {
  if (value === 0 || value === 1 || value === 2) {
    return value;
  }
  return 3;
}

// RawData в ws - это Buffer, ArrayBuffer или их массив. Функция приводит все
// варианты к одному Buffer, чтобы дальнейший разбор не разветвлялся.
function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function toMessageData(data: RawData, isBinary: boolean): WSMessageReceive {
  const buffer = toBuffer(data);
  if (!isBinary) {
    return buffer.toString("utf8");
  }
  const copy = new Uint8Array(buffer.byteLength);
  // Копия обязательна: ws переиспользует внутренний пул, и отданный наружу
  // ArrayBuffer превратился бы в мусор при следующем чтении из сокета.
  copy.set(buffer);
  return copy.buffer;
}

// Внутренний запрос собирается вручную, потому что HTTP-сервер уже отдал
// апгрейд и готового Headers у моста нет.
function buildRequestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, rawValue] of Object.entries(request.headers)) {
    if (rawValue == null) {
      continue;
    }
    // Массив схлопывается до первого значения: склейка через запятую
    // исказила бы такие заголовки, как Authorization.
    headers.append(key, Array.isArray(rawValue) ? rawValue[0] : rawValue);
  }
  return headers;
}

// Ответ на апгрейд пишется в сокет вручную: рукопожатие не состоялось, и
// отдать обычный Response здесь нельзя. Content-Length: 0 закрывает тело явно,
// иначе клиент будет ждать данных, которых не будет.
function rejectUpgrade(socket: Duplex, status: number): void {
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n" +
      "\r\n",
  );
}

export function createLegacyWebSocketBridge<E extends Env>(app: Hono<E>): LegacyWebSocketBridge {
  // noServer: порт и апгрейд остаются у http-сервера, а ws только доводит до
  // конца уже принятое соединение. Иначе два сервера делили бы один порт.
  const webSocketServer = new WebSocketServer({ noServer: true });
  // Ключ - сам объект запроса: другого стабильного идентификатора у апгрейда
  // нет, а карта живет лишь до завершения рукопожатия.
  const pendingWebSockets = new Map<IncomingMessage, PendingWebSocket>();

  webSocketServer.on("connection", (webSocket, request) => {
    const pending = pendingWebSockets.get(request);
    // Соединение без ожидающего запроса никому не принадлежит: молча
    // закрываем его, чтобы оно не осталось висеть без обработчиков.
    if (!pending) {
      return;
    }
    pending.resolve(webSocket);
    pendingWebSockets.delete(request);
  });

  // Ожидание регистрируется до вызова app.request: событие "connection"
  // может прийти раньше, чем маршрут вернет управление.
  const waitForWebSocket = (
    request: IncomingMessage,
    connectionSymbol: symbol,
  ): Promise<WebSocket> =>
    new Promise((resolve) => {
      pendingWebSockets.set(request, { connectionSymbol, resolve });
    });

  const upgradeWebSocket = defineWebSocketHelper<WebSocket, { onError?: (error: unknown) => void }>(
    async (context, events, options) => {
      // Не-апгрейд пропускается без ответа: Hono продолжит обработку как
      // обычного HTTP-запроса.
      if (context.req.header("upgrade")?.toLowerCase() !== "websocket") {
        return;
      }

      const bindings = context.env as LegacyWebSocketBindings;
      // Привязки появляются только на Node-адаптере; в остальных средах
      // (например, в тестах без сокета) мост честно отвечает ошибкой.
      if (!bindings.incoming) {
        return new Response(null, { status: 500 });
      }

      const connectionSymbol = Symbol("legacy-websocket-request");
      // Символ пишется в env до входа в асинхронную часть: обработчик upgrade
      // должен успеть сравнить его с ожидающей записью.
      bindings[LEGACY_CONNECTION_SYMBOL] = connectionSymbol;
      const reportError = options?.onError ?? (() => undefined);

      // Отсоединенная задача: Hono ждет Response, а не завершения обмена.
      // Отсюда же берется гарантия, что рукопожатие уже состоялось - promise
      // разрешается только из события "connection".
      void (async () => {
        const webSocket = await waitForWebSocket(bindings.incoming, connectionSymbol);
        // Сообщения могут прийти между "connection" и навешиванием onMessage.
        // Буфер закрывает эту гонку без потери первых кадров.
        const bufferedMessages: Array<[RawData, boolean]> = [];
        const bufferMessage = (data: RawData, isBinary: boolean) => {
          bufferedMessages.push([data, isBinary]);
        };
        webSocket.on("message", bufferMessage);

        const webSocketContext = new WSContext<WebSocket>({
          raw: webSocket,
          url: context.req.url,
          protocol: webSocket.protocol,
          // Геттер, а не сохраненное значение: контекст живет дольше одного
          // кадра, и readyState обязан отражать текущее состояние сокета.
          get readyState() {
            return toReadyState(webSocket.readyState);
          },
          close(code, reason) {
            webSocket.close(code, reason);
          },
          send(source, sendOptions) {
            // Опция сжатия пробрасывается явно: без нее ws применил бы свое
            // умолчание, расходящееся с тем, что запросил вызывающий.
            webSocket.send(source, { compress: sendOptions.compress });
          },
        });

        try {
          events.onOpen?.(new Event("open"), webSocketContext);
        } catch (error) {
          // Пользовательский обработчик может выбросить что угодно; мост не
          // имеет права падать вместе с ним, поэтому ошибка уходит в onError.
          reportError(error);
        }

        const handleMessage = (data: RawData, isBinary: boolean) => {
          try {
            events.onMessage?.(
              new MessageEvent("message", { data: toMessageData(data, isBinary) }),
              webSocketContext,
            );
          } catch (error) {
            reportError(error);
          }
        };

        webSocket.off("message", bufferMessage);
        // Порядок строгий: снять буферный обработчик, проиграть накопленное,
        // и только затем навесить рабочий. Иначе кадры либо задвоились бы,
        // либо обогнали уже обработанные.
        for (const message of bufferedMessages) {
          handleMessage(...message);
        }
        webSocket.on("message", handleMessage);
        webSocket.on("close", (code, reason) => {
          try {
            // wasClean всегда true: мост не различает разрыв сети и штатное
            // закрытие, а клиентам важнее факт закрытия, чем его причина.
            events.onClose?.(
              Object.assign(new Event("close"), {
                code,
                reason: reason.toString(),
                wasClean: true,
              }),
              webSocketContext,
            );
          } catch (error) {
            reportError(error);
          }
        });
        webSocket.on("error", (error) => {
          try {
            // Ошибка заворачивается в событие и уходит в пользовательский
            // onError: событие протокола ошибок не имеет.
            events.onError?.(Object.assign(new Event("error"), { error }), webSocketContext);
          } catch (handlerError) {
            reportError(handlerError);
          }
        });
      })();

      // Пустой Response нужен только чтобы подтвердить маршрут: реальный
      // ответ на апгрейд пишет ws в сокет через handleUpgrade.
      return new Response();
    },
  );

  return {
    injectWebSocket(server) {
      // Слушатель upgrade вешается один раз при старте: нижележащий
      // http-сервер - единственное место, где еще есть доступ к сокету.
      const httpServer = server as Server;
      httpServer.on("upgrade", async (request, socket, head) => {
        // Запрос без upgrade оставляем другим слушателям: мост отвечает
        // только за протокол websocket.
        if (request.headers.upgrade?.toLowerCase() !== "websocket") {
          return;
        }

        const host = request.headers.host ?? "localhost";
        const url = new URL(request.url ?? "/", `http://${host}`);
        const bindings: LegacyWebSocketBindings = {
          incoming: request,
          outgoing: undefined,
        };
        let response: Response;
        try {
          // Полноценный проход через приложение, а не отдельная проверка:
          // только так на апгрейде отрабатывают middleware, аутентификация
          // и проверка ролей.
          response = await app.request(url, { headers: buildRequestHeaders(request) }, bindings);
        } catch {
          // Внутренняя ошибка приложения: завершаем рукопожатие отказом,
          // иначе сокет остался бы открытым без обработчиков.
          rejectUpgrade(socket, 500);
          return;
        }

        const pending = pendingWebSockets.get(request);
        // Символы должны совпасть: так отсекаются случаи, когда маршрут не
        // инициировал апгрейд вовсе или отказал в авторизации. Тогда в карту
        // попадает лишняя запись, и ее нужно убрать, а клиенту отдать статус
        // обычного HTTP-ответа.
        if (!pending || pending.connectionSymbol !== bindings[LEGACY_CONNECTION_SYMBOL]) {
          pendingWebSockets.delete(request);
          rejectUpgrade(socket, response.status);
          return;
        }

        // Рукопожатие завершается только теперь, когда подтверждено, что
        // соединение ожидает именно этот запрос.
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.emit("connection", webSocket, request);
        });
      });
      httpServer.on("close", () => {
        // Сервер сокетов не держит порт сам, но держит соединения: без
        // закрытия процесс не завершился бы при остановке API.
        webSocketServer.close();
      });
    },
    upgradeWebSocket,
  };
}
