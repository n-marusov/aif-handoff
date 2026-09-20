import { expect, test } from "@playwright/test";
import {
  API_URL,
  PROJECT_ID,
  createTaskViaApi,
  deleteTaskViaApi,
  openProjectBoard,
  runId,
} from "./common";

// UC-runtime.override.override-profile-for-task: переопределение runtime-профиля на уровне задачи (основной источник).
// HF3.2: переопределение профиля для конкретного изменения (контекст).
// BR-fact.project.runtime-profiles: профиль задачи наследует профиль проекта, пока не переопределён (контекст).
// contract-aif-rest-api: POST /runtime-profiles, PATCH /tasks/:id, GET /tasks/:id — внешний oracle (контекст).
test("L-05c: task-level runtime override сохраняется через Task Settings", async ({
  page,
  request,
}) => {
  const suffix = runId();
  const profileName = `e2e-override-profile-${suffix}`;
  const model = `e2e-model-${suffix}`;
  const task = await createTaskViaApi(request, {
    title: `e2e-override-${suffix}`,
    description: "E2E GUI fixture for task-level runtime override",
    autoMode: false,
    paused: true,
  });

  // Профиль создаётся через реальный API (oracle) — как project-профиль.
  const profileResponse = await request.post(`${API_URL}/runtime-profiles`, {
    data: {
      projectId: PROJECT_ID,
      name: profileName,
      runtimeId: "claude",
      providerId: "anthropic",
      transport: "sdk",
      apiKeyEnvVar: "E2E_FAKE_KEY",
      defaultModel: "opus",
    },
  });
  expect(profileResponse.ok()).toBe(true);
  const profile = (await profileResponse.json()) as { id: string; name: string };

  try {
    await openProjectBoard(page);

    // Пользовательский путь: открываем детали задачи → Settings → Runtime override.
    await page.getByText(task.title, { exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Runtime override" }).click();

    // Выбираем созданный профиль и задаём model override.
    // Опция селекта — имя в формате `name (runtimeId/providerId)`, поэтому
    // выбираем по значению (profile.id), а не по label.
    const profileSelect = page
      .getByText("Runtime profile", { exact: true })
      .locator("xpath=following-sibling::select");
    await profileSelect.selectOption({ value: profile.id });
    await page.getByPlaceholder("runtime default").fill(model);
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // Форма закрылась — детали снова видимы.
    await expect(page.getByText("Task Settings", { exact: true })).toBeHidden();

    // Oracle: PATCH сохранил override на задачу.
    const oracle = await request.get(`${API_URL}/tasks/${task.id}`);
    expect(oracle.ok()).toBe(true);
    const row = (await oracle.json()) as {
      runtimeProfileId: string | null;
      modelOverride: string | null;
    };
    expect(row.runtimeProfileId).toBe(profile.id);
    expect(row.modelOverride).toBe(model);
  } finally {
    await deleteTaskViaApi(request, task.id);
    const deleted = await request.delete(`${API_URL}/runtime-profiles/${profile.id}`);
    expect(deleted.status()).toBe(200);
  }
});

// UC-runtime.override.override-profile-for-task: очистка override возвращает наследование профиля проекта (основной источник).
// HF3.2: переопределение профиля для конкретного изменения (контекст).
// contract-aif-rest-api: POST /runtime-profiles, PATCH /tasks/:id, GET /tasks/:id — внешний oracle сброса (контекст).
test("L-05c: очистка override сбрасывает runtimeProfileId и modelOverride (negative)", async ({
  page,
  request,
}) => {
  const suffix = runId();
  const profileName = `e2e-override-reset-profile-${suffix}`;
  const task = await createTaskViaApi(request, {
    title: `e2e-override-reset-${suffix}`,
    description: "E2E GUI fixture for task-level runtime override reset",
    autoMode: false,
    paused: true,
  });

  // Профиль создаётся через реальный API (oracle) — как project-профиль.
  const profileResponse = await request.post(`${API_URL}/runtime-profiles`, {
    data: {
      projectId: PROJECT_ID,
      name: profileName,
      runtimeId: "claude",
      providerId: "anthropic",
      transport: "sdk",
      apiKeyEnvVar: "E2E_FAKE_KEY",
      defaultModel: "opus",
    },
  });
  expect(profileResponse.ok()).toBe(true);
  const profile = (await profileResponse.json()) as { id: string; name: string };

  // Задаём override через реальный API (oracle), чтобы UI имел что сбросить.
  const setResponse = await request.put(`${API_URL}/tasks/${task.id}`, {
    data: { runtimeProfileId: profile.id, modelOverride: `e2e-model-${suffix}` },
  });
  expect(setResponse.ok()).toBe(true);

  try {
    await openProjectBoard(page);
    await page.getByText(task.title, { exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    // Панель runtime-оверрайда автоматически открыта (у задачи уже есть override).
    await expect(page.getByText("Runtime profile", { exact: true })).toBeVisible();

    // Сбрасываем профиль на значение по умолчанию и очищаем model override.
    const profileSelect = page
      .getByText("Runtime profile", { exact: true })
      .locator("xpath=following-sibling::select");
    await profileSelect.selectOption({ index: 0 });
    await page.getByPlaceholder("runtime default").fill("");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.getByText("Task Settings", { exact: true })).toBeHidden();

    // Oracle: override сброшен (null → наследование профиля проекта).
    const oracle = await request.get(`${API_URL}/tasks/${task.id}`);
    expect(oracle.ok()).toBe(true);
    const row = (await oracle.json()) as {
      runtimeProfileId: string | null;
      modelOverride: string | null;
    };
    expect(row.runtimeProfileId).toBeNull();
    expect(row.modelOverride).toBeNull();
  } finally {
    await deleteTaskViaApi(request, task.id);
    const deleted = await request.delete(`${API_URL}/runtime-profiles/${profile.id}`);
    expect(deleted.status()).toBe(200);
  }
});
