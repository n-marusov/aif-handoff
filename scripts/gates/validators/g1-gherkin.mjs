// G1-GHERKIN — Gherkin-синтаксис пользовательских историй.
//
// Проверяет структуру Gherkin в `docs/user-stories/` (gates.md §6.1):
//   - теги: `@US-*`, `@UC-*`, приоритет `@P0`/`@P1`/`@P2`;
//   - ключевые слова: `Feature:`, `Scenario:`, `Given/When/Then`;
//   - каждый сценарий содержит переходы Given → When → Then.
//
// Детерминированная часть: проверка обязательных ключевых слов и тегов на
// уровне файла. Семантическая корректность одного результата на сценарий —
// LLM-fallback (в каталоге помечено как «Скрипт-парсер (план)»).

import { join } from "node:path";

import { collectMarkdownFiles, displayPath, readText } from "../lib/fs-tools.mjs";
import { log } from "../lib/logger.mjs";

export const GATE = { id: "G1-GHERKIN", name: "Gherkin-синтаксис", group: "G1" };

const GHERKIN_STEP_KEYWORD = /^\s*(Given|When|Then|And|But)\b/;
const GHERKIN_BLOCK_KEYWORD =
  /^\s*(Feature|Background|Scenario Outline|Scenario|Examples|Example):/;

export async function run({ repoRoot }) {
  const checks = [];
  let scanned = 0;

  for (const file of collectMarkdownFiles(join(repoRoot, "docs/user-stories"))) {
    scanned += 1;
    const source = readText(file) ?? "";
    const rel = displayPath(file);
    const lines = source.split("\n");

    const tagLines = lines.filter((line) => line.trimStart().startsWith("@"));
    const tagBlock = tagLines.join(" ");

    // 1. Обязательные теги: US и приоритет.
    if (!/@US-[a-z0-9.]+/.test(tagBlock)) {
      checks.push({ scope: rel, status: "fail", message: "нет тега «@US-*»" });
    }
    if (!/@P[0-2]\b/.test(tagBlock)) {
      checks.push({
        scope: rel,
        status: "warn",
        message: "нет тега приоритета «@P0»/«@P1»/«@P2»",
      });
    }

    // 2. Feature.
    if (!/^\s*Feature:/m.test(source)) {
      checks.push({ scope: rel, status: "fail", message: "отсутствует блок «Feature:»" });
    }

    // 3. Сценарии и их структура.
    const scenarioStart = lines.reduce((indexes, line, index) => {
      if (/^\s*(Scenario|Scenario Outline):/.test(line)) indexes.push(index);
      return indexes;
    }, []);

    if (scenarioStart.length === 0) {
      checks.push({ scope: rel, status: "fail", message: "нет ни одного «Scenario:»" });
      continue;
    }

    for (let i = 0; i < scenarioStart.length; i += 1) {
      const start = scenarioStart[i];
      const end = i + 1 < scenarioStart.length ? scenarioStart[i + 1] : lines.length;
      const scenarioBody = lines.slice(start + 1, end);
      const keywords = scenarioBody
        .filter((line) => GHERKIN_STEP_KEYWORD.test(line))
        .map((line) => (line.trim().match(GHERKIN_STEP_KEYWORD) ?? ["", ""])[1]);

      const hasGiven = keywords.includes("Given") || keywords.includes("And");
      const hasWhen = keywords.includes("When");
      const hasThen = keywords.includes("Then");

      if (!hasWhen || !hasThen) {
        checks.push({
          scope: `${rel}:${start + 1}`,
          status: "fail",
          message: "сценарий не содержит полноценной связки When/Then",
        });
      }
      if (!hasGiven) {
        checks.push({
          scope: `${rel}:${start + 1}`,
          status: "warn",
          message: "сценарий без предусловия Given (допустимо только для Background)",
        });
      }
    }
  }

  log.info(`G1-GHERKIN: проверено ${scanned} пользовательских историй`);
  return { checks, summary: `checked gherkin of ${scanned} user stories` };
}
