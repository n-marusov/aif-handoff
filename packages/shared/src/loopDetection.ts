/**
 * Классификация вызовов инструментов для защиты от зацикливания.
 *
 * Серия только читающих вызовов без единой записи считается вероятным runaway-циклом:
 * агент снова и снова повторяет одну и ту же команду чтения, ничего не меняя. Список ниже
 * и есть определение "только чтение" - расширяя его, помни, что любой незакрытый здесь
 * инструмент считается модифицирующим и прерывает серию.
 */

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep"]);

/** Шаблоны только читающих shell-команд, привязанные к началу команды. */
export const READ_ONLY_BASH_PATTERNS =
  /(?:^|\s)(?:git\s+(?:show|diff|status|log|grep|ls-files)|cat\s|sed\s|rg\s|ls\s|head\s|tail\s|wc\s|find\s|grep\s)/;

export function isReadOnlyToolCall(toolName: string, detail: string | undefined): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) return true;
  // Для Bash тип вызова неизвестен до разбора команды, поэтому решение принимается
  // по регулярному выражению выше. Незнакомый инструмент намеренно считается
  // модифицирующим: серия прерывается, и защита не срабатывает ложно.
  if (toolName === "Bash" && detail) {
    return READ_ONLY_BASH_PATTERNS.test(detail);
  }
  return false;
}
