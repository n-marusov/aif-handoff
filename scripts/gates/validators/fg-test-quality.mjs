// FG-TEST-QUALITY — верификация тестов.
//
// Проверяет anti-паттерны в тестовых файлах (gates.md §6.4 «Верификация
// тестов»; gates.md §9.6 — этот гейт waiver НЕ подлежит):
//   fail:
//   - скип-маркеры в коммитнутых тестах: `.skip(`, `.only(`, `xit(`, `xdescribe(`,
//     `.todo(` — тест, который не исполняется, не может упасть;
//   - тривиальный always-pass: `expect(true).toBe(true)` и т.п.
//   warn:
//   - тест без единого assert (нет `expect`/`assert` внутри тела) — эвристика
//     на основе балансировки скобок.
//
// Скан ограничен файлами `__tests__`/`*.test.*` под `packages/*/src`.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { displayPath, readText, walkFiles } from "../lib/fs-tools.mjs";
import { log } from "../lib/logger.mjs";

export const GATE = { id: "FG-TEST-QUALITY", name: "Верификация тестов", group: "FG" };

const SKIP_PATTERNS = [/\.skip\(/, /\.only\(/, /\bxit\(/, /\bxdescribe\(/, /\.todo\(/, /\bxtest\(/];

const TRIVIAL_ASSERT = [
  /expect\(\s*true\s*\)\.toBe\(\s*true\s*\)/,
  /expect\(\s*false\s*\)\.toBe\(\s*false\s*\)/,
];

const ASSERT_RE = /\b(?:expect|assert|vi\.assert|assert\.)/;

/**
 * Split source into `it(`/`test(` blocks with balanced parentheses. Returns
 * `[{ name, body }]` where body is the full text between the open and close paren.
 */
function splitTestBlocks(source) {
  const blocks = [];
  const re = /\b(?:it|test)\s*\(/g;
  let match = null;

  while ((match = re.exec(source)) !== null) {
    const open = source.indexOf("(", match.index);
    if (open < 0) continue;

    let depth = 0;
    let end = -1;
    for (let cursor = open; cursor < source.length; cursor += 1) {
      const ch = source[cursor];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          end = cursor + 1;
          break;
        }
      }
    }
    if (end < 0) continue;

    const inner = source.slice(open + 1, end - 1);
    // Отбросить замыкающую `;`/запятую, если попали в сигнатуру `it("name", fn)`.
    blocks.push({
      nameAt: match.index,
      inner,
      text: source.slice(match.index, end),
    });
    re.lastIndex = end;
  }

  return blocks;
}

export async function run({ repoRoot }) {
  const checks = [];
  let scanned = 0;

  const packagesDir = join(repoRoot, "packages");
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const src = join(packagesDir, entry.name, "src");
    if (!existsSync(src)) continue;

    for (const file of walkFiles(src)) {
      if (!/\.(test|spec)\.tsx?$/.test(file)) continue;
      scanned += 1;
      const source = readText(file) ?? "";
      const rel = displayPath(file);
      const lines = source.split("\n");

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (SKIP_PATTERNS.some((pattern) => pattern.test(line))) {
          checks.push({
            scope: `${rel}:${i + 1}`,
            status: "fail",
            message: `скип/only-маркер в коммитнутом тесте: ${line.trim()}`,
          });
        }
        if (TRIVIAL_ASSERT.some((pattern) => pattern.test(line))) {
          checks.push({
            scope: `${rel}:${i + 1}`,
            status: "fail",
            message: `тривиальный always-pass assert: ${line.trim()}`,
          });
        }
      }

      for (const block of splitTestBlocks(source)) {
        const body = block.inner;
        const hasAssert = ASSERT_RE.test(body);
        if (hasAssert) continue;
        const name = body.slice(0, 40).replace(/\s+/g, " ").trim();
        checks.push({
          scope: rel,
          status: "warn",
          message: `блок it/test без единого assert: ${name}…`,
        });
      }
    }
  }

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  log.info(`FG-TEST-QUALITY: проверено ${scanned} файлов (${fails} fail, ${warns} warn)`);
  return { checks, summary: `checked ${scanned} test files for anti-patterns` };
}
