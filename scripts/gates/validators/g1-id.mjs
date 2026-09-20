// G1-ID — схема идентификаторов.
//
// Проверяет, что идентификаторы в спецификационных артефактах соответствуют
// каноническим схемам каталога (gates.md §6.1):
//   HF1..HF12 / HF{1..12}.{1..N}  (docs/vision.md)
//   UC-<domain>.<subdomain>.<action>  (docs/use-cases/)
//   US-<domain>.<subdomain>.<action>  (docs/user-stories/)
//   BR-<тип>.<domain>.<tag>  (docs/business-rules/, тип: fact|constraint|trigger|inference)
//   REQ-FR-<domain>.<subdomain>.<action>  (docs/fun-req/)
//   REQ-NFR-<domain>.<quality>.<tag>  (docs/nonfun-req/)
//   ADR-<STAGE>.<DOMAIN>.<topic>  (docs/adr/, STAGE: DES|IMPL)
//   contract-<slug>  (docs/contracts/)
//
// Файл считается нарушающим схему, если его имя не начинается с ожидаемого
// префикса или заголовок первого уровня не повторяет идентификатор файла.

import { basename, join } from "node:path";
import { collectMarkdownFiles, displayPath, readText, repoRoot } from "../lib/fs-tools.mjs";
import { log } from "../lib/logger.mjs";

export const GATE = { id: "G1-ID", name: "Схема идентификаторов", group: "G1" };

// Каталог -> (шаблон префикса файла, шаблон заголовка)
const CATALOG_RULES = [
  {
    dir: "docs/use-cases",
    filePattern: /^UC-[a-z0-9-]+(\.[a-z0-9-]+)*\.md$/,
    headingPattern: /^UC-[a-z0-9-]+(\.[a-z0-9-]+)*/,
  },
  {
    dir: "docs/user-stories",
    filePattern: /^US-[a-z0-9-]+(\.[a-z0-9-]+)*\.md$/,
    headingPattern: /^US-[a-z0-9-]+(\.[a-z0-9-]+)*/,
  },
  {
    dir: "docs/business-rules",
    filePattern: /^BR-(fact|constraint|trigger|inference)\.[a-z0-9-]+(\.[a-z0-9-]+)*\.md$/,
    headingPattern: /^BR-(fact|constraint|trigger|inference)\.[a-z0-9-]+(\.[a-z0-9-]+)*/,
  },
  {
    dir: "docs/fun-req",
    filePattern: /^REQ-FR-[a-z0-9-]+(\.[a-z0-9-]+)*\.md$/,
    headingPattern: /^REQ-FR-[a-z0-9-]+(\.[a-z0-9-]+)*/,
  },
  {
    dir: "docs/nonfun-req",
    filePattern: /^REQ-NFR-[a-z0-9-]+(\.[a-z0-9-]+)*\.md$/,
    headingPattern: /^REQ-NFR-[a-z0-9-]+(\.[a-z0-9-]+)*/,
  },
  {
    dir: "docs/adr",
    filePattern: /^ADR-(DES|IMPL)\.[A-Z]+\.[a-z0-9-]+\.md$/,
    headingPattern: /^ADR-(DES|IMPL)\.[A-Z]+\.[a-z0-9-]+/,
  },
];

// Описания для сообщений проверок
const CATALOG_LABELS = {
  "docs/use-cases": "UC-<domain>.<subdomain>.<action>",
  "docs/user-stories": "US-<domain>.<subdomain>.<action>",
  "docs/business-rules": "BR-<тип>.<domain>.<tag>",
  "docs/fun-req": "REQ-FR-<domain>.<subdomain>.<action>",
  "docs/nonfun-req": "REQ-NFR-<domain>.<quality>.<tag>",
  "docs/adr": "ADR-<STAGE>.<DOMAIN>.<topic>",
};

function findCatalogRules(file) {
  const rel = displayPath(file);
  for (const rule of CATALOG_RULES) {
    if (rel.startsWith(`${rule.dir}/`)) return rule;
  }
  return null;
}

export async function run({ repoRoot }) {
  const checks = [];
  let scanned = 0;

  for (const rule of CATALOG_RULES) {
    const dir = join(repoRoot, rule.dir);
    const files = collectMarkdownFiles(dir);

    for (const file of files) {
      scanned += 1;
      const name = basename(file);
      const rel = displayPath(file);

      if (!rule.filePattern.test(name)) {
        checks.push({
          scope: rel,
          status: "fail",
          message: `имя файла не соответствует схеме ${CATALOG_LABELS[rule.dir]}`,
        });
        continue;
      }

      const source = readText(file) ?? "";
      const heading = source.split("\n").find((line) => line.startsWith("# "));
      if (heading === undefined) {
        checks.push({
          scope: rel,
          status: "fail",
          message: "отсутствует заголовок первого уровня",
        });
        continue;
      }

      const headingText = heading.replace(/^#\s+/, "");
      const idInHeading = (headingText.match(rule.headingPattern) ?? [""])[0];
      const idFromName = name.replace(/\.md$/, "");
      if (idInHeading !== idFromName) {
        checks.push({
          scope: rel,
          status: "fail",
          message: `заголовок «${headingText}» не повторяет идентификатор файла ${idFromName}`,
        });
      }
    }
  }

  log.info(`G1-ID: проверено ${scanned} файлов каталогов`);
  return { checks, summary: `scanned ${scanned} spec files` };
}
