import { expect, test } from "@playwright/test";
import { API_URL, createTaskViaApi, deleteTaskViaApi, openProjectBoard, runId } from "./common";

// UC-handoff.transfer.ownership-to-executor: пользователь передаёт владение задачей (основной источник).
// HF7.1: роли, handoff и эскалация (контекст).
// BR-constraint.ownership.handoff: передача с ownershipRevision (контекст).
// contract-aif-rest-api: POST /tasks/:id/handoff — внешний oracle (контекст).
test("L-04: handoff AI → Human через диалог Assign / hand off", async ({ page, request }) => {
  const suffix = runId();
  const title = `e2e-handoff-${suffix}`;
  const reason = `e2e-handoff-reason-${suffix}`;
  const task = await createTaskViaApi(request, {
    title,
    autoMode: false,
    paused: true,
    executionOwner: "ai",
  });

  try {
    await openProjectBoard(page);
    await page.getByText(title, { exact: true }).click();

    // Кнопка доступна (legacy-контекст: participants выключен → canHandoff=true).
    await page.getByRole("button", { name: "Assign / hand off", exact: true }).click();

    // Диалог передачи владения.
    const dialog = page.getByRole("heading", { name: "Assign or hand off task" });
    await expect(dialog).toBeVisible();

    // Выбираем Human-владельца; assignees пусты (участники выключены).
    await page.getByText("Human", { exact: true }).click();
    await page.getByLabel("Reason (optional)").fill(reason);
    await page.getByRole("button", { name: "Save ownership", exact: true }).click();

    // Диалог закрывается, владелец в UI — Human owner.
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Human owner", { exact: true }).first()).toBeVisible();

    // Oracle: владение изменено через API с инкрементом ревизии.
    await expect
      .poll(async () => {
        const oracle = await request.get(`${API_URL}/tasks/${task.id}`);
        if (!oracle.ok()) return null;
        const row = (await oracle.json()) as {
          executionOwner: string;
          ownershipRevision: number;
        };
        return `${row.executionOwner}:${row.ownershipRevision}`;
      })
      .toBe("human:1");

    // История исполнителей содержит запись handoff с причиной.
    await page.getByRole("tab", { name: "Executors" }).click();
    await expect(page.getByText(reason, { exact: true })).toBeVisible();
    await expect(page.getByText("Human owner", { exact: true }).first()).toBeVisible();
  } finally {
    await deleteTaskViaApi(request, task.id);
  }
});

// UC-handoff.transfer.ownership-to-executor: конфликт ревизии отклоняется (negative).
// HF7.1: роли, handoff и эскалация (контекст).
// BR-constraint.ownership.handoff: optimistic concurrency (контекст).
test("L-04b: handoff с устаревшей ревизией отклоняется (409, negative)", async ({ request }) => {
  const suffix = runId();
  const task = await createTaskViaApi(request, {
    title: `e2e-handoff-conflict-${suffix}`,
    autoMode: false,
    paused: true,
    executionOwner: "ai",
  });

  try {
    // Устаревшая ревизия: текущая 0, ожидаемая 5.
    const response = await request.post(`${API_URL}/tasks/${task.id}/handoff`, {
      data: {
        executionOwner: "human",
        assigneeIds: [],
        expectedOwnershipRevision: 5,
        expectedExecutionOwner: "ai",
        expectedStatus: "backlog",
      },
    });
    expect(response.ok()).toBe(false);

    // Владение не изменилось.
    const oracle = await request.get(`${API_URL}/tasks/${task.id}`);
    const row = (await oracle.json()) as { executionOwner: string; ownershipRevision: number };
    expect(row.executionOwner).toBe("ai");
    expect(row.ownershipRevision).toBe(0);
  } finally {
    await deleteTaskViaApi(request, task.id);
  }
});
