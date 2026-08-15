import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@aif/shared";

const log = logger("codex-config");

/** Resolve the Codex home directory ($CODEX_HOME or ~/.codex). */
export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/** Derive a stable provider name from a base URL host (e.g. routerai.ru → routerai). */
export function providerNameFromBaseUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname;
    return host.split(".")[0] ?? "custom";
  } catch {
    return "custom";
  }
}

export interface EnsureCodexProviderConfigInput {
  baseUrl: string;
  apiKeyEnvVar: string;
  /** Optional default model id advertised in the provider block. */
  model?: string | null;
  /** Wire API for the provider. Codex CLI v0.145 uses `responses` for custom providers. */
  wireApi?: string;
  /** Explicit provider name; defaults to the baseUrl host's first label. */
  providerName?: string;
}

function blockExists(configText: string, header: string): boolean {
  return configText.includes(header);
}

/**
 * Ensure `~/.codex/config.toml` defines a custom model provider pointing at the
 * configured base URL and selects it as `model_provider`. This is required for
 * local Codex CLI transports against OpenAI-compatible gateways (e.g.
 * router.ai): the CLI reads `model_providers.<name>.base_url` from config.toml
 * and ignores OPENAI_BASE_URL / CODEX_BASE_URL env vars (see cli.ts
 * BLOCKED_ENV_KEYS).
 *
 * Idempotent: existing content (MCP servers, project trust, other providers) is
 * preserved; the provider block is only appended when missing, and the
 * `model_provider` top-level key is set once. Failures are non-fatal — the
 * caller logs them.
 */
export function ensureCodexProviderConfig(input: EnsureCodexProviderConfigInput): {
  providerName: string;
  configPath: string;
} {
  const providerName =
    input.providerName?.trim() || providerNameFromBaseUrl(input.baseUrl) || "custom";
  const configPath = join(codexHome(), "config.toml");
  const header = `[model_providers.${providerName}]`;

  try {
    mkdirSync(codexHome(), { recursive: true });
    const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";

    if (blockExists(existing, header)) {
      log.debug({ providerName, configPath }, "Codex provider config already present");
      return { providerName, configPath };
    }

    const providerBlock = [
      "",
      header,
      `name = "${providerName}"`,
      `base_url = "${input.baseUrl.replace(/\/+$/, "")}"`,
      `env_key = "${input.apiKeyEnvVar}"`,
      `wire_api = "${input.wireApi ?? "responses"}"`,
      ...(input.model?.trim() ? [`model = "${input.model.trim()}"`] : []),
      "",
    ].join("\n");

    const hasModelProvider = /^model_provider\s*=/.test(existing);
    const body = existing.trimEnd() + (existing.trim().length > 0 ? "\n" : "") + providerBlock;
    const withSelection = hasModelProvider
      ? body.replace(/^model_provider\s*=.*$/m, `model_provider = "${providerName}"`)
      : `model_provider = "${providerName}"\n` + body;

    writeFileSync(configPath, withSelection, { encoding: "utf8" });
    log.info(
      { providerName, configPath, baseUrl: input.baseUrl },
      "Configured Codex model provider",
    );
    return { providerName, configPath };
  } catch (err) {
    log.warn(
      { providerName, configPath, err: err instanceof Error ? err.message : String(err) },
      "Failed to write Codex provider config",
    );
    return { providerName, configPath };
  }
}
