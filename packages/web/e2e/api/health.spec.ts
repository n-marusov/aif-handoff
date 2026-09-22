import { expect, test } from "@playwright/test";
import { API_URL } from "./common";

const HEALTH_SMOKE_CLASSIFICATION = {
  scope: "infra",
  trace: "non-us",
} as const;

// BR: BR-fact.audit.observability
// FR: REQ-FR-dashboard.realtime.broadcast-live-updates
// NFR: REQ-NFR-api.availability.coordinator-resilience
// KI: KI-05
// E2E-API-001: infra-only deployment smoke (explicit non-US classification).
// contract-aif-rest-api: GET /health, GET /agent/status.
test("E2E-API-001: стенд отвечает на health, agent/status и settings", async ({ request }) => {
  // Явная фиксация класса теста: инфраструктурный smoke, не user-story.
  expect(HEALTH_SMOKE_CLASSIFICATION.scope).toBe("infra");
  expect(HEALTH_SMOKE_CLASSIFICATION.trace).toBe("non-us");

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
