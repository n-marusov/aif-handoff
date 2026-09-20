import { expect, test } from "@playwright/test";
import {
  API_URL,
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
