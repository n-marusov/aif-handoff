// AG-CYCLES — циклы зависимостей между пакетами.
//
// Проверяет граф внутренних зависимостей `@aif/*` на циклы (gates.md §6.5).
// Аналог ArchUnit `beFreeOfCycles`; исполняется статически по package.json.
// Цикл между пакетами — блокер (waiver не допускается, gates.md §9.7).

import { join } from "node:path";

import { log } from "../lib/logger.mjs";
import { findCycles, loadPackageGraph } from "../lib/package-graph.mjs";

export const GATE = { id: "AG-CYCLES", name: "Циклы зависимостей", group: "AG" };

export async function run({ repoRoot }) {
  const packages = loadPackageGraph(repoRoot);
  const cycles = findCycles(packages);

  const checks = cycles.map((cycle) => ({
    scope: cycle.join(" → "),
    status: "fail",
    message: "циклическая зависимость между пакетами",
  }));

  if (cycles.length > 0) {
    log.warn(`AG-CYCLES: ${cycles.length} цикл(ов)`);
  } else {
    log.info(`AG-CYCLES: циклов нет среди ${packages.length} пакетов`);
  }

  return { checks, summary: `checked ${packages.length} packages for cycles` };
}
