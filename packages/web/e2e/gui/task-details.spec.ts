import { expect, test } from "@playwright/test";
import { API_URL, createTaskViaApi, deleteTaskViaApi, openProjectBoard, runId } from "./common";

// UC-dashboard.detail.view-task-details: пользователь открывает детальный просмотр задачи (основной источник).
// HF2.3: детали изменения (контекст).
// contract-aif-rest-api: GET /tasks/:id, POST /tasks/:id/comments — внешний oracle (контекст).
// KI: «E2E GUI: в UI нет композера комментариев» — лента проверяется через API-созданный комментарий (контекст).
test("L-02: открывает детали задачи и видит секции", async ({ page, request }) => {
  const suffix = runId();
  const title = `e2e-detail-${suffix}`;
  const description = `E2E GUI detail fixture ${suffix}`;
  const task = await createTaskViaApi(request, {
    title,
    description,
    autoMode: false,
    paused: true,
    priority: 1,
  });

  try {
    await openProjectBoard(page);

    // Пользовательский путь: клик по карточке открывает slide-over деталей.
    await page.getByText(title, { exact: true }).click();

    // Описание, заголовок и статус в шапке. Карточка тоже показывает описание
    // (line-clamp), поэтому берём элемент внутри слайд-овера (.last() — портал в конце body).
    await expect(page.getByText(description, { exact: true }).last()).toBeVisible();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    // Постоянные секции деталей.
    await expect(page.getByText("Description", { exact: true })).toBeVisible();
    await expect(page.getByText("Plan", { exact: true })).toBeVisible();
    // Бейдж токенов отображается (in/out/total) — у свежей задачи нули.
    await expect(page.getByText("in: 0", { exact: true })).toBeVisible();

    // Oracle: статус/владелец согласованы между UI и API.
    const oracle = await request.get(`${API_URL}/tasks/${task.id}`);
    expect(oracle.ok()).toBe(true);
    const row = (await oracle.json()) as { status: string; executionOwner: string };
    // Слайд-овер показывает бейдж владельца AI owner (legacy-контекст: canHandoff=true).
    // Бейдж есть и на карточке доски, поэтому берём последний элемент (портал слайд-овера).
    await expect(page.getByText("AI owner", { exact: true }).last()).toBeVisible();
    expect(row.status).toBe("backlog");
    expect(row.executionOwner).toBe("ai");
  } finally {
    await deleteTaskViaApi(request, task.id);
  }
});

// UC-dashboard.detail.view-task-details: комментарий сохраняется и отображается в ленте (основной источник).
// HF2.3: детали изменения (контекст).
// contract-aif-rest-api: POST /tasks/:id/comments, GET /tasks/:id/comments (контекст).
// KI: композер комментариев отсутствует — комментарий создаётся через реальный API (контекст).
test("L-02b: лента комментариев отображает комментарий из API (oracle)", async ({
  page,
  request,
}) => {
  const suffix = runId();
  const title = `e2e-detail-comments-${suffix}`;
  const message = `e2e-comment-${suffix}`;
  const task = await createTaskViaApi(request, {
    title,
    autoMode: false,
    paused: true,
  });

  // Комментарий создаётся через реальный API (agent-путь) — инвариант ленты.
  const commentResponse = await request.post(`${API_URL}/tasks/${task.id}/comments`, {
    data: { message, attachments: [] },
  });
  expect(commentResponse.status()).toBe(201);

  try {
    await openProjectBoard(page);
    await page.getByText(title, { exact: true }).click();

    // Вкладка Comments показывает созданный комментарий.
    await page.getByRole("tab", { name: "Comments" }).click();
    await expect(page.getByText(message, { exact: true })).toBeVisible();

    // Negative assertion: посторонний текст не присутствует.
    await expect(page.getByText(`e2e-comment-absent-${suffix}`, { exact: true })).toBeHidden();

    // Oracle: комментарий присутствует в API.
    const comments = await request.get(`${API_URL}/tasks/${task.id}/comments`);
    expect(comments.ok()).toBe(true);
    const list = (await comments.json()) as Array<{ message: string }>;
    expect(list.some((comment) => comment.message === message)).toBe(true);
  } finally {
    await deleteTaskViaApi(request, task.id);
  }
});
