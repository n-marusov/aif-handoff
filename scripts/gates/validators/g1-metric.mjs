// G1-METRIC — измеримость критериев.
//
// Проверяет критерии приёмки/успеха на размытые формулировки (gates.md §6.1):
// «быстро», «надёжно», «как правило», «и т. п.», «и т.д.», «несколько», «около»,
// «примерно», «достаточно». Проверка — эвристический детектор (в каталоге:
// «Скрипт-детектор размытых формулировок (план); LLM-fallback») и поэтому
// выставляет `warn`, а не `fail`. Fail выставляется только при явно пустых
// критериях приёмки (пустой список после заголовка).

import { join } from "node:path";

import { collectMarkdownFiles, displayPath, readText } from "../lib/fs-tools.mjs";
import { log } from "../lib/logger.mjs";

export const GATE = { id: "G1-METRIC", name: "Измеримость", group: "G1" };

const FUZZY_PATTERNS = [
  /\bбыстро\b/iu,
  /\bнадёжно\w*/iu,
  /\bкак правило\b/iu,
  /\bи т\.?\s?п\.?\b/iu,
  /\bи т\.?\s?д\.?\b/iu,
  /\bнесколько\b/iu,
  /\bоколо\b/iu,
  /\bпримерно\b/iu,
  /\bдостаточно\b/iu,
  /\bмаксимально возможн\w*\b/iu,
];

const CATALOGS = ["docs/fun-req", "docs/nonfun-req", "docs/use-cases"];

function findCriteriaBlocks(source) {
  const blocks = [];
  const lines = source.split("\n");
  let inCriteria = false;
  let block = [];

  for (const line of lines) {
    if (/^\*\*Критерии приёмки:\*\*|^## Критерии приёмки/.test(line)) {
      inCriteria = true;
      block = [];
      continue;
    }
    if (inCriteria && /^#{1,3} /.test(line)) {
      inCriteria = false;
      if (block.length > 0) blocks.push(block);
      continue;
    }
    if (inCriteria) block.push(line);
  }
  if (inCriteria && block.length > 0) blocks.push(block);
  return blocks;
}

export async function run({ repoRoot }) {
  const checks = [];
  let scanned = 0;

  for (const dir of CATALOGS) {
    for (const file of collectMarkdownFiles(join(repoRoot, dir))) {
      scanned += 1;
      const source = readText(file) ?? "";
      const rel = displayPath(file);
      const blocks = findCriteriaBlocks(source);

      if (blocks.length === 0) continue;

      for (const block of blocks) {
        // Пустой блок = критерии объявлены, но не заполнены.
        const meaningful = block.filter((line) => line.trim() !== "").length;
        if (meaningful === 0) {
          checks.push({
            scope: rel,
            status: "fail",
            message: "раздел «Критерии приёмки» объявлен, но пуст",
          });
          continue;
        }

        for (const line of block) {
          for (const pattern of FUZZY_PATTERNS) {
            const match = line.match(pattern);
            if (match === null) continue;
            checks.push({
              scope: rel,
              status: "warn",
              message: `размытая формулировка «${match[0]}» в критерии приёмки`,
            });
            break; // одна пометка на строку
          }
        }
      }
    }
  }

  const warns = checks.filter((c) => c.status === "warn").length;
  const fails = checks.filter((c) => c.status === "fail").length;
  log.info(`G1-METRIC: проверено ${scanned} файлов (${warns} warn, ${fails} fail)`);
  return { checks, summary: `checked ${scanned} files for fuzzy criteria` };
}
