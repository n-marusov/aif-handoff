#!/usr/bin/env node
/**
 * Repo guard against ticket-style log markers in production source.
 *
 * Known issue: "`[FIX]`/`[FIX:*]` маркеры остаются в production-логах coordinator".
 * Temporary ticket prefixes (`[FIX]`, `[FIX:149]`, `[fix]`) are debugging leftovers: they
 * leak into operator-facing logs and alert text, so production source must use neutral,
 * stable event wording instead. The marker `[FIXTURE_PATH]`-style identifiers do not match.
 *
 * Scans non-test TypeScript sources under each package's src directory. The scan root
 * can be overridden with `AIF_LOG_MARKER_SCAN_ROOT` (used by the guard test). A line may
 * opt out with an inline `log-marker-allow: <reason>` comment when the marker is
 * intentional.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER_PATTERN = /\[FIX(?:\]|:)/i;
const OPT_OUT = "log-marker-allow";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scanRoot = process.env.AIF_LOG_MARKER_SCAN_ROOT
  ? resolve(process.env.AIF_LOG_MARKER_SCAN_ROOT)
  : join(repoRoot, "packages");

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "__tests__", "fixtures"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const TEST_FILE_PATTERN = /\.(test|spec)\.tsx?$/;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (TEST_FILE_PATTERN.test(entry.name)) continue;
    if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
    yield full;
  }
}

if (!existsSync(scanRoot)) {
  console.error(`Log-marker guard: scan root does not exist: ${scanRoot}`);
  process.exit(1);
}

const offenders = [];
for (const file of walk(scanRoot)) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!MARKER_PATTERN.test(line)) return;
    if (line.includes(OPT_OUT)) return;
    offenders.push({ file, line: index + 1, text: line.trim() });
  });
}

if (offenders.length > 0) {
  console.error("Ticket-style log markers found in production source:");
  for (const { file, line, text } of offenders) {
    console.error(`  ${relative(repoRoot, file)}:${line}: ${text}`);
  }
  console.error(
    `\n${offenders.length} marker(s) found. Use neutral wording, or add a ` +
      `\`${OPT_OUT}: <reason>\` comment when the marker is intentional.`,
  );
  process.exit(1);
}

console.log("No ticket-style log markers found in production source.");
