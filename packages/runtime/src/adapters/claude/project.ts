/**
 * Заглушка инициализации проекта под Claude.
 *
 * Реальная генерация файлов агентов идёт централизованно в projectInit.ts
 * (ai-factory init --agents claude), поэтому адаптеру остаётся только сохранить
 * форму интерфейса — тело функции пусто намеренно.
 */

/**
 * Инициализация проекта под Claude — обрабатывается ai-factory init --agents
 * в projectInit.ts. Это no-op заглушка; реальная работа выполняется централизованно.
 */
export function initClaudeProject(_projectRoot: string): void {
  // Делегировано ai-factory init --agents claude в projectInit.ts
}
