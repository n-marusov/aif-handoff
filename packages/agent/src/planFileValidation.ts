/**
 * Инфраструктурный адаптер: чтение и валидация файла плана.
 *
 * Координатор не должен импортировать node:fs напрямую (Task 26 — порт-адаптеры
 * для git/файлов/HTTP). Здесь инкапсулирован единственный файловый доступ
 * координатора: проверка, что канонический файл плана существует и не пуст
 * (gate валидации плана после planner/improver для plan-review задач).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getProjectConfig } from "@aif/shared";

/** Вход проверки: корень исполнения + поля задачи, из которых выводится путь. */
export interface PlanFileValidationInput {
  executionRoot: string;
  isFix: boolean;
  planPath: string | null | undefined;
}

/**
 * Проверяет, что канонический файл плана существует и не пуст (после trim).
 * Любая ошибка чтения интерпретируется как "план невалиден" — gate не должен
 * случайно пропустить пустой план.
 */
export function isPlanFileValid(input: PlanFileValidationInput): boolean {
  try {
    const cfg = getProjectConfig(input.executionRoot);
    const planRelPath = input.isFix ? cfg.paths.fix_plan : input.planPath || cfg.paths.plan;
    const planAbsPath = resolve(input.executionRoot, planRelPath);
    if (!existsSync(planAbsPath)) return false;
    const content = readFileSync(planAbsPath, "utf8").trim();
    return content.length > 0;
  } catch {
    return false;
  }
}
