import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runCodexAgentApi, validateCodexAgentApiConnection } from "../adapters/codex/api.js";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }

  const raw = readFileSync(filePath, "utf8");
  const parsed: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) {
      continue;
    }

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

function loadIntegrationEnvFromFile(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "../../../../.env.integration");
  const fileValues = readEnvFile(envPath);

  for (const [key, value] of Object.entries(fileValues)) {
    if (!process.env[key] && value.length > 0) {
      process.env[key] = value;
    }
  }
}

loadIntegrationEnvFromFile();

const ENABLED = process.env.AIF_LLM_INTEGRATION === "1";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL?.trim() ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() ?? "";
const READY = OPENAI_BASE_URL.length > 0 && OPENAI_API_KEY.length > 0 && OPENAI_MODEL.length > 0;

describe.skipIf(!ENABLED || !READY)("Codex API LLM integration", () => {
  it("validates OpenAI-compatible connection using integration env", async () => {
    const validation = await validateCodexAgentApiConnection({
      runtimeId: "codex",
      providerId: "openai",
      options: {
        baseUrl: OPENAI_BASE_URL,
        apiKey: OPENAI_API_KEY,
      },
    });

    expect(validation.ok, validation.message).toBe(true);
  }, 60_000);

  it("runs a real non-stream chat/completions request", async () => {
    const result = await runCodexAgentApi(
      {
        runtimeId: "codex",
        providerId: "openai",
        profileId: "integration-profile",
        workflowKind: "qa",
        prompt: "Reply with exactly this and nothing else: OK",
        model: OPENAI_MODEL,
        usageContext: TEST_USAGE_CONTEXT,
        execution: { runTimeoutMs: 60_000 },
        options: {
          baseUrl: OPENAI_BASE_URL,
          apiKey: OPENAI_API_KEY,
          apiRetryCount: 1,
          headers: {
            "X-AIF-Integration": "codex-api",
          },
        },
      },
      {
        debug() {},
        info() {},
        warn() {},
      },
    );

    expect(typeof result.outputText).toBe("string");
    expect((result.outputText ?? "").trim().length).toBeGreaterThan(0);
    expect(result.sessionId == null || typeof result.sessionId === "string").toBe(true);
    expect(result.usage == null || typeof result.usage.totalTokens === "number").toBe(true);
  }, 90_000);
});
