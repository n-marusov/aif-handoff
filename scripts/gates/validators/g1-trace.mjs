// G1-TRACE — трассируемость.
//
// Проверяет цепочку трассировки требований (gates.md §6.1 «Трассируемость»):
//   UC обязан ссылаться на источник — функцию vision.md (HF1..HF12) или
//   бизнес-правило (BR-*) — в поле «**Источник требований:**»;
//   BR обязан иметь раздел «## Трассируемость» со ссылками на функцию/UC.
//
// Slash-дублирование: ID в ссылках вида `HF1.2`, `UC-...`, `BR-...` проверяются
// формой (реестр файлов не требуется — он покрыт G1-LINK / G1-ID).

import { join } from "node:path";

import { collectMarkdownFiles, displayPath, readText } from "../lib/fs-tools.mjs";
import { log } from "../lib/logger.mjs";

export const GATE = { id: "G1-TRACE", name: "Трассируемость", group: "G1" };

const HF_ID = /HF(?:1[0-2]|[1-9])(?:\.[0-9]+)?/i;
const ANY_ID = /(?:HF(?:1[0-2]|[1-9])(?:\.[0-9]+)?|UC-[a-z0-9.]+|BR-[a-z0-9.\-]+)/i;

export async function run({ repoRoot }) {
  const checks = [];
  let scanned = 0;

  // 1. UC — обязательное поле «Источник требований» со ссылкой на HF/BR/UC.
  for (const file of collectMarkdownFiles(join(repoRoot, "docs/use-cases"))) {
    scanned += 1;
    const source = readText(file) ?? "";
    const rel = displayPath(file);

    const sourceLine = source
      .split("\n")
      .find((line) => line.startsWith("**Источник требований:**"));
    if (sourceLine === undefined) {
      checks.push({
        scope: rel,
        status: "fail",
        message: "отсутствует поле «**Источник требований:**»",
      });
      continue;
    }
    if (!ANY_ID.test(sourceLine)) {
      checks.push({
        scope: rel,
        status: "fail",
        message: "поле «Источник требований» не ссылается на HF/UC/BR идентификатор",
      });
    }
  }

  // 2. BR — раздел «Трассируемость» со ссылкой на HF/UC/vision/architecture.
  //    Матрица гейтов (§7) не требует TRACE для BR — проверяем со статусом warn
  //    (лучшая попытка), т.к. часть правил трассируется только на ADR/код.
  for (const file of collectMarkdownFiles(join(repoRoot, "docs/business-rules"))) {
    scanned += 1;
    const source = readText(file) ?? "";
    const rel = displayPath(file);

    if (!source.includes("## Трассируемость")) {
      checks.push({
        scope: rel,
        status: "warn",
        message: "отсутствует раздел «## Трассируемость» (рекомендуется для BR)",
      });
      continue;
    }
    const tracePart = source.split("## Трассируемость")[1] ?? "";
    const referencesFunction =
      HF_ID.test(tracePart) ||
      /UC-[a-z0-9.]+/i.test(tracePart) ||
      /vision\.md/i.test(tracePart) ||
      /architecture\.md/i.test(tracePart);
    if (!referencesFunction) {
      checks.push({
        scope: rel,
        status: "warn",
        message:
          "раздел «Трассируемость» не ссылается на функцию HF, UC, vision.md или architecture.md",
      });
    }
  }

  if (checks.length === 0) {
    log.info(`G1-TRACE: трассировка корректна для ${scanned} артефактов`);
  } else {
    log.warn(`G1-TRACE: ${checks.length} нарушений трассировки`);
  }

  return { checks, summary: `checked traceability of ${scanned} artifacts` };
}
