// AG-LAYERS — слои и границы пакетов.
//
// Проверяет соблюдение слоёв clean architecture между пакетами @aif/*
// (gates.md §6.5 «Слои и границы»): shared — корень без внутренних
// зависимостей; runtime/data — библиотечные слои; api/agent/web/mcp —
// приложения. Запрещённые рёбра берутся из `package-graph.mjs`
// (единый источник правил, согласованный с `.ai-factory/ARCHITECTURE.md`
// и `docs/architecture.md`).

import { log } from "../lib/logger.mjs";
import { forbiddenLayerEdges, loadPackageGraph } from "../lib/package-graph.mjs";

export const GATE = { id: "AG-LAYERS", name: "Слои и границы", group: "AG" };

export async function run({ repoRoot }) {
  const packages = loadPackageGraph(repoRoot);
  const forbidden = forbiddenLayerEdges();
  const checks = [];

  for (const pkg of packages) {
    for (const dep of pkg.deps) {
      const rule = forbidden.some(([from, to]) => from === pkg.name && to === dep);
      if (!rule) continue;
      checks.push({
        scope: `${pkg.name} → ${dep}`,
        status: "fail",
        message: `запрещённое ребро слоёв (clean architecture)`,
      });
    }
  }

  if (checks.length > 0) {
    log.warn(`AG-LAYERS: ${checks.length} нарушений слоёв`);
  } else {
    log.info(`AG-LAYERS: слои соблюдены для ${packages.length} пакетов`);
  }

  return {
    checks,
    summary: `checked ${packages.length} packages against ${forbidden.length} layer rules`,
  };
}
