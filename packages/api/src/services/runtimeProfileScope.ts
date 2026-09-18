/**
 * Валидация выбора runtime-профилей с учётом области видимости проекта.
 *
 * Почему отдельный модуль: правило видимости (глобальный профиль виден всем,
 * профиль проекта - только своему проекту) должно применяться одинаково и при
 * создании задачи, и при правке настроек приложения. Иначе один из эндпоинтов
 * принял бы чужой профиль, и задача ушла бы в неверный runtime.
 *
 * Инварианты:
 * - Проверяем и видимость, и включённость: выключенный профиль - такая же
 *   ошибка, как несуществующий, отличается только текст сообщения.
 * - null/undefined в карте selections означает "поле не задано" и пропускается
 *   молча: частичное обновление формы - штатный сценарий.
 * - Функции не бросают, а возвращают ValidationFailure | null, чтобы вызывающий
 *   код сам выбрал HTTP-статус ответа.
 */

import { findRuntimeProfileById } from "@aif/data";

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
  // Аккумулируем ошибки по всем полям, а не падаем на первой: UI должен
  // подсветить всю форму за один проход, а не заставлять искать ошибки циклами.
  const existing = fieldErrors[field] ?? [];
  existing.push(message);
  fieldErrors[field] = existing;
}

export function validateProjectScopedRuntimeProfileSelections(input: {
  projectId?: string | null;
  selections: RuntimeProfileSelectionMap;
}): ValidationFailure | null {
  const fieldErrors: Record<string, string[]> = {};

  for (const [field, runtimeProfileId] of Object.entries(input.selections)) {
    // Отсутствие значения - это "не менять профиль", а не пустая строка:
    // явная проверка на null/undefined отделяет это от реального id "".
    if (runtimeProfileId === undefined || runtimeProfileId === null) continue;

    const profile = findRuntimeProfileById(runtimeProfileId);
    const isEnabled = profile != null && profile.enabled !== false;
    // Видимость шире включённости: глобальный профиль виден всегда, профиль
    // проекта - только когда проверка вызвана в контексте того же проекта.
    const isVisible =
      profile != null &&
      (profile.projectId == null ||
        (input.projectId != null && profile.projectId === input.projectId));

    if (!isVisible || !isEnabled) {
      // Два разных условия в одной ветке: текст сообщения зависит только от
      // того, задан ли проект. Вызов addFieldError дедуплицирует накопление.
      addFieldError(
        fieldErrors,
        field,
        input.projectId == null
          ? "Must reference an enabled global runtime profile"
          : "Must reference an enabled global or same-project runtime profile",
      );
    }
  }

  if (Object.keys(fieldErrors).length === 0) {
    return null;
  }

  return {
    error: "Invalid runtime profile selection",
    fieldErrors,
  };
}

export function validateAppRuntimeDefaultSelections(
  selections: RuntimeProfileSelectionMap,
): ValidationFailure | null {
  const fieldErrors: Record<string, string[]> = {};

  for (const [field, runtimeProfileId] of Object.entries(selections)) {
    // Как и в проектной проверке: null в карте полей означает "не задано",
    // такое поле просто не участвует в валидации.
    if (runtimeProfileId === undefined || runtimeProfileId === null) continue;

    const profile = findRuntimeProfileById(runtimeProfileId);
    // Для дефолтов приложения допустим только глобальный профиль: ссылка на
    // профиль проекта сделала бы поведение приложения зависимым от проекта.
    // enabled проверяем строго истинно: дефолт обязан быть явно включён.
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
