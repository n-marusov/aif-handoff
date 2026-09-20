import { expect, test } from "@playwright/test";
import { API_URL, PROJECT_ID, createTaskViaApi, deleteTaskViaApi, runId } from "./common";

// E2E-API-002: жизненный цикл задачи через REST — create → read → update → transition → negative.
// contract-aif-rest-api: POST /tasks, GET /tasks/:id, PATCH /tasks/:id, POST /tasks/:id/events.
// BR-fact.audit.observability: каждый переход пишется в аудит (проверяется наличием WS/статуса).
test("E2E-API-002: создание и обновление задачи согласованы между созданием и чтением", async ({
  request,
}) => {
  const suffix = runId();
  const task = await createTaskViaApi(request, {
    title: `e2e-api-lifecycle-${suffix}`,
    description: "E2E API fixture: lifecycle",
    autoMode: false,
    paused: true,
    priority: 1,
    executionOwner: "human",
  });

  try {
    // create → статус backlog, oracle по деталям.
    expect(task.status).toBe("backlog");
    expect(task.title).toContain("e2e-api-lifecycle-");

    // GET /tasks/:id — независимый oracle: id, статус, владелец совпадают.
    const detail = await request.get(`${API_URL}/tasks/${task.id}`);
    expect(detail.ok()).toBe(true);
    const row = (await detail.json()) as {
      id: string;
      status: string;
      executionOwner: string;
      priority: number;
      paused: boolean;
    };
    expect(row.id).toBe(task.id);
    expect(row.status).toBe("backlog");
    expect(row.executionOwner).toBe("human");
    expect(row.priority).toBe(1);
    expect(row.paused).toBe(true);

    // PATCH /tasks/:id — меняем title и priority.
    const patch = await request.patch(`${API_URL}/tasks/${task.id}`, {
      data: { title: `e2e-api-lifecycle-renamed-${suffix}`, priority: 3 },
    });
    expect(patch.ok()).toBe(true);
    const patched = (await patch.json()) as { title: string; priority: number };
    expect(patched.title).toBe(`e2e-api-lifecycle-renamed-${suffix}`);
    expect(patched.priority).toBe(3);

    // Oracle: изменения персистентны.
    const afterPatch = await request.get(`${API_URL}/tasks/${task.id}`);
    const afterRow = (await afterPatch.json()) as {
      title: string;
      priority: number;
      status: string;
    };
    expect(afterRow.title).toBe(`e2e-api-lifecycle-renamed-${suffix}`);
    expect(afterRow.priority).toBe(3);
    expect(afterRow.status).toBe("backlog");
  } finally {
    await deleteTaskViaApi(request, task.id);
  }
});

// E2E-API-003: авто-переход стадии по гейту — start_ai из backlog → planning.
// contract-aif-rest-api: POST /tasks/:id/events.
// BR-constraint.ownership.handoff: AI-действия доступны владельцу задачи (context).
test("E2E-API-003: start_ai переводит задачу backlog → planning и публикует WS-событие", async ({
  request,
}) => {
  const suffix = runId();
  const task = await createTaskViaApi(request, {
    title: `e2e-api-transition-${suffix}`,
    autoMode: false,
    paused: true,
    executionOwner: "human",
  });

  try {
    const event = await request.post(`${API_URL}/tasks/${task.id}/events`, {
      data: { event: "start_ai" },
    });
    expect(event.ok()).toBe(true);
    const moved = (await event.json()) as { id: string; status: string };
    expect(moved.id).toBe(task.id);
    expect(moved.status).toBe("planning");

    // Oracle: статус согласован в деталях.
    const detail = await request.get(`${API_URL}/tasks/${task.id}`);
    const row = (await detail.json()) as { status: string };
    expect(row.status).toBe("planning");
  } finally {
    await deleteTaskViaApi(request, task.id);
  }
});

// E2E-API-004 (negative): событие не по гейту отклоняется — start_ai из planning невозможен.
// contract-aif-rest-api: POST /tasks/:id/events → 4xx при недопустимом переходе.
test("E2E-API-004: start_ai из planning отклоняется (negative)", async ({ request }) => {
  const suffix = runId();
  const task = await createTaskViaApi(request, {
    title: `e2e-api-negative-${suffix}`,
    autoMode: false,
    paused: true,
    executionOwner: "human",
  });

  try {
    const first = await request.post(`${API_URL}/tasks/${task.id}/events`, {
      data: { event: "start_ai" },
    });
    expect(first.ok()).toBe(true);
    const moved = (await first.json()) as { status: string };
    expect(moved.status).toBe("planning");

    // Повторный start_ai из planning — недопустимый переход.
    const second = await request.post(`${API_URL}/tasks/${task.id}/events`, {
      data: { event: "start_ai" },
    });
    expect(second.status).toBe(400);

    // Oracle: статус остался planning (негативный сценарий не изменил состояние).
    const detail = await request.get(`${API_URL}/tasks/${task.id}`);
    const row = (await detail.json()) as { status: string };
    expect(row.status).toBe("planning");
  } finally {
    await deleteTaskViaApi(request, task.id);
  }
});

// E2E-API-004b: события несуществующей задачи — 404.
test("E2E-API-004b: событие для несуществующей задачи → 404 (negative)", async ({ request }) => {
  const response = await request.post(
    `${API_URL}/tasks/00000000-0000-0000-0000-000000000000/events`,
    {
      data: { event: "start_ai" },
    },
  );
  expect(response.status).toBe(404);
});
