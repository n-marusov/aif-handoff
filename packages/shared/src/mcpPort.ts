/**
 * Разбор переменной окружения MCP_PORT.
 *
 * Возвращается размеченное состояние, а не просто число: вызывающий код обязан
 * различать "переменная не задана" (допустимо подставить значение по умолчанию) и
 * "задана мусором" (ошибка конфигурации, о которой нужно сказать пользователю).
 */

export type ParsedMcpPortSetting =
  | { status: "unset" }
  | { status: "valid"; value: string; port: number }
  | { status: "invalid"; value: string };

export function parseMcpPortSetting(value: string | undefined): ParsedMcpPortSetting {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { status: "unset" };
  }

  const port = Number(trimmed);
  // Проверяются и целочисленность, и диапазон: значение вне 1..65535 портом не
  // является. Числовая форма возвращается строкой, чтобы вызывающий код не терял
  // нормализованное значение (например, для записи в конфиг клиента).
  if (Number.isInteger(port) && port > 0 && port <= 65_535) {
    return { status: "valid", value: String(port), port };
  }

  return { status: "invalid", value: trimmed };
}
