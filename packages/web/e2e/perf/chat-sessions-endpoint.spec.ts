import { expect, test } from "@playwright/test";
import { PERF_BUDGETS } from "./utils";

// `/chat/sessions` читает метаданные сессий Codex с диска. Даже при 30-секундном
// кеше в памяти холодные запросы проходят через ~/.codex/sessions; этот тест
// фиксирует бюджет, чтобы такие регрессии быстро проявлялись.
test.describe("chat-sessions endpoint timing", () => {
  test("cold and warm reads stay under their budgets", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Берём первый project id из API, чтобы не жёстко привязываться
    // к фикстуре, которой может не быть на конкретной машине.
    const projectId = await page.evaluate(async () => {
      const res = await fetch("/projects", { credentials: "include" });
      if (!res.ok) return null;
      const body = (await res.json()) as Array<{ id: string }>;
      return body[0]?.id ?? null;
    });
    test.skip(!projectId, "No projects present on the dev DB — skip endpoint timing.");

    const query = `?projectId=${encodeURIComponent(projectId!)}`;
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

    // eslint-disable-next-line no-console
    console.log("[perf] chat/sessions:", { coldMs: cold.ms, warmMs: warm.ms });

    expect(cold.status).toBe(200);
    expect(warm.status).toBe(200);
    expect(cold.ms).toBeLessThan(PERF_BUDGETS.chatSessionsColdMs);
    expect(warm.ms).toBeLessThan(PERF_BUDGETS.chatSessionsWarmMs);
  });
});
