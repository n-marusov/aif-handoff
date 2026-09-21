import { expect, test } from "@playwright/test";
import { API_URL, createTaskViaApi, deleteTaskViaApi, openProjectBoard, runId } from "./common";

// UC-dashboard.realtime.receive-live-status-updates: UI обновляется по WS-событию (основной источник).
// HF2.4: обновления в реальном времени (контекст).
// contract-aif-ws: task:moved → инвалидация react-query без reload (контекст).
test("L-07: внешнее изменение статуса отображается на доске без перезагрузки", async ({
  page,
  request,
}) => {
  const suffix = runId();
  const title = `e2e-realtime-${suffix}`;
  const task = await createTaskViaApi(request, {
    title,
    autoMode: false,
    paused: true,
  });

  try {
    await openProjectBoard(page);
    await expect(page.getByText(title, { exact: true })).toBeVisible();

    // Дождёмся готовности приложенческого WebSocket: внешний переход ниже
    // шлёт task:moved только живым сокетам. Если событие уйдёт до открытия
    // сокета, доска не узнает о переходе (WS без replay) и тест упадёт —
    // см. anti-flake §15.2 в docs/qa/e2e-api-testing.md.
    await page.waitForFunction(
      () => typeof (window as unknown as Record<string, unknown>).__aifWsClientId === "string",
      undefined,
      { timeout: 10_000 },
    );

    // Фиксируем тип навигации: тест не должен перезагружать страницу.
    const navigationType = await page.evaluate(
      () => performance.getEntriesByType("navigation")[0]?.toJSON().type ?? "unknown",
    );

    // Внешний актор (API) переводит задачу на стадию planning.
    const eventResponse = await request.post(`${API_URL}/tasks/${task.id}/events`, {
      data: { event: "start_ai" },
    });
    expect(eventResponse.ok()).toBe(true);

    // Доска обновляется без reload: карточка уходит из Backlog и появляется в Planning.
    await expect
      .poll(async () => {
        const cardBox = await page.getByText(title, { exact: true }).boundingBox();
        if (!cardBox) return "missing";
        const planning = page.getByRole("heading", { name: "Planning", exact: true });
        const backlog = page.getByRole("heading", { name: "Backlog", exact: true });
        const planningBox = await planning.boundingBox();
        const backlogBox = await backlog.boundingBox();
        if (!planningBox || !backlogBox) return "no-headings";
        return Math.abs(cardBox.x - planningBox.x) < Math.abs(cardBox.x - backlogBox.x)
          ? "planning"
          : "backlog";
      })
      .toBe("planning");

    // Страница не перезагружалась.
    const after = await page.evaluate(
      () => performance.getEntriesByType("navigation")[0]?.toJSON().type ?? "unknown",
    );
    expect(after).toBe(navigationType);

    // Oracle: API подтверждает новый статус.
    const oracle = await request.get(`${API_URL}/tasks/${task.id}`);
    expect(oracle.ok()).toBe(true);
    const row = (await oracle.json()) as { status: string };
    expect(row.status).toBe("planning");
  } finally {
    await deleteTaskViaApi(request, task.id);
  }
});
