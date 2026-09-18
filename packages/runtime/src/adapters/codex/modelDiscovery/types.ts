/**
 * Контракты обнаружения моделей Codex.
 *
 * Модуль описывает только типы: как выглядит JSON-RPC-клиент и какие зависимости нужны
 * для запуска процесса app-server. Это позволяет в тестах подменять реальный спавн
 * процесса и транспорт на фейки — вся побочная работа вынесена за интерфейс.
 */

import type { RuntimeModelListInput } from "../../../types.js";
import type { JsonRpcNotificationEnvelope } from "../appServer/protocol.js";
import type { CodexAppServerLogger, CodexAppServerProcessContext } from "../appServer/process.js";

// Логгер переиспользуется от app-server: единый формат логов во всём адаптере.
export type CodexModelDiscoveryLogger = CodexAppServerLogger;

// Минимальный контракт RPC-клиента, которого достаточно для запроса списка моделей.
// notify и close необязательны: не каждый транспорт умеет уведомления.
export interface JsonRpcClient {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify?(method: string, params?: unknown): Promise<void>;
  close(reason?: string): void;
}

// profileId допускает null: профиль может быть не выбран, и это штатная ситуация,
// а не ошибка (Nullable Cast Rule: null остаётся в типе и обрабатывается явно).
export interface JsonRpcClientConnectOptions {
  runtimeId: string;
  profileId?: string | null;
  transport?: string;
  requestTimeoutMs?: number;
  logger?: CodexModelDiscoveryLogger;
  onNotification?: (notification: JsonRpcNotificationEnvelope) => void;
}

// Зависимости внедряются функциями, а не создаются внутри модуля запуска:
// так тесты подставляют мгновенный sleep и фейковый процесс Codex.
export interface CodexModelDiscoveryStartupDeps {
  spawnCodexAppServer: (input: RuntimeModelListInput) => CodexAppServerProcessContext;
  connectJsonRpcClient: (
    launch: CodexAppServerProcessContext,
    options: JsonRpcClientConnectOptions,
  ) => Promise<JsonRpcClient>;
  terminateProcess: (context: CodexAppServerProcessContext) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}
