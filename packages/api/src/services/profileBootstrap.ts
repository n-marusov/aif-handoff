/**
 * Автосоздание глобального runtime-профиля из переменных окружения на старте API
 * (шаги 3.1 и 3.3 сценария gitlab-demo).
 *
 * Почему по умолчанию выключено: у существующих установок уже есть свои профили
 * (в том числе настроенные через Codex OAuth), и молчаливое добавление нового
 * профиля изменило бы их поведение. Флаг AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED
 * делает включение осознанным шагом, а не побочным эффектом обновления.
 *
 * Инварианты:
 * - Идемпотентность: профиль с тем же именем не трогаем, если явно не задан
 *   AIF_BOOTSTRAP_FORCE_UPDATE.
 * - Секреты не сохраняются: в БД уходит только имя переменной с ключом
 *   (apiKeyEnvVar), сам ключ читает процесс рантайма при запуске.
 * - Отсутствие переменной с ключом не прерывает старт: профиль может быть
 *   настроен и использован позже, поэтому это warn, а не ошибка.
 */

import { getEnv, logger } from "@aif/shared";
import {
  createRuntimeProfile,
  listRuntimeProfiles,
  updateAppSettings,
  updateRuntimeProfile,
} from "@aif/data";

const log = logger("profile-bootstrap");

export interface ProfileBootstrapResult {
  /** Что именно сделал бутстрап при этом запуске. */
  // Значения различают причину бездействия специально: "disabled" - бутстрап
  // выключен флагом, "skipped" - профиль уже есть. Смешивать их в логах нельзя.
  action: "created" | "updated" | "skipped" | "disabled";
  /** Идентификатор итогового глобального профиля (null при disabled/нет действий). */
  profileId: string | null;
  name: string;
}

/**
 * Автосоздаёт глобальный runtime-профиль из переменных окружения при старте API
 * (шаги 3.1 и 3.3 в gitlab-demo.md).
 *
 * Включается флагом `AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED` (по умолчанию `false`),
 * чтобы существующие установки (включая Codex OAuth через `codex login`) не
 * меняли поведение неожиданно. Идемпотентно: если профиль с таким именем уже
 * существует, он не меняется без `AIF_BOOTSTRAP_FORCE_UPDATE=true`.
 * Секреты не сохраняются — сохраняется только имя env-переменной ключа API.
 */
export function seedBootstrapRuntimeProfile(): ProfileBootstrapResult {
  const env = getEnv();
  const name = env.AIF_BOOTSTRAP_RUNTIME_PROFILE_NAME;

  if (!env.AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED) {
    log.debug({ name }, "Runtime profile bootstrap disabled; skipping");
    return { action: "disabled", profileId: null, name };
  }

  // CODEX_BASE_URL намеренно не входит в env-схему (нижние слои читают его
  // напрямую из process.env), поэтому здесь используем тот же способ.
  // Читаем тем же способом, что нижние слои, иначе бутстрап видел бы иное
  // значение, чем сам адаптер при запуске.
  const codexBaseUrl = process.env.CODEX_BASE_URL?.trim() || null;
  // Цепочка фолбэков: явная переменная бутстрапа, затем Codex-совместимый
  // адрес. Пустая строка приводится к null, чтобы не перебивать валидацию.
  const baseUrl = env.AIF_BOOTSTRAP_BASE_URL?.trim() || codexBaseUrl;
  // Модель по умолчанию тоже ищем по цепочке: специальная переменная бутстрапа,
  // затем общая OPENAI_MODEL, иначе поле остаётся незаданным.
  const defaultModel = env.AIF_BOOTSTRAP_DEFAULT_MODEL?.trim() || env.OPENAI_MODEL?.trim() || null;

  if (!process.env[env.AIF_BOOTSTRAP_API_KEY_ENV_VAR]) {
    // Старт не прерываем: ключ может появиться в окружении позже, а профиль
    // всё равно полезен - его можно увидеть и поправить в UI.
    log.warn(
      { apiKeyEnvVar: env.AIF_BOOTSTRAP_API_KEY_ENV_VAR },
      "Runtime profile bootstrap: referenced API-key env var is not set; runs will fail validation",
    );
  }

  // Ищем только среди глобальных и сравниваем по имени: имя профиля - это
  // ключ идемпотентности всего бутстрапа.
  const existing = listRuntimeProfiles({ includeGlobal: true }).find(
    (profile) => profile.name === name,
  );

  let profile: ReturnType<typeof createRuntimeProfile>;
  let action: ProfileBootstrapResult["action"];

  // fields собирается один раз и используется и в create, и в update: иначе
  // набор полей мог бы разойтись между двумя ветками кода.
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
      // Профиль мог быть настроен вручную: без явного force-update не трогаем
      // его, иначе бутстрап затирал бы изменения пользователя при каждом старте.
      log.info(
        { profileId: existing.id, name },
        "Runtime profile bootstrap: global profile already exists; skipping",
      );
      profile = existing;
      action = "skipped";
    } else {
      // force-update перезаписывает поля целиком: это явно запрошенное
      // поведение, молчаливых частичных слияний здесь нет.
      profile = updateRuntimeProfile(existing.id, fields);
      action = "updated";
      log.info(
        { profileId: existing.id, name },
        "Runtime profile bootstrap: updated profile from env",
      );
    }
  } else {
    // projectId: null делает профиль глобальным, то есть доступным всем
    // проектам, а не только тому, из которого пришёл запрос.
    profile = createRuntimeProfile({ projectId: null, name, ...fields });
    action = "created";
    log.info({ profileId: profile?.id, name }, "Runtime profile bootstrap: created global profile");
  }

  if (profile && env.AIF_BOOTSTRAP_SET_DEFAULTS) {
    // Дефолты приложения меняем только по явному флагу: иначе бутстрап подменил
    // бы уже выбранные пользователем профили во всех четырёх слотах.
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

  // profile?.id ?? null покрывает случай, когда create вернул undefined:
  // результат всегда приводится к одному виду для вызывающего кода.
  return { action, profileId: profile?.id ?? null, name };
}
