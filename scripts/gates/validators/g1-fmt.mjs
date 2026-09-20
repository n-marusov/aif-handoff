// G1-FMT — формат и шаблон.
//
// Проверяет наличие обязательных структурных полей в спецификационных
// артефактах по типу каталога (gates.md §6.1 «Формат и шаблон»). Каталог
// считается нарушающим формат, если отсутствует любой из обязательных
// маркеров. Hard-mode по умолчанию: отсутствие поля — fail.

import { join } from "node:path";

import { collectMarkdownFiles, displayPath, readText } from "../lib/fs-tools.mjs";
import { log } from "../lib/logger.mjs";

export const GATE = { id: "G1-FMT", name: "Формат и шаблон", group: "G1" };

// Маркеры обязательных полей по каталогам. Маркер может быть регулярным
// выражением (регистронезависимо) или строкой (подстрока).
const CATALOG_REQUIREMENTS = [
  {
    dir: "docs/use-cases",
    label: "UC",
    required: [
      { test: /^# UC-/m, message: "заголовок H1 вида «# UC-…»" },
      { test: /^\*\*Актор:\*\*/m, message: "поле «**Актор:**»" },
      { test: /^\*\*Приоритет:\*\*/m, message: "поле «**Приоритет:**»" },
      { test: /^\*\*Ключевая функция:\*\*/m, message: "поле «**Ключевая функция:**»" },
      { test: /^\*\*Канал:\*\*/m, message: "поле «**Канал:**»" },
      { test: /^\*\*Описание:\*\*/m, message: "поле «**Описание:**»" },
      { test: /^\*\*Основной поток:\*\*/m, message: "поле «**Основной поток:**»" },
      { test: /^\*\*Источник требований:\*\*/m, message: "поле «**Источник требований:**»" },
    ],
  },
  {
    dir: "docs/user-stories",
    label: "US",
    required: [
      { test: /^# US-/m, message: "заголовок H1 вида «# US-…»" },
      { test: /@US-[a-z0-9.]+/, message: "тег «@US-…»" },
      { test: /Feature:/, message: "ключевое слово Gherkin «Feature:»" },
      { test: /Scenario:/, message: "ключевое слово Gherkin «Scenario:»" },
    ],
  },
  {
    dir: "docs/business-rules",
    label: "BR",
    required: [
      { test: /^# BR-/m, message: "заголовок H1 вида «# BR-…»" },
      { test: /\*\*ID\*\*/, message: "поле «**ID**»" },
      { test: /\*\*Тип\*\*/, message: "поле «**Тип**»" },
      { test: /\*\*Домен\*\*/, message: "поле «**Домен**»" },
      { test: /^## (Правило|Трассируемость)/m, message: "раздел «Правило» или «Трассируемость»" },
    ],
  },
  {
    dir: "docs/fun-req",
    label: "FR",
    required: [
      { test: /^# REQ-FR-/m, message: "заголовок H1 вида «# REQ-FR-…»" },
      { test: /^\*\*Приоритет:\*\*/m, message: "поле «**Приоритет:**»" },
      { test: /^\*\*Источник:\*\*/m, message: "поле «**Источник:**»" },
      { test: /^\*\*Критерии приёмки:\*\*/m, message: "поле «**Критерии приёмки:**»" },
    ],
  },
  {
    dir: "docs/nonfun-req",
    label: "NFR",
    required: [
      { test: /^# REQ-NFR-/m, message: "заголовок H1 вида «# REQ-NFR-…»" },
      { test: /^\*\*Приоритет:\*\*/m, message: "поле «**Приоритет:**»" },
      { test: /^\*\*Источник:\*\*/m, message: "поле «**Источник:**»" },
      {
        test: /^## (Описание|Критерии приёмки)/m,
        message: "раздел «Описание» или «Критерии приёмки»",
      },
    ],
  },
];

export async function run({ repoRoot }) {
  const checks = [];
  let scanned = 0;

  for (const catalog of CATALOG_REQUIREMENTS) {
    const files = collectMarkdownFiles(join(repoRoot, catalog.dir));
    for (const file of files) {
      scanned += 1;
      const source = readText(file) ?? "";
      const rel = displayPath(file);

      for (const requirement of catalog.required) {
        const found =
          typeof requirement.test === "string"
            ? source.includes(requirement.test)
            : requirement.test.test(source);
        if (found) continue;

        checks.push({
          scope: rel,
          status: "fail",
          message: `отсутствует ${requirement.message}`,
        });
      }
    }
  }

  log.info(`G1-FMT: проверено ${scanned} файлов`);
  return { checks, summary: `scanned ${scanned} files for template conformance` };
}
