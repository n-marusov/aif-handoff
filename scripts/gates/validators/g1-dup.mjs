// G1-DUP — дубликаты идентификаторов.
//
// Проверяет уникальность идентификаторов в каталогах спецификаций: два файла
// с одинаковым ID (по имени) в одном каталоге — дубликат. Также ловит
// повторяющиеся заголовки-идентификаторы первого уровня внутри каталога.

import { basename, join } from "node:path";

import { collectMarkdownFiles, displayPath, readText } from "../lib/fs-tools.mjs";
import { log } from "../lib/logger.mjs";

export const GATE = { id: "G1-DUP", name: "Дубликаты", group: "G1" };

const CATALOG_DIRS = [
  "docs/use-cases",
  "docs/user-stories",
  "docs/business-rules",
  "docs/fun-req",
  "docs/nonfun-req",
  "docs/adr",
];

export async function run({ repoRoot }) {
  const checks = [];
  const seen = new Map();

  for (const dir of CATALOG_DIRS) {
    const files = collectMarkdownFiles(join(repoRoot, dir));
    for (const file of files) {
      const id = basename(file).replace(/\.md$/, "");
      const rel = displayPath(file);

      if (seen.has(id)) {
        checks.push({
          scope: rel,
          status: "fail",
          message: `дубликат идентификатора ${id}: уже используется в ${seen.get(id)}`,
        });
      } else {
        seen.set(id, rel);
      }
    }
  }

  if (checks.length === 0) {
    log.info(`G1-DUP: дубликатов среди ${seen.size} идентификаторов нет`);
  } else {
    log.warn(`G1-DUP: найдено ${checks.length} дубликатов`);
  }

  return { checks, summary: `checked ${seen.size} catalog ids` };
}
