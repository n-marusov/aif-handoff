/**
 * Глобальные настройки приложения: дефолты рантаймов, состояние MCP и файл
 * .ai-factory/config.yaml проекта.
 *
 * Почему модуль устроен именно так:
 * - Дефолты рантаймов отдаются в двух формах: сохраненные значения и resolved*
 *   поля, вычисленные слоем данных. UI показывает оба набора, чтобы было
 *   видно, что реально применится при отсутствии явной настройки.
 * - Часть настроек читается только из окружения (getEnv) и не меняется через
 *   API: они отражаются в ответе, но не принимаются в теле запроса.
 * - MCP-маршруты проходят по всем зарегистрированным рантаймам и собирают
 *   результат отдельно по каждому: один сломанный адаптер не должен ломать
 *   установку в остальные, поэтому ошибки гасятся в теле ответа.
 * - Установка выбирает транспорт по MCP_PORT: валидный порт означает HTTP,
 *   иначе stdio. Выбор делается здесь, потому что клиент не знает, как
 *   развернут сервер, а неверный вариант просто не запустится.
 * - config.yaml читается и пишется целиком: точечные правки невозможны без
 *   потери комментариев и порядка ключей, а файл принадлежит пользователю.
 * - После записи кэш конфига проекта сбрасывается: иначе агент продолжит
 *   работать со старыми настройками до рестарта.
 */
import { Hono } from "hono";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import {
  findProjectById,
  getAppDefaultRuntimeProfileId,
  getAppSettings,
  listRuntimeProfiles,
  updateAppSettings,
} from "@aif/data";
import {
  logger,
  findMonorepoRoot,
  getEnv,
  clearProjectConfigCache,
  parseMcpPortSetting,
} from "@aif/shared";
import type { RuntimeMcpInstallInput } from "@aif/runtime";
import { updateAppRuntimeDefaultsSchema } from "../schemas.js";
import { jsonValidator } from "../middleware/zodValidator.js";
import { getApiRuntimeRegistry } from "../services/runtime.js";
import { validateAppRuntimeDefaultSelections } from "../services/runtimeProfileScope.js";

const log = logger("api:settings");

const MCP_SERVER_NAME = "handoff";
// Корень монорепозитория вычисляется от расположения файла: путь нужен для
// stdio-варианта MCP, и его нельзя брать из cwd процесса.
const MONOREPO_ROOT = findMonorepoRoot(import.meta.dirname);

// Единая точка описания MCP-записи: и установка, и проверка статуса должны
// говорить об одном и том же сервере.
function buildMcpServerEntry(): RuntimeMcpInstallInput {
  const env = getEnv();
  const parsedPort = parseMcpPortSetting(process.env.MCP_PORT);

  if (parsedPort.status === "valid") {
    // HTTP-транспорт предпочтителен, когда порт задан явно: один процесс на
    // несколько клиентов дешевле, чем stdio-процесс на каждое окно редактора.
    return {
      serverName: MCP_SERVER_NAME,
      transport: "streamable_http",
      url: `http://localhost:${parsedPort.value}/mcp`,
    };
  }

  return {
    serverName: MCP_SERVER_NAME,
    transport: "stdio",
    // DATABASE_URL и PROJECTS_DIR пересчитываются в абсолютные пути: cwd
    // MCP-процесса не совпадает с корнем проекта.
    command: "npx",
    args: ["tsx", join(MONOREPO_ROOT, "packages/mcp/src/index.ts")],
    cwd: MONOREPO_ROOT,
    env: {
      MCP_TRANSPORT: "stdio",
      DATABASE_URL: join(MONOREPO_ROOT, env.DATABASE_URL),
      PROJECTS_DIR: join(MONOREPO_ROOT, process.env.PROJECTS_DIR || ".projects"),
      LOG_LEVEL: "info",
      LOG_DESTINATION: "stderr",
    },
  };
}

