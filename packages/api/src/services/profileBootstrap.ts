import { getEnv, logger } from "@aif/shared";
import {
  createRuntimeProfile,
  listRuntimeProfiles,
  updateAppSettings,
  updateRuntimeProfile,
  type RuntimeProfileRow,
} from "@aif/data";

const log = logger("profile-bootstrap");

export interface ProfileBootstrapResult {
  /** What the seed did this boot. */
  action: "created" | "updated" | "skipped" | "disabled";
  /** Id of the effective global profile (null when disabled / nothing to do). */
  profileId: string | null;
  name: string;
}

/**
 * Auto-provision a global runtime profile from environment variables at API
 * startup (gitlab-demo.md steps 3.1 + 3.3 automation).
 *
 * Gated by `AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED` (default `false`), so
 * existing installs — including Codex OAuth (`codex login`) setups — keep their
 * current behavior. Idempotent: when a global profile with the configured name
 * already exists it is left untouched unless `AIF_BOOTSTRAP_FORCE_UPDATE=true`.
 * No secrets are persisted — only the name of the API-key env var.
 */
export function seedBootstrapRuntimeProfile(): ProfileBootstrapResult {
  const env = getEnv();
  const name = env.AIF_BOOTSTRAP_RUNTIME_PROFILE_NAME;

  if (!env.AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED) {
    log.debug({ name }, "Runtime profile bootstrap disabled; skipping");
    return { action: "disabled", profileId: null, name };
  }

  // CODEX_BASE_URL is intentionally not part of the env schema (lower layers
  // read it from process.env directly), so resolve it here the same way.
  const codexBaseUrl = process.env.CODEX_BASE_URL?.trim() || null;
  const baseUrl = env.AIF_BOOTSTRAP_BASE_URL?.trim() || codexBaseUrl;
  const defaultModel = env.AIF_BOOTSTRAP_DEFAULT_MODEL?.trim() || env.OPENAI_MODEL?.trim() || null;

  if (!process.env[env.AIF_BOOTSTRAP_API_KEY_ENV_VAR]) {
    log.warn(
      { apiKeyEnvVar: env.AIF_BOOTSTRAP_API_KEY_ENV_VAR },
      "Runtime profile bootstrap: referenced API-key env var is not set; runs will fail validation",
    );
  }

  const existing = listRuntimeProfiles({ includeGlobal: true }).find(
    (profile) => profile.name === name,
  );

  let profile: RuntimeProfileRow | undefined;
  let action: ProfileBootstrapResult["action"];

  const fields = {
    runtimeId: env.AIF_BOOTSTRAP_RUNTIME_ID,
    providerId: env.AIF_BOOTSTRAP_PROVIDER_ID,
    transport: env.AIF_BOOTSTRAP_TRANSPORT,
    baseUrl,
    apiKeyEnvVar: env.AIF_BOOTSTRAP_API_KEY_ENV_VAR,
    defaultModel,
    enabled: true,
  };

  if (existing) {
    if (!env.AIF_BOOTSTRAP_FORCE_UPDATE) {
      log.info(
        { profileId: existing.id, name },
        "Runtime profile bootstrap: global profile already exists; skipping",
      );
      profile = existing;
      action = "skipped";
    } else {
      profile = updateRuntimeProfile(existing.id, fields);
      action = "updated";
      log.info(
        { profileId: existing.id, name },
        "Runtime profile bootstrap: updated profile from env",
      );
    }
  } else {
    profile = createRuntimeProfile({ projectId: null, name, ...fields });
    action = "created";
    log.info({ profileId: profile?.id, name }, "Runtime profile bootstrap: created global profile");
  }

  if (profile && env.AIF_BOOTSTRAP_SET_DEFAULTS) {
    updateAppSettings({
      defaultTaskRuntimeProfileId: profile.id,
      defaultPlanRuntimeProfileId: profile.id,
      defaultReviewRuntimeProfileId: profile.id,
      defaultChatRuntimeProfileId: profile.id,
    });
    log.info(
      { profileId: profile.id },
      "Runtime profile bootstrap: applied app-wide runtime defaults",
    );
  }

  return { action, profileId: profile?.id ?? null, name };
}
