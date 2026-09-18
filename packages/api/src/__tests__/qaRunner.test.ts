import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mockRunApiRuntimeOneShot = vi.fn();
const mockFindTaskById = vi.fn();
const mockUpdateTask = vi.fn();
const mockGetProjectConfig = vi.fn();

vi.mock("../services/runtime.js", () => ({
  runApiRuntimeOneShot: (...args: unknown[]) => mockRunApiRuntimeOneShot(...args),
}));

vi.mock("@aif/data", () => ({
  findTaskById: (id: string) => mockFindTaskById(id),
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
}));

// Держим broadcast / конвертацию payload заглушками (no-op), чтобы раннер тестировался изолированно.
vi.mock("../ws.js", () => ({
  broadcast: vi.fn(),
}));
vi.mock("../repositories/tasks.js", () => ({
  toTaskBroadcastPayload: (t: { id: string }) => ({ id: t.id }),
}));

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getProjectConfig: (...args: unknown[]) => mockGetProjectConfig(...args),
  };
});

const { runQaQuery, computeQaBranchSlug, buildQaPrompt } = await import("../services/qaRunner.js");

const BRANCH = "feature/foo";

function writeArtifacts(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "change-summary.md"), "# Change Summary\nstuff");
  writeFileSync(join(dir, "test-plan.md"), "# Test Plan\nsteps");
  writeFileSync(join(dir, "test-cases.md"), "# Test Cases\ncases");
}

describe("computeQaBranchSlug", () => {
  it("matches the aif-qa skill slug for feature/foo", () => {
    expect(computeQaBranchSlug("feature/foo", process.cwd())).toBe("feature-foo-a72ccce7");
  });

  it("matches the aif-qa skill slug for feature-foo (distinct hash from feature/foo)", () => {
    expect(computeQaBranchSlug("feature-foo", process.cwd())).toBe("feature-foo-6f80dfc6");
  });
});

describe("buildQaPrompt", () => {
  it("embeds the three exact artifact paths", () => {
    const dir = "/abs/qa/feature-foo-a72ccce7";
    const prompt = buildQaPrompt(dir);
    expect(prompt).toContain(join(dir, "change-summary.md"));
    expect(prompt).toContain(join(dir, "test-plan.md"));
    expect(prompt).toContain(join(dir, "test-cases.md"));
  });
});

