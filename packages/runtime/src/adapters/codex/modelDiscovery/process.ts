/**
 * Адаптация входов model-discovery к процессу Codex app-server.
 *
 * Модуль — тонкий переходник: наружу (в discovery) отдаётся узкий тип RuntimeModelListInput,
 * а app-server ожидает более широкий CodexAppServerLaunchInput. Смысл прослойки в том, чтобы
 * не тащить детали запуска процесса в код обхода моделей и иметь одну точку перевода опций
 * (включая приведение optional-полей к явному null).
 */

import type { RuntimeModelListInput } from "../../../types.js";
import {
  buildCodexAppServerEnv,
  buildCodexAppServerEnvWithStats,
  resolveCodexAppServerExecutable,
  spawnCodexAppServerProcess,
  terminateCodexAppServerProcess,
  type CodexAppServerLaunchInput,
  type CodexAppServerProcessContext,
} from "../appServer/process.js";

// Публичные обёртки ниже повторяют сигнатуры app-server, но принимают discovery-вход.
// Это осознанный фасад: вызывающий не должен знать про toLaunchInput.
export function resolveDiscoveryExecutable(input: RuntimeModelListInput): string {
  return resolveCodexAppServerExecutable(toLaunchInput(input));
}

export function buildCodexAppServerDiscoveryEnv(
  input: RuntimeModelListInput,
): Record<string, string> {
  return buildCodexAppServerEnv(toLaunchInput(input));
}

// Полная версия отдаёт ещё и статистику фильтрации env: сколько ключей проброшено,
// сколько отфильтровано как неразрешённые. Нужна для диагностики и тестов.
export function buildCodexAppServerDiscoveryEnvWithStats(input: RuntimeModelListInput): {
  env: Record<string, string>;
  forwardedCount: number;
  filteredCount: number;
  blockedCount: number;
  droppedDisallowedPrefixKeys: string[];
} {
  return buildCodexAppServerEnvWithStats(toLaunchInput(input));
}

export function spawnCodexAppServer(input: RuntimeModelListInput): CodexAppServerProcessContext {
  return spawnCodexAppServerProcess({
    input: toLaunchInput(input),
  });
}

// terminateProcess остаётся async-обёрткой даже над потенциально синхронным завершением:
// единый контракт упрощает подмену в тестах и вызов в finally.
export async function terminateProcess(context: CodexAppServerProcessContext): Promise<void> {
  await terminateCodexAppServerProcess(context);
}

// Единственное место перевода типов. Optional-поля принудительно превращаются в null:
// app-server различает "не задано" (null) и undefined, и ему нужна явная форма.
function toLaunchInput(input: RuntimeModelListInput): CodexAppServerLaunchInput {
  return {
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    transport: input.transport,
    projectRoot: input.projectRoot,
    options: input.options,
    apiKey: input.apiKey ?? null,
    apiKeyEnvVar: input.apiKeyEnvVar ?? null,
    baseUrl: input.baseUrl ?? null,
  };
}
