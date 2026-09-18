import { expect, test } from "@playwright/test";
import { PERF_BUDGETS, readNavigationTiming, readWebVitals, recordNetwork } from "./utils";

// Этот тест проверяет холодный рендер дашборда: открывает `/`, ждёт завершения
// начальной загрузки проектов и фиксирует метрики времени/сети. "Холодный"
// означает отсутствие HTTP-кеша бандлов в браузере; серверный кеш API при этом
// остаётся активным, поэтому первые прогоны после старта dev дают худшие задержки.
test.describe("dashboard cold load", () => {
  test("renders kanban shell within LCP/DOM-ready budgets", async ({ page, context }) => {
    await context.clearCookies();
    const network = recordNetwork(page, (url) => url.includes("localhost:3009"));

    const nav = page.goto("/", { waitUntil: "domcontentloaded" });
    const response = await nav;
    expect(response?.status() ?? 500).toBeLessThan(400);

    // Ждём, пока приложение завершит первый запрос проектов и отрисует
    // стабильное состояние дашборда. База perf-окружения может быть пустой —
    // тогда показывается состояние без проектов вместо колонок канбана.
    await page.waitForSelector(
      "text=/Backlog|Planning|Implementing|Projects overview|No projects yet/i",
      {
        timeout: 30_000,
      },
    );

    const timing = await readNavigationTiming(page);
    const vitals = await readWebVitals(page);
    const apiCalls = network.stop();

    // eslint-disable-next-line no-console
    console.log("[perf] dashboard timing:", {
      nav: timing,
      vitals,
      apiCalls: apiCalls.map(({ url, durationMs, status }) => ({
        url: url.replace("http://localhost:3009", ""),
        durationMs,
        status,
      })),
    });

    expect(timing.domContentLoadedMs).toBeLessThan(PERF_BUDGETS.dashboardDomReadyMs);
    if (vitals.lcpMs != null) {
      expect(vitals.lcpMs).toBeLessThan(PERF_BUDGETS.dashboardLcpMs);
    }
  });
});
