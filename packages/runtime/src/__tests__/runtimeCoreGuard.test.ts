import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Known issue: "ESLint runtime-core: запрет adapters завязан на явный список файлов".
// Reproducer (Task 10): the adapter-import ban applies to an explicit list, so a new core
// file absent from the list would silently bypass it. The guard asserts the shared list
// (consumed by eslint.config.mjs) covers every top-level runtime core file.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const coreDir = join(repoRoot, "packages", "runtime", "src");
const listModulePath = join(repoRoot, "eslint", "runtimeCoreFiles.mjs");

function actualCoreFiles(): string[] {
  return readdirSync(coreDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `packages/runtime/src/${entry.name}`)
    .sort();
}

function findUnlistedCoreFiles(actual: string[], listed: string[]): string[] {
  const known = new Set(listed);
  return actual.filter((file) => !known.has(file));
}

describe("runtime core ESLint guard", () => {
  it("reports a temp core file that is absent from the shared list", () => {
    const listed = ["packages/runtime/src/index.ts"];
    expect(findUnlistedCoreFiles(["packages/runtime/src/newCoreFile.ts"], listed)).toEqual([
      "packages/runtime/src/newCoreFile.ts",
    ]);
  });

  it("lists every top-level runtime core file in the shared list", async () => {
    const { RUNTIME_CORE_FILES } = (await import(pathToFileURL(listModulePath).href)) as {
      RUNTIME_CORE_FILES: string[];
    };
    expect(findUnlistedCoreFiles(actualCoreFiles(), RUNTIME_CORE_FILES)).toEqual([]);
  });

  it("is consumed by the ESLint config", () => {
    const config = readFileSync(join(repoRoot, "eslint.config.mjs"), "utf8");
    expect(config).toContain("runtimeCoreFiles.mjs");
    expect(config).toContain("RUNTIME_CORE_FILES");
  });
});
