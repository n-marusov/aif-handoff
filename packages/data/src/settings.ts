/**
 * Репозиторий настроек приложения (singleton app_settings).
 */
import { eq } from "drizzle-orm";
import {
  appSettings,
  logger as createLogger,
  type AppSettings,
  type UpdateAppSettingsInput,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { findRuntimeProfileById } from "./runtimeProfiles.js";

const log = createLogger("data");

const APP_SETTINGS_ID = 1;

export type AppSettingsRow = typeof appSettings.$inferSelect;

export function toAppSettingsResponse(row: AppSettingsRow): AppSettings {
  return {
    id: row.id,
    defaultTaskRuntimeProfileId: row.defaultTaskRuntimeProfileId,
    defaultPlanRuntimeProfileId: row.defaultPlanRuntimeProfileId,
    defaultReviewRuntimeProfileId: row.defaultReviewRuntimeProfileId,
    defaultChatRuntimeProfileId: row.defaultChatRuntimeProfileId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function ensureAppSettingsRow(): AppSettingsRow {
  const db = getDb();
  // Строку с id=1 создаёт миграция 13. Запасной путь нужен для старых баз и тестов:
  // даже если схема пуста, чтение настроек должно возвращать пригодный объект.
  const existing = db.select().from(appSettings).where(eq(appSettings.id, APP_SETTINGS_ID)).get();
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  log.debug({ appSettingsId: APP_SETTINGS_ID }, "Seeding missing singleton app settings row");
  // Вставка идемпотентна: onConflictDoNothing позволяет двум параллельным вызовам
  // не упасть на гонке за единственную строку. Итоговый select поэтому обязателен —
  // нужную строку мог создать соседний вызов, а не мы.
  db
    .insert(appSettings)
    .values({
      id: APP_SETTINGS_ID,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();

  return db.select().from(appSettings).where(eq(appSettings.id, APP_SETTINGS_ID)).get()!;
}

export function getAppSettings(): AppSettingsRow {
  const settings = ensureAppSettingsRow();
  log.debug({ appSettingsId: settings.id }, "Loaded app settings");
  return settings;
}

export function updateAppSettings(input: UpdateAppSettingsInput): AppSettingsRow {
  ensureAppSettingsRow();

  const patch: Partial<AppSettingsRow> = {
    updatedAt: new Date().toISOString(),
  };
  if (input.defaultTaskRuntimeProfileId !== undefined) {
    patch.defaultTaskRuntimeProfileId = input.defaultTaskRuntimeProfileId;
  }
  if (input.defaultPlanRuntimeProfileId !== undefined) {
    patch.defaultPlanRuntimeProfileId = input.defaultPlanRuntimeProfileId;
  }
  if (input.defaultReviewRuntimeProfileId !== undefined) {
    patch.defaultReviewRuntimeProfileId = input.defaultReviewRuntimeProfileId;
  }
  if (input.defaultChatRuntimeProfileId !== undefined) {
    patch.defaultChatRuntimeProfileId = input.defaultChatRuntimeProfileId;
  }

  log.debug(
    {
      appSettingsId: APP_SETTINGS_ID,
      defaultTaskRuntimeProfileId: input.defaultTaskRuntimeProfileId ?? null,
      defaultPlanRuntimeProfileId: input.defaultPlanRuntimeProfileId ?? null,
      defaultReviewRuntimeProfileId: input.defaultReviewRuntimeProfileId ?? null,
      defaultChatRuntimeProfileId: input.defaultChatRuntimeProfileId ?? null,
    },
    "Updating app settings runtime defaults",
  );

  getDb()
    .update(appSettings)
    .set(patch)
    .where(eq(appSettings.id, APP_SETTINGS_ID))
    .run();

  return ensureAppSettingsRow();
}

export function getAppDefaultRuntimeProfileId(
  mode: "task" | "plan" | "review" | "chat",
): string | null {
  const settings = getAppSettings();
  const candidates =
    mode === "chat"
      ? [{ slot: "chat", profileId: settings.defaultChatRuntimeProfileId }]
      : mode === "plan"
        ? [
            { slot: "plan", profileId: settings.defaultPlanRuntimeProfileId },
            { slot: "task", profileId: settings.defaultTaskRuntimeProfileId },
          ]
        : mode === "review"
          ? [
              { slot: "review", profileId: settings.defaultReviewRuntimeProfileId },
              { slot: "task", profileId: settings.defaultTaskRuntimeProfileId },
            ]
          : [{ slot: "task", profileId: settings.defaultTaskRuntimeProfileId }];

  const seenProfileIds = new Set<string>();

  // Профиль берётся из цепочки кандидатов: специфичный для режима, затем общий
  // task-профиль. Отклонённый кандидат (удалён, отключён, принадлежит проекту) не
  // считается ошибкой — просто передаёт ход следующему. Множество seenProfileIds
  // защищает от повторной проверки одного и того же id в цепочке.
  for (const candidate of candidates) {
    if (!candidate.profileId || seenProfileIds.has(candidate.profileId)) continue;
    seenProfileIds.add(candidate.profileId);

    const profile = findRuntimeProfileById(candidate.profileId);
    if (!profile) {
      log.warn(
        { mode, appDefaultSlot: candidate.slot, runtimeProfileId: candidate.profileId },
        "App runtime default points to a missing profile",
      );
      continue;
    }
    if (profile.projectId != null) {
      log.warn(
        {
          mode,
          appDefaultSlot: candidate.slot,
          runtimeProfileId: candidate.profileId,
          ownerProjectId: profile.projectId,
        },
        "App runtime default points to a project-scoped profile",
      );
      continue;
    }
    if (!profile.enabled) {
      log.warn(
        { mode, appDefaultSlot: candidate.slot, runtimeProfileId: candidate.profileId },
        "App runtime default points to a disabled profile",
      );
      continue;
    }

    return profile.id;
  }

  return null;
}
