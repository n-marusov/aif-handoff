// AG-BOUNDARIES — границы компонентов.
//
// Проверяет изоляцию интерфейсов, которую ESLint-конфиг декларирует как
// lint-guard (gates.md §6.5 «Границы компонентов»):
//   - DB-boundary: `api`, `agent`, `runtime`, `mcp` не импортируют
//     `@aif/data/db`, `drizzle-orm`, `better-sqlite3` напрямую (БД — только
//     через `@aif/data`);
//   - runtime-core не импортирует адаптеры напрямую (порт — через registry).
//
// ESLint остаётся основным исполнителем правила; этот гейт — независимый
// детерминированный скан, который не зависит от конфигурации линтера.
//
// Ловятся все три формы импорта: `from "mod"`, side-effect `import "mod"`
// и динамический `import("mod")`.

import { join } from "node:path";

import { displayPath, readText, walkFiles } from "../lib/fs-tools.mjs";
import { log } from "../lib/logger.mjs";

export const GATE = { id: "AG-BOUNDARIES", name: "Границы компонентов", group: "AG" };

const RESTRICTED_MODULES = [
  { module: "@aif/data/db", label: "@aif/data/db" },
  { module: "drizzle-orm", label: "drizzle-orm" },
  { module: "drizzle-orm/better-sqlite3", label: "drizzle-orm/better-sqlite3" },
  { module: "better-sqlite3", label: "better-sqlite3" },
];

// Три формы импорта: `from "mod"`, side-effect `import "mod"`, dynamic `import("mod")`.
const RESTRICTED_IMPORT_PATTERNS = RESTRICTED_MODULES.flatMap(({ module, label }) => {
  const escaped = module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const locator = `${escaped}(?:\\.js)?`;
  return [
    {
      pattern: new RegExp(`from\\s+["']${locator}["']`),
      label: `прямой импорт ${label} (from)`,
    },
    {
      pattern: new RegExp(`import\\s+["']${locator}["']`),
      label: `прямой импорт ${label} (side-effect)`,
    },
    {
      pattern: new RegExp(`import\\s*\\(\\s*["']${locator}["']`),
      label: `прямой импорт ${label} (dynamic)`,
    },
  ];
});

const BOUNDARY_PACKAGES = ["api", "agent", "runtime", "mcp"];

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "__tests__", "fixtures"]);

export async function run({ repoRoot }) {
  const checks = [];
  let scanned = 0;

  for (const pkg of BOUNDARY_PACKAGES) {
    const src = join(repoRoot, "packages", pkg, "src");
    for (const file of walkFiles(src, { skipDirs: SKIP_DIRS })) {
      if (!/\.tsx?$/.test(file)) continue;
      scanned += 1;

      const source = readText(file) ?? "";
      const rel = displayPath(file);
      const lines = source.split("\n");

      for (const rule of RESTRICTED_IMPORT_PATTERNS) {
        for (let i = 0; i < lines.length; i += 1) {
          if (!rule.pattern.test(lines[i])) continue;
          checks.push({
            scope: `${rel}:${i + 1}`,
            status: "fail",
            message: rule.label,
          });
          break;
        }
      }
    }
  }

  if (checks.length > 0) {
    log.warn(`AG-BOUNDARIES: ${checks.length} нарушений границ`);
  } else {
    log.info(`AG-BOUNDARIES: границы соблюдены в ${scanned} файлах`);
  }

  return { checks, summary: `scanned ${scanned} files for boundary violations` };
}
