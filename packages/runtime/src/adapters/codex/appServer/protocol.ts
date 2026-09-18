/**
 * Типы и константы протокола codex app-server.
 *
 * Файл служит единственным описанием контракта: имена методов, формы конвертов JSON-RPC
 * и связка "метод -> тип запроса и ответа". Остальные модули адаптера импортируют типы
 * отсюда, поэтому расхождение сигнатур ловится компилятором, а не в рантайме.
 *
 * Типы из ./generated/ сгенерированы по схеме сервера и вручную не редактируются -
 * их обновляют вместе с версией codex.
 */

import type { ClientNotification } from "./generated/ClientNotification.js";
import type { InitializeParams } from "./generated/InitializeParams.js";
import type { InitializeResponse } from "./generated/InitializeResponse.js";
import type { ServerNotification } from "./generated/ServerNotification.js";
import type { ServerRequest } from "./generated/ServerRequest.js";
import type { ModelListParams } from "./generated/v2/ModelListParams.js";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js";
import type { ThreadListParams } from "./generated/v2/ThreadListParams.js";
import type { ThreadListResponse } from "./generated/v2/ThreadListResponse.js";
import type { ThreadForkParams } from "./generated/v2/ThreadForkParams.js";
import type { ThreadForkResponse } from "./generated/v2/ThreadForkResponse.js";
import type { ThreadReadParams } from "./generated/v2/ThreadReadParams.js";
import type { ThreadReadResponse } from "./generated/v2/ThreadReadResponse.js";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.js";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.js";
import type { TurnInterruptResponse } from "./generated/v2/TurnInterruptResponse.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";

// Форма ошибки из JSON-RPC 2.0: code - число из спецификации, message - для человека,
// data - произвольный payload сервера (именно туда codex кладёт свой codexErrorInfo).
// Тип data оставлен unknown осознанно: разбор начинается только в errors.ts, где каждый
// прочитанный входной параметр проходит явную проверку.
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

// id может быть как числом, так и строкой: сервер вправе выбирать любое представление,
// а клиент обязан вернуть в ответе ровно то значение, которое получил.
// Поле jsonrpc помечено необязательным, потому что сервер не всегда его присылает:
// отсутствие версии в конверте не считается нарушением для этого диалекта.
export interface JsonRpcRequestEnvelope {
  id: number | string;
  method: string;
  params?: unknown;
  jsonrpc?: "2.0";
}

// Уведомление - тот же запрос, но без id: ответ на него не предусмотрен,
// поэтому сопоставлять его не с чем и ждать его некому.
export interface JsonRpcNotificationEnvelope {
  method: string;
  params?: unknown;
  jsonrpc?: "2.0";
}

// В успешном ответе id может быть null: спецификация допускает это, если запрос
// не удалось связать с конкретным вызовом.
export interface JsonRpcSuccessEnvelope {
  id: number | string | null;
  result: unknown;
  jsonrpc?: "2.0";
}

// Валидный ответ содержит ровно одно из двух: либо result, либо error -
// именно поэтому это два разных интерфейса, а не один с опциональными полями.
export interface JsonRpcErrorEnvelope {
  id: number | string | null;
  error: JsonRpcErrorObject;
  jsonrpc?: "2.0";
}

// Псевдонимы только ради читаемости: сгенерированные имена длинны, а в коде адаптера
// важно сразу видеть, что это уведомление или серверный запрос.
export type CodexAppServerNotification = ServerNotification | ClientNotification;
export type CodexAppServerServerRequest = ServerRequest;

// Объект-литерал с as const, а не enum: значения остаются обычными строками
// (их можно сравнивать с ответом сервера напрямую) и не тянут за собой enum-код в бандл.
export const CodexAppServerMethod = {
  INITIALIZE: "initialize",
  MODEL_LIST: "model/list",
  THREAD_LIST: "thread/list",
  THREAD_FORK: "thread/fork",
  THREAD_READ: "thread/read",
  THREAD_START: "thread/start",
  THREAD_RESUME: "thread/resume",
  TURN_START: "turn/start",
  TURN_INTERRUPT: "turn/interrupt",
} as const;

// Тип-объединение выводится из значений того же объекта: добавили строку в объект -
// автоматически расширился и тип. Так список методов и его тип не могут разойтись.
export type CodexAppServerMethod = (typeof CodexAppServerMethod)[keyof typeof CodexAppServerMethod];

// Маппинг "метод -> { params, result }" - основа типизации в client.ts: он позволяет
// одному дженерик-методу request<M> оставаться типобезопасным без перегрузок.
// Ключи вычисляются из констант ([CodexAppServerMethod.X]) - только так TypeScript
// выведет объект, выровненный по ключам, и не даст забыть ни один метод.
export type CodexAppServerRequestMap = {
  // Выполняется первым: сервер отвергает вызовы на неинициализированной сессии.
  [CodexAppServerMethod.INITIALIZE]: {
    params: InitializeParams;
    result: InitializeResponse;
  };
  // Список моделей отделён от initialize: он зависит от аккаунта и может меняться.
  [CodexAppServerMethod.MODEL_LIST]: {
    params: ModelListParams;
    result: ModelListResponse;
  };
  // Постраничный список диалогов; параметры пагинации описаны в ThreadListParams.
  [CodexAppServerMethod.THREAD_LIST]: {
    params: ThreadListParams;
    result: ThreadListResponse;
  };
  // Форк создаёт новую ветку истории, не затрагивая оригинальный диалог.
  [CodexAppServerMethod.THREAD_FORK]: {
    params: ThreadForkParams;
    result: ThreadForkResponse;
  };
  // Чтение состояния диалога без побочных эффектов.
  [CodexAppServerMethod.THREAD_READ]: {
    params: ThreadReadParams;
    result: ThreadReadResponse;
  };
  // Создание нового диалога: в ответе приходит threadId для всех последующих вызовов.
  [CodexAppServerMethod.THREAD_START]: {
    params: ThreadStartParams;
    result: ThreadStartResponse;
  };
  // Продолжение диалога по id - основной путь восстановления после рестарта процесса.
  [CodexAppServerMethod.THREAD_RESUME]: {
    params: ThreadResumeParams;
    result: ThreadResumeResponse;
  };
  // Запуск одного цикла генерации; события по нему идут отдельным потоком уведомлений.
  [CodexAppServerMethod.TURN_START]: {
    params: TurnStartParams;
    result: TurnStartResponse;
  };
  // Отмена активного turn: генерация прекращается, но диалог остаётся живым.
  [CodexAppServerMethod.TURN_INTERRUPT]: {
    params: TurnInterruptParams;
    result: TurnInterruptResponse;
  };
};
