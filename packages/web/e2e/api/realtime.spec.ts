import { expect, test } from "@playwright/test";
import {
  API_URL,
  connectAndAwaitWsConnected,
  createTaskViaApi,
  deleteTaskViaApi,
  runId,
  waitForWsEvent,
} from "./common";

// E2E-API-007: сквозной контур REST → WS — переход задачи публикует событие
// внешнему наблюдателю (e2e-api-testing §9.1, §6.2).
// contract-aif-ws: ws:connected, task:moved / task:updated.
// §14.2: независимый оракул — WS-клиент не является частью API-процесса.
test("E2E-API-007: WS-клиент получает событие перехода задачи", async ({ request }) => {
  test.setTimeout(90_000);
  const suffix = runId();
  const task = await createTaskViaApi(request, {
    title: `e2e-api-ws-${suffix}`,
    autoMode: false,
    paused: true,
    executionOwner: "human",
  });

  const { socket } = await connectAndAwaitWsConnected();
  try {
    // Подписка на событие по id задачи до REST-мутации: перехода может не быть,
    // если событие ушло до установки слушателя (anti-flake §15.2).
    const received = waitForWsEvent(socket, { expectedId: task.id, timeoutMs: 10_000 });

    const event = await request.post(`${API_URL}/tasks/${task.id}/events`, {
      data: { event: "start_ai" },
    });
    expect(event.ok()).toBe(true);
    const moved = (await event.json()) as { status: string };
    expect(moved.status).toBe("planning");

    // Внешний наблюдатель получил событие с id задачи (task:moved либо task:updated).
    const wsEvent = await received;
    expect(wsEvent.type).toMatch(/^task:(moved|updated)$/);
    expect(wsEvent.payload?.id).toBe(task.id);

    // REST oracle: статус согласован с WS-событием.
    const detail = await request.get(`${API_URL}/tasks/${task.id}`);
    const row = (await detail.json()) as { status: string };
    expect(row.status).toBe("planning");
  } finally {
    socket.close();
    await deleteTaskViaApi(request, task.id);
  }
});
