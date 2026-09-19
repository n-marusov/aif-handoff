/**
 * Реестр рантаймов процесса агента: единый владелец порта.
 *
 * Раньше реестр создавался в двух местах: composition root
 * (packages/agent/src/index.ts → setRuntimeRegistry для координатора) и
 * самостоятельно в subagentQuery.ts (свой bootstrapRuntimeRegistry и свой
 * usage sink). Два инстанса одного реестра — два источника правды и риск
 * расхождения sink'ов.
 *
 * Теперь реестр ровно один: создаёт его composition root и внедряет через
 * setRuntimeRegistry; все потребители (coordinator, subagentQuery) читают
 * getRuntimeRegistrySync. Модуль вынесен отдельно от coordinator, чтобы
 * subagentQuery мог импортировать holder без циклической зависимости.
 */
import { logger } from "@aif/shared";
import type { RuntimeRegistry } from "@aif/runtime";

const log = logger("runtime-registry");

let _runtimeRegistry: RuntimeRegistry | null = null;

/** Внедрение реестра композиционным корнем (агентный entry point). */
export function setRuntimeRegistry(registry: RuntimeRegistry): void {
  _runtimeRegistry = registry;
  log.debug({ source: "injected" }, "Runtime registry injected into agent");
}

/** Синхронное чтение внедрённого реестра; null — реестр ещё не внедрён. */
export function getRuntimeRegistrySync(): RuntimeRegistry | null {
  return _runtimeRegistry;
}

/** Чтение с обязательством: бросает, если реестр не внедрён (композиционный сбой). */
export function requireRuntimeRegistry(): RuntimeRegistry {
  const registry = _runtimeRegistry;
  if (!registry) {
    log.error(
      {},
      "Runtime registry is not injected; composition root must call setRuntimeRegistry",
    );
    throw new Error(
      "Runtime registry is not injected. The agent entry point must call setRuntimeRegistry before processing tasks.",
    );
  }
  return registry;
}
