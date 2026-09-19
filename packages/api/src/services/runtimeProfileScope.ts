/**
 * Валидация выбора runtime-профилей для HTTP-доставки.
 *
 * Основное правило (проектная область видимости профиля) живёт в @aif/data
 * (`validateProjectScopedRuntimeProfileSelections` в taskOperations.ts) — оно
 * общее для API и MCP. Здесь остаётся специфичная для настроек приложения
 * проверка дефолтов (только глобальные профили), у которой нет MCP-аналога.
 */
import { findRuntimeProfileById } from "@aif/data";

// Видимость правила: потребители импортируют его под прежним именем.
export { validateProjectScopedRuntimeProfileSelections } from "@aif/data";

type RuntimeProfileSelectionMap = Record<string, string | null | undefined>;

type ValidationFailure = {
  error: string;
  fieldErrors: Record<string, string[]>;
};

function addFieldError(
  fieldErrors: Record<string, string[]>,
  field: string,
  message: string,
): void {
  const existing = fieldErrors[field] ?? [];
  existing.push(message);
  fieldErrors[field] = existing;
}

/**
 * Валидация дефолтов приложения: допустим только глобальный включённый профиль.
 * Профиль проекта как дефолт приложения сделал бы поведение зависимым от проекта.
 */
export function validateAppRuntimeDefaultSelections(
  selections: RuntimeProfileSelectionMap,
): ValidationFailure | null {
  const fieldErrors: Record<string, string[]> = {};

  for (const [field, runtimeProfileId] of Object.entries(selections)) {
    if (runtimeProfileId === undefined || runtimeProfileId === null) continue;

    const profile = findRuntimeProfileById(runtimeProfileId);
    const isEligible = profile != null && profile.projectId == null && profile.enabled;

    if (!isEligible) {
      addFieldError(fieldErrors, field, "Must reference an enabled global runtime profile");
    }
  }

  if (Object.keys(fieldErrors).length === 0) {
    return null;
  }

  return {
    error: "Invalid app runtime defaults",
    fieldErrors,
  };
}
