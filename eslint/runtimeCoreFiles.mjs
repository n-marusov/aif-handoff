/**
 * Single source of truth for the runtime-core file list.
 *
 * Runtime CORE (everything outside `adapters/**`) must not import concrete adapters —
 * they are wired through the registry/bootstrap. The ban is expressed as an explicit
 * file list in `eslint.config.mjs`; this module is imported by BOTH the ESLint config
 * and the guard test (`packages/runtime/src/__tests__/runtimeCoreGuard.test.ts`) so the
 * two can never drift.
 *
 * Known issue: "ESLint runtime-core: запрет adapters завязан на явный список файлов" —
 * a new core file had to be added here manually or it silently bypassed the ban. The
 * guard test now fails whenever a top-level `packages/runtime/src/*.ts` file is missing.
 */
export const RUNTIME_CORE_FILES = [
  "packages/runtime/src/index.ts",
  "packages/runtime/src/types.ts",
  "packages/runtime/src/registry.ts",
  "packages/runtime/src/bootstrap.ts",
  "packages/runtime/src/resolution.ts",
  "packages/runtime/src/capabilities.ts",
  "packages/runtime/src/promptPolicy.ts",
  "packages/runtime/src/workflowSpec.ts",
  "packages/runtime/src/modelDiscovery.ts",
  "packages/runtime/src/cache.ts",
  "packages/runtime/src/errors.ts",
  "packages/runtime/src/trust.ts",
  "packages/runtime/src/module.ts",
  "packages/runtime/src/timeouts.ts",
  "packages/runtime/src/languagePolicy.ts",
  "packages/runtime/src/limitEvents.ts",
  "packages/runtime/src/limitState.ts",
  "packages/runtime/src/modelEffort.ts",
  "packages/runtime/src/openaiRateLimits.ts",
  "packages/runtime/src/projectInit.ts",
  "packages/runtime/src/proxyEnv.ts",
  "packages/runtime/src/shellSafety.ts",
  "packages/runtime/src/toolEvents.ts",
  "packages/runtime/src/usageSink.ts",
  "packages/runtime/src/utils.ts",
];
