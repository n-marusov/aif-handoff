import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { logger } from "@aif/shared";

const log = logger("git-test-utils");

// Every temp directory created through this module is tracked so a suite can wipe them
// in one call. Known issue: "Agent: флейки git-тестов при полном параллельном прогоне
// (Windows)" — a leaked or shared root lets one file observe another file's repository.
const createdRoots = new Set<string>();

function normalizePath(value: string): string {
  return resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Known issue: "Agent: флейки git-тестов при полном параллельном прогоне (Windows)".
 *
 * Guards a git test root against two cross-test hazards: operating outside the OS temp
 * directory (i.e. inside the real checkout) and running directly in the process working
 * directory. Call this for roots that were not created via {@link createGitTestRoot}.
 */
export function assertIsolatedGitTestRoot(rootPath: string): void {
  const root = normalizePath(rootPath);
  const tempRoot = normalizePath(tmpdir());
  if (!root.startsWith(`${tempRoot}/`)) {
    throw new Error(`Git test root must live under the OS temp dir; got ${rootPath}`);
  }
  if (root === normalizePath(process.cwd())) {
    throw new Error(`Git test root must not be the process working directory; got ${rootPath}`);
  }
}

/** Removes every temp root created through this module (git roots and isolated homes). */
export function cleanupGitTestRoots(): void {
  for (const root of createdRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort: a directory still held open on Windows must not fail the suite.
    }
  }
  createdRoots.clear();
}

/**
 * Initializes a git repository in an existing directory with the local identity and
 * signing settings every git-heavy agent suite needs to commit without touching the
 * developer's global config. Extracted so suites share one setup path.
 */
export function initGitRepo(rootPath: string, branch = "main"): void {
  execFileSync("git", ["init", `--initial-branch=${branch}`], { cwd: rootPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: rootPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: rootPath, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: rootPath, stdio: "ignore" });
}

// Best-effort attribution of a temp root to the suite that created it. The stack frame
// is the only source available without forcing every caller to pass its file name.
function callerTestFile(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  for (const line of stack.split("\n").slice(1)) {
    const match = /\(?([^()]+?\.(?:test|spec)\.tsx?):\d+:\d+\)?/.exec(line);
    const file = match?.[1];
    if (file && !file.includes("gitTestUtils")) return file;
  }
  return undefined;
}

/**
 * Known issue: "`ai:validate`: флейк agent-сьюта из-за записи в глобальный git config".
 *
 * `prepareRepository` (production) deliberately writes `credential.helper` and
 * `safe.directory` at `--global` scope so submodule clones inherit them
 * (`packages/agent/src/repositoryPrepare.ts`). Tests must therefore never let those
 * writes reach the developer's real `~/.gitconfig` — otherwise a permission or
 * concurrent-access failure there fails the suite for reasons unrelated to the
 * code under test.
 *
 * This helper creates an isolated home directory holding an empty global git config.
 * Point `GIT_CONFIG_GLOBAL` (highest priority for git) and `HOME` at the returned paths
 * (e.g. via `vi.stubEnv`) so every `git config --global` read/write performed by the
 * child processes lands in the sandbox instead of the real profile.
 *
 * @returns `homeDir` for the `HOME` override and `globalConfigPath` for `GIT_CONFIG_GLOBAL`.
 */
export function createIsolatedGitConfig(prefix = "aif-git-home-"): {
  homeDir: string;
  globalConfigPath: string;
} {
  const homeDir = mkdtempSync(join(tmpdir(), prefix));
  createdRoots.add(homeDir);
  const globalConfigPath = join(homeDir, "gitconfig");
  // Pre-create the file: git writes to the path given by GIT_CONFIG_GLOBAL but does not
  // create its parent/target on every command, and an empty file is a valid config.
  writeFileSync(globalConfigPath, "");
  log.debug({ tempDir: homeDir, globalConfigPath }, "Created isolated git home");
  return { homeDir, globalConfigPath };
}

export function createGitTestRoot(
  prefix: string,
  options: { configYaml?: string; readme?: string } = {},
): { rootPath: string; initialSha: string } {
  const rootPath = mkdtempSync(join(tmpdir(), prefix));
  createdRoots.add(rootPath);
  assertIsolatedGitTestRoot(rootPath);
  log.debug(
    { testFile: callerTestFile(), tempDir: tmpdir(), gitRoot: rootPath },
    "Created isolated git test root",
  );
  initGitRepo(rootPath);
  writeFileSync(join(rootPath, "README.md"), options.readme ?? "# test\n");
  if (options.configYaml) {
    mkdirSync(join(rootPath, ".ai-factory"), { recursive: true });
    writeFileSync(join(rootPath, ".ai-factory", "config.yaml"), options.configYaml);
  }
  execFileSync("git", ["add", "-A"], { cwd: rootPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "test: initialize repository", "--no-verify"], {
    cwd: rootPath,
    stdio: "ignore",
  });

  const initialSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootPath,
    encoding: "utf8",
  }).trim();
  return { rootPath, initialSha };
}
