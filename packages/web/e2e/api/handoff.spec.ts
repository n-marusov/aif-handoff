import { expect, test } from "@playwright/test";
import { API_URL, createTaskViaApi, deleteTaskViaApi, runId } from "./common";

// E2E-API-005: handoff AI → Human через POST /tasks/:id/handoff.
// contract-aif-rest-api: POST /tasks/:id/handoff.
// BR-fact.ownership.handoff: handoff переключает владельца атомарно (context).
test("E2E-API-005: handoff исполняет передачу владения A→H и фиксирует ревизию", async ({
  request,
}) => {
  const suffix = runId();
  const task = await createTaskViaApi(request, {
    title: `e2e-api-handoff-${suffix}`,
    autoMode: false,
    paused: true,
    executionOwner: "ai",
  });

  try {
    // Текущая ревизия владения (0 для свежей задачи).
    const before = await request.get(`${API_URL}/tasks/${task.id}`);
    const beforeRow = (await before.json()) as {
      ownershipRevision: number;
      executionOwner: string;
    };
    expect(beforeRow.executionOwner).toBe("ai");

    const handoff = await request.post(`${API_URL}/tasks/${task.id}/handoff`, {
      data: {
        executionOwner: "human",
        expectedOwnershipRevision: beforeRow.ownershipRevision,
        assigneeIds: [],
      },
    });
    expect(handoff.ok()).toBe(true);
    const body = (await handoff.json()) as {
      task: { id: string; status: string };
      ownership: { executionOwner: string; ownershipRevision: number };
    };
    expect(body.ownership.executionOwner).toBe("human");
    expect(body.ownership.ownershipRevision).toBe(beforeRow.ownershipRevision + 1);
    expect(body.task.id).toBe(task.id);

    // Oracle по деталям.
    const detail = await request.get(`${API_URL}/tasks/${task.id}`);
    const row = (await detail.json()) as { executionOwner: string; ownershipRevision: number };
    expect(row.executionOwner).toBe("human");
    expect(row.ownershipRevision).toBe(beforeRow.ownershipRevision + 1);
  } finally {
    await deleteTaskViaApi(request, task.id);
  }
});

// E2E-API-005b (negative): handoff с устаревшей ревизией отклоняется (409).
// BR-fact.ownership.handoff: конкурентная передача с устаревшей ревизией невозможна.
test("E2E-API-005b: handoff с устаревшей ревизией отклоняется 409 (negative)", async ({
  request,
}) => {
  const suffix = runId();
  const task = await createTaskViaApi(request, {
    title: `e2e-api-handoff-stale-${suffix}`,
    autoMode: false,
    paused: true,
    executionOwner: "ai",
  });

  try {
    const before = await request.get(`${API_URL}/tasks/${task.id}`);
    const beforeRow = (await before.json()) as { ownershipRevision: number };

    // Первый успешный handoff сдвигает ревизию.
    const first = await request.post(`${API_URL}/tasks/${task.id}/handoff`, {
      data: {
        executionOwner: "human",
        expectedOwnershipRevision: beforeRow.ownershipRevision,
        assigneeIds: [],
      },
    });
    expect(first.ok()).toBe(true);

    // Повтор с той же (уже устаревшей) ревизией → 409.
    const stale = await request.post(`${API_URL}/tasks/${task.id}/handoff`, {
      data: {
        executionOwner: "ai",
        expectedOwnershipRevision: beforeRow.ownershipRevision,
        assigneeIds: [],
      },
    });
    expect(stale.status()).toBe(409);

    // Oracle: владелец остался human.
    const detail = await request.get(`${API_URL}/tasks/${task.id}`);
    const row = (await detail.json()) as { executionOwner: string };
    expect(row.executionOwner).toBe("human");
  } finally {
    await deleteTaskViaApi(request, task.id);
  }
});
