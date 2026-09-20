// G1-LINK — целостность ссылок.
//
// Проверяет, что относительные markdown-ссылки в спецификационных артефактах
// ведут на существующие файлы. Внешние URL (http/https/mailto) и внутрифайловые
// якоря (#anchor) не проверяются на существование файла; ссылки с фрагментом
// (`file.md#section`) распознаются по части до `#`.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import {
  collectMarkdownFiles,
  displayPath,
  extractLocalLinks,
  readText,
} from "../lib/fs-tools.mjs";
import { log } from "../lib/logger.mjs";

export const GATE = { id: "G1-LINK", name: "Целостность ссылок", group: "G1" };

// Файлы, в которых допускаются несуществующие относительные ссылки, т.к. они
// документируют планируемые артефакты (allowlist для целевого состояния).
const ALLOW_BROKEN = new Set([
  // .agents/*  — локальное тулирование разработчика (gitignored), отсутствует в
  // CI-checkout; ссылки на него — «локальные», не проверяются (см. open-questions.md).
]);

// Подписи gitignored-контента: ссылки на такие пути не являются дефектом
// спецификации — файлы физически есть в рабочем дереве, но не попадают в CI.
const GITIGNORED_PATH_PREFIXES = [".agents/", ".ai-factory/skill-context/", ".ai-factory/files/"];

function targetPathInRepo(repoRoot, file, target) {
  if (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:")
  ) {
    return null;
  }
  if (target.startsWith("#")) return null;
  if (target.startsWith("data:")) return null;

  // Внешние абсолютные ссылки (например, / docs) — вне зоны проверки.
  if (target.startsWith("/")) return null;

  const fragmentless = target.split("#")[0];
  if (fragmentless === "") return null;

  return normalize(join(dirname(file), fragmentless));
}

export async function run({ repoRoot }) {
  const checks = [];
  let scanned = 0;
  let broken = 0;

  // Каталоги спецификаций, где ссылки обязаны резолвиться.
  const files = collectMarkdownFiles(join(repoRoot, "docs"));
  const rootReadme = join(repoRoot, "README.md");
  if (existsSync(rootReadme)) files.push(rootReadme);

  for (const file of files) {
    const source = readText(file) ?? "";
    const links = extractLocalLinks(source);

    for (const link of links) {
      const target = targetPathInRepo(repoRoot, file, link.target);
      if (target === null) continue;
      scanned += 1;

      const relativeToRepo = displayPath(resolve(target));
      const resolvedPath = resolve(target);
      if (existsSync(resolvedPath)) continue;

      if (ALLOW_BROKEN.has(relativeToRepo) || ALLOW_BROKEN.has(link.target)) continue;

      // Ссылки на gitignored-контент (локальные зависимости, отсутствуют в CI):
      // проверяем по резолвнутому пути, а не по записанной в документе строке.
      const normalizedResolved = resolvedPath.replaceAll("\\", "/");
      const normalizedRoot = repoRoot.replaceAll("\\", "/");
      const isGitignored = GITIGNORED_PATH_PREFIXES.some((prefix) =>
        normalizedResolved.startsWith(`${normalizedRoot}/${prefix}`),
      );
      if (isGitignored) continue;

      broken += 1;
      checks.push({
        scope: `${displayPath(file)}:${link.line}`,
        status: "fail",
        message: `ссылка «${link.target}» ведёт на несуществующий файл ${relativeToRepo}`,
      });
    }
  }

  if (broken > 0) {
    log.warn(`G1-LINK: ${broken} битых ссылок из ${scanned} проверенных`);
  } else {
    log.info(`G1-LINK: проверено ${scanned} ссылок, битых нет`);
  }

  return { checks, summary: `checked ${scanned} links, ${broken} broken` };
}
