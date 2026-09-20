// G1-GLOSS — глоссарий.
//
// Проверяет согласованность `docs/glossary.md` (gates.md §6.1 «Глоссарий»):
//   - каждое определение содержит обязательные поля («**Тип:**»,
//     «**Определение.**»);
//   - ссылки «**Связанные термины.**» используют конвенцию явных якорей
//     `#<slug>-<code>`, где `<code>` — код термина (строка в обратных кавычках),
//     заведённый в глоссарии. Якорь с неизвестным кодом — «висячее» понятие.
//
// Полнота покрытия терминов (каждый ли доменный термин заведён) — гибрид
// LLM+скрипт; здесь проверяется форма и целостность ссылок.

import { join } from "node:path";

import { displayPath, readText } from "../lib/fs-tools.mjs";
import { log } from "../lib/logger.mjs";

export const GATE = { id: "G1-GLOSS", name: "Глоссарий", group: "G1" };

const GLOSSARY_FILE = "docs/glossary.md";

export async function run({ repoRoot }) {
  const checks = [];
  const glossary = join(repoRoot, GLOSSARY_FILE);
  const source = readText(glossary);

  if (source === null) {
    return {
      checks: [{ scope: GLOSSARY_FILE, status: "fail", message: "файл глоссария не существует" }],
      summary: "glossary missing",
    };
  }

  const lines = source.split("\n");

  // 1. Структура определений: блок `### Термин` обязан содержать
  //    «**Тип:**» и «**Определение.**».
  let currentTerm = null;
  let hasType = false;
  let hasDefinition = false;

  const flushTerm = () => {
    if (currentTerm === null) return;
    if (!hasType) {
      checks.push({
        scope: GLOSSARY_FILE,
        status: "fail",
        message: `термин «${currentTerm}» без поля «**Тип:**»`,
      });
    }
    if (!hasDefinition) {
      checks.push({
        scope: GLOSSARY_FILE,
        status: "fail",
        message: `термин «${currentTerm}» без «**Определение.**»`,
      });
    }
  };

  for (const line of lines) {
    if (line.startsWith("### ")) {
      flushTerm();
      currentTerm = line.slice(4).trim();
      hasType = false;
      hasDefinition = false;
      continue;
    }
    if (currentTerm === null) continue;
    if (line.includes("**Тип:**")) hasType = true;
    if (line.includes("**Определение.**")) hasDefinition = true;
  }
  flushTerm();

  // 2. Коды терминов: строка в обратных кавычках в блоке сразу после заголовка
  //    «### » (пропуская пустые строки).
  const knownCodes = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("### ")) continue;
    for (let offset = 1; offset <= 3; offset += 1) {
      const probe = lines[i + offset] ?? "";
      if (probe.trim() === "") continue;
      const match = probe.match(/^\s*`([^`]+)`\s*$/);
      if (match !== null) {
        knownCodes.add(match[1]);
        break;
      }
      // Не-пустая, не-кодовая строка до кода — код находится дальше/отсутствует.
      break;
    }
  }

  // Каноническая форма кода в якоре: без «@» и «/» (глоссарий вырезает их из
  // package-имён: `@aif/shared` -> `aifshared`), camelCase приводится к виду
  // через дефис (`taskPipeline` -> `task-pipeline`), как это делают якоря.
  const hyphenate = (code) =>
    code
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[@/]/g, "")
      .toLowerCase();
  const normalizedKnownCodes = [...knownCodes].map(hyphenate).sort((a, b) => b.length - a.length);

  // 3. Связанные термины: якорь `#<slug>-<code>` обязан иметь известный код
  //    (как суффикс якоря — код может содержать дефис). Глоссарий ведётся
  //    вручную, якоря непоследовательны (иногда camelCase через «-», иногда
  //    слитно, включая опечатку `runtimeregistry`) — это эвристика (в каталоге
  //    G1-GLOSS помечен как гибрид LLM+скрипт), поэтому проверка выставляет
  //    `warn`, а не `fail`, и оставляется владельцу для ручной ревизии.
  for (const line of lines) {
    if (!line.includes("**Связанные термины.**")) continue;
    for (const match of line.matchAll(/\[([^\]]+)\]\(#([^)]+)\)/g)) {
      const anchor = match[2].toLowerCase();
      const known = normalizedKnownCodes.some((code) => anchor.endsWith(code));
      if (known) continue;
      checks.push({
        scope: GLOSSARY_FILE,
        status: "warn",
        message: `«висячая» ссылка связанного термина «${match[1]}» (${match[2]}) — код не найден среди заведённых`,
      });
    }
  }

  if (checks.length === 0) {
    log.info("G1-GLOSS: глоссарий корректен");
  } else {
    log.warn(`G1-GLOSS: ${checks.length} замечаний`);
  }

  return { checks, summary: `glossary: ${knownCodes.size} known term codes` };
}
