import { WebSocket } from "ws";
import {
  API_URL,
  PROJECT_ID,
  createTaskViaApi,
  deleteTaskViaApi,
  makeTaskPayload,
  runId,
  type CreateTaskOptions,
  type CreatedTask,
} from "../gui/common.js";
export {
  createGitLabBranchWithCommit,
  GITLAB_REPOSITORY_PATH,
  GITLAB_TOKEN,
  GITLAB_WEB_URL,
  GitLabApiError,
  gitLabApi,
  gitLabProjectPathEncoded,
  isRetryableMergeReadinessDelay,
} from "../shared/gitlab.js";

export {
  API_URL,
  PROJECT_ID,
  createTaskViaApi,
  deleteTaskViaApi,
  makeTaskPayload,
  runId,
  type CreateTaskOptions,
  type CreatedTask,
};

/** WebSocket endpoint dev-стека: в non-participants mode соединение анонимное. */
export const WS_URL = String(process.env.AIF_E2E_WS_URL ?? "ws://localhost:3009/ws");

export interface WsEventMessage {
  type: string;
  payload?: Record<string, unknown>;
}

type WsRaw = string | Buffer | ArrayBuffer | Buffer[];

function parseWsMessage(raw: WsRaw): WsEventMessage | null {
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (raw instanceof ArrayBuffer) {
    text = Buffer.from(new Uint8Array(raw)).toString();
  } else if (Array.isArray(raw)) {
    text = Buffer.concat(raw.map((part) => Buffer.from(new Uint8Array(part)))).toString();
  } else {
    text = Buffer.from(raw).toString();
  }
  try {
    return JSON.parse(text) as WsEventMessage;
  } catch {
    return null;
  }
}

/**
 * Открывает сырое WebSocket-соединение к API и ждёт приветственного `ws:connected`.
 * Возвращает объект сокета и сам приветственный event (external observer по
 * e2e-api-testing §9.1).
 */
export function connectAndAwaitWsConnected(
  timeoutMs = 10_000,
): Promise<{ socket: WebSocket; connected: WsEventMessage }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out waiting for ws:connected on ${WS_URL}`));
    }, timeoutMs);
    socket.on("message", (raw: WsRaw) => {
      const message = parseWsMessage(raw);
      if (message?.type === "ws:connected") {
        clearTimeout(timer);
        resolve({ socket, connected: message });
      }
    });
    socket.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Клиентский наблюдатель: дожидается события с указанным `type` (или любым,
 * если type не задан), у которого payload.id === expectedId. Детерминированная
 * альтернатива sleep() для WS-проверок (anti-flake §15.2).
 */
export function waitForWsEvent(
  socket: WebSocket,
  options: { expectedId?: string; type?: string; timeoutMs?: number } = {},
): Promise<WsEventMessage> {
  const { expectedId, type, timeoutMs = 10_000 } = options;
  return new Promise((resolve, reject) => {
    const handler = (raw: WsRaw) => {
      const message = parseWsMessage(raw);
      if (!message) return;
      if (type && message.type !== type) return;
      if (expectedId && message.payload?.id !== expectedId) return;
      cleanup();
      resolve(message);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timed out waiting for WS event ${type ?? "(any)"} id=${expectedId ?? "(any)"}`),
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", handler);
    };
    socket.on("message", handler);
  });
}
