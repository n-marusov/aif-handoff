import { expect, test } from "@playwright/test";
import { API_URL, PROJECT_ID } from "./common";

// E2E-API-008: проекты — список и сводка согласованы со стендом.
// contract-aif-rest-api: GET /projects, GET /projects/overview.
test("E2E-API-008: список проектов и overview содержат эталонный проект стенда", async ({
  request,
}) => {
  const projects = await request.get(`${API_URL}/projects`);
  expect(projects.ok()).toBe(true);
  const rows = (await projects.json()) as Array<{ id: string; name: string }>;
  expect(rows.some((row) => row.id === PROJECT_ID)).toBe(true);

  const overview = await request.get(`${API_URL}/projects/overview`);
  expect(overview.ok()).toBe(true);
  const overviewRows = (await overview.json()) as Array<{ projectId: string }>;
  expect(overviewRows.some((row) => row.projectId === PROJECT_ID)).toBe(true);
});

// E2E-API-009: runtime-профили — список и каталог рантаймов отвечают на стенде.
// contract-aif-rest-api: GET /runtime-profiles?includeGlobal=true, GET /runtime-profiles/runtimes.
test("E2E-API-009: runtime-profiles и runtimes отвечают и согласованы по форме", async ({
  request,
}) => {
  const profiles = await request.get(`${API_URL}/runtime-profiles?includeGlobal=true`);
  expect(profiles.ok()).toBe(true);
  const profileRows = (await profiles.json()) as Array<{ id: string; name?: string }>;
  // Список может быть пустым на пустом стенде — форма контракта важнее содержания.
  expect(Array.isArray(profileRows)).toBe(true);

  const runtimes = await request.get(`${API_URL}/runtime-profiles/runtimes`);
  expect(runtimes.ok()).toBe(true);
  const runtimeRows = (await runtimes.json()) as Array<{
    id: string;
    providerId: string;
    capabilities: Record<string, unknown>;
  }>;
  expect(Array.isArray(runtimeRows)).toBe(true);
  for (const runtime of runtimeRows) {
    expect(runtime.providerId).toBeTruthy();
  }
});
