import { UsageSource, type RuntimeUsageContext } from "../../types.js";

/**
 * Общий usage context только для тестов: позволяет фикстурам строить валидные
 * `RuntimeRunInput` без бойлерплейта в каждом файле.
 *
 * Пример использования:
 * ```ts
 * const input: RuntimeRunInput = {
 *   runtimeId: "claude",
 *   prompt: "...",
 *   usageContext: TEST_USAGE_CONTEXT,
 * };
 * ```
 */
export const TEST_USAGE_CONTEXT: RuntimeUsageContext = {
  source: UsageSource.TEST,
};
