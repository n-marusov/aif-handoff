import { expect, test } from "@playwright/test";
import {
  PERF_BUDGETS,
  PERF_API_ORIGIN,
  evaluateBudgetSamples,
  readNavigationTiming,
  readWebVitals,
  recordNetwork,
  resolvePerfBudgetPolicy,
} from "./utils";

// Явное исключение §4 (docs/qa/e2e-gui-testing.md): perf-бюджет холодной
// загрузки дашборда — техническое поведение без UC/US, инфраструктурная
// проверка (аналог L-01d).
// Этот тест проверяет холодный рендер дашборда: открывает `/`, ждёт завершения
// начальной загрузки проектов и фиксирует метрики времени/сети. "Холодный"
// означает отсутствие HTTP-кеша бандлов в браузере; серверный кеш API при этом
// остаётся активным, поэтому первые прогоны после старта dev дают худшие задержки.
test.describe("dashboard cold load", () => {
  test("renders kanban shell within LCP/DOM-ready budgets", async ({ page, context }) => {
    const policy = resolvePerfBudgetPolicy();
    const domSamples: number[] = [];
    const lcpSamples: number[] = [];

    for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
      await context.clearCookies();
      const network = recordNetwork(page, (url) => url.startsWith(PERF_API_ORIGIN));

      const nav = page.goto("/", { waitUntil: "domcontentloaded" });
      const response = await nav;
      expect(response?.status() ?? 500).toBeLessThan(400);

      await page.waitForSelector(
        "text=/Backlog|Planning|Implementing|Projects overview|No projects yet/i",
        {
          timeout: 30_000,
        },
      );

      const timing = await readNavigationTiming(page);
      const vitals = await readWebVitals(page);
      const apiCalls = network.stop();

      domSamples.push(timing.domContentLoadedMs);
      if (vitals.lcpMs != null) {
        lcpSamples.push(vitals.lcpMs);
      }

      // eslint-disable-next-line no-console
      console.log("[perf] dashboard timing:", {
        attempt: attempt + 1,
        nav: timing,
        vitals,
        apiCalls: apiCalls.map(({ url, durationMs, status }) => ({
          url: url.replace(PERF_API_ORIGIN, ""),
          durationMs,
          status,
        })),
      });
    }

    const domEval = evaluateBudgetSamples(domSamples, PERF_BUDGETS.dashboardDomReadyMs, policy);
    expect(domEval.pass).toBe(true);

    if (lcpSamples.length > 0) {
      const lcpEval = evaluateBudgetSamples(lcpSamples, PERF_BUDGETS.dashboardLcpMs, policy);
      expect(lcpEval.pass).toBe(true);
    }
  });
});
