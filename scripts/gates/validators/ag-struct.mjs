// AG-STRUCT — структурные метрики.
//
// Проверяет структурные метрики модулей (gates.md §6.5 «Структурные метрики»):
//   - размер файла (строк) не превышает порог — proxy для сложности/связности;
//   - в пакете не накапливаются «мегафайлы» (файлы крупнее х2 порога).
//
// Пороги по умолчанию (tunable через env):
//   GATE_STRUCT_MAX_LINES   (default 1400)
//   GATE_STRUCT_MAX_MEGA    (default 2600)
//
// Проверка детерминированная; значения — ориентир качества, нарушение >2x
// порога — fail, превышение обычного порога — warn (калибруется владельцем).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { displayPath, readText, walkFiles } from "../lib/fs-tools.mjs";
import { log } from "../lib/logger.mjs";

export const GATE = { id: "AG-STRUCT", name: "Структурные метрики", group: "AG" };

const MAX_LINES = Number(process.env.GATE_STRUCT_MAX_LINES ?? 1400);
const MAX_MEGA_LINES = Number(process.env.GATE_STRUCT_MAX_MEGA ?? 2600);
const PACKAGES_ROOT = "packages";

export async function run({ repoRoot }) {
  const checks = [];
  let scanned = 0;

  const packagesDir = join(repoRoot, PACKAGES_ROOT);

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    const src = join(packagesDir, entry.name, "src");
    if (!existsSync(src)) continue;

    for (const file of walkFiles(src)) {
      if (!/\.tsx?$/.test(file) || /\.(test|spec)\.tsx?$/.test(file)) continue;
      const source = readText(file) ?? "";
      const lineCount = source.split("\n").length;
      scanned += 1;

      if (lineCount > MAX_MEGA_LINES) {
        checks.push({
          scope: displayPath(file),
          status: "fail",
          message: `мегафайл: ${lineCount} строк (порог ${MAX_MEGA_LINES})`,
        });
      } else if (lineCount > MAX_LINES) {
        checks.push({
          scope: displayPath(file),
          status: "warn",
          message: `крупный модуль: ${lineCount} строк (порог ${MAX_LINES})`,
        });
      }
    }
  }

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  log.info(`AG-STRUCT: проверено ${scanned} файлов (${fails} fail, ${warns} warn)`);
  return { checks, summary: `checked ${scanned} source files for size metrics` };
}
