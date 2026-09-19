/**
 * Тонкий адаптер поверх use case `generateCommit`.
 *
 * Реализация переехала в packages/api/src/use-cases/commitGeneration.ts при
 * clean-architecture refactoring; здесь сохранён прежний публичный контракт
 * (`runCommitQuery` + типы результата), чтобы маршруты и тесты не менялись.
 */
import { generateCommit } from "../use-cases/commitGeneration.js";

export { buildCommitPrompt } from "../use-cases/commitGeneration.js";

export interface RunCommitQueryResult {
  ok: boolean;
  error?: string;
  code?: "ai_handoff_required";
}

export interface RunCommitQueryInput {
  projectId: string;
  taskId?: string | null;
}

export { generateCommit };

/**
 * Обратносовместимый псевдоним: маршруты зовут runCommitQuery, use case зовётся
 * generateCommit. Типы параметров совпадают с контрактом use case.
 */
export async function runCommitQuery(input: RunCommitQueryInput): Promise<RunCommitQueryResult> {
  return generateCommit(input);
}
