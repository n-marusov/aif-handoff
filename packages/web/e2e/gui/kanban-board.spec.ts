import { expect, test } from "@playwright/test";
import {
  API_URL,
  PROJECT_ID,
  STATUS_COLUMN_LABELS,
  createTaskViaApi,
  deleteTaskViaApi,
  openProjectBoard,
  runId,
} from "./common";

// UC-dashboard.board.view-kanban-columns: пользователь видит колонки Kanban (основной источник).
// HF2.1: просмотр изменений по стадиям (контекст).
// BR-fact.audit.observability: статусы согласованы с аудитом (контекст).
// contract-aif-rest-api: GET /tasks?projectId=X — внешний oracle (контекст).
test("L-01: отображает колонки Kanban и карточку задачи из API", async ({ page, request }) => {
  const suffix = runId();
  const task = await createTaskViaApi(request, {
    title: `e2e-kanban-view-${suffix}`,
    description: "E2E GUI fixture for the kanban board view",
    autoMode: false,
    paused: true,
    priority: 2,
  });

  try {
    await openProjectBoard(page);

    // Все 11 колонок стадий присутствуют с подписями из STATUS_CONFIG.
    for (const label of STATUS_COLUMN_LABELS) {
      await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
    }

    // Фикстура создана через реальный API (oracle) со статусом backlog.
    expect(task.status).toBe("backlog");

    // Карточка появляется в колонке Backlog после инвалидации кеша.
    await expect(page.getByText(task.title, { exact: true })).toBeVisible();

    // Приоритет задачи отображается на карточке бейджем (Medium для priority=2).
    const card = page
      .getByText(task.title, { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'cursor-pointer')][1]");
    await expect(card.getByText("Medium", { exact: true })).toBeVisible();

    // Счётчик колонки Backlog не меньше 1 (фикстура видима).
    const backlogCount = await page
      .getByRole("heading", { name: "Backlog", exact: true })
      .locator("xpath=..")
      .locator("span")
      .last()
      .innerText();
    expect(Number.parseInt(backlogCount, 10)).toBeGreaterThanOrEqual(1);

    // Oracle по REST: задача остаётся backlog (координатор не трогает paused).
    const oracle = await request.get(`${API_URL}/tasks/${task.id}`);
    expect(oracle.ok()).toBe(true);
    const row = (await oracle.json()) as { status: string; paused: boolean };
    expect(row.status).toBe("backlog");
    expect(row.paused).toBe(true);
  } finally {
    await deleteTaskViaApi(request, task.id);
  }
});

