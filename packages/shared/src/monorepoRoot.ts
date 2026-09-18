/**
 * Поиск корня монорепозитория подъёмом по дереву каталогов.
 *
 * Корнем считается ближайший каталог с package.json, содержащим поле workspaces. Признак
 * выбран не случайно: у вложенных пакетов есть собственный package.json, и без проверки
 * workspaces поиск остановился бы на первом же из них.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Поднимается от `startPath` до ближайшего каталога, в package.json которого есть
 * `workspaces`, то есть до корня монорепозитория. Если корень не найден, возвращает путь
 * на три уровня выше startPath.
 */
export function findMonorepoRoot(startPath: string): string {
  // Отправная точка - каталог вызывающего файла. Ограничение в 10 шагов защищает от
  // бесконечного подъёма на необычных файловых системах.
  let dir = dirname(startPath);

  for (let i = 0; i < 10; i++) {
    const pkgPath = resolve(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.workspaces) return dir;
      } catch {
        // Повреждённый package.json не прерывает поиск: поднимаемся выше и продолжаем
        // искать корень.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Запасной вариант: три уровня вверх от каталога файла. Нужен, когда корень не
  // найден - например, код выполняется из собранного бандла без package.json рядом.
  return resolve(dirname(startPath), "../../..");
}

/** Корень монорепозитория относительно import.meta.url вызывающего модуля. */
export function findMonorepoRootFromUrl(importMetaUrl: string): string {
  return findMonorepoRoot(fileURLToPath(importMetaUrl));
}
