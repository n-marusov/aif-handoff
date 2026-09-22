// E2E correlation helpers (P2.1) — reduce MTTR by correlating test steps with
// API/agent log events via stable ids.
//
// Conventions:
//   - `traceId` — one per Playwright worker run. Sources, in order of priority:
//       1. AIF_E2E_TRACE_ID env (allows CI to correlate an entire lane);
//       2. auto-generated `e2e-<epoch>-<ran>` at first import.
//   - `testId` — stable slug of a test title (used in log lines), so triage can
//     grep `[e2e:<testId>]` and find the exact scenario in the Playwright report.

const TRACE_ID =
  process.env.AIF_E2E_TRACE_ID ?? `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function runTraceId(): string {
  return TRACE_ID;
}

export function testIdFor(title: string): string {
  return title
    .replace(/[\s/\\:]+/g, "-")
    .replace(/[^a-zA-Z0-9-_]/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64);
}

/** Логирует шаг теста с тест- и trace-идом для сопоставления с event-логами. */
export function logTraceStep(
  testId: string,
  step: string,
  details?: Record<string, unknown>,
): void {
  const detailText = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[e2e:${testId}] [trace:${TRACE_ID}] ${step}${detailText}`);
}