// Возвращает null вместо исключения: для маршрута это штатный случай
// отсутствующего projectId, и он превращается в 400.
function resolveConfigPath(projectId: string | undefined): string | null {
  if (!projectId) return null;
  const project = findProjectById(projectId);
  if (!project) return null;
  return join(project.rootPath, ".ai-factory", "config.yaml");
}

// resolved* поля считает слой данных с учетом окружения и профилей проекта,
// поэтому они не совпадают с сохраненными значениями, когда те пусты.
export function buildAppRuntimeDefaultsResponse() {
  const settings = getAppSettings();
  return {
    defaultTaskRuntimeProfileId: settings.defaultTaskRuntimeProfileId,
    defaultPlanRuntimeProfileId: settings.defaultPlanRuntimeProfileId,
    defaultReviewRuntimeProfileId: settings.defaultReviewRuntimeProfileId,
    defaultChatRuntimeProfileId: settings.defaultChatRuntimeProfileId,
    resolvedDefaultTaskRuntimeProfileId: getAppDefaultRuntimeProfileId("task"),
    resolvedDefaultPlanRuntimeProfileId: getAppDefaultRuntimeProfileId("plan"),
    resolvedDefaultReviewRuntimeProfileId: getAppDefaultRuntimeProfileId("review"),
    resolvedDefaultChatRuntimeProfileId: getAppDefaultRuntimeProfileId("chat"),
  };
}

export async function buildSettingsOverview() {
  const env = getEnv();
  const appRuntimeDefaults = buildAppRuntimeDefaultsResponse();
  log.debug({ warmupEnabled: env.AIF_WARMUP_ENABLED }, "Resolved warmup feature flag");

  try {
    const registry = await getApiRuntimeRegistry();
    const runtimeProfiles = listRuntimeProfiles();
    const enabledProfiles = runtimeProfiles.filter((profile) => profile.enabled);
    return {
      useSubagents: env.AGENT_USE_SUBAGENTS,
      maxReviewIterations: env.AGENT_MAX_REVIEW_ITERATIONS,
      autoReviewStrategy: env.AGENT_AUTO_REVIEW_STRATEGY,
      usageLimitsEnabled: env.AIF_USAGE_LIMITS_ENABLED,
      warmupEnabled: env.AIF_WARMUP_ENABLED,
      qaPipelineEnabled: env.AIF_QA_PIPELINE_ENABLED,
      agentStageStaleTimeoutMs: env.AGENT_STAGE_STALE_TIMEOUT_MS,
      agentActivitySilenceMs: env.AGENT_ACTIVITY_SILENCE_MS,
      githubIssuePrEnabled: env.AIF_GITHUB_ISSUE_PR_ENABLED,
      gitProvider: env.GIT_PROVIDER,
      gitlabIssueMrEnabled: env.AIF_GITLAB_ISSUE_MR_ENABLED,
      runtimeReadiness: {
        availableRuntimeCount: registry.listRuntimes().length,
        runtimeProfileCount: runtimeProfiles.length,
        enabledRuntimeProfileCount: enabledProfiles.length,
      },
      runtimeDefaults: {
        modules: env.AIF_RUNTIME_MODULES,
        openAiBaseUrlConfigured: Boolean(env.OPENAI_BASE_URL),
        codexCliPathConfigured: Boolean(env.CODEX_CLI_PATH),
        app: appRuntimeDefaults,
      },
    };
  } catch (error) {
    // Отказ реестра рантаймов не должен ронять сводку: остальные настройки
    // полезны и без него, поэтому в catch собирается тот же ответ с нулями.
    log.error({ error }, "Failed to include runtime settings payload");
    const allProfiles = listRuntimeProfiles();
    const enabledProfiles = listRuntimeProfiles({ enabledOnly: true });
    return {
      useSubagents: env.AGENT_USE_SUBAGENTS,
      maxReviewIterations: env.AGENT_MAX_REVIEW_ITERATIONS,
      autoReviewStrategy: env.AGENT_AUTO_REVIEW_STRATEGY,
      usageLimitsEnabled: env.AIF_USAGE_LIMITS_ENABLED,
      warmupEnabled: env.AIF_WARMUP_ENABLED,
      qaPipelineEnabled: env.AIF_QA_PIPELINE_ENABLED,
      agentStageStaleTimeoutMs: env.AGENT_STAGE_STALE_TIMEOUT_MS,
      agentActivitySilenceMs: env.AGENT_ACTIVITY_SILENCE_MS,
      githubIssuePrEnabled: env.AIF_GITHUB_ISSUE_PR_ENABLED,
      gitProvider: env.GIT_PROVIDER,
      gitlabIssueMrEnabled: env.AIF_GITLAB_ISSUE_MR_ENABLED,
      runtimeReadiness: {
        availableRuntimeCount: 0,
        runtimeProfileCount: allProfiles.length,
        enabledRuntimeProfileCount: enabledProfiles.length,
      },
      runtimeDefaults: {
        modules: env.AIF_RUNTIME_MODULES,
        openAiBaseUrlConfigured: Boolean(env.OPENAI_BASE_URL),
        codexCliPathConfigured: Boolean(env.CODEX_CLI_PATH),
        app: appRuntimeDefaults,
      },
    };
  }
}