describe("runQaQuery", () => {
  let root: string;

  beforeEach(() => {
    mockRunApiRuntimeOneShot.mockReset();
    mockFindTaskById.mockReset();
    mockUpdateTask.mockReset();
    mockGetProjectConfig.mockReset();
    root = mkdtempSync(join(tmpdir(), "qa-runner-test-"));
    mockGetProjectConfig.mockReturnValue({ paths: { qa: ".ai-factory/qa/" } });
    // findTaskById отдаёт одну и ту же базовую задачу при каждом вызове (чтения running/done/error).
    mockFindTaskById.mockReturnValue({ id: "t1", branchName: BRANCH, qaStatus: "idle" });
    mockRunApiRuntimeOneShot.mockResolvedValue({ result: { outputText: "ok" }, context: {} });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns ok:false when task not found (never throws)", async () => {
    mockFindTaskById.mockReturnValue(undefined);
    const res = await runQaQuery({ projectId: "p1", taskId: "missing", executionRoot: root });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
    expect(mockRunApiRuntimeOneShot).not.toHaveBeenCalled();
  });

  it("rejects QA for a human-owned task without invoking the runtime", async () => {
    mockFindTaskById.mockReturnValue({
      id: "t1",
      executionOwner: "human",
      branchName: BRANCH,
      qaStatus: "idle",
    });
    const res = await runQaQuery({ projectId: "p1", taskId: "t1", executionRoot: root });
    expect(res).toMatchObject({ ok: false, code: "ai_handoff_required" });
    expect(mockRunApiRuntimeOneShot).not.toHaveBeenCalled();
  });

  it("falls back to the current git branch when task has no branchName", async () => {
    mockFindTaskById.mockReturnValue({ id: "t1", branchName: null, qaStatus: "idle" });
    // executionRoot — обычный tmpdir (без рабочего дерева git), поэтому резервный путь
    // `git branch --show-current`, зеркалящий скилл, разрешается в "" → slug "branch".
    const slug = computeQaBranchSlug("", root);
    writeArtifacts(join(root, ".ai-factory/qa", slug));
    const res = await runQaQuery({ projectId: "p1", taskId: "t1", executionRoot: root });
    expect(res.ok).toBe(true);
    expect(mockRunApiRuntimeOneShot).toHaveBeenCalled();
  });

  it("calls runtime with qa workflow contract", async () => {
    const slug = computeQaBranchSlug(BRANCH, root);
    writeArtifacts(join(root, ".ai-factory/qa", slug));
    await runQaQuery({ projectId: "p1", taskId: "t1", executionRoot: root });
    const arg = mockRunApiRuntimeOneShot.mock.calls[0][0];
    expect(arg.workflowKind).toBe("qa");
    expect(arg.projectRoot).toBe(root);
    expect(arg.fallbackSlashCommand).toBe("/aif-qa --all");
    expect(arg.usageContext).toEqual({ source: "qa" });
  });

  it("does NOT set qaStatus running — the caller claims that slot atomically", async () => {
    // Переход running переехал в routes/tasks startQaRun (tryStartQaRun), чтобы
    // конкурентные старты сериализовались на уровне БД. Воркер лишь завершает
    // прогон, поэтому сам никогда не должен писать qaStatus:"running".
    const slug = computeQaBranchSlug(BRANCH, root);
    writeArtifacts(join(root, ".ai-factory/qa", slug));
    await runQaQuery({ projectId: "p1", taskId: "t1", executionRoot: root });
    expect(mockUpdateTask).not.toHaveBeenCalledWith("t1", { qaStatus: "running" });
  });

  it("persists qaStatus done + three artifacts on success", async () => {
    const slug = computeQaBranchSlug(BRANCH, root);
    writeArtifacts(join(root, ".ai-factory/qa", slug));
    const res = await runQaQuery({ projectId: "p1", taskId: "t1", executionRoot: root });
    expect(res.ok).toBe(true);
    expect(mockUpdateTask).toHaveBeenCalledWith("t1", {
      qaStatus: "done",
      qaChangeSummary: "# Change Summary\nstuff",
      qaTestPlan: "# Test Plan\nsteps",
      qaTestCases: "# Test Cases\ncases",
    });
  });

  it("reads artifacts from a custom cfg.paths.qa override", async () => {
    mockGetProjectConfig.mockReturnValue({ paths: { qa: "custom/qa-out/" } });
    const slug = computeQaBranchSlug(BRANCH, root);
    writeArtifacts(join(root, "custom/qa-out", slug));
    const res = await runQaQuery({ projectId: "p1", taskId: "t1", executionRoot: root });
    expect(res.ok).toBe(true);
    const doneCall = mockUpdateTask.mock.calls.find((c) => c[1]?.qaStatus === "done");
    expect(doneCall?.[1].qaChangeSummary).toBe("# Change Summary\nstuff");
  });

  it("fails the run (ok:false, qaStatus error) when required artifacts are missing", async () => {
    const slug = computeQaBranchSlug(BRANCH, root);
    const dir = join(root, ".ai-factory/qa", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "change-summary.md"), "# only summary");
    // test-plan.md и test-cases.md намеренно отсутствуют
    const res = await runQaQuery({ projectId: "p1", taskId: "t1", executionRoot: root });
    expect(res.ok).toBe(false);
    // Конкретная ошибка называет каждый отсутствующий файл и только их.
    expect(res.error).toContain("test-plan.md");
    expect(res.error).toContain("test-cases.md");
    expect(res.error).not.toContain("change-summary.md");
    // Сохраняет статус ошибки и никогда не заявляет "done".
    expect(mockUpdateTask).toHaveBeenCalledWith("t1", { qaStatus: "error" });
    expect(mockUpdateTask.mock.calls.some((c) => c[1]?.qaStatus === "done")).toBe(false);
  });

  it("sets qaStatus error and returns ok:false when runtime throws", async () => {
    mockRunApiRuntimeOneShot.mockRejectedValue(new Error("boom"));
    const res = await runQaQuery({ projectId: "p1", taskId: "t1", executionRoot: root });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("boom");
    expect(mockUpdateTask).toHaveBeenCalledWith("t1", { qaStatus: "error" });
  });

  it("never throws when slug resolution fails on a stale executionRoot", async () => {
    // Несуществующий корень заставляет `git hash-object` в computeQaBranchSlug
    // (execFileSync с отсутствующим cwd) бросать синхронно — раньше этот бросок
    // вылетал до try-блока (например, удалённый worktree). Теперь он должен
    // ловиться, сохраняться как qaStatus:"error" и возвращаться как ok:false.
    const staleRoot = join(root, "deleted-worktree"); // никогда не создаётся → cwd отсутствует
    const res = await runQaQuery({ projectId: "p1", taskId: "t1", executionRoot: staleRoot });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(mockUpdateTask).toHaveBeenCalledWith("t1", { qaStatus: "error" });
    // Разрешение упало первым, поэтому runtime никогда не вызывается.
    expect(mockRunApiRuntimeOneShot).not.toHaveBeenCalled();
  });
});
