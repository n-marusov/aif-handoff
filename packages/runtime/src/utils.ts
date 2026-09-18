// Мелкие помощники для разбора недоверенных значений.
//
// Оба возвращают безопасное значение вместо исключения: данные приходят из ответов
// провайдеров и из JSON-полей базы, где ожидаемая форма - не гарантия.

// Не-объект превращается в пустой объект: вызывающему коду не нужно проверять результат
// на null, а любое чтение поля даст undefined.
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Пустая строка приравнивается к отсутствию значения: это избавляет вызывающий код от
// отдельной проверки на "задано, но пусто".
export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
