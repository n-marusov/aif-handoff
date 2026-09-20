// Package dependency graph for the @aif/* workspace.
//
// Reads `packages/*/package.json` `dependencies`/`devDependencies` and extracts
// internal edges (keys starting with `@aif/`). Used by AG-CYCLES, AG-LAYERS and
// AG-BOUNDARIES.

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { readText } from "./fs-tools.mjs";

/** @returns {{ name: string; dir: string; deps: string[]; devDeps: string[] }[]} */
export function loadPackageGraph(repoRoot) {
  const packages = [];
  const packagesDir = join(repoRoot, "packages");

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = join(packagesDir, entry.name);
    const manifest = readText(join(packageDir, "package.json"));
    if (manifest === null) continue;

    let json = null;
    try {
      json = JSON.parse(manifest);
    } catch {
      continue;
    }
    if (typeof json !== "object" || json === null || json.name === undefined) continue;

    const collectInternal = (deps) =>
      Object.keys(deps ?? {}).filter((name) => name.startsWith("@aif/"));

    packages.push({
      name: json.name,
      dir: packageDir,
      deps: collectInternal(json.dependencies),
      devDeps: collectInternal(json.devDependencies),
    });
  }

  packages.sort((a, b) => a.name.localeCompare(b.name));
  return packages;
}

/**
 * Detect cycles in the directed dependency graph.
 * @param {{ name: string; deps: string[] }[]} packages
 * @returns {{ cycle: string[] }[]}
 */
export function findCycles(packages) {
  const index = new Map(packages.map((p) => [p.name, p.deps]));
  const visited = new Set();
  const inStack = new Set();
  const stack = [];
  const cycles = [];

  const visit = (name) => {
    if (visited.has(name)) return;
    visited.add(name);
    inStack.add(name);
    stack.push(name);

    for (const dep of index.get(name) ?? []) {
      if (!index.has(dep)) continue;
      if (inStack.has(dep)) {
        const start = stack.indexOf(dep);
        const cycle = stack.slice(start).concat(dep);
        if (!cycles.some((existing) => existing.join(">") === cycle.join(">"))) {
          cycles.push(cycle);
        }
        continue;
      }
      visit(dep);
    }

    stack.pop();
    inStack.delete(name);
  };

  for (const pkg of packages) visit(pkg.name);
  return cycles;
}

/**
 * Forbidden layer edges per the clean-architecture rules from
 * `.ai-factory/ARCHITECTURE.md` / AGENTS.md.
 * @returns {[string, string][]} forbidden (from, to) pairs among @aif/* names
 */
export function forbiddenLayerEdges() {
  return [
    // shared — корень: не зависит ни от кого из внутренних пакетов.
    ["@aif/shared", "@aif/data"],
    ["@aif/shared", "@aif/api"],
    ["@aif/shared", "@aif/agent"],
    ["@aif/shared", "@aif/web"],
    ["@aif/shared", "@aif/runtime"],
    ["@aif/shared", "@aif/mcp"],
    // runtime — библиотечный слой: не зависит от приложений.
    ["@aif/runtime", "@aif/api"],
    ["@aif/runtime", "@aif/agent"],
    ["@aif/runtime", "@aif/web"],
    ["@aif/runtime", "@aif/mcp"],
    ["@aif/runtime", "@aif/data"],
    // data — слой данных: не зависит от приложений.
    ["@aif/data", "@aif/api"],
    ["@aif/data", "@aif/agent"],
    ["@aif/data", "@aif/web"],
    ["@aif/data", "@aif/mcp"],
    ["@aif/data", "@aif/runtime"],
  ];
}
