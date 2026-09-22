import { expect, test } from "@playwright/test";
import { PERF_BUDGETS, evaluateBudgetSamples, resolvePerfBudgetPolicy } from "./utils";

// Явное исключение §4 (docs/qa/e2e-gui-testing.md): perf-бюджет времени ответа
// эндпоинта — техническое поведение без UC/US, оформляется как инфраструктурная
// проверка (аналог L-01d).
// `/chat/sessions` читает метаданные сессий Codex с диска. Даже при 30-секундном
// кеше в памяти холодные запросы проходят через ~/.codex/sessions; этот тест
// фиксирует бюджет, чтобы такие регрессии быстро проявлялись.
test.describe("chat-sessions endpoint timing", () => {
  test("cold and warm reads stay under their budgets", async ({ page }) => {
    const policy = resolvePerfBudgetPolicy();
    const coldSamples: number[] = [];
    const warmSamples: number[] = [];

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const projectId = await page.evaluate(async () => {
      const res = await fetch("/projects", { credentials: "include" });
      if (!res.ok) return null;
      const body = (await res.json()) as Array<{ id: string }>;
      return body[0]?.id ?? null;
    });
    test.skip(!projectId, "No projects present on the dev DB — skip endpoint timing.");

    const query = `?projectId=${encodeURIComponent(projectId!)}`;
    for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
      const cold = await page.evaluate(async (q) => {
        const started = performance.now();
        const res = await fetch(`/chat/sessions${q}`, {
          credentials: "include",
        });
        return { status: res.status, ms: performance.now() - started };
      }, query);

      const warm = await page.evaluate(async (q) => {
        const started = performance.now();
        const res = await fetch(`/chat/sessions${q}`, {
          credentials: "include",
        });
        return { status: res.status, ms: performance.now() - started };
      }, query);

      expect(cold.status).toBe(200);
      expect(warm.status).toBe(200);
      coldSamples.push(cold.ms);
      warmSamples.push(warm.ms);

      // eslint-disable-next-line no-console
      console.log("[perf] chat/sessions:", {
        attempt: attempt + 1,
        coldMs: cold.ms,
        warmMs: warm.ms,
      });
    }

    const coldEval = evaluateBudgetSamples(coldSamples, PERF_BUDGETS.chatSessionsColdMs, policy);
    const warmEval = evaluateBudgetSamples(warmSamples, PERF_BUDGETS.chatSessionsWarmMs, policy);
    expect(coldEval.pass).toBe(true);
    expect(warmEval.pass).toBe(true);
  });
});
