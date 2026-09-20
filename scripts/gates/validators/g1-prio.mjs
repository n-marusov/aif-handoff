// G1-PRIO — приоритеты.
//
// Проверяет, что прецеденты указывают приоритет P0/P1/P2 (gates.md §6.1) и что
// P0/P1-требования ссылаются на покрытие тестами (поле «**Приоритет:**» +
// наличие теста-покрытия в тексте). Отсутствие поля — fail; отсутствие
// упоминания тест-покрытия для P0 — warn (не является жёстким блокером).

import { join } from "node:path";

import { collectMarkdownFiles, displayPath, readText } from "../lib/fs-tools.mjs";
import { log } from "../lib/logger.mjs";

export const GATE = { id: "G1-PRIO", name: "Приоритеты", group: "G1" };

const PRIORITY_PATTERN = /^\*\*Приоритет:\*\*\s*(P[0-2])/i;
const TEST_MENTION = /(тест|покрыт[ия]?|тестир|провер[к]?)/i;

export async function run({ repoRoot }) {
  const checks = [];
  let scanned = 0;

  for (const file of collectMarkdownFiles(join(repoRoot, "docs/use-cases"))) {
    scanned += 1;
    const source = readText(file) ?? "";
    const rel = displayPath(file);
    const lines = source.split("\n");

    const priorityLine = lines.find((line) => line.startsWith("**Приоритет:**"));
    if (priorityLine === undefined) {
      checks.push({ scope: rel, status: "fail", message: "поле «**Приоритет:**» отсутствует" });
      continue;
    }

    const match = priorityLine.match(PRIORITY_PATTERN);
    if (match === null) {
      checks.push({
        scope: rel,
        status: "fail",
        message: `неизвестный приоритет «${priorityLine.replace("**Приоритет:**", "").trim()}»; ожидается P0/P1/P2`,
      });
      continue;
    }

    // P0/P1 — ожидаем упоминание тест-покрытия (warn, а не fail).
    if (match[1] !== "P2" && !TEST_MENTION.test(source)) {
      checks.push({
        scope: rel,
        status: "warn",
        message: `приоритет ${match[1]}, но в тексте нет упоминания тест-покрытия критериев приёмки`,
      });
    }
  }

  log.info(`G1-PRIO: проверено ${scanned} прецедентов`);
  return { checks, summary: `checked priorities of ${scanned} use cases` };
}
