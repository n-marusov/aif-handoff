/**
 * Контрактный сьют для адаптер-декларируемых метаданных резолвинга.
 *
 * Task 9 is tests-first: эти тесты фиксируют ЦЕЛЕВОЙ интерфейс descriptor,
 * который Task 10 должен реализовать во всех четырёх адаптерах. Пока поля
 * (`apiKeyEnvCandidates`, `defaultBaseUrl`, `effort`) отсутствуют в
 * `RuntimeDescriptor`, тесты падают — это и есть «красная» стадия TDD.
 *
 * Новая декларация не дублирует существующие `defaultApiKeyEnvVar` /
 * `defaultBaseUrlEnvVar` (одиночные подсказки UI), а расширяет их машинно
 * используемыми данными резолвинга:
 * - `apiKeyEnvCandidates` — упорядоченный список env-имён для пробы ключа;
 * - `defaultBaseUrl`     — конкретный базовый URL по умолчанию (или null, если
 *                          библиотека провайдера решает сама);
 * - `defaultTransport`   — уже существует в descriptor и проверяется тут же;
 * - `effort`             — имя options-ключа и fallback-уровни reasoning-effort.
 */

import { describe, it, expect } from "vitest";
import { createClaudeRuntimeAdapter } from "../adapters/claude/index.js";
import { createCodexRuntimeAdapter } from "../adapters/codex/index.js";
import { createOpenCodeRuntimeAdapter } from "../adapters/opencode/index.js";
import { createOpenRouterRuntimeAdapter } from "../adapters/openrouter/index.js";
import {
  CLAUDE_MODEL_EFFORT_LEVELS,
  CODEX_MODEL_EFFORT_LEVELS,
  OPENCODE_MODEL_EFFORT_LEVELS,
  OPENROUTER_MODEL_EFFORT_LEVELS,
} from "../modelEffort.js";
import { RuntimeTransport } from "../types.js";

function descriptors() {
  return {
    claude: createClaudeRuntimeAdapter().descriptor,
    codex: createCodexRuntimeAdapter().descriptor,
    opencode: createOpenCodeRuntimeAdapter().descriptor,
    openrouter: createOpenRouterRuntimeAdapter().descriptor,
  };
}

describe("adapter-declared resolution metadata (contract)", () => {
  it("declares ordered API key env candidates per adapter", () => {
    const d = descriptors();
    // Claude: явный ключ важнее auth-токена (иерархия из inferDefaultApiKeyEnvVar).
    expect(d.claude.apiKeyEnvCandidates).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
    expect(d.codex.apiKeyEnvCandidates).toContain("OPENAI_API_KEY");
    expect(d.openrouter.apiKeyEnvCandidates).toContain("OPENROUTER_API_KEY");
    expect(d.opencode.apiKeyEnvCandidates.length).toBeGreaterThan(0);
  });

  it("declares a default base URL (or null when the provider library decides)", () => {
    const d = descriptors();
    // OpenRouter — публичный SaaS: конкретный fallback URL.
    expect(d.openrouter.defaultBaseUrl).toBe("https://openrouter.ai/api/v1");
    // Anthropic SDK знает свой адрес сам — null означает «не подменять».
    expect(d.claude.defaultBaseUrl).toBeNull();
    // Codex sdk/cli молчит по умолчанию (OAuth) — null.
    expect(d.codex.defaultBaseUrl).toBeNull();
    expect(typeof d.opencode.defaultBaseUrl).toBe("string");
  });

  it("declares the default transport per adapter", () => {
    const d = descriptors();
    expect(d.claude.defaultTransport).toBe(RuntimeTransport.SDK);
    expect(d.codex.defaultTransport).toBe(RuntimeTransport.CLI);
    expect(d.openrouter.defaultTransport).toBe(RuntimeTransport.API);
    expect(d.opencode.defaultTransport).toBe(RuntimeTransport.API);
  });

  it("declares the effort option key per adapter", () => {
    const d = descriptors();
    expect(d.claude.effort.optionKey).toBe("effort");
    expect(d.codex.effort.optionKey).toBe("modelReasoningEffort");
    expect(d.opencode.effort.optionKey).toBe("reasoningEffort");
    expect(d.openrouter.effort.optionKey).toBe("effort");
  });

  it("declares the fallback effort level sets per adapter", () => {
    const d = descriptors();
    expect(d.claude.effort.fallbackLevels).toEqual([...CLAUDE_MODEL_EFFORT_LEVELS]);
    expect(d.codex.effort.fallbackLevels).toEqual([...CODEX_MODEL_EFFORT_LEVELS]);
    expect(d.opencode.effort.fallbackLevels).toEqual([...OPENCODE_MODEL_EFFORT_LEVELS]);
    expect(d.openrouter.effort.fallbackLevels).toEqual([...OPENROUTER_MODEL_EFFORT_LEVELS]);
  });
});