// UC-dashboard.board.view-kanban-columns: фильтр задач (контекст US-сценария "Пользователь фильтрует задачи").
// HF2.1: просмотр изменений по стадиям (контекст).
test("L-01b: фильтр AI-owned оставляет только AI-owned карточки", async ({ page, request }) => {
  const suffix = runId();
  const aiTask = await createTaskViaApi(request, {
    title: `e2e-kanban-filter-ai-${suffix}`,
    autoMode: false,
    paused: true,
    executionOwner: "ai",
  });
  const humanTask = await createTaskViaApi(request, {
    title: `e2e-kanban-filter-human-${suffix}`,
    autoMode: false,
    paused: true,
    executionOwner: "human",
  });

  try {
    await openProjectBoard(page);
    await expect(page.getByText(aiTask.title, { exact: true })).toBeVisible();
    await expect(page.getByText(humanTask.title, { exact: true })).toBeVisible();

    // Включаем фильтр «AI-owned».
    await page.getByRole("button", { name: "AI-owned", exact: true }).click();
    await expect(page.getByRole("button", { name: "AI-owned", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // AI-owned задача осталась, human-задача скрыта.
    await expect(page.getByText(aiTask.title, { exact: true })).toBeVisible();
    await expect(page.getByText(humanTask.title, { exact: true })).toBeHidden();

    // Снимаем фильтр — обе задачи снова на доске (negative assertion для фильтра).
    await page.getByRole("button", { name: "clear filters" }).click();
    await expect(page.getByText(humanTask.title, { exact: true })).toBeVisible();
  } finally {
    await deleteTaskViaApi(request, aiTask.id);
    await deleteTaskViaApi(request, humanTask.id);
  }
});

// UC-dashboard.board.view-kanban-columns: отрицательный сценарий — колонка не содержит мусора.
// HF2.1: просмотр изменений по стадиям (контекст).
test("L-01c: несуществующая задача не отображается на доске (negative)", async ({ page }) => {
  await openProjectBoard(page);
  await expect(page.getByText(`e2e-does-not-exist-${runId()}`, { exact: true })).toBeHidden();
});

// Прямой доступ к API стенда: health-check перед прогоном (диагностика окружения).
test("L-01d: API стенда отвечает на health-check", async ({ request }) => {
  const response = await request.get(`${API_URL}/health`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { status: string };
  expect(body.status).toBe("ok");
});

// US-dashboard.board.view-kanban-columns: пользователь меняет порядок задач в колонке (основной источник).
// HF2.1: просмотр изменений по стадиям (контекст).
// contract-aif-rest-api: PATCH /tasks/:id/position, GET /tasks?projectId=X — внешний oracle (контекст).
// Примечание: реордеринг реализован кнопками «Move task up/down» (useReorderTask),
// а не drag&-drop; различие зафиксировано в docs/known-issues.md (Task 8).
test("L-01e: реордеринг карточки в Backlog меняет position и сохраняется после reload", async ({
  page,
  request,
}) => {
  const suffix = runId();
  const first = await createTaskViaApi(request, {
    title: `e2e-reorder-first-${suffix}`,
    autoMode: false,
    paused: true,
  });
  const second = await createTaskViaApi(request, {
    title: `e2e-reorder-second-${suffix}`,
    autoMode: false,
    paused: true,
  });

  try {
    // Текущий максимум position в backlog (общий стенд может содержать другие задачи).
    const beforeTasks = (await (
      await request.get(`${API_URL}/tasks?projectId=${PROJECT_ID}`)
    ).json()) as Array<{ id: string; status: string; position: number }>;
    const maxPosition = Math.max(
      0,
      ...beforeTasks.filter((row) => row.status === "backlog").map((row) => row.position),
    );

    // Размещаем пару выше всех существующих: first выше, second ниже.
    // Гарантия: при клике «Move task up» на second новый position всегда
    // оказывается меньше first (midpoint с соседом сверху или first-100),
    // независимо от остальных задач на стенде.
    const setFirst = await request.patch(`${API_URL}/tasks/${first.id}/position`, {
      data: { position: maxPosition + 1000 },
    });
    const setSecond = await request.patch(`${API_URL}/tasks/${second.id}/position`, {
      data: { position: maxPosition + 2000 },
    });
    expect(setFirst.ok()).toBe(true);
    expect(setSecond.ok()).toBe(true);

    await openProjectBoard(page);

    const firstCard = page
      .getByText(first.title, { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'cursor-pointer')][1]");
    const secondCard = page
      .getByText(second.title, { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'cursor-pointer')][1]");

    // Исходный порядок: first выше second в колонке Backlog.
    const before = await firstCard.boundingBox();
    const beforeSecond = await secondCard.boundingBox();
    expect(before).not.toBeNull();
    expect(beforeSecond).not.toBeNull();
    expect(before!.y).toBeLessThan(beforeSecond!.y);

    // Пользовательский путь: перемещаем second выше через кнопку Move task up.
    await secondCard.getByRole("button", { name: "Move task up" }).click();

    // После реордеринга second отображается выше first.
    await expect
      .poll(async () => {
        const afterSecond = await secondCard.boundingBox();
        const afterFirst = await firstCard.boundingBox();
        if (!afterSecond || !afterFirst) return false;
        return afterSecond.y < afterFirst.y;
      })
      .toBe(true);

    // Oracle: position second стал меньше position first.
    const tasksResponse = await request.get(`${API_URL}/tasks?projectId=${PROJECT_ID}`);
    expect(tasksResponse.ok()).toBe(true);
    const tasks = (await tasksResponse.json()) as Array<{
      id: string;
      position: number;
    }>;
    const firstRow = tasks.find((row) => row.id === first.id);
    const secondRow = tasks.find((row) => row.id === second.id);
    expect(firstRow).toBeDefined();
    expect(secondRow).toBeDefined();
    expect(secondRow!.position).toBeLessThan(firstRow!.position);

    // Порядок сохраняется после reload (персистентность position).
    await page.reload();
    await expect(page.getByText(second.title, { exact: true })).toBeVisible();
    await expect(page.getByText(first.title, { exact: true })).toBeVisible();
    const afterReloadFirst = await page
      .getByText(first.title, { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'cursor-pointer')][1]")
      .boundingBox();
    const afterReloadSecond = await page
      .getByText(second.title, { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'cursor-pointer')][1]")
      .boundingBox();
    expect(afterReloadFirst).not.toBeNull();
    expect(afterReloadSecond).not.toBeNull();
    expect(afterReloadSecond!.y).toBeLessThan(afterReloadFirst!.y);
  } finally {
    await deleteTaskViaApi(request, first.id);
    await deleteTaskViaApi(request, second.id);
  }
});
