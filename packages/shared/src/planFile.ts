/**
 * Канонический путь к файлу плана задачи и запись текста в него.
 *
 * "Канонический" означает, что путь вычисляется из конфигурации проекта, а не берётся из
 * запроса: план всегда лежит в предсказуемом месте, поэтому его можно найти без
 * обращения к базе. Для fix-задач используется отдельный путь (cfg.paths.fix_plan), чтобы
 * план исправления не затирал план фичи.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getProjectConfig } from "./projectConfig.js";

// Реэкспорт браузер-безопасных функций для обратной совместимости: исторически они жили
// в этом модуле, и внешний код импортирует их именно отсюда.
export { slugify, generatePlanPath } from "./planPath.js";
export type { GeneratePlanPathOptions } from "./planPath.js";

// --- Функции, зависящие от Node.js ---

interface CanonicalPlanInput {
  projectRoot: string;
  isFix: boolean;
  planPath?: string;
}

interface SyncCanonicalPlanInput extends CanonicalPlanInput {
  planText: string | null;
}

export function getCanonicalPlanPath(input: CanonicalPlanInput): string {
  const cfg = getProjectConfig(input.projectRoot);
  if (input.isFix) {
    return resolve(input.projectRoot, cfg.paths.fix_plan);
  }
  return resolve(input.projectRoot, input.planPath || cfg.paths.plan);
}

export function syncPlanTextToCanonicalFile(input: SyncCanonicalPlanInput): string {
  const canonicalPath = getCanonicalPlanPath(input);
  // Каталог создаётся на случай первого запуска или нестандартной структуры проекта.
  mkdirSync(dirname(canonicalPath), { recursive: true });
  // null трактуется как пустой план, а хвостовые пробелы срезаются: чем меньше
  // незначащих различий в файле, тем стабильнее diff и проверки изменений.
  const normalized = (input.planText ?? "").trimEnd();
  // Завершающий перевод строки дописывается всегда, чтобы файл не выглядел
  // изменённым из-за отсутствия пустой строки в конце.
  writeFileSync(canonicalPath, `${normalized}\n`, "utf8");
  return canonicalPath;
}
