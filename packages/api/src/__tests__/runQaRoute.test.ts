import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { projects, tasks, resetEnvCache } from "@aif/shared";
import { createTestDb } from "@aif/data/db";

// QA-маршруты гейтятся флагом AIF_QA_PIPELINE_ENABLED (по умолчанию выключен). Включим его
// до импорта модуля маршрутов — schemas.ts вызывает getEnv() в момент определения
// схем, кэшируя разобранный env. Случай с выключенным флагом ниже возвращает его обратно.
process.env.AIF_QA_PIPELINE_ENABLED = "true";

const testDb = { current: createTestDb() };

vi.mock("@aif/data/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/data/db")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

vi.mock("../ws.js", () => ({
  broadcast: vi.fn(),
  setupWebSocket: vi.fn(() => ({ injectWebSocket: vi.fn(), upgradeWebSocket: vi.fn() })),
  getInjectWebSocket: vi.fn(),
}));

// Не даём fire-and-forget раннеру исполнять настоящий runtime.
const mockRunQaQuery = vi.fn();
vi.mock("../services/qaRunner.js", () => ({
  runQaQuery: (...args: unknown[]) => mockRunQaQuery(...args),
}));

const { tasksRouter } = await import("../routes/tasks.js");

function createApp() {
  const app = new Hono();
  app.route("/tasks", tasksRouter);
  return app;
}

function seedTask(overrides: Record<string, unknown> = {}) {
  const db = testDb.current;
  db.insert(projects).values({ id: "p1", name: "P1", rootPath: "/tmp/p1" }).run();
  db.insert(tasks)
    .values({
      id: "t1",
      projectId: "p1",
      title: "Task 1",
      branchName: "feature/foo",
      qaStatus: "idle",
      ...overrides,
    })
    .run();
}

describe("POST /tasks/:id/run-qa", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    testDb.current = createTestDb();
    app = createApp();
    mockRunQaQuery.mockReset();
    mockRunQaQuery.mockResolvedValue({ ok: true });
  });

  it("returns 404 when task not found", async () => {
    const res = await app.request("/tasks/missing/run-qa", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when project not found", async () => {
    testDb.current
      .insert(tasks)
      .values({ id: "t1", projectId: "ghost", title: "T", branchName: "feature/foo" })
      .run();
    const res = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when QA already running", async () => {
    seedTask({ qaStatus: "running" });
    const res = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(res.status).toBe(409);
    expect(mockRunQaQuery).not.toHaveBeenCalled();
  });

  it("serializes concurrent starts: a second POST gets 409 (atomic running claim)", async () => {
    seedTask(); // qaStatus idle
    const first = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(first.status).toBe(202);
    // Первый запрос синхронно захватил qaStatus:"running" через
    // compare-and-set; замокианный раннер никогда его не сбрасывает, имитируя
    // идущий прогон. Второй POST обязан проиграть захват и не запускать дублирующий прогон.
    const second = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(second.status).toBe(409);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRunQaQuery).toHaveBeenCalledTimes(1);
  });

  it("releases the running claim with qaStatus error when the dispatch throws", async () => {
    seedTask(); // qaStatus idle
    // runQaQuery по контракту никогда не бросает, но guard рассылки обязан
    // выдержать нарушение контракта (или упавший динамический импорт): сохранить
    // терминальный qaStatus, чтобы атомарный захват не залип на "running"
    // и не блокировал все будущие запуски QA для задачи.
    mockRunQaQuery.mockRejectedValue(new Error("dispatch boom"));
    const res = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    const row = testDb.current
      .select()
      .from(tasks)
      .all()
      .find((t) => t.id === "t1");
    expect(row?.qaStatus).toBe("error");
    // Слот освобождён — последующий ручной запуск может захватить его снова.
    mockRunQaQuery.mockResolvedValue({ ok: true });
    const retry = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(retry.status).toBe(202);
  });

  it("returns 202 for a branchless task (runner resolves the branch via git)", async () => {
    seedTask({ branchName: null });
    const res = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRunQaQuery).toHaveBeenCalledWith({
      projectId: "p1",
      taskId: "t1",
      executionRoot: "/tmp/p1",
    });
  });

  it("returns 202 and triggers the runner on a valid request", async () => {
    seedTask();
    const res = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(res.status).toBe(202);
    // Fire-and-forget: даём устояться асинхронному импорту и вызову.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRunQaQuery).toHaveBeenCalledWith({
      projectId: "p1",
      taskId: "t1",
      executionRoot: "/tmp/p1",
    });
  });

  it("uses worktreePath as executionRoot when present", async () => {
    seedTask({ worktreePath: "/tmp/wt/t1" });
    const res = await app.request("/tasks/t1/run-qa", { method: "POST" });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRunQaQuery).toHaveBeenCalledWith({
      projectId: "p1",
      taskId: "t1",
      executionRoot: "/tmp/wt/t1",
    });
  });

  it("returns 403 with feature_disabled when AIF_QA_PIPELINE_ENABLED is off", async () => {
    seedTask();
    process.env.AIF_QA_PIPELINE_ENABLED = "false";
    resetEnvCache();
    try {
      const res = await app.request("/tasks/t1/run-qa", { method: "POST" });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("feature_disabled");
      expect(mockRunQaQuery).not.toHaveBeenCalled();
    } finally {
      process.env.AIF_QA_PIPELINE_ENABLED = "true";
      resetEnvCache();
    }
  });
});
