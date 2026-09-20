import { expect, test } from "@playwright/test";
import { API_URL } from "./common";

// E2E-API-001: развернуть стенд — deployment-smoke (e2e-api-testing §10 Шаг 1, §9.1).
// contract-aif-rest-api: GET /health, GET /agent/status.
test("E2E-API-001: стенд отвечает на health, agent/status и settings", async ({ request }) => {
  // REST health-check — первый сегмент пути: сервер жив и БД инициализирована.
  const health = await request.get(`${API_URL}/health`);
  expect(health.ok()).toBe(true);
  const healthBody = (await health.json()) as { status: string };
  expect(healthBody.status).toBe("ok");

  // Agent status — координатор отвечает и отдаёт числовой uptime.
  const agentStatus = await request.get(`${API_URL}/agent/status`);
  expect(agentStatus.ok()).toBe(true);
  const agentBody = (await agentStatus.json()) as { uptime: number; activeTaskCount: number };
  expect(agentBody.uptime).toBeGreaterThanOrEqual(0);
  expect(agentBody.activeTaskCount).toBeGreaterThanOrEqual(0);

  // Settings — дефолты фронтенда, открытый эндпоинт.
  const settings = await request.get(`${API_URL}/settings`);
  expect(settings.ok()).toBe(true);
});
