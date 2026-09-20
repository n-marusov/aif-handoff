import { expect, test } from "@playwright/test";
import { API_URL, PROJECT_ID, openProjectBoard, runId } from "./common";

// UC-runtime.profile.configure-project-runtime: администратор создаёт профиль проекта (основной источник).
// HF3.1: настройка runtime-профиля для проекта (контекст).
// contract-aif-rest-api: POST/GET/DELETE /runtime-profiles — внешний oracle (контекст).
test("L-05: создание project runtime-профиля через ProjectRuntimeSettings", async ({
  page,
  request,
}) => {
  const suffix = runId();
  const profileName = `e2e-profile-${suffix}`;
  const signal = `e2e-${suffix}`;
  const model = signal + "-model";
  const apiKeyEnvVar = `E2E_FAKE_KEY`;

  await openProjectBoard(page);

  // Открываем панель настроек runtime через кнопку RUNTIME в шапке.
  await page.getByRole("button", { name: "Runtime profiles" }).click();
  await expect(page.getByRole("heading", { name: "Runtime Profiles", exact: true })).toBeVisible();

  // Создаём новый project-профиль.
  await page.getByRole("button", { name: "+ New Project Profile" }).click();

  // Runtime с дефолтными значениями: claude / sdk / ANTHROPIC_API_KEY.
  // placeholder модели — defaultModelPlaceholder для claude (`opus`).
  await page.getByPlaceholder("Runtime profile name").fill(profileName);
  await page.getByPlaceholder("opus").fill(model);
  await page.getByPlaceholder("ANTHROPIC_API_KEY").fill(apiKeyEnvVar);
  await page.getByRole("button", { name: "Create Profile", exact: true }).click();

  // Профиль появился в списке Project Profiles.
  await expect(page.getByText(profileName, { exact: true })).toBeVisible();
  await expect(
    page.getByText(new RegExp(`model=${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), {
      exact: false,
    }),
  ).toBeVisible();

  // Oracle: профиль сохранён в API для проекта.
  const profilesResponse = await request.get(
    `${API_URL}/runtime-profiles?projectId=${PROJECT_ID}&scope=project`,
  );
  expect(profilesResponse.ok()).toBe(true);
  const profiles = (await profilesResponse.json()) as Array<{
    id: string;
    name: string;
    projectId: string | null;
    runtimeId: string;
    defaultModel: string | null;
    apiKeyEnvVar: string;
  }>;
  const created = profiles.find((profile) => profile.name === profileName);
  expect(created).toBeDefined();
  expect(created!.projectId).toBe(PROJECT_ID);
  expect(created!.runtimeId).toBe("claude");
  expect(created!.defaultModel).toBe(model);
  expect(created!.apiKeyEnvVar).toBe(apiKeyEnvVar);

  try {
    // Профиль переиспользуем: профиль остаётся видимым после перезагрузки страницы.
    await page.reload();
    await page.getByRole("button", { name: "Runtime profiles" }).click();
    await expect(page.getByText(profileName, { exact: true })).toBeVisible();
  } finally {
    if (created) {
      const deleted = await request.delete(`${API_URL}/runtime-profiles/${created.id}`);
      expect(deleted.status()).toBe(200);
    }
  }
});

// UC-runtime.profile.configure-project-runtime: невалидное имя env-переменной отклоняется (negative).
// HF3.1: настройка runtime-профиля для проекта (контекст).
// contract-aif-rest-api: POST /runtime-profiles — валидация (контекст).
test("L-05b: профиль с невалидным apiKeyEnvVar отклоняется (negative)", async ({ request }) => {
  const response = await request.post(`${API_URL}/runtime-profiles`, {
    data: {
      projectId: PROJECT_ID,
      name: `e2e-profile-invalid-${runId()}`,
      runtimeId: "claude",
      providerId: "anthropic",
      transport: "sdk",
      apiKeyEnvVar: "NOT A VALID ENV VAR",
      defaultModel: "opus",
    },
  });
  expect(response.ok()).toBe(false);
  expect(response.status()).toBe(400);
  const body = (await response.json()) as { error?: string };
  expect(body.error).toBeTruthy();
});
