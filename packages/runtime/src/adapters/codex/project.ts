/**
 * Заглушка инициализации проекта для адаптера Codex.
 *
 * Намеренно ничего не делает: вся работа по подготовке проекта (создание AGENTS.md и
 * агентских определений) выполняется централизованно в projectInit.ts через
 * `ai-factory init --agents`. Такой разделитель нужен, чтобы адаптер не дублировал
 * логику инициализации и не расходился с ней.
 */
export function initCodexProject(_projectRoot: string): void {
  // Делегировано ai-factory init --agents codex в projectInit.ts
}
