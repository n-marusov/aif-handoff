/**
 * Контрактный сьют для MCP-инструментов (`src/tools/*.ts`).
 *
 * Цель — зафиксировать наблюдаемое поведение девяти инструментов через их
 * публичные хендлеры (реальную регистрацию), не зависящее от внутренней
 * реализации `@aif/data`. Хендлеры вызываются через фейковый MCP-сервер,
 * который перехватывает колбэк `registerTool` и позволяет тесту дёрнуть
 * обработчик как чистую функцию.
 *
 * Особое внимание — правилам, которые сейчас дублируют API-поведение
 * (план Task 8): отказ ownership-полей в generic-обновлении и валидация
 * runtime-profile перед записью.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { projects } from "@aif/shared";
import { createTestDb } from "@aif/data/db";
import { RateLimiter } from "../middleware/rateLimit.js";
import type { ToolContext } from "../tools/index.js";
import { register as registerCreateTask } from "../tools/createTask.js";
import { register as registerUpdateTask } from "../tools/updateTask.js";
import { register as registerSyncStatus } from "../tools/syncStatus.js";
import { register as registerPushPlan } from "../tools/pushPlan.js";
import { register as registerAnnotatePlan } from "../tools/annotatePlan.js";
import { register as registerGetTask } from "../tools/getTask.js";
import { register as registerListTasks } from "../tools/listTasks.js";
import { register as registerSearchTasks } from "../tools/searchTasks.js";
import { register as registerListProjects } from "../tools/listProjects.js";

const testDb = { current: createTestDb() };
vi.mock("@aif/data/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/data/db")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

const { createTask, createRuntimeProfile, findTaskById } = await import("@aif/data");

type ToolCallback = (args: unknown) => Promise<unknown> | unknown;

interface CapturedTool {
  name: string;
  description: string;
  callback: ToolCallback;
}

class FakeMcpServer {
  readonly tools = new Map<string, CapturedTool>();

  registerTool(name: string, config: { description?: string }, callback: ToolCallback): void {
    this.tools.set(name, { name, description: config.description ?? "", callback });
  }
}

const testDbModule = testDb;

function seedProject(id = "proj-1"): void {
  testDbModule.current
    .insert(projects)
    .values({ id, name: `Project ${id}`, rootPath: "/tmp/test" })
    .run();
}

function makeContext(): ToolContext {
  // Достаточно вместительная корзина: контрактные тесты не должны упираться
  // в лимит частоты, он покрывается отдельным юнит-сьютом rateLimit.
  const limiter = new RateLimiter({ rpm: 10_000, burst: 10_000 }, { rpm: 10_000, burst: 10_000 });
  return { rateLimiter: limiter };
}

function registerAll(server: FakeMcpServer, context: ToolContext): void {
  // Read-only
  registerListTasks(server as never, context);
  registerGetTask(server as never, context);
  registerSearchTasks(server as never, context);
  registerListProjects(server as never, context);
  // Write
  registerCreateTask(server as never, context);
  registerUpdateTask(server as never, context);
  registerSyncStatus(server as never, context);
  registerPushPlan(server as never, context);
  registerAnnotatePlan(server as never, context);
}

async function parseToolText(result: unknown): Promise<Record<string, unknown>> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const text = content[0]?.text ?? "";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("MCP tools contract", () => {
  let server: FakeMcpServer;
  let context: ToolContext;

  beforeEach(() => {
    testDbModule.current = createTestDb();
    seedProject();
    server = new FakeMcpServer();
    context = makeContext();
    registerAll(server, context);
  });

  it("registers exactly the nine public tool names", () => {
    expect([...server.tools.keys()].sort()).toEqual(
      [
        "handoff_annotate_plan",
        "handoff_create_task",
        "handoff_get_task",
        "handoff_list_projects",
        "handoff_list_tasks",
        "handoff_push_plan",
        "handoff_search_tasks",
        "handoff_sync_status",
        "handoff_update_task",
      ].sort(),
    );
  });

  it("handoff_create_task creates a task and returns a compact response", async () => {
    const create = server.tools.get("handoff_create_task")!;
    const result = await create.callback({
      projectId: "proj-1",
      title: "Contract task",
      description: "Desc",
      priority: 2,
      tags: ["alpha"],
    });
    const body = await parseToolText(result);
    expect((body as { title: string }).title).toBe("Contract task");
    expect((body as { executionOwner: string }).executionOwner).toBe("ai");
    expect(body).not.toHaveProperty("password");
    expect(body).not.toHaveProperty("plan");
  });

  it("handoff_create_task rejects unknown projects with a validation error", async () => {
    const create = server.tools.get("handoff_create_task")!;
    await expect(
      create.callback({ projectId: "missing-0000-0000", title: "Nope", description: "" }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("handoff_create_task rejects a cross-project runtime profile", async () => {
    seedProject("proj-2");
    const profile = createRuntimeProfile({
      projectId: "proj-2",
      name: "Other project runtime",
      runtimeId: "claude",
      providerId: "anthropic",
      enabled: true,
    });
    const create = server.tools.get("handoff_create_task")!;
    await expect(
      create.callback({
        projectId: "proj-1",
        title: "Cross",
        description: "",
        runtimeProfileId: profile!.id,
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("handoff_update_task rejects ownership fields (duplicate API rule)", async () => {
    const task = createTask({ projectId: "proj-1", title: "Own", description: "D" });
    const update = server.tools.get("handoff_update_task")!;
    await expect(
      update.callback({
        taskId: task!.id,
        executionOwner: "human",
        ownershipRevision: 1,
      }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("Task ownership cannot be changed"),
    });
  });

  it("handoff_update_task updates a task and reports the changed fields", async () => {
    const task = createTask({ projectId: "proj-1", title: "Old title", description: "D" });
    const update = server.tools.get("handoff_update_task")!;
    const result = await update.callback({ taskId: task!.id, title: "New title", priority: 3 });
    const body = await parseToolText(result);
    expect((body as { title: string }).title).toBe("New title");
  });

  it("handoff_update_task rejects missing tasks", async () => {
    const update = server.tools.get("handoff_update_task")!;
    await expect(
      update.callback({ taskId: "missing-0000-0000-0000", title: "Nope" }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("handoff_sync_status applies a newer status change", async () => {
    const task = createTask({ projectId: "proj-1", title: "Sync", description: "D" });
    const sync = server.tools.get("handoff_sync_status")!;
    const result = await sync.callback({
      taskId: task!.id,
      newStatus: "planning",
      sourceTimestamp: new Date(Date.now() + 60_000).toISOString(),
      direction: "aif_to_handoff",
    });
    const body = await parseToolText(result);
    expect(body.applied).toBe(true);
    expect(findTaskById(task!.id)?.status).toBe("planning");
  });

  it("handoff_sync_status refuses to overwrite terminal done/accepted", async () => {
    const task = createTask({ projectId: "proj-1", title: "Done", description: "D" });
    const { transitionTaskStatus } = await import("@aif/data");
    const transition = transitionTaskStatus({
      taskId: task!.id,
      status: "done",
      expectedStatus: task!.status,
      actor: { kind: "system", id: null, displayNameSnapshot: "test" } as never,
    });
    expect(transition.ok).toBe(true);
    const sync = server.tools.get("handoff_sync_status")!;
    const result = await sync.callback({
      taskId: task!.id,
      newStatus: "planning",
      sourceTimestamp: new Date(Date.now() + 60_000).toISOString(),
      direction: "aif_to_handoff",
    });
    const body = await parseToolText(result);
    expect(body.applied).toBe(false);
    expect(String(body.reason)).toContain("terminal status");
  });

  it("handoff_push_plan stores the plan and returns annotations", async () => {
    const task = createTask({ projectId: "proj-1", title: "Plan", description: "D" });
    const push = server.tools.get("handoff_push_plan")!;
    const result = await push.callback({
      taskId: task!.id,
      planContent: "## Plan\n- [ ] Step one",
    });
    const body = await parseToolText(result);
    expect((body.task as { hasPlan: boolean }).hasPlan).toBe(true);
    expect(findTaskById(task!.id)?.plan).toContain("Step one");
  });

  it("handoff_annotate_plan inserts a task annotation into markdown", async () => {
    const task = createTask({ projectId: "proj-1", title: "Annotate", description: "D" });
    const annotate = server.tools.get("handoff_annotate_plan")!;
    const result = await annotate.callback({
      taskId: task!.id,
      planContent: "## Plan\n- [ ] Step",
    });
    const body = await parseToolText(result);
    expect(String(body.annotatedPlan)).toContain("<!-- handoff:task:");
    expect(Array.isArray(body.annotations)).toBe(true);
  });

  it("handoff_get_task returns requested fields with id always included", async () => {
    const task = createTask({ projectId: "proj-1", title: "Fetch", description: "D" });
    const get = server.tools.get("handoff_get_task")!;
    const result = await get.callback({ taskId: task!.id, fields: ["title"] });
    const body = await parseToolText(result);
    expect(body.id).toBe(task!.id);
    expect(body.title).toBe("Fetch");
    expect(body).not.toHaveProperty("description");
  });

  it("handoff_get_task reports not-found via isError payload", async () => {
    const get = server.tools.get("handoff_get_task")!;
    const result = (await get.callback({
      taskId: "missing-0000-0000-0000-0000",
    })) as { isError: boolean };
    expect(result.isError).toBe(true);
  });

  it("handoff_list_tasks returns summary items without heavy fields", async () => {
    createTask({ projectId: "proj-1", title: "A", description: "D" });
    createTask({ projectId: "proj-1", title: "B", description: "D" });
    const list = server.tools.get("handoff_list_tasks")!;
    const result = await list.callback({ limit: 10 });
    const body = await parseToolText(result);
    const items = body.items as Array<Record<string, unknown>>;
    expect(body.total).toBe(2);
    expect(items[0]).not.toHaveProperty("plan");
    expect(items[0]).not.toHaveProperty("implementationLog");
  });

  it("handoff_list_projects returns the seeded projects", async () => {
    const list = server.tools.get("handoff_list_projects")!;
    const result = await list.callback({});
    const body = await parseToolText(result);
    expect(Array.isArray(body)).toBe(true);
    expect((body as Array<{ id: string }>).map((p) => p.id)).toContain("proj-1");
  });
});
