// G1-TBD — реестр TBD.
//
// Каждый маркер `[TBD-xx]` в спецификационных артефактах обязан быть заведён в
// `open-questions.md` (реестр открытых вопросов) с владельцем и сроком.
// Маркер без записи — дефект процесса (gates.md §9.3): артефакт не переходит в
// `live`, пока TBD не закрыт или не зафиксирован как waiver.
//
// Формат маркера в артефактах: `[TBD-<CODE>]` или `[TBD-VM1]`–`[TBD-VT7]`.
// Формат записи в реестре: ячейка таблицы `| \`TBD-<CODE>\` | ... |`.

import { join } from "node:path";

import { collectMarkdownFiles, displayPath, readText } from "../lib/fs-tools.mjs";
import { log } from "../lib/logger.mjs";

export const GATE = { id: "G1-TBD", name: "Реестр TBD", group: "G1" };

const TBD_MARKER = /\[(TBD-[A-Z0-9]+)\]/g;
const REGISTRY_FILE = "open-questions.md";

export async function run({ repoRoot }) {
  const checks = [];
  const registered = new Set();

  // 1. Прочитать реестр.
  const registryPath = join(repoRoot, REGISTRY_FILE);
  const registrySource = readText(registryPath);
  if (registrySource === null) {
    return {
      checks: [
        {
          scope: REGISTRY_FILE,
          status: "fail",
          message: `реестр открытых вопросов ${REGISTRY_FILE} не существует`,
        },
      ],
      summary: "TBD registry missing",
    };
  }

  for (const match of registrySource.matchAll(/`(TBD-[A-Z0-9]+)`/g)) {
    registered.add(match[1]);
  }

  // 2. Собрать маркеры из артефактов.
  const markers = new Map(); // id -> string[] (scope list)
  for (const file of collectMarkdownFiles(join(repoRoot, "docs"))) {
    const source = readText(file) ?? "";
    for (const match of source.matchAll(TBD_MARKER)) {
      const id = match[1];
      if (!markers.has(id)) markers.set(id, []);
      markers.get(id).push(displayPath(file));
    }
  }

  // 3. Сверить.
  let unregistered = 0;
  for (const [id, scopes] of markers) {
    if (registered.has(id)) continue;
    unregistered += 1;
    checks.push({
      scope: scopes.join(", "),
      status: "fail",
      message: `маркер [${id}] не заведён в ${REGISTRY_FILE}`,
    });
  }

  if (unregistered > 0) {
    log.warn(`G1-TBD: ${unregistered} незарегистрированных маркеров из ${markers.size}`);
  } else {
    log.info(`G1-TBD: все ${markers.size} TBD-маркеров зарегистрированы`);
  }

  return { checks, summary: `registered ${registered.size} TBD, found ${markers.size} markers` };
}
