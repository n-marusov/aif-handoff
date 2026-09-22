// e2e-llm-preflight.mjs — fail-fast preflight для LLM-контура e2e.
//
// Запускается перед e2e:gui:llm / e2e:api:llm (таргет e2e:llm). Проверяет, что:
//   1. AIF_LLM_INTEGRATION=1 — явное согласие на интеграционный контур;
//   2. APITY доступен и runtime-читаемость сообщает хотя бы один включённый
//      runtime-профиль (без него LLM-стадии уходят в blocked_external/фейлы).
//
// Поведение: детерминированный быстрый отказ с диагностикой «что настроить»,
// а не каскад таймаутов внутри сьютов. Возвращает ненулевой код при сбое.

const API_URL = process.env.AIF_E2E_API_URL ?? "http://localhost:3009";

function log(message) {
  console.log(`[e2e-llm-preflight] ${message}`);
}

function fail(message) {
  console.error(`[e2e-llm-preflight] ERROR: ${message}`);
  process.exitCode = 1;
}

async function main() {
  if (process.env.AIF_LLM_INTEGRATION !== "1") {
    fail(
      [
        "AIF_LLM_INTEGRATION=1 is required for the LLM lane",
        "The LLM lane (e2e:llm) runs LLM-dependent scenarios (L-10-full/L-10k) that need a real runtime.",
        "Set AIF_LLM_INTEGRATION=1 in the environment when invoking `make e2e-llm` (or npm run e2e:llm).",
        "Without the flag these scenarios are skipped in the core lane (e2e:core) — not run.",
      ].join("\n"),
    );
    return;
  }

  log(`checking API readiness at ${API_URL}/settings`);
  let settings;
  try {
    const response = await fetch(`${API_URL}/settings`);
    if (!response.ok) {
      fail(`GET ${API_URL}/settings -> HTTP ${response.status} (expected 2xx)`);
      return;
    }
    settings = await response.json();
  } catch (error) {
    fail(`GET ${API_URL}/settings failed: ${error instanceof Error ? error.message : error}`);
    return;
  }

  const ready = settings?.runtimeReadiness;
  const count =
    typeof ready?.enabledRuntimeProfileCount === "number" ? ready.enabledRuntimeProfileCount : 0;
  if (count <= 0) {
    fail(
      [
        "no enabled runtime profile configured in the stack",
        "The LLM lane needs at least one enabled runtime profile (runtimeReadiness.enabledRuntimeProfileCount > 0).",
        "Configure a runtime profile (Claude/Codex/OpenRouter) via Runtime Profiles UI or API, then re-run.",
      ].join("\n"),
    );
    return;
  }

  log(
    `preflight OK: AIF_LLM_INTEGRATION=1, enabled runtime profiles=${count} (gitProvider=${settings?.gitProvider ?? "?"})`,
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
