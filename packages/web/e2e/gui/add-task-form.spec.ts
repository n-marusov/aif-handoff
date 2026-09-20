import { expect, test } from "@playwright/test";
import { API_URL, PROJECT_ID, openProjectBoard, runId } from "./common";

// US-integration.issues.bootstrap-project-sync-and-create-task: администратор вручную ставит задачу через форму (основной источник).
// UC-integration.issues.bootstrap-project-sync-and-create-task: создание задачи вручную (контекст).
// US-dashboard.board.view-kanban-columns: карточка задачи отображается в колонке Backlog (контекст).
// HF2.1: просмотр изменений по стадиям (контекст).
// contract-aif-rest-api: GET /tasks?projectId=X — внешний oracle (контекст).
test("L-02-form: создание задачи через AddTaskForm и появление карточки в Backlog", async ({
  page,
  request,
}) => {
  const suffix = runId();
  const title = `e2e-add-form-${suffix}`;

  await openProjectBoard(page);

  // Пользовательский путь: открываем форму добавления задачи в колонке Backlog.
  await page.getByRole("button", { name: "Add task" }).click();
  await page.getByPlaceholder("Task title").fill(title);

  // Отправка формы (кнопка Add активна — заголовок заполнен).
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // Форма закрылась после успешного создания.
  await expect(page.getByPlaceholder("Task title")).toBeHidden();

  // Карточка появляется в колонке Backlog.
  await expect(page.getByText(title, { exact: true })).toBeVisible();

  // Oracle: задача создана через реальный API.
  const tasksResponse = await request.get(`${API_URL}/tasks?projectId=${PROJECT_ID}`);
  expect(tasksResponse.ok()).toBe(true);
  const tasks = (await tasksResponse.json()) as Array<{
    id: string;
    title: string;
    status: string;
  }>;
  const created = tasks.find((task) => task.title === title);
  expect(created).toBeDefined();
  expect(created!.status).toBe("backlog");

  // Cleanup: удаляем созданную задачу.
  const deleted = await request.delete(`${API_URL}/tasks/${created!.id}`);
  expect(deleted.status()).toBe(200);
});

// US-integration.issues.bootstrap-project-sync-and-create-task: пустой заголовок отклоняется формой (negative).
// UC-integration.issues.bootstrap-project-sync-and-create-task: валидация обязательного заголовка (контекст).
// contract-aif-rest-api: GET /tasks?projectId=X — проверка отсутствия создания (контекст).
test("L-02-form: пустой заголовок не создаёт задачу (negative)", async ({ page, request }) => {
  const suffix = runId();

  await openProjectBoard(page);

  // Открываем форму и оставляем заголовок пустым.
  await page.getByRole("button", { name: "Add task" }).click();
  const titleInput = page.getByPlaceholder("Task title");
  const submit = page.getByRole("button", { name: "Add", exact: true });

  // Форма отклоняет отправку: кнопка Add заблокирована при пустом заголовке.
  await expect(submit).toBeDisabled();

  // Валидация активна: заполненный заголовок разблокирует кнопку,
  // повторная очистка снова блокирует её до отправки.
  await titleInput.fill(`e2e-add-form-empty-${suffix}`);
  await expect(submit).toBeEnabled();
  await titleInput.clear();
  await expect(submit).toBeDisabled();

  // Oracle: маркерная задача не создалась (форма не отправила запрос).
  const marker = `e2e-add-form-empty-${suffix}`;
  const tasksResponse = await request.get(`${API_URL}/tasks?projectId=${PROJECT_ID}`);
  expect(tasksResponse.ok()).toBe(true);
  const tasks = (await tasksResponse.json()) as Array<{ title: string }>;
  expect(tasks.some((task) => task.title === marker)).toBe(false);
});