export const settingsRoutes = new Hono();

settingsRoutes.get("/runtime-defaults", (c) => {
  return c.json(buildAppRuntimeDefaultsResponse());
});

// Валидация выбора профилей отделена от zod-схемы: ей нужно обращаться к базе
// (проверять существование и область видимости профилей).
settingsRoutes.put("/runtime-defaults", jsonValidator(updateAppRuntimeDefaultsSchema), (c) => {
  const body = c.req.valid("json");
  log.debug({ body }, "[settings] Runtime defaults update requested");

  const validation = validateAppRuntimeDefaultSelections(body);
  if (validation) {
    log.warn({ fieldErrors: validation.fieldErrors }, "Rejected invalid app runtime defaults");
    return c.json(validation, 400);
  }

  updateAppSettings(body);
  const response = buildAppRuntimeDefaultsResponse();
  log.info({ runtimeDefaults: response }, "Updated app runtime defaults");
  return c.json(response);
});

/** Статус MCP-серверов во всех зарегистрированных рантаймах */
settingsRoutes.get("/mcp", async (c) => {
  const registry = await getApiRuntimeRegistry();
  const runtimes = registry.listRuntimes();
  const statuses: Array<{ runtimeId: string; installed: boolean; config?: unknown }> = [];

  for (const descriptor of runtimes) {
    const adapter = registry.tryResolveRuntime(descriptor.id);
    // Опрашиваются только адаптеры с поддержкой MCP: отсутствие метода означает,
    // что рантайм в принципе не умеет хранить такую запись.
    if (!adapter?.getMcpStatus) continue;
    try {
      const status = await adapter.getMcpStatus({ serverName: MCP_SERVER_NAME });
      statuses.push({
        runtimeId: descriptor.id,
        installed: status.installed,
        config: status.config,
      });
    } catch (err) {
      log.warn({ runtimeId: descriptor.id, err }, "Failed to check MCP status");
      statuses.push({ runtimeId: descriptor.id, installed: false });
    }
  }

  const anyInstalled = statuses.some((s) => s.installed);
  return c.json({
    installed: anyInstalled,
    serverName: MCP_SERVER_NAME,
    runtimes: statuses,
  });
});

