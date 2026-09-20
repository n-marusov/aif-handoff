// Filesystem and markdown helpers shared by the gate validators.
//
// Kept dependency-light on purpose: everything here uses Node's built-in
// `node:fs` and `node:path` modules plus the `yaml` package that is already
// hoisted to the workspace root (declared by @aif/shared / @aif/api).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// Repo root: <repo>/scripts/gates/lib/fs-tools.mjs -> <repo>/
export const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".turbo",
  ".astro",
  ".ai-factory/files",
]);

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown"]);
const SKIP_MARKDOWN_FILES = new Set(["README.md", "INDEX.md", "USE-CASES-INDEX.md"]);

/**
 * Recursively walk a directory and yield absolute file paths.
 * @param {string} dir absolute directory path
 * @param {{ skipDirs?: Set<string> }} [options]
 * @yields {string}
 */
export function* walkFiles(dir, options = {}) {
  const skipDirs = options.skipDirs ?? SKIP_DIRS;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      yield* walkFiles(full, options);
      continue;
    }
    if (!entry.isFile()) continue;
    yield full;
  }
}

/**
 * Collect every markdown file under `root` (skipping README/index files that
 * are rarely part of the ID catalog).
 * @param {string} root absolute directory path
 * @returns {string[]} absolute file paths, sorted by repo-relative path
 */
export function collectMarkdownFiles(root) {
  const files = [];
  for (const file of walkFiles(root)) {
    if (!MARKDOWN_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const name = file.split(sep).pop();
    if (SKIP_MARKDOWN_FILES.has(name)) continue;
    files.push(file);
  }
  files.sort((a, b) => relative(repoRoot, a).localeCompare(relative(repoRoot, b)));
  return files;
}

/**
 * Read a text file, normalising CRLF to LF. Missing files yield null.
 * @param {string} file absolute path
 * @returns {string | null}
 */
export function readText(file) {
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/**
 * Split a markdown source into lines with 1-based line numbers.
 * @param {string} source
 * @returns {{ text: string; line: number }[]}
 */
export function numberedLines(source) {
  const lines = source.split("\n");
  return lines.map((text, index) => ({ text, line: index + 1 }));
}

/**
 * Extract `(target)` and `[label](target)` markdown references that target a
 * local file (relative path or `#anchor`), skipping fenced code blocks.
 * @param {string} source
 * @returns {{ target: string; label: string | null; line: number }[]}
 */
export function extractLocalLinks(source) {
  const links = [];
  let inFence = false;

  const inlinePattern = /\[([^\]]*)\]\(([^)\]\s]+)(?:\s+"[^"]*")?\)/g;
  // Bare (target.md) references (e.g. glossary `task` code spans) — excluded
  // voluntarily: bare parens are too often inline code, not links.

  numberedLines(source).forEach(({ text, line }) => {
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    let match = null;
    while ((match = inlinePattern.exec(text)) !== null) {
      links.push({ target: match[2], label: match[1] || null, line });
    }
  });

  return links;
}

/**
 * Load a YAML file (used by G1-MACHINE for `docs/contracts/INDEX.yaml`).
 * Returns null when the file is missing; `.parseError` is set for malformed
 * YAML so callers can distinguish "missing" from "broken".
 * @param {string} file absolute path
 * @returns {unknown | null}
 */
export function loadYaml(file) {
  const source = readText(file);
  if (source === null) return null;
  try {
    // yaml is a workspace dependency that npm hoists to the root; import it
    // lazily so validators that never touch YAML pay no resolution cost.
    const { parse } = require("yaml");
    return parse(source);
  } catch (err) {
    const value = {};
    value.parseError = err instanceof Error ? err.message : String(err);
    return value;
  }
}

/**
 * Repo-relative display path with forward slashes (used in gate output).
 * @param {string} file absolute path
 * @returns {string}
 */
export function displayPath(file) {
  return relative(repoRoot, file).replaceAll("\\", "/");
}
