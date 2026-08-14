import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { appSettings, resetEnvCache, runtimeProfiles } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };

vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

const { seedBootstrapRuntimeProfile } = await import("../services/profileBootstrap.js");

function stubBootstrapEnv(overrides: Record<string, string | undefined> = {}) {
  const defaults: Record<string, string> = {
    AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED: "true",
    AIF_BOOTSTRAP_RUNTIME_PROFILE_NAME: "Test Bootstrap",
    AIF_BOOTSTRAP_RUNTIME_ID: "codex",
    AIF_BOOTSTRAP_PROVIDER_ID: "openai",
    AIF_BOOTSTRAP_TRANSPORT: "cli",
    AIF_BOOTSTRAP_BASE_URL: "https://router.test/v1",
    AIF_BOOTSTRAP_API_KEY_ENV_VAR: "OPENAI_API_KEY",
    AIF_BOOTSTRAP_DEFAULT_MODEL: "test-model-1",
    AIF_BOOTSTRAP_SET_DEFAULTS: "true",
    AIF_BOOTSTRAP_FORCE_UPDATE: "false",
    OPENAI_API_KEY: "sk-test",
  };
  for (const [key, value] of Object.entries({ ...defaults, ...overrides })) {
    vi.stubEnv(key, value);
  }
  resetEnvCache();
}

function countProfiles(): number {
  return testDb.current.select().from(runtimeProfiles).all().length;
}

function findProfileByName(name: string) {
  return testDb.current.select().from(runtimeProfiles).where(eq(runtimeProfiles.name, name)).get();
}

function readAppSettings() {
  return testDb.current.select().from(appSettings).get();
}

describe("seedBootstrapRuntimeProfile", () => {
  beforeEach(() => {
    testDb.current = createTestDb();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("is a no-op when the flag is disabled", () => {
    stubBootstrapEnv({ AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED: "false" });

    const result = seedBootstrapRuntimeProfile();

    expect(result).toEqual({
      action: "disabled",
      profileId: null,
      name: "Test Bootstrap",
    });
    expect(countProfiles()).toBe(0);
  });

  it("creates a global enabled profile with the env values", () => {
    stubBootstrapEnv();

    const result = seedBootstrapRuntimeProfile();

    expect(result.action).toBe("created");
    const row = findProfileByName("Test Bootstrap");
    expect(row).toBeDefined();
    expect(row!.projectId).toBeNull();
    expect(row!.runtimeId).toBe("codex");
    expect(row!.providerId).toBe("openai");
    expect(row!.transport).toBe("cli");
    expect(row!.baseUrl).toBe("https://router.test/v1");
    expect(row!.apiKeyEnvVar).toBe("OPENAI_API_KEY");
    expect(row!.defaultModel).toBe("test-model-1");
    expect(row!.enabled).toBe(true);
  });

  it("applies app-wide runtime defaults to the created profile", () => {
    stubBootstrapEnv();

    seedBootstrapRuntimeProfile();

    const settings = readAppSettings();
    const row = findProfileByName("Test Bootstrap");
    expect(settings).toBeDefined();
    expect(settings!.defaultTaskRuntimeProfileId).toBe(row!.id);
    expect(settings!.defaultPlanRuntimeProfileId).toBe(row!.id);
    expect(settings!.defaultReviewRuntimeProfileId).toBe(row!.id);
    expect(settings!.defaultChatRuntimeProfileId).toBe(row!.id);
  });

  it("does not touch app defaults when AIF_BOOTSTRAP_SET_DEFAULTS=false", () => {
    stubBootstrapEnv({ AIF_BOOTSTRAP_SET_DEFAULTS: "false" });

    seedBootstrapRuntimeProfile();

    const settings = readAppSettings();
    expect(settings).toBeDefined();
    expect(settings!.defaultTaskRuntimeProfileId).toBeNull();
    expect(settings!.defaultChatRuntimeProfileId).toBeNull();
  });

  it("falls back to CODEX_BASE_URL and OPENAI_MODEL when explicit vars are unset", () => {
    stubBootstrapEnv({
      AIF_BOOTSTRAP_BASE_URL: undefined,
      AIF_BOOTSTRAP_DEFAULT_MODEL: undefined,
      CODEX_BASE_URL: "https://codex-router.test/v1",
      OPENAI_MODEL: "fallback-model",
    });

    seedBootstrapRuntimeProfile();

    const row = findProfileByName("Test Bootstrap");
    expect(row!.baseUrl).toBe("https://codex-router.test/v1");
    expect(row!.defaultModel).toBe("fallback-model");
  });

  it("is idempotent: a second call skips and does not duplicate", () => {
    stubBootstrapEnv();

    const first = seedBootstrapRuntimeProfile();
    const second = seedBootstrapRuntimeProfile();

    expect(first.action).toBe("created");
    expect(second.action).toBe("skipped");
    expect(second.profileId).toBe(first.profileId);
    expect(countProfiles()).toBe(1);
  });

  it("updates an existing profile when AIF_BOOTSTRAP_FORCE_UPDATE=true", () => {
    stubBootstrapEnv();
    seedBootstrapRuntimeProfile();

    stubBootstrapEnv({
      AIF_BOOTSTRAP_FORCE_UPDATE: "true",
      AIF_BOOTSTRAP_DEFAULT_MODEL: "updated-model",
    });
    const result = seedBootstrapRuntimeProfile();

    expect(result.action).toBe("updated");
    expect(countProfiles()).toBe(1);
    const row = findProfileByName("Test Bootstrap");
    expect(row!.defaultModel).toBe("updated-model");
  });
});