/** Установить MCP-сервер во все зарегистрированные рантаймы, где это поддержено */
settingsRoutes.post("/mcp/install", async (c) => {
  const entry = buildMcpServerEntry();
  const registry = await getApiRuntimeRegistry();
  const runtimes = registry.listRuntimes();
  const results: Array<{ runtimeId: string; success: boolean; error?: string }> = [];

  for (const descriptor of runtimes) {
    const adapter = registry.tryResolveRuntime(descriptor.id);
    if (!adapter?.installMcpServer) continue;
    try {
      await adapter.installMcpServer(entry);
      log.info(
        { runtimeId: descriptor.id, transport: entry.transport ?? "stdio" },
        "MCP server installed",
      );
      results.push({ runtimeId: descriptor.id, success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ runtimeId: descriptor.id, err }, "Failed to install MCP server");
      results.push({ runtimeId: descriptor.id, success: false, error: message });
    }
  }

  // Итоговый success только при успехе во всех рантаймах, при этом частичные
  // ошибки возвращаются рядом с флагами, чтобы клиент показал детали.
  return c.json({
    success: results.every((r) => r.success),
    serverName: MCP_SERVER_NAME,
    runtimes: results,
  });
});

/** Удалить MCP-сервер из всех зарегистрированных рантаймов */
// Удаление не откатывается: маршрут best-effort, поэтому в ответе всегда
// success - вызывающий код не должен ветвиться по частичным сбоям.
settingsRoutes.delete("/mcp", async (c) => {
  const registry = await getApiRuntimeRegistry();
  const runtimes = registry.listRuntimes();

  for (const descriptor of runtimes) {
    const adapter = registry.tryResolveRuntime(descriptor.id);
    if (!adapter?.uninstallMcpServer) continue;
    try {
      await adapter.uninstallMcpServer({ serverName: MCP_SERVER_NAME });
      log.info({ runtimeId: descriptor.id }, "MCP server removed");
    } catch (err) {
      log.error({ runtimeId: descriptor.id, err }, "Failed to remove MCP server");
    }
  }

  return c.json({ success: true });
});

/** Проверить, есть ли .ai-factory/config.yaml у проекта */
// Отдельный легкий маршрут для проверки существования файла: UI вызывает его
// перед тем, как запрашивать содержимое.
settingsRoutes.get("/config/status", (c) => {
  const configPath = resolveConfigPath(c.req.query("projectId"));
  if (!configPath) {
    return c.json({ error: "projectId is required" }, 400);
  }
  return c.json({ exists: existsSync(configPath), path: configPath });
});

/** Прочитать .ai-factory/config.yaml проекта */
settingsRoutes.get("/config", async (c) => {
  const configPath = resolveConfigPath(c.req.query("projectId"));
  if (!configPath) {
    return c.json({ error: "projectId is required" }, 400);
  }
  if (!existsSync(configPath)) {
    return c.json({ error: "config.yaml not found" }, 404);
  }
  try {
    const raw = await readFile(configPath, "utf-8");
    // Содержимое не валидируется схемой: файл принадлежит пользователю, и
    // незнакомые ключи должны пережить чтение.
    const config = YAML.parse(raw) as Record<string, unknown>;
    return c.json({ config });
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to read config.yaml",
    );
    return c.json({ error: "Failed to read config.yaml" }, 500);
  }
});

/** Записать .ai-factory/config.yaml проекта */
settingsRoutes.put("/config", async (c) => {
  const projectId = c.req.query("projectId");
  const configPath = resolveConfigPath(projectId);
  if (!configPath) {
    return c.json({ error: "projectId is required" }, 400);
  }
  try {
    const { config } = await c.req.json<{ config: Record<string, unknown> }>();
    if (!config || typeof config !== "object") {
      return c.json({ error: "config must be an object" }, 400);
    }
    const yaml = YAML.stringify(config, {
      // lineWidth: 0 отключает перенос длинных строк, иначе stringify
      // переформатирует пользовательские значения.
      lineWidth: 0,
      defaultKeyType: "PLAIN",
      defaultStringType: "PLAIN",
    });
    await writeFile(configPath, yaml, "utf-8");
    const project = findProjectById(projectId!);
    // Кэш сбрасывается после успешной записи: агент читает конфиг через
    // общий кэш, и без сброса изменения не увидит.
    if (project) clearProjectConfigCache(project.rootPath);
    log.info({ projectId }, "config.yaml updated");
    return c.json({ success: true });
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to write config.yaml",
    );
    return c.json({ error: "Failed to write config.yaml" }, 500);
  }
});
