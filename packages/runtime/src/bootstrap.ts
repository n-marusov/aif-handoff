/**
 * Фабрика реестра рантаймов: создаёт RuntimeRegistry с предустановленными встроенными
 * адаптерами (Claude, Codex, OpenCode, OpenRouter) и поверх них подключает внешние
 * модули-плагины.
 *
 * Единая точка регистрации нужна, чтобы процессы api и agent видели идентичный набор
 * рантаймов: расхождение в списках адаптеров дало бы разное поведение планировщика
 * задачи и пользовательского интерфейса при одном и том же профиле.
 */

import { createClaudeRuntimeAdapter } from "./adapters/claude/index.js";
import { createCodexRuntimeAdapter } from "./adapters/codex/index.js";
import { createOpenCodeRuntimeAdapter } from "./adapters/opencode/index.js";
import { createOpenRouterRuntimeAdapter } from "./adapters/openrouter/index.js";
import {
  createRuntimeRegistry,
  type RuntimeRegistry,
  type RuntimeRegistryLogger,
} from "./registry.js";
import type { RuntimeUsageSink } from "./usageSink.js";

// Единый пакет опций bootstrap: всё необязательно, вызывающий код передаёт только то,
// чем его конфигурация отличается от конфигурации по умолчанию.
export interface BootstrapRuntimeRegistryOptions {
  logger?: RuntimeRegistryLogger;
  runtimeModules?: string[];
  /**
   * Sink, принимающий События использования каждого LLM-вызова через реестр.
   * Хостовые процессы (api, agent) передают sink на БД из `@aif/data`, и
   * каждый запуск сохраняется в `usage_events`. Без него использование
   * молча отбрасывается — допустимо только для тестов и CLI-инструментов.
   */
  usageSink?: RuntimeUsageSink;
  // Без флага реестр вырезает effort-метадату из списков моделей: discovery требует
  // дополнительных запросов к провайдеру и гарантий транспорта, поэтому он явный.
  modelEffortDiscoveryEnabled?: boolean;
}

/**
 * Создаёт RuntimeRegistry, предзаполненный встроенными адаптерами (Claude,
 * Codex), и опционально подключает внешние модули runtime.
 *
 * Общий bootstrap для процессов agent и API — чтобы не дублировать регистрацию.
 */
export async function bootstrapRuntimeRegistry(
  options: BootstrapRuntimeRegistryOptions = {},
): Promise<RuntimeRegistry> {
  // builtInAdapters - канонический список встроенных адаптеров. Правило проекта:
  // каждый обязан объявить capabilities.usageReporting, и discovery-тест в
  // bootstrap.test.ts падает, если новый адаптер добавили сюда без этой декларации.
  const registry = createRuntimeRegistry({
    builtInAdapters: [
      createClaudeRuntimeAdapter(),
      createCodexRuntimeAdapter(),
      createOpenCodeRuntimeAdapter(),
      createOpenRouterRuntimeAdapter(),
    ],
    logger: options.logger,
    // sink прокидывается в реестр один раз: именно реестр вызывает его на каждый
    // LLM-запрос, так что адаптеры не знают о персистентности usage.
    usageSink: options.usageSink,
    modelEffortDiscoveryEnabled: options.modelEffortDiscoveryEnabled,
  });

  // Внешние модули - опциональные плагины из конфигурации; их отсутствие нормально,
  // поэтому пустой список даже не выделяется в отдельную ветку.
  for (const moduleSpecifier of options.runtimeModules ?? []) {
    try {
      // await обязателен: контракт RegisterRuntimeModule допускает асинхронную
      // регистрацию, а реестр наружу должен уходить уже полным.
      await registry.registerRuntimeModule(moduleSpecifier);
    } catch (error) {
      // Отказ плагина не валит весь bootstrap: один сломанный модуль - не причина
      // лишать пользователя рабочих встроенных адаптеров, только теряется расширение.
      // Опциональная цепочка у warn: в тестах logger может отсутствовать, и логирование
      // не должно само стать источником падения.
      options.logger?.warn(
        { moduleSpecifier, error },
        "Runtime module failed to load; continuing with built-in adapters",
      );
    }
  }

  return registry;
}
