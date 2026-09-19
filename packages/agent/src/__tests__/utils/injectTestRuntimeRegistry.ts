/**
 * Тестовый хелпер: внедряет реальный реестр рантаймов через composition-сейм.
 *
 * С появлением единого владельца реестра (runtimeRegistry.ts + entry point)
 * тесты, которые ходят в executeSubagentQuery через реальный subagentQuery,
 * обязаны внедрить реестр до вызова. Хелпер строит реальный реестр один раз
 * (адаптеры создаются поверх моков SDK, как их настраивает тест) и повторно
 * внедряет его перед каждым тестом.
 */
import type { bootstrapRuntimeRegistry } from "@aif/runtime";
import { setRuntimeRegistry } from "../../runtimeRegistry.js";

type RuntimeRegistryResult = Awaited<ReturnType<typeof bootstrapRuntimeRegistry>>;

let injectedRegistry: RuntimeRegistryResult | null = null;

export async function injectTestRuntimeRegistry(): Promise<void> {
  if (injectedRegistry) {
    setRuntimeRegistry(injectedRegistry);
    return;
  }
  const { bootstrapRuntimeRegistry } = await import("@aif/runtime");
  injectedRegistry = await bootstrapRuntimeRegistry({
    logger: { debug: () => undefined, warn: () => undefined, error: () => undefined },
    runtimeModules: [],
    modelEffortDiscoveryEnabled: false,
    usageSink: { record: async () => undefined },
  });
  setRuntimeRegistry(injectedRegistry);
}
