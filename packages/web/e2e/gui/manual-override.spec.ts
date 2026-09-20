import { expect, test } from "@playwright/test";
import { API_URL, createTaskViaApi, deleteTaskViaApi, openProjectBoard, runId } from "./common";

// UC-pipeline.manual-override.intervene-task-stage: пользователь вручную переводит задачу (основной источник).
// HF1.7: ручное управление движением (контекст).
// BR-trigger.*: действия стадий — внешний oracle (контекст).
// contract-aif-rest-api: POST /tasks/:id/events (контекст).
test("L-03: кнопка Start AI переводит задачу Backlog → Planning", async ({ page, request }) => {
  const suffix = runId();
  const title = `e2e-manual-${suffix}`;
  const task = await createTaskViaApi(request, {
    title,
    autoMode: false,
    paused: true,
    planPath: `.e2e/plans/l-03-${suffix}.md`,
    skipReview: true,
  });

  try {
    await openProjectBoard(page);

    // Задача в Backlog до действия.
    await expect(page.getByText(title, { exact: true })).toBeVisible();

    // Открываем детали и нажимаем Start AI.
    await page.getByText(title, { exact: true }).click();
    await page.getByRole("button", { name: "Start AI", exact: true }).click();

    // Диалог подтверждения плана не появляется: файл плана отсутствует,
    // поэтому переход применяется сразу и детали закрываются.
    // Проверяем отсутствие модалки «Plan file already exists».
    await expect(page.getByRole("heading", { name: "Plan file already exists" })).toBeHidden();

    // Oracle: задача переведена на стадию planning.
    await expect
      .poll(async () => {
        const oracle = await request.get(`${API_URL}/tasks/${task.id}`);
        if (!oracle.ok()) return "error";
        const row = (await oracle.json()) as { status: string };
        return row.status;
      })
      .toBe("planning");

    // Детали закрываются после start_ai (URL без /task/<id>).
    await expect.poll(async () => page.url()).not.toContain(`/task/${task.id}`);

    // Карточка покинула Backlog и появилась в колонке Planning.
    const backlogHeading = page.getByRole("heading", { name: "Backlog", exact: true });
    const planningHeading = page.getByRole("heading", { name: "Planning", exact: true });
    await expect(backlogHeading).toBeVisible();
    await expect(planningHeading).toBeVisible();

    // Проверяем перемещение по позиции: карточка теперь внутри Planning.
    const card = page.getByText(title, { exact: true });
    await expect(card).toBeVisible();
    const cardBox = await card.boundingBox();
    const backlogBox = await backlogHeading.boundingBox();
    const planningBox = await planningHeading.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(backlogBox).not.toBeNull();
    expect(planningBox).not.toBeNull();
    // Карточка ближе к заголовку Planning, чем к Backlog (по X-координате).
    expect(Math.abs(cardBox!.x - planningBox!.x)).toBeLessThan(
      Math.abs(cardBox!.x - backlogBox!.x),
    );
  } finally {
    await deleteTaskViaApi(request, task.id);
  }
});

// UC-pipeline.manual-override.intervene-task-stage: действие не разрешено для текущего статуса (negative).
// HF1.7: ручное управление движением (контекст).
// BR-trigger.*: state machine отклоняет недопустимый переход (контекст).
test("L-03b: start_ai отклоняется для задачи не в backlog (negative)", async ({ request }) => {
  const suffix = runId();
  const task = await createTaskViaApi(request, {
    title: `e2e-manual-negative-${suffix}`,
    autoMode: false,
    paused: true,
  });

  try {
    // Переводим задачу в planning через API (легитимный переход).
    const first = await request.post(`${API_URL}/tasks/${task.id}/events`, {
      data: { event: "start_ai" },
    });
    expect(first.ok()).toBe(true);

    // Повторный start_ai недопустим: state machine возвращает отказ.
    const second = await request.post(`${API_URL}/tasks/${task.id}/events`, {
      data: { event: "start_ai" },
    });
    expect(second.ok()).toBe(false);
  } finally {
    await deleteTaskViaApi(request, task.id);
  }
});
