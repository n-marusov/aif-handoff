import { expect, test } from "@playwright/test";
import { API_URL, createTaskViaApi, deleteTaskViaApi, openProjectBoard, runId } from "./common";

test("DEBUG: ws connection and task:moved broadcast", async ({ page, request }) => {
  const messages: string[] = [];
  page.on("console", (msg) => {
    messages.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on("websocket", (ws) => {
    messages.push(`[ws:open] ${ws.url()}`);
    ws.on("framesent", (f) => messages.push(`[ws:send] ${String(f.payload)}`));
    ws.on("framereceived", (f) => messages.push(`[ws:recv] ${String(f.payload)}`));
  });

  const suffix = runId();
  const title = `e2e-debug-${suffix}`;
  const task = await createTaskViaApi(request, {
    title,
    autoMode: false,
    paused: true,
  });

  try {
    await openProjectBoard(page);
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await page.waitForTimeout(3000);

    const eventResponse = await request.post(`${API_URL}/tasks/${task.id}/events`, {
      data: { event: "start_ai" },
    });
    const eventBody = await eventResponse.text();
    messages.push(`[api:event] ${eventResponse.status()} ${eventBody.slice(0, 200)}`);

    await page.waitForTimeout(3000);
    const taskNow = await request.get(`${API_URL}/tasks/${task.id}`);
    const taskBody = (await taskNow.json()) as { status: string };
    messages.push(`[api:task] status=${taskBody.status}`);

    console.log("DEBUG LOG:\n" + messages.join("\n"));
  } finally {
    await deleteTaskViaApi(request, task.id);
  }
});
