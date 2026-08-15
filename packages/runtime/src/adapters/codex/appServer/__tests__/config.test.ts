import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexHome, ensureCodexProviderConfig, providerNameFromBaseUrl } from "../../config.js";

describe("codex provider config", () => {
  let home: string;
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    home = join(tmpdir(), `codex-config-${Math.random().toString(36).slice(2)}`);
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  it("resolves codexHome from CODEX_HOME else ~/.codex", () => {
    expect(codexHome()).toBe(home);
    delete process.env.CODEX_HOME;
    expect(codexHome()).toContain(".codex");
  });

  it("derives provider name from the base URL host", () => {
    expect(providerNameFromBaseUrl("https://routerai.ru/api/v1")).toBe("routerai");
    expect(providerNameFromBaseUrl("https://api.openai.com/v1")).toBe("api");
    expect(providerNameFromBaseUrl("not-a-url")).toBe("custom");
  });

  it("writes a provider block and selects model_provider", () => {
    const result = ensureCodexProviderConfig({
      baseUrl: "https://routerai.ru/api/v1",
      apiKeyEnvVar: "OPENAI_API_KEY",
      model: "deepseek/deepseek-v4-flash",
    });

    expect(result.providerName).toBe("routerai");
    const configPath = join(home, "config.toml");
    expect(existsSync(configPath)).toBe(true);
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain('model_provider = "routerai"');
    expect(text).toContain("[model_providers.routerai]");
    expect(text).toContain('base_url = "https://routerai.ru/api/v1"');
    expect(text).toContain('env_key = "OPENAI_API_KEY"');
    expect(text).toContain('wire_api = "responses"');
  });

  it("preserves existing content and is idempotent", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), '[mcp_servers.handoff]\ncommand = "npx"\n', "utf8");

    ensureCodexProviderConfig({
      baseUrl: "https://routerai.ru/api/v1",
      apiKeyEnvVar: "OPENAI_API_KEY",
    });
    const first = readFileSync(join(home, "config.toml"), "utf8");
    expect(first).toContain("[mcp_servers.handoff]");
    expect(first).toContain("[model_providers.routerai]");
    expect(first).toContain('model_provider = "routerai"');

    // Second call must not duplicate the block.
    ensureCodexProviderConfig({
      baseUrl: "https://routerai.ru/api/v1",
      apiKeyEnvVar: "OPENAI_API_KEY",
    });
    const second = readFileSync(join(home, "config.toml"), "utf8");
    expect(second.match(/\[model_providers\.routerai\]/g)).toHaveLength(1);
    expect(second.match(/model_provider = "routerai"/g)).toHaveLength(1);
  });
});
