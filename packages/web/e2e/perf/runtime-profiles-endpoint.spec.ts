import { expect, test } from "@playwright/test";
import { PERF_BUDGETS, recordNetwork } from "./utils";

// Измеряет запрос `/runtime-profiles` изнутри браузера: это реальный путь
// пользователя (fetch -> React Query -> render), а не сырой curl.
// Запрос выполняется дважды: первый вызов проверяет холодный кеш
// (включая серверный обход ~/.codex/sessions), второй — кеш в памяти эндпоинта.
test.describe("runtime-profiles endpoint timing", () => {
  test("cold and warm reads stay under their budgets", async ({ page, request }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const network = recordNetwork(page, (url) => url.includes("/runtime-profiles"));

    // Холодный вызов выполняется из страницы, чтобы cookies/origin совпадали
    // с контекстом приложения. Вызов прямой, не через UI-триггер, чтобы
    // отделить стоимость эндпоинта от рендера React.
    // Идём через прокси Vite (same origin), чтобы исключить CORS и рассинхрон
    // cookies — это повторяет реальный dev-сценарий общения с API.
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

    // eslint-disable-next-line no-console
    console.log("[perf] runtime-profiles:", {
      coldMs: coldResponse.ms,
      warmMs: warmResponse.ms,
      coldTotalMs,
      samples: samples.map((s) => ({ durationMs: s.durationMs, status: s.status })),
    });

    expect(coldResponse.status).toBe(200);
    expect(warmResponse.status).toBe(200);
    expect(coldResponse.ms).toBeLessThan(PERF_BUDGETS.runtimeProfilesColdMs);
    expect(warmResponse.ms).toBeLessThan(PERF_BUDGETS.runtimeProfilesWarmMs);

    // Базовая проверка через request API Node ходит напрямую в API (без прокси),
    // чтобы поломка dev-прокси Vite проявлялась как разница между измерениями.
    const baseline = await request.get("http://localhost:3009/runtime-profiles?includeGlobal=true");
    expect(baseline.ok()).toBeTruthy();
  });
});
