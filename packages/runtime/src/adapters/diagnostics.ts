/**
 * Общий шаблон диагностики ошибок вызова LLM-рантайма.
 *
 * Три адаптера (openrouter, opencode, claude) дублировали один и тот же каркас:
 * развилка по структурной `category` ошибки (стабильный контракт) с последующим
 * строковым fallback для неклассифицированных `Error`. Этот модуль — единственное
 * место, где шаблон описан один раз; адаптер поставляет только свои формулировки
 * (messageMap) и порядок строковых матчеров (textRules), а управляющая структура
 * остаётся общей.
 *
 * Правила диагностики соблюдаются здесь же:
 * - классификация по `category`, а не по тексту — текст только для fallback;
 * - `unknown` и не-RuntimeExecutionError уходят в строковый разбор;
 * - каждый адаптерный textRule — `{ pattern(i: RegExp|string), message }`, проверка
 *   идёт в порядке объявления (первый матч побеждает).
 *
 * Важно: это диагностика ДЛЯ ЧЕЛОВЕКА (UI/логи), а не управляющая логика.
 * Ветвление здесь не влияет на code path — только на текст подсказки.
 */

import type { RuntimeDiagnoseErrorInput } from "../types.js";
import { RuntimeExecutionError } from "../errors.js";

export interface AdapterTextDiagnosticRule {
  /** Ищется в нижнем регистре объединения message + stderrTail. */
  pattern: string | RegExp;
  message: string;
}

export interface AdapterDiagnosticMessages {
  /** Сообщение-подпись провайдера (используется в fallback и хвостах). */
  providerLabel: string;
  /** Сообщение по структурной категории: category -> подсказка. */
  categoryMap: Partial<Record<RuntimeExecutionError["category"], string>>;
  /** Сообщения-обёртки для «сырых» категорий, где уместен хвост исходного сообщения. */
  rawTailCategories?: Partial<Record<RuntimeExecutionError["category"], string>>;
  /** Строковый fallback для неклассифицированных ошибок. */
  textRules: AdapterTextDiagnosticRule[];
  /**
   * Финальный fallback для адаптеров с уникальной строковой эвристикой
   * (например, «exited with code 1» у Claude). Вызывается только когда ни
   * одна категория, ни textRules не совпали, и возвращает готовый текст.
   */
  whenUnmatched?: (message: string, stderrTail: string) => string;
}

/**
 * Приводит ошибку к человекочитаемой диагностике адаптера.
 * Возвращается готовый текст; пустой результат невозможен: финальный fallback —
 * либо `whenUnmatched`, либо `"<provider> error: <message>"`.
 */
export function diagnoseRuntimeFailure(
  input: RuntimeDiagnoseErrorInput,
  messages: AdapterDiagnosticMessages,
): string {
  const message = input.error instanceof Error ? input.error.message : String(input.error);

  // Основной путь: развилка по структурной category (стабильный контракт).
  if (input.error instanceof RuntimeExecutionError && input.error.category !== "unknown") {
    const fixed = messages.categoryMap[input.error.category];
    if (fixed) return fixed;
    const tailTemplate = messages.rawTailCategories?.[input.error.category];
    if (tailTemplate) return `${tailTemplate} ${message}`;
  }

  // Резерв: строки для неклассифицированных ошибок или plain Error.
  const combined = `${message} ${input.stderrTail ?? ""}`.toLowerCase();
  for (const rule of messages.textRules) {
    const matched =
      typeof rule.pattern === "string"
        ? combined.includes(rule.pattern)
        : rule.pattern.test(combined);
    if (matched) return rule.message;
  }

  if (messages.whenUnmatched) {
    return messages.whenUnmatched(message, input.stderrTail ?? "");
  }

  return `${messages.providerLabel} error: ${message}`;
}
