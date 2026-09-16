import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitLabRepositoryConnection } from "@aif/shared";

const initProjectMock = vi.fn();
const getRuntimeRegistrySyncMock = vi.fn();
const findProjectByIdMock = vi.fn();
const findGitLabRepositoryMock = vi.fn();

vi.mock("../coordinator.js", () => ({
  getRuntimeRegistrySync: () => getRuntimeRegistrySyncMock(),
  setRuntimeRegistry: () => {},
  COORDINATOR_ID: "test-coordinator",
}));

vi.mock("@aif/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/runtime")>();
  return {
    ...actual,
    initProject: (...args: unknown[]) => initProjectMock(...args),
  };
});

vi.mock("@aif/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/data")>();
  return {
    ...actual,
    findProjectById: (...args: unknown[]) => findProjectByIdMock(...args),
    findGitLabRepository: (...args: unknown[]) => findGitLabRepositoryMock(...args),
  };
});

const { prepareGitLabRepository, prepareGitLabRepositoryForProject } =
  await import("../gitlabPrepare.js");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitQuiet(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function makeConnection(
  webUrl: string,
  overrides: Partial<GitLabRepositoryConnection> = {},
): GitLabRepositoryConnection {
  return {
    projectId: "project-1",
    namespace: "gitlab-org",
    name: "example",
    webUrl,
    defaultBranch: "main",
    tokenEnvVar: "GITLAB_TOKEN",
    eligibility: { labels: [], assignee: null, milestone: null },
    enabled: true,
    tokenConfigured: true,
    lastSyncedAt: null,
    syncError: null,
    gitPreparedAt: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("prepareGitLabRepository", () => {
  let root: string;
  let origin: string;

  function initLocalRepo(branch = "master"): void {
    gitQuiet(root, ["init", `--initial-branch=${branch}`]);
    gitQuiet(root, ["config", "user.email", "t@t.local"]);
    gitQuiet(root, ["config", "user.name", "T"]);
    gitQuiet(root, ["config", "commit.gpgsign", "false"]);
    // Real POST /projects creates an initial scaffold commit; mirror that so
    // the branch is born (unborn branches break -M/commit/push semantics).
    gitQuiet(root, ["commit", "--allow-empty", "-m", "init: project scaffold", "--no-verify"]);
  }

  function createOriginWithMain(): string {
    const bare = mkdtempSync(join(tmpdir(), "aif-gitlab-origin-"));
    gitQuiet(bare, ["init", "--bare", "--initial-branch=main"]);
    return bare;
  }

  beforeEach(() => {
    initProjectMock.mockReset();
    initProjectMock.mockReturnValue({ ok: true });
    getRuntimeRegistrySyncMock.mockReset();
    getRuntimeRegistrySyncMock.mockReturnValue({ listRuntimes: () => [] });
    findProjectByIdMock.mockReset();
    findGitLabRepositoryMock.mockReset();
    root = mkdtempSync(join(tmpdir(), "aif-gitlab-prepare-"));
    origin = createOriginWithMain();
    vi.stubEnv("GITLAB_TOKEN", "secret-token");
    // Allow local filesystem submodule clones (blocked by default since Git 2.38.1)
    execFileSync("git", ["config", "--global", "protocol.file.allow", "always"], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("adds origin when missing", () => {
    initLocalRepo("master");
    const connection = makeConnection(origin);

    prepareGitLabRepository({ projectRoot: root, connection });

    const remotes = git(root, ["remote", "-v"]);
    expect(remotes).toContain(origin);
  });

  it("does not duplicate origin when already present", () => {
    initLocalRepo("master");
    gitQuiet(root, ["remote", "add", "origin", origin]);
    const connection = makeConnection(origin);

    prepareGitLabRepository({ projectRoot: root, connection });

    const remotes = git(root, ["remote"]);
    expect(remotes.split("\n")).toEqual(["origin"]);
  });

  it("sets safe.directory for the project root", () => {
    initLocalRepo("master");
    const connection = makeConnection(origin);

    prepareGitLabRepository({ projectRoot: root, connection });

    const safe = git(root, ["config", "--global", "--get-all", "safe.directory"]);
    expect(safe).toContain(root);
  });

  it("creates the scaffold with initProject when .ai-factory is missing", () => {
    initLocalRepo("master");
    const connection = makeConnection(origin);

    prepareGitLabRepository({ projectRoot: root, connection });

    expect(initProjectMock).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: root }));
  });

  it("skips initProject when .ai-factory already exists", () => {
    initLocalRepo("master");
    mkdirSync(join(root, ".ai-factory"), { recursive: true });
    writeFileSync(join(root, ".ai-factory", "config.yaml"), "language:\n  ui: en\n");
    gitQuiet(root, ["add", ".ai-factory"]);
    gitQuiet(root, ["commit", "-m", "scaffold", "--no-verify"]);
    const connection = makeConnection(origin);

    prepareGitLabRepository({ projectRoot: root, connection });

    expect(initProjectMock).not.toHaveBeenCalled();
  });

  it("commits scaffold files when they appear", () => {
    initLocalRepo("master");
    initProjectMock.mockImplementation(() => {
      mkdirSync(join(root, ".ai-factory"), { recursive: true });
      writeFileSync(join(root, ".ai-factory", "config.yaml"), "language:\n  ui: en\n");
      return { ok: true };
    });
    const connection = makeConnection(origin);

    prepareGitLabRepository({ projectRoot: root, connection });

    const log = git(root, ["log", "--oneline", "-1"]);
    expect(log).toContain("chore: ai-factory scaffold");
  });

  it("commits scaffold files even when .ai-factory already existed", () => {
    initLocalRepo("master");
    // .ai-factory already present (no init needed) but scaffold files are
    // untracked (e.g. leftover from a partial run) — they must be committed.
    mkdirSync(join(root, ".ai-factory"), { recursive: true });
    writeFileSync(join(root, ".ai-factory", "config.yaml"), "language:\n  ui: en\n");
    gitQuiet(root, ["add", ".ai-factory"]);
    gitQuiet(root, ["commit", "-m", "scaffold", "--no-verify"]);
    mkdirSync(join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(join(root, ".claude", "agents", "x.md"), "# x\n");
    const connection = makeConnection(origin);

    prepareGitLabRepository({ projectRoot: root, connection });

    const log = git(root, ["log", "--oneline", "-1"]);
    expect(log).toContain("chore: ai-factory scaffold");
  });

  it("extracts the remote default branch (not hardcoded main)", () => {
    initLocalRepo("main");
    gitQuiet(root, ["commit", "--allow-empty", "-m", "local init", "--no-verify"]);
    gitQuiet(root, ["remote", "add", "origin", origin]);
    gitQuiet(root, ["push", "-u", "origin", "main"]);
    // Now defaultBranch is reported as master by GitLab but origin has main.
    // A correct implementation extracts by connection.defaultBranch → master is
    // absent on origin, so it falls to the empty-origin path and renames local.
    const connection = makeConnection(origin, { defaultBranch: "master" });

    prepareGitLabRepository({ projectRoot: root, connection });

    expect(git(root, ["branch", "--show-current"])).toBe("master");
  });

  it("throws project_not_found when the project is missing", () => {
    findProjectByIdMock.mockReturnValue(undefined);

    expect(() => prepareGitLabRepositoryForProject("missing")).toThrowError(
      expect.objectContaining({ kind: "project_not_found" }),
    );
  });

  it("throws connection_not_found when the project has no GitLab connection", () => {
    findProjectByIdMock.mockReturnValue({ id: "p1", rootPath: root });
    findGitLabRepositoryMock.mockReturnValue(undefined);

    expect(() => prepareGitLabRepositoryForProject("p1")).toThrowError(
      expect.objectContaining({ kind: "connection_not_found" }),
    );
  });

  it("initializes git submodules when .gitmodules exists on the remote", () => {
    // Create a bare repo to serve as the submodule target
    const subBare = mkdtempSync(join(tmpdir(), "aif-gitlab-sub-bare-"));
    gitQuiet(subBare, ["init", "--bare", "--initial-branch=main"]);
    // Push content to submodule repo so submodule update can clone it
    const subWs = mkdtempSync(join(tmpdir(), "aif-gitlab-sub-ws-"));
    gitQuiet(subWs, ["init", "--initial-branch=main"]);
    gitQuiet(subWs, ["config", "user.email", "t@t.local"]);
    gitQuiet(subWs, ["config", "user.name", "T"]);
    gitQuiet(subWs, ["commit", "--allow-empty", "-m", "init", "--no-verify"]);
    gitQuiet(subWs, ["remote", "add", "origin", subBare]);
    gitQuiet(subWs, ["push", "-u", "origin", "main"]);

    // Set up the origin repo with a properly-registered submodule
    const ws = mkdtempSync(join(tmpdir(), "aif-gitlab-ws-"));
    gitQuiet(ws, ["init", "--initial-branch=main"]);
    gitQuiet(ws, ["config", "user.email", "t@t.local"]);
    gitQuiet(ws, ["config", "user.name", "T"]);
    gitQuiet(ws, ["commit", "--allow-empty", "-m", "init", "--no-verify"]);
    gitQuiet(ws, ["remote", "add", "origin", origin]);
    gitQuiet(ws, ["push", "-u", "origin", "main"]);

    // Use git submodule add to properly register the submodule (creates .gitmodules + gitlink entry)
    const subUrl = subBare.replace(/\\/g, "/");
    gitQuiet(ws, ["submodule", "add", subUrl, "lib"]);
    gitQuiet(ws, ["commit", "-m", "add submodule", "--no-verify"]);
    gitQuiet(ws, ["push", "origin", "main"]);

    const connection = makeConnection(origin);
    prepareGitLabRepository({ projectRoot: root, connection });

    // Submodule should be checked out (lib/.git should exist)
    expect(existsSync(join(root, "lib", ".git"))).toBe(true);
  });

  it("throws submodule_failed when a submodule URL is unreachable", () => {
    // Create a bare repo to serve as a temporary valid submodule target
    const tmpBare = mkdtempSync(join(tmpdir(), "aif-gitlab-tmp-bare-"));
    gitQuiet(tmpBare, ["init", "--bare", "--initial-branch=main"]);
    const tmpWs = mkdtempSync(join(tmpdir(), "aif-gitlab-tmp-ws-"));
    gitQuiet(tmpWs, ["init", "--initial-branch=main"]);
    gitQuiet(tmpWs, ["config", "user.email", "t@t.local"]);
    gitQuiet(tmpWs, ["config", "user.name", "T"]);
    gitQuiet(tmpWs, ["commit", "--allow-empty", "-m", "init", "--no-verify"]);
    gitQuiet(tmpWs, ["remote", "add", "origin", tmpBare]);
    gitQuiet(tmpWs, ["push", "-u", "origin", "main"]);

    // Set up origin with a properly-registered submodule
    const ws = mkdtempSync(join(tmpdir(), "aif-gitlab-ws-"));
    gitQuiet(ws, ["init", "--initial-branch=main"]);
    gitQuiet(ws, ["config", "user.email", "t@t.local"]);
    gitQuiet(ws, ["config", "user.name", "T"]);
    gitQuiet(ws, ["commit", "--allow-empty", "-m", "init", "--no-verify"]);
    gitQuiet(ws, ["remote", "add", "origin", origin]);
    gitQuiet(ws, ["push", "-u", "origin", "main"]);

    const tmpUrl = tmpBare.replace(/\\/g, "/");
    gitQuiet(ws, ["submodule", "add", tmpUrl, "missing"]);
    // Replace the submodule URL with a non-existent path so submodule update fails
    const badUrl = join(tmpdir(), "aif-gitlab-nonexistent-" + Date.now()).replace(/\\/g, "/");
    writeFileSync(
      join(ws, ".gitmodules"),
      `[submodule "missing"]\n\tpath = missing\n\turl = ${badUrl}\n`,
    );
    gitQuiet(ws, ["add", ".gitmodules"]);
    gitQuiet(ws, ["commit", "-m", "break submodule url", "--no-verify"]);
    gitQuiet(ws, ["push", "origin", "main"]);

    const connection = makeConnection(origin);

    expect(() => prepareGitLabRepository({ projectRoot: root, connection })).toThrow(
      expect.objectContaining({ kind: "submodule_failed" }),
    );
  });

  it("runs the full prepare for a project with a connection", () => {
    initLocalRepo("master");
    findProjectByIdMock.mockReturnValue({ id: "project-1", rootPath: root });
    findGitLabRepositoryMock.mockReturnValue(makeConnection(origin));

    const result = prepareGitLabRepositoryForProject("project-1");

    expect(result.gitPreparedAt).toBeDefined();
    expect(git(root, ["remote"])).toBe("origin");
  });
});
