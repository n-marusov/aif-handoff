/**
 * Нормализация данных об использовании токенов.
 *
 * Один и тот же смысл приходит от разных рантаймов в двух нотациях: snake_case (ответы в
 * стиле Anthropic) и camelCase (объекты SDK). Разбирать оба варианта в каждом адаптере
 * означало бы дублировать правила, поэтому приведение к одному виду живёт здесь.
 * Некорректные значения не считаются фатальными и заменяются нулём: статистика не должна
 * ломать обработку задачи.
 */

interface UsageLike {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadInputTokens?: unknown;
  cacheCreationInputTokens?: unknown;
  total_cost_usd?: unknown;
  totalCostUsd?: unknown;
}

export interface TaskTokenUsage {
  input: number;
  output: number;
  total: number;
  costUsd: number;
}

// Дробные и отрицательные значения приводятся к целому неотрицательному числу:
// счётчики в базе целочисленные, а отрицательное количество токенов бессмысленно.
function toTokenInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : 0;
}

function toNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value > 0 ? value : 0;
}

/**
 * Приводит отчёт SDK об использовании (snake_case или camelCase) к счётчикам задачи:
 * входные и выходные токены плюс стоимость.
 */
export function parseTaskTokenUsage(usage: UsageLike | null | undefined): TaskTokenUsage {
  if (!usage) return { input: 0, output: 0, total: 0, costUsd: 0 };

  const promptInput = toTokenInt(usage.input_tokens ?? usage.inputTokens);
  const output = toTokenInt(usage.output_tokens ?? usage.outputTokens);
  const cacheRead = toTokenInt(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
  const cacheCreation = toTokenInt(
    usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens,
  );
  // Кэшированные токены включаются во входные: для бюджета это расход входного
  // контекста, просто оплачиваемый по другой цене. Стоимость берётся из ответа как есть.
  const input = promptInput + cacheRead + cacheCreation;
  const costUsd = toNonNegativeNumber(usage.total_cost_usd ?? usage.totalCostUsd);
  return { input, output, total: input + output, costUsd };
}
