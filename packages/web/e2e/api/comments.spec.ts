import { expect, test } from "@playwright/test";
import { API_URL, createTaskViaApi, deleteTaskViaApi, runId } from "./common";

// E2E-API-006: комментарий через REST — создание и согласованность при чтении.
// contract-aif-rest-api: POST /tasks/:id/comments, GET /tasks/:id/comments.
// §14.1: реальная проверка через независимый oracle (GET после POST).
test("E2E-API-006: comment создаётся и отображается в списке как oracle", async ({ request }) => {
  const suffix = runId();
  const task = await createTaskViaApi(request, {
    title: `e2e-api-comment-${suffix}`,
    autoMode: false,
    paused: true,
  });

  try {
    const body = `E2E API comment ${suffix}`;
    const created = await request.post(`${API_URL}/tasks/${task.id}/comments`, {
      data: { message: body },
    });
    expect(created.ok()).toBe(true);
    const comment = (await created.json()) as { id: string; message: string; taskId: string };
    expect(comment.message).toBe(body);

    // Oracle: комментарий в списке.
    const list = await request.get(`${API_URL}/tasks/${task.id}/comments`);
    expect(list.ok()).toBe(true);
    const comments = (await list.json()) as Array<{ id: string; message: string }>;
    expect(comments.some((row) => row.id === comment.id)).toBe(true);
    expect(comments.find((row) => row.id === comment.id)?.message).toBe(body);
  } finally {
    await deleteTaskViaApi(request, task.id);
  }
});

// E2E-API-006b (negative): комментарий к несуществующей задаче → 404.
test("E2E-API-006b: comment для несуществующей задачи → 404 (negative)", async ({ request }) => {
  const response = await request.post(
    `${API_URL}/tasks/00000000-0000-0000-0000-000000000000/comments`,
    { data: { message: "orphan" } },
  );
  expect(response.status()).toBe(404);
});
