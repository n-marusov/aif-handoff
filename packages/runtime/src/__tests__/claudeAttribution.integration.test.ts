import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeRuntimeAdapter } from "../adapters/claude/index.js";
import {
  CLAUDE_MIN_VERSION,
  isVersionBelowMin,
  readBundledClaudeVersion,
} from "../adapters/claude/version.js";
import type { RuntimeRunInput } from "../types.js";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";

/**
 * Поведенческий smoke-тест ранее падавшего пути `/chat` — запрошен в
 * ревью PR #162 («выполнить реальный путь адаптера Handoff SDK ... с
 * default-настройками подавления и подтвердить, что query стартует и завершается»).
 *
 * Прогоняет реальный адаптер end to end (`createClaudeRuntimeAdapter().run`):
 * `parseExecutionOptions` → version guard → `runClaudeRuntime` →
 * `buildClaudeQueryOptions` (применяет подавление по умолчанию
 * `settings.attribution = { commit: "", pr: "" }`) → Agent SDK `query` → поток.
 * Зелёный результат доказывает, что payload с пустым attribution стартует и завершается
 * на фактическом бинарнике Claude Code — регрессия HTTP 500 ушла.
 *
 * Под флагом: требует реального аутентифицированного `claude` на PATH и
 * `AIF_CLAUDE_INTEGRATION=1`. CI этому не удовлетворяет, поэтому основной
 * набор остаётся герметичным. Локальный запуск:
 *   AIF_CLAUDE_INTEGRATION=1 npx vitest run claudeAttribution.integration.test.ts
 *
 * Предыдущая версия файла утверждала, что сгенерированный git-коммит не содержит
 * трейлер Co-Authored-By. Утверждение было неразличающим: в пути Agent
 * SDK + Bash-commit трейлер не вставляется вне зависимости от attribution,
 * и тест проходил одинаково для `{ attribution: { commit: "", pr: "" } }`,
 * `{}` и без `settings` вообще — регрессию он поймать не мог. Заменён этим
 * smoke-тестом старта/завершения, который напрямую наблюдает
 * модуль отказа (exit-code 1 на старте).
 */
const ENABLED = process.env.AIF_CLAUDE_INTEGRATION === "1";

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe.skipIf(!ENABLED)("Claude runtime — default suppression settings (integration)", () => {
  it("starts and completes a run under the default empty-attribution settings", async () => {
    // Бинарник Claude Code, который Agent SDK реально запускает (встроенный
    // нативный, чья версия объявлена в манифесте SDK), обязан быть не ниже
    // поддерживаемого минимума — иначе version guard, задействованный в
    // adapter.run, отклонит запуск до старта, а это тоже корректный,
    // непрозрачный режим отказа. Чтение манифеста (а не проба `claude` на
    // PATH) держит пред-проверку в согласии с тем, что выполняет query().
    const version = readBundledClaudeVersion();
    expect(
      version && !isVersionBelowMin(version),
      `Bundled Claude Code ${version?.raw ?? "unknown"} is below the supported minimum ${CLAUDE_MIN_VERSION}`,
    ).toBe(true);

    const cwd = mkdtempSync(join(tmpdir(), "claude-attr-smoke-"));
    try {
      const adapter = createClaudeRuntimeAdapter({ logger: silentLogger });
      const input: RuntimeRunInput = {
        runtimeId: "claude",
        providerId: "anthropic",
        prompt: "Reply with exactly this and nothing else: OK",
        cwd,
        projectRoot: cwd,
        // Нет override `execution.hooks.settings` → buildClaudeQueryOptions
        // применит подавление по умолчанию { attribution: { commit: "", pr: "" } } —
        // ровно тот payload, на котором старые сборки Claude Code падали на старте.
        execution: { hooks: { runTimeoutMs: 60_000 } },
        usageContext: TEST_USAGE_CONTEXT,
      };

      const result = await adapter.run(input);

      // Завершено с выводом — запуск стартовал (не вышел с кодом 1) и
      // выдал результат через поток Agent SDK.
      expect(typeof result.outputText).toBe("string");
      expect((result.outputText ?? "").trim().length).toBeGreaterThan(0);
      const completed = (result.events ?? []).some((event) => event.type === "result:success");
      expect(completed).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 90_000);
});
