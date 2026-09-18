/**
 * Подключение JSON-RPC-клиента к уже запущенному app-server Codex.
 *
 * Жизненный цикл процесса и транспорт разделены: спавн делается выше, а здесь только
 * устанавливается канал. Если процесс успел умереть, бросаем ошибку сразу, добавляя в текст
 * хвост stderr — без него диагноз "exited early" практически бесполезен.
 */

import { JsonlRpcClient } from "../appServer/jsonlRpcClient.js";
import type { CodexAppServerProcessContext } from "../appServer/process.js";
import type { JsonRpcClient, JsonRpcClientConnectOptions } from "./types.js";

export async function connectJsonRpcClient(
  launch: CodexAppServerProcessContext,
  options: JsonRpcClientConnectOptions,
): Promise<JsonRpcClient> {
  // exitCode != null — процесс уже завершился; подключаться некуда, канал бы просто завис.
  if (launch.process.exitCode != null) {
    const details = launch.stderrTail.join("").trim();
    throw new Error(
      details
        ? `Codex app-server exited early with code ${launch.process.exitCode}: ${details}`
        : `Codex app-server exited early with code ${launch.process.exitCode}`,
    );
  }

  return new JsonlRpcClient(launch.process, {
    runtimeId: options.runtimeId,
    // ?? null сохраняет явный null вместо undefined: контракт клиента требует именно null.
    profileId: options.profileId ?? null,
    transport: options.transport,
    requestTimeoutMs: options.requestTimeoutMs,
    logger: options.logger,
    onNotification: options.onNotification,
  });
}

// Промис-обёртка над setTimeout: позволяет передавать sleep как зависимость и
// await-ить паузу между попытками подключения.
export async function sleep(ms: number): Promise<void> {
  return await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
