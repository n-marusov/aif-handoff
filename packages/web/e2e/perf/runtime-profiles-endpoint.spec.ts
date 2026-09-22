import { expect, test } from "@playwright/test";
import {
  PERF_API_URL,
  PERF_BUDGETS,
  evaluateBudgetSamples,
  recordNetwork,
  resolvePerfBudgetPolicy,
} from "./utils";

// Явное исключение §4 (docs/qa/e2e-gui-testing.md): perf-бюджет эндпоинта
// runtime-профилей — техническое поведение без UC/US, инфраструктурная
// проверка (аналог L-01d).
// Измеряет запрос `/runtime-profiles` изнутри браузера: это реальный путь
// пользователя (fetch -> React Query -> render), а не сырой curl.
// Запрос выполняется дважды: первый вызов проверяет холодный кеш
// (включая серверный обход ~/.codex/sessions), второй — кеш в памяти эндпоинта.
test.describe("runtime-profiles endpoint timing", () => {
  test("cold and warm reads stay under their budgets", async ({ page, request }) => {
    const policy = resolvePerfBudgetPolicy();
    const coldSamples: number[] = [];
    const warmSamples: number[] = [];

    await page.goto("/", { waitUntil: "domcontentloaded" });

    for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
      const network = recordNetwork(page, (url) => url.includes("/runtime-profiles"));

      const coldStart = Date.now();
      const coldResponse = await page.evaluate(async () => {
        const started = performance.now();
        const res = await fetch("/runtime-profiles?includeGlobal=true", {
          credentials: "include",
        });
        return { status: res.status, ms: performance.now() - started };
      });
      const coldTotalMs = Date.now() - coldStart;

      const warmResponse = await page.evaluate(async () => {
        const started = performance.now();
        const res = await fetch("/runtime-profiles?includeGlobal=true", {
          credentials: "include",
        });
        return { status: res.status, ms: performance.now() - started };
      });

      const samples = network.stop();
      expect(coldResponse.status).toBe(200);
      expect(warmResponse.status).toBe(200);
      coldSamples.push(coldResponse.ms);
      warmSamples.push(warmResponse.ms);

      // eslint-disable-next-line no-console
      console.log("[perf] runtime-profiles:", {
        attempt: attempt + 1,
        coldMs: coldResponse.ms,
        warmMs: warmResponse.ms,
        coldTotalMs,
        samples: samples.map((s) => ({ durationMs: s.durationMs, status: s.status })),
      });
    }

    const coldEval = evaluateBudgetSamples(coldSamples, PERF_BUDGETS.runtimeProfilesColdMs, policy);
    const warmEval = evaluateBudgetSamples(warmSamples, PERF_BUDGETS.runtimeProfilesWarmMs, policy);
    expect(coldEval.pass).toBe(true);
    expect(warmEval.pass).toBe(true);

    const baseline = await request.get(`${PERF_API_URL}/runtime-profiles?includeGlobal=true`);
    expect(baseline.ok()).toBeTruthy();
  });
});
