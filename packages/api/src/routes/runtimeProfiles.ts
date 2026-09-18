/**
 * Маршруты профилей рантайма (@aif/api).
 *
 * Профиль рантайма отвечает на вопрос "чем исполнять": адаптер (runtimeId),
 * провайдер, транспорт, базовый URL, ИМЯ переменной окружения с ключом доступа и
 * модель по умолчанию. Профили хранятся в БД и переопределяются по уровням, а
 * разрешение идёт по цепочке задача -> проект -> система -> env. Сам порядок
 * выбора живёт в @aif/runtime, здесь он только вызывается: дублировать правило в
 * роутере нельзя, иначе API и агент начнут выбирать разные профили.
 *
 * Почему файл устроен именно так:
 * - Секреты не попадают в БД: персистится только имя переменной окружения
 *   (apiKeyEnvVar). Временный ключ для проверки соединения или списка моделей
 *   приходит в теле запроса и живёт в локальной копии env внутри обработчика;
 *   в хранилище он не пишется, а в лог уходит лишь имя переменной.
 * - Результаты обнаружения моделей и проверки соединения кэшируются сервисом
 *   discovery с TTL, поэтому по умолчанию здесь forceRefresh=true: ручной вызов
 *   из UI должен отражать текущее состояние, а не устаревший снимок кэша.
 * - Разрешённый профиль всегда проходит через redactResolvedRuntimeProfile:
 *   после слияния уровней в объекте могут оказаться чувствительные поля, и они
 *   не должны утечь в ответ.
 * - Обогащение лимитами расхода (Codex и Claude) это дорогой путь: скан сессий и
 *   сетевой вызов. Он целиком выключается флагом AIF_USAGE_LIMITS_ENABLED, и
 *   каждая ветка обогащения проверяет флаг прежде чем что-то делать.
 * - Заголовки профиля ограничены allowlist (см. ALLOWED_HEADER_PREFIXES):
 *   произвольный заголовок вида Authorization означает перенос секрета в БД,
 *   поэтому такие ключи отклоняются на входе, а не маскируются на выходе.
 */
import { Hono } from "hono";
import { z } from "zod";
// Разрешение профиля, отпечаток авторизации и маскирование живут в @aif/runtime:
// здесь только транспортный слой, чтобы правила выбора уровней не расходились
// между адаптерами и API.
import {
  buildCodexAuthFingerprint,
  createRuntimeWorkflowSpec,
  getCodexAuthIdentity,
  isValidEnvVarName,
  redactResolvedRuntimeProfile,
  resolveClaudeProviderIdentity,
  resolveRuntimeProfile,
  RuntimeTransport,
} from "@aif/runtime";
import {
  getEnv,
  logger,
  normalizeRuntimeLimitSnapshot,
  type RuntimeLimitSnapshot,
} from "@aif/shared";
// Доступ к БД только через @aif/data: прямые запросы из роутера запрещены
// правилами проекта, а репозитории уже содержат нужные инварианты.
import {
  createRuntimeProfile,
  deleteRuntimeProfile,
  findRuntimeProfileById,
  findProjectById,
  findTaskById,
  getRuntimeProfileResponseById,
  listRuntimeProfileResponses,
  getAppDefaultRuntimeProfileId,
  resolveEffectiveRuntimeProfile,
  toRuntimeProfileResponse,
  updateRuntimeProfile,
} from "@aif/data";
// Схемы запросов вынесены в ../schemas.js, чтобы валидация совпадала с другими
// роутерами и тестами, а не описывалась заново в каждом обработчике.
import {
  createRuntimeProfileSchema,
  runtimeProfileListQuerySchema,
  runtimeProfileModelsSchema,
  runtimeProfileValidationSchema,
  updateRuntimeProfileSchema,
} from "../schemas.js";
// Реестр рантаймов и сервис discovery создаются лениво и кэшируются на уровне
// модуля: их инициализация стоит дорого, поэтому инстанс общий для всех запросов.
import { getApiRuntimeModelDiscoveryService, getApiRuntimeRegistry } from "../services/runtime.js";
import { resolveCachedCodexOverlaySnapshot } from "../services/codexOverlayCache.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { jsonValidator, queryValidator } from "../middleware/zodValidator.js";

const log = logger("runtime-profile-route");

// Валидация и обнаружение моделей бьют по внешним API и стоят денег, поэтому
// лимит на них жёстче (10 в минуту), чем на обычные мутации профилей (30 в минуту).
const validationRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 10 });
const mutationRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 30 });

export const runtimeProfilesRouter = new Hono();
type CreateRuntimeProfilePayload = z.infer<typeof createRuntimeProfileSchema>;
type UpdateRuntimeProfilePayload = z.infer<typeof updateRuntimeProfileSchema>;
type RuntimeProfileValidationPayload = z.infer<typeof runtimeProfileValidationSchema>;
type RuntimeProfileModelsPayload = z.infer<typeof runtimeProfileModelsSchema>;

// Allowlist, а не blocklist: список запрещённых заголовков быстро устаревает
// (появляются новые схемы авторизации), а разрешить заранее известный набор
// безопасных префиксов проще и надёжнее.
const ALLOWED_HEADER_PREFIXES = [
  "content-",
  "accept",
  "x-request-id",
  "x-correlation-id",
  "x-trace-id",
  "user-agent",
  "cache-control",
  "if-",
];

// Возвращает ключи, которые не попали в allowlist. Пустой массив означает, что
// профиль можно сохранять; непустой превращается в 400 с перечислением полей.
function listSensitiveHeaderKeys(headers: Record<string, string> | undefined): string[] {
  if (!headers) return [];
  return Object.keys(headers).filter((key) => {
    const lowered = key.toLowerCase();
    return !ALLOWED_HEADER_PREFIXES.some(
      (prefix) => lowered === prefix || lowered.startsWith(prefix),
    );
  });
}

// Временный ключ из тела запроса надо положить в то же имя переменной, которое
// использует соответствующий адаптер при реальном запуске, иначе проверка пройдёт
// в другом окружении и результат будет недостоверным.
function inferApiKeyEnvVar(profile: {
  runtimeId: string;
  providerId: string;
  apiKeyEnvVar?: string | null;
}): string {
  // Явное имя проверяется на валидность: пользователь мог ошибиться в написании,
  // и тогда лучше откатиться к выводу имени, чем подставить ключ в несуществующую
  // переменную (проверка упала бы по другой причине и путала бы диагноз).
  const explicitEnvVar = profile.apiKeyEnvVar?.trim();
  if (isValidEnvVarName(explicitEnvVar)) return explicitEnvVar;
  if (explicitEnvVar) {
    log.warn(
      {
        runtimeId: profile.runtimeId,
        providerId: profile.providerId,
        invalidApiKeyEnvVar: explicitEnvVar,
      },
      "WARN [runtime-profile-route] Invalid apiKeyEnvVar provided for temporary validation key; using inferred fallback",
    );
  }

  // Провайдер-специфичную логику делегируем слою разрешения через облегченный проход resolve.
  const resolved = resolveRuntimeProfile({
    source: "api-key-inference",
    profile: { runtimeId: profile.runtimeId, providerId: profile.providerId },
    fallbackRuntimeId: profile.runtimeId,
    fallbackProviderId: profile.providerId,
  });
  // Последний рубеж: если слой разрешения не дал имени переменной, берём
  // общепринятое для OpenAI-совместимых провайдеров, чтобы проверка не упала
  // только из-за отсутствия окружения.
  return resolved.apiKeyEnvVar ?? "OPENAI_API_KEY";
}

// Квери-параметры приходят строками, поэтому "1" и "true" считаются истиной, а
// отсутствие значения даёт переданный fallback: у разных эндпоинтов умолчания
// разные.
function sanitizeBooleanQuery(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

// providerMeta и options приходят из БД как unknown: нужен узкий страж, чтобы не
// обращаться к полям массива или примитива.
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Локальным считается только Codex с транспортом SDK/CLI/app-server: он читает
// локальные сессии и подписку, тогда как API-транспорт ведёт себя как обычный
// внешний провайдер и лимитов из сессий не имеет.
function isLocalCodexProfile(profile: { runtimeId: string; transport?: string | null }): boolean {
  return profile.runtimeId === "codex"
    ? profile.transport === RuntimeTransport.SDK ||
        profile.transport === RuntimeTransport.CLI ||
        profile.transport === RuntimeTransport.APP_SERVER
    : false;
}

// Проверка вынесена отдельно от Codex: источник лимитов у Claude другой
// (провайдер и квота), и обогащение этих семейств независимо.
function isClaudeProfile(profile: { runtimeId: string }): boolean {
  return profile.runtimeId === "claude";
}

// providerMeta наполняется постепенно и может содержать пустые строки от старых
// записей: пустое значение трактуется как отсутствие, чтобы обогащение могло
// дописать поле.
function readProviderMetaString(
  providerMeta: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = providerMeta?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Минимальные структурные типы профилей: обогащение работает и с полной строкой
// из БД, и с черновиком из формы, поэтому перечислены только реально нужные поля.
interface LocalCodexAccountProfileLike {
  id: string;
  projectId?: string | null;
  runtimeId: string;
  providerId: string;
  transport?: string | null;
  defaultModel?: string | null;
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
  runtimeLimitUpdatedAt?: string | null;
}

interface ClaudeIdentityProfileLike {
  runtimeId: string;
  providerId: string;
  transport?: string | null;
  baseUrl?: string | null;
  apiKeyEnvVar?: string | null;
  defaultModel?: string | null;
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
}

// Дописывает в снимок лимитов данные аккаунта Codex. Уже сохранённые значения не
// перетираются: снимок мог быть снят под другим аккаунтом, и подмена identity
// исказила бы историю расхода.
function enrichProfileWithCodexIdentity<T extends LocalCodexAccountProfileLike>(
  profile: T,
  identity: Awaited<ReturnType<typeof getCodexAuthIdentity>>,
): T {
  if (!isLocalCodexProfile(profile) || !profile.runtimeLimitSnapshot || !identity) {
    return profile;
  }

  const snapshot = profile.runtimeLimitSnapshot;
  const providerMeta = isObjectRecord(snapshot.providerMeta) ? snapshot.providerMeta : {};
  // Спред с тернарником это условное поле: пустой объект оставляет существующее
  // значение, непустой добавляет недостающее.
  const nextProviderMeta = {
    ...providerMeta,
    ...(readProviderMetaString(providerMeta, "accountId") ? {} : { accountId: identity.accountId }),
    ...(readProviderMetaString(providerMeta, "authMode") ? {} : { authMode: identity.authMode }),
    ...(readProviderMetaString(providerMeta, "accountName")
      ? {}
      : { accountName: identity.accountName }),
    ...(readProviderMetaString(providerMeta, "accountEmail")
      ? {}
      : { accountEmail: identity.accountEmail }),
    ...(readProviderMetaString(providerMeta, "planType") ? {} : { planType: identity.planType }),
  };

  return {
    ...profile,
    runtimeLimitSnapshot: normalizeRuntimeLimitSnapshot({
      ...snapshot,
      providerMeta: nextProviderMeta,
    }),
  };
}

// Быстрый выход до обращения к identity: если ни у одного профиля нет локального
// Codex со снимком лимитов, сетевой вызов не нужен.
async function enrichProfilesWithCodexIdentity<T extends LocalCodexAccountProfileLike>(
  profiles: T[],
): Promise<T[]> {
  if (!profiles.some((profile) => isLocalCodexProfile(profile) && profile.runtimeLimitSnapshot)) {
    return profiles;
  }

  // Identity запрашивается один раз на пакет, а не на профиль: иначе список из
  // десятка профилей порождал бы столько же одинаковых вызовов.
  const identity = await getCodexAuthIdentity();
  if (!identity) {
    return profiles;
  }

  return profiles.map((profile) => enrichProfileWithCodexIdentity(profile, identity));
}

// Отсутствующая или битая дата трактуется как минус бесконечность, то есть
// "данных нет": при сравнении свежести такой профиль всегда проигрывает
// индексному снимку.
function parseTimestampMs(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

// Снимок из индекса не привязан к конкретному профилю, поэтому ему подставляется
// id профиля, которому он отдаётся: без этого клиент не сопоставит снимок со
// строкой списка.
function applyCodexSnapshotToProfile<T extends RuntimeLimitSnapshot>(
  snapshot: T,
  profileId: string,
): T {
  const nextSnapshot = snapshot.profileId === profileId ? snapshot : { ...snapshot, profileId };
  return normalizeRuntimeLimitSnapshot(nextSnapshot) as unknown as T;
}

// Кэш отпечатка живёт на время запроса: identity читается один раз, а
// используется для всех профилей пакета. Кэшируется сам Promise, а не значение,
// чтобы параллельные обращения не запускали чтение повторно.
function createCodexIndexedSnapshotLookup() {
  let authFingerprintPromise: Promise<string | null> | null = null;

  // readAuthFingerprint ленива: для профилей с сохранённым отпечатком сеть вообще
  // не трогается.
  const readAuthFingerprint = async (): Promise<string | null> => {
    if (!authFingerprintPromise) {
      authFingerprintPromise = getCodexAuthIdentity().then((identity) =>
        buildCodexAuthFingerprint(identity),
      );
    }
    return await authFingerprintPromise;
  };

  return {
    // Отпечаток берётся из самого снимка, если он там сохранён: это дешевле, чем
    // спрашивать identity, и работает даже когда рантайм недоступен.
    async resolveAccountFingerprint(profile: LocalCodexAccountProfileLike): Promise<string | null> {
      const providerMeta = isObjectRecord(profile.runtimeLimitSnapshot?.providerMeta)
        ? profile.runtimeLimitSnapshot?.providerMeta
        : null;
      const embeddedFingerprint = readProviderMetaString(providerMeta, "accountFingerprint");
      if (embeddedFingerprint) {
        return embeddedFingerprint;
      }
      return await readAuthFingerprint();
    },
    // Выбор снимка делегируется кэшу оверлеев: он знает про приоритет limitId и
    // модели, и роутер не должен повторять это правило у себя.
    getSelected(input: {
      accountFingerprint: string;
      projectRoot?: string | null;
      preferredLimitId?: string | null;
      model?: string | null;
    }): RuntimeLimitSnapshot | null {
      return resolveCachedCodexOverlaySnapshot({
        accountFingerprint: input.accountFingerprint,
        projectRoot: input.projectRoot ?? null,
        preferredLimitId: input.preferredLimitId ?? null,
        model: input.model ?? null,
      });
    },
  };
}

async function refreshProfileWithIndexedCodexLimit<T extends LocalCodexAccountProfileLike>(
  profile: T,
  selectedProjectId?: string | null,
  snapshotLookup = createCodexIndexedSnapshotLookup(),
): Promise<T> {
  // Механизм лимитов использования — это дорогой ввод-вывод (сканирование
  // сессий Codex, сетевой вызов identity Claude). Гейт здесь, чтобы развертывание
  // могло отказаться через AIF_USAGE_LIMITS_ENABLED=false и пропустить всю связанную работу.
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) {
    return profile;
  }

  // Дальше три быстрых выхода: обогащение имеет смысл только для локального
  // Codex, у которого уже выбрана модель. Без модели выбрать снимок нечем.
  if (!isLocalCodexProfile(profile)) {
    return profile;
  }

  const model = profile.defaultModel?.trim() ?? null;
  if (!model) {
    return profile;
  }

  // projectId самого профиля важнее выбранного в UI: профиль мог быть создан для
  // конкретного проекта, и тогда корень надо брать у него.
  const effectiveProjectId = profile.projectId ?? selectedProjectId ?? null;
  const projectRoot = effectiveProjectId
    ? (findProjectById(effectiveProjectId)?.rootPath ?? null)
    : null;
  const persistedProviderMeta = isObjectRecord(profile.runtimeLimitSnapshot?.providerMeta)
    ? profile.runtimeLimitSnapshot.providerMeta
    : null;
  // Сохранённый limitId это предпочтение, а не жёсткое требование: кэш может его
  // не найти и вернуть другой подходящий снимок.
  const persistedLimitId = readProviderMetaString(persistedProviderMeta, "limitId");
  const accountFingerprint = await snapshotLookup.resolveAccountFingerprint(profile);
  // Без отпечатка аккаунта индекс нельзя сопоставить с профилем, поэтому выходим
  // с отладочным логом, а не с ошибкой.
  if (!accountFingerprint) {
    log.debug(
      {
        profileId: profile.id,
        projectId: effectiveProjectId,
        projectRoot,
      },
      "[runtime-profile-route] Skipping indexed Codex overlay because no account fingerprint is available",
    );
    return profile;
  }

  const selectedSnapshot = snapshotLookup.getSelected({
    accountFingerprint,
    projectRoot,
    preferredLimitId: persistedLimitId,
    model,
  });
  // Снимок мог не выбраться: индекс есть, но подходящей записи в нём нет.
  if (!selectedSnapshot) {
    log.debug(
      {
        profileId: profile.id,
        projectId: effectiveProjectId,
        projectRoot,
      },
      "[runtime-profile-route] No indexed Codex overlay snapshot selected for profile",
    );
    return profile;
  }

  const persistedAtMs = Math.max(
    parseTimestampMs(profile.runtimeLimitUpdatedAt ?? null),
    parseTimestampMs(profile.runtimeLimitSnapshot?.checkedAt ?? null),
  );
  const indexedCheckedAtMs = parseTimestampMs(selectedSnapshot.checkedAt);
  log.debug(
    {
      profileId: profile.id,
      projectId: effectiveProjectId,
      projectRoot,
      persistedAtMs: Number.isFinite(persistedAtMs) ? persistedAtMs : null,
      indexedCheckedAtMs: Number.isFinite(indexedCheckedAtMs) ? indexedCheckedAtMs : null,
    },
    "[runtime-profile-route] Evaluated indexed Codex overlay snapshot freshness",
  );
  // Сравниваем свежесть двух источников: если в БД лежит более новый снимок, он
  // авторитетнее индекса, и перезаписывать его нельзя.
  if (persistedAtMs > indexedCheckedAtMs) {
    return profile;
  }

  return {
    ...profile,
    runtimeLimitSnapshot: applyCodexSnapshotToProfile(selectedSnapshot, profile.id),
    runtimeLimitUpdatedAt: selectedSnapshot.checkedAt,
  };
}

// Раннее выключение лимитов повторяется и здесь, до создания lookup: при
// выключенных лимитах не тратим время даже на подготовку зависимостей.
async function refreshProfilesWithIndexedCodexLimits<T extends LocalCodexAccountProfileLike>(
  profiles: T[],
  selectedProjectId?: string | null,
): Promise<T[]> {
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) {
    return profiles;
  }
  // Один lookup на весь пакет: отпечаток аккаунта читается один раз, а профили
  // обрабатываются параллельно.
  const snapshotLookup = createCodexIndexedSnapshotLookup();
  return await Promise.all(
    profiles.map((profile) =>
      refreshProfileWithIndexedCodexLimit(profile, selectedProjectId, snapshotLookup),
    ),
  );
}

// В отличие от Codex, данные провайдера Claude вычисляются из самого профиля
// (транспорт, baseUrl, модель) и окружения процесса: сеть задействуется только
// когда включены лимиты.
async function enrichProfileWithClaudeIdentity<T extends ClaudeIdentityProfileLike>(
  profile: T,
): Promise<T> {
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) {
    return profile;
  }
  if (!isClaudeProfile(profile) || !profile.runtimeLimitSnapshot) {
    return profile;
  }

  // env передаётся явно, а не берётся изнутри: это позволяет тестам подменить
  // окружение и не читать реальные ключи.
  const identity = await resolveClaudeProviderIdentity({
    providerId: profile.providerId,
    transport: profile.transport ?? null,
    baseUrl: profile.baseUrl ?? null,
    apiKeyEnvVar: profile.apiKeyEnvVar ?? null,
    defaultModel: profile.defaultModel ?? null,
    env: process.env,
  });
  const snapshot = profile.runtimeLimitSnapshot;
  const providerMeta = isObjectRecord(snapshot.providerMeta) ? snapshot.providerMeta : {};
  // Как и у Codex, уже заполненные поля не перетираются: снимок мог быть снят под
  // другим провайдером.
  const nextProviderMeta = {
    ...providerMeta,
    ...(readProviderMetaString(providerMeta, "providerFamily")
      ? {}
      : { providerFamily: identity.providerFamily }),
    ...(readProviderMetaString(providerMeta, "providerLabel")
      ? {}
      : { providerLabel: identity.providerLabel }),
    ...(readProviderMetaString(providerMeta, "quotaSource")
      ? {}
      : { quotaSource: identity.quotaSource }),
    ...(readProviderMetaString(providerMeta, "accountFingerprint")
      ? {}
      : { accountFingerprint: identity.accountFingerprint }),
    ...(readProviderMetaString(providerMeta, "accountLabel")
      ? {}
      : { accountLabel: identity.accountLabel }),
  };

  return {
    ...profile,
    runtimeLimitSnapshot: normalizeRuntimeLimitSnapshot({
      ...snapshot,
      providerMeta: nextProviderMeta,
    }),
  };
}

// Шаги обогащения независимы, поэтому идут последовательно: сначала фиксируется
// identity Codex, затем поверх накладываются данные Claude.
async function enrichProfilesWithProviderIdentity<
  T extends LocalCodexAccountProfileLike & ClaudeIdentityProfileLike,
>(profiles: T[]): Promise<T[]> {
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) {
    return profiles;
  }
  // Codex-обогащение асинхронное и пакетное: оно же и отсеивает профили без
  // локальных сессий, поэтому Claude-шаг получает уже суженный список.
  const withCodexIdentity = await enrichProfilesWithCodexIdentity(profiles);
  return await Promise.all(
    withCodexIdentity.map((profile) => enrichProfileWithClaudeIdentity(profile)),
  );
}

// Сначала глобальные профили, потом проектные; внутри группы по времени
// создания. Это совпадает с ожидаемым порядком для пользователя и делает выдачу
// стабильной между запросами.
function compareVisibleRuntimeProfiles(
  left: { id: string; projectId: string | null; createdAt: string },
  right: { id: string; projectId: string | null; createdAt: string },
): number {
  const leftRank = left.projectId == null ? 0 : 1;
  const rightRank = right.projectId == null ? 0 : 1;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return left.id.localeCompare(right.id);
}

// Три способа задать проверяемый профиль собраны в одном месте, потому что и
// validate, и models принимают одинаковый набор полей и должны разрешаться
// одинаково.
function resolveValidationProfile(input: {
  profileId?: string;
  projectId?: string;
  profile?:
    | {
        projectId?: string | null;
        name: string;
        runtimeId: string;
        providerId: string;
        transport?: string | null;
        baseUrl?: string | null;
        apiKeyEnvVar?: string | null;
        defaultModel?: string | null;
        headers?: Record<string, string>;
        options?: Record<string, unknown>;
        enabled?: boolean;
      }
    | undefined;
}) {
  // Профиль по id читается из БД как есть: это уже сохранённая конфигурация.
  if (input.profileId) {
    const row = findRuntimeProfileById(input.profileId);
    if (!row) return null;
    return {
      source: "profile_id",
      profile: toRuntimeProfileResponse(row),
    } as const;
  }

  if (input.profile) {
    // Черновик ещё не в БД, но остальному коду нужна полная форма: подставляем
    // пустой id и текущие метки времени, чтобы ответ совпадал по полям с
    // сохранённым профилем.
    return {
      source: "payload",
      profile: {
        id: null,
        projectId: input.profile.projectId ?? null,
        name: input.profile.name,
        runtimeId: input.profile.runtimeId,
        providerId: input.profile.providerId,
        transport: input.profile.transport ?? null,
        baseUrl: input.profile.baseUrl ?? null,
        apiKeyEnvVar: input.profile.apiKeyEnvVar ?? null,
        defaultModel: input.profile.defaultModel ?? null,
        headers: input.profile.headers ?? {},
        options: input.profile.options ?? {},
        enabled: input.profile.enabled ?? true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    } as const;
  }

  // Проект без явного профиля проверяется по эффективному: пользователю важно
  // увидеть то соединение, которое реально будет использовано, а не абстрактный
  // дефолт. Источник попадает в ответ, чтобы было понятно происхождение.
  if (input.projectId) {
    const systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId("task");
    const effective = resolveEffectiveRuntimeProfile({
      projectId: input.projectId,
      mode: "task",
      systemDefaultRuntimeProfileId,
    });
    if (!effective.profile) {
      return null;
    }
    return {
      source: `effective:${effective.source}`,
      profile: effective.profile,
    } as const;
  }

  return null;
}

// Каталог доступных рантаймов: UI строит из него форму профиля, поэтому отдаются и
// возможности адаптера, и подсказки по транспортам и моделям.
// GET /runtime-profiles/runtimes
runtimeProfilesRouter.get("/runtimes", async (c) => {
  const registry = await getApiRuntimeRegistry();
  return c.json(
    registry.listRuntimes().map((runtime) => ({
      id: runtime.id,
      providerId: runtime.providerId,
      displayName: runtime.displayName,
      description: runtime.description ?? null,
      capabilities: runtime.capabilities,
      defaultTransport: runtime.defaultTransport ?? null,
      defaultApiKeyEnvVar: runtime.defaultApiKeyEnvVar ?? null,
      defaultBaseUrlEnvVar: runtime.defaultBaseUrlEnvVar ?? null,
      // Значение читается из окружения процесса только если задано имя переменной:
      // сам базовый URL в реестре не хранится, чтобы не дублировать env.
      defaultBaseUrl: runtime.defaultBaseUrlEnvVar
        ? (process.env[runtime.defaultBaseUrlEnvVar] ?? null)
        : null,
      defaultModelPlaceholder: runtime.defaultModelPlaceholder ?? null,
      supportedTransports: runtime.supportedTransports ?? [],
    })),
  );
});

// Список профилей. scope=visible по умолчанию: клиент видит и глобальные, и
// проектные записи, отсортированные так, что глобальные идут первыми.
// GET /runtime-profiles?projectId=...&includeGlobal=...&enabledOnly=...&scope=...
runtimeProfilesRouter.get("/", queryValidator(runtimeProfileListQuerySchema), async (c) => {
  const query = c.req.valid("query");
  const projectId = query.projectId;
  const includeGlobal = sanitizeBooleanQuery(query.includeGlobal, true);
  const enabledOnly = sanitizeBooleanQuery(query.enabledOnly, false);
  const scope = query.scope ?? "visible";

  log.debug(
    { projectId, includeGlobal, enabledOnly, scope },
    "[runtime-profile-route] List request",
  );
  // projectId обязателен для scope=project: без него фильтрация потеряла бы смысл и
  // вернула бы пустой список вместо явной ошибки.
  if (scope === "project" && !projectId) {
    return c.json({ error: "projectId is required when scope=project" }, 400);
  }

  let profiles;
  if (scope === "global") {
    profiles = listRuntimeProfileResponses({ enabledOnly }).filter(
      (profile) => profile.projectId == null,
    );
    // includeGlobal=false плюс фильтр по projectId дают срез одного проекта, хотя
    // репозиторий умеет отдавать выборку и с наследованием.
  } else if (scope === "project") {
    profiles = listRuntimeProfileResponses({
      projectId,
      includeGlobal: false,
      enabledOnly,
    }).filter((profile) => profile.projectId === projectId);
  } else {
    profiles = listRuntimeProfileResponses({ projectId, includeGlobal, enabledOnly }).sort(
      compareVisibleRuntimeProfiles,
    );
  }
  // Обогащение идёт после выборки и сортировки: оно не меняет порядок, а только
  // дополняет снимки лимитов.
  const refreshedProfiles = await refreshProfilesWithIndexedCodexLimits(
    profiles,
    projectId ?? null,
  );
  return c.json(await enrichProfilesWithProviderIdentity(refreshedProfiles));
});

// GET /runtime-profiles/:id
runtimeProfilesRouter.get("/:id", async (c) => {
  const { id } = c.req.param();
  const profile = getRuntimeProfileResponseById(id);
  if (!profile) return c.json({ error: "Runtime profile not found" }, 404);
  // Корень проекта берётся из самого профиля: он определяет, какой индексный
  // снимок лимитов подходит для строки.
  const refreshedProfile = await refreshProfileWithIndexedCodexLimit(
    profile,
    profile.projectId ?? null,
  );
  return c.json((await enrichProfilesWithProviderIdentity([refreshedProfile]))[0]);
});

// Создание профиля: ответ отдаётся в той же форме, что и в списке, чтобы клиент
// мог положить объект в состояние без второго запроса.
// POST /runtime-profiles
runtimeProfilesRouter.post(
  "/",
  mutationRateLimit,
  jsonValidator(createRuntimeProfileSchema),
  async (c) => {
    const body = c.req.valid("json") as CreateRuntimeProfilePayload;
    // Отсекаем запрещённые заголовки до записи в БД: проверка после сохранения
    // была бы бесполезной, секрет уже лежал бы в хранилище.
    const sensitiveHeaderKeys = listSensitiveHeaderKeys(body.headers);
    if (sensitiveHeaderKeys.length > 0) {
      log.warn(
        { profileName: body.name, runtimeId: body.runtimeId, sensitiveHeaderKeys },
        "WARN [runtime-profile-route] Rejected create request with sensitive header keys",
      );
      return c.json(
        {
          error: "Sensitive header keys are not allowed in persisted runtime profiles",
          fieldErrors: {
            headers: sensitiveHeaderKeys.map((key) => `Disallowed header key: ${key}`),
          },
        },
        400,
      );
    }

    const created = createRuntimeProfile(body);
    if (!created) return c.json({ error: "Failed to create runtime profile" }, 500);
    log.debug(
      { profileId: created.id, runtimeId: created.runtimeId, providerId: created.providerId },
      "[runtime-profile-route] Created runtime profile",
    );
    return c.json(toRuntimeProfileResponse(created), 201);
  },
);

// PUT /runtime-profiles/:id
runtimeProfilesRouter.put(
  "/:id",
  mutationRateLimit,
  jsonValidator(updateRuntimeProfileSchema),
  async (c) => {
    const { id } = c.req.param();
    const body = c.req.valid("json") as UpdateRuntimeProfilePayload;
    const existing = findRuntimeProfileById(id);
    if (!existing) return c.json({ error: "Runtime profile not found" }, 404);
    // При обновлении проверка та же, что и при создании, и по той же причине:
    // частичный апдейт тоже может принести запрещённый заголовок.
    const sensitiveHeaderKeys = listSensitiveHeaderKeys(body.headers);
    if (sensitiveHeaderKeys.length > 0) {
      log.warn(
        { profileId: id, runtimeId: existing.runtimeId, sensitiveHeaderKeys },
        "WARN [runtime-profile-route] Rejected update request with sensitive header keys",
      );
      return c.json(
        {
          error: "Sensitive header keys are not allowed in persisted runtime profiles",
          fieldErrors: {
            headers: sensitiveHeaderKeys.map((key) => `Disallowed header key: ${key}`),
          },
        },
        400,
      );
    }
    const updated = updateRuntimeProfile(id, body);
    if (!updated) return c.json({ error: "Failed to update runtime profile" }, 500);
    return c.json(toRuntimeProfileResponse(updated));
  },
);

// Удаление сначала подтверждает существование: репозиторий идемпотентен, а
// клиенту нужен честный 404 вместо молчаливого успеха.
// DELETE /runtime-profiles/:id
runtimeProfilesRouter.delete("/:id", mutationRateLimit, async (c) => {
  const { id } = c.req.param();
  const existing = findRuntimeProfileById(id);
  if (!existing) return c.json({ error: "Runtime profile not found" }, 404);
  deleteRuntimeProfile(id);
  return c.json({ success: true });
});

// Эффективный профиль задачи: наружу отдаются и выбранный профиль, и id на
// каждом уровне, чтобы UI показал, откуда взялась конфигурация.
// GET /runtime-profiles/effective/task/:taskId
runtimeProfilesRouter.get("/effective/task/:taskId", async (c) => {
  const { taskId } = c.req.param();
  const task = findTaskById(taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);

  // Дефолт приложения передаётся как системный уровень: слой разрешения не читает
  // настройки сам, он ждёт их аргументом.
  const systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId("task");
  const effective = resolveEffectiveRuntimeProfile({
    taskId,
    projectId: task.projectId,
    mode: "task",
    systemDefaultRuntimeProfileId,
  });

  return c.json({
    source: effective.source,
    profile: effective.profile
      ? (
          await enrichProfilesWithProviderIdentity([
            await refreshProfileWithIndexedCodexLimit(effective.profile, task.projectId),
          ])
        )[0]
      : effective.profile,
    taskRuntimeProfileId: effective.taskRuntimeProfileId,
    projectRuntimeProfileId: effective.projectRuntimeProfileId,
    systemRuntimeProfileId: effective.systemRuntimeProfileId,
  });
});

// Для чата отдельный режим разрешения (mode: "chat"): у него свой дефолт
// приложения, потому что чат и задачи могут ходить в разные модели.
// GET /runtime-profiles/effective/chat/:projectId
runtimeProfilesRouter.get("/effective/chat/:projectId", async (c) => {
  const { projectId } = c.req.param();
  const systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId("chat");
  const effective = resolveEffectiveRuntimeProfile({
    projectId,
    mode: "chat",
    systemDefaultRuntimeProfileId,
  });

  // Спецификация работы объявляет вид задачи, требования к возможностям адаптера
  // и политику переиспользования сессии: для разового чата сессия не переиспользуется.
  const workflow = createRuntimeWorkflowSpec({
    workflowKind: "chat",
    prompt: "Resolve effective chat runtime profile",
    requiredCapabilities: [],
    sessionReusePolicy: "never",
  });
  const resolved = resolveRuntimeProfile({
    source: effective.source,
    profile: effective.profile,
    workflow,
    fallbackRuntimeId: getEnv().AIF_DEFAULT_RUNTIME_ID,
    fallbackProviderId: getEnv().AIF_DEFAULT_PROVIDER_ID,
    env: process.env,
    // Отключённый профиль разрешён: эндпоинт отвечает на вопрос "что выбрано", а
    // не запускает исполнение.
    allowDisabled: true,
  });

  return c.json({
    source: effective.source,
    profile: effective.profile
      ? (
          await enrichProfilesWithProviderIdentity([
            await refreshProfileWithIndexedCodexLimit(effective.profile, projectId),
          ])
        )[0]
      : effective.profile,
    taskRuntimeProfileId: effective.taskRuntimeProfileId,
    projectRuntimeProfileId: effective.projectRuntimeProfileId,
    systemRuntimeProfileId: effective.systemRuntimeProfileId,
    resolved: redactResolvedRuntimeProfile(resolved),
  });
});

// POST /runtime-profiles/validate
runtimeProfilesRouter.post(
  "/validate",
  validationRateLimit,
  jsonValidator(runtimeProfileValidationSchema),
  async (c) => {
    const body = c.req.valid("json") as RuntimeProfileValidationPayload;
    const resolvedInput = resolveValidationProfile({
      profileId: body.profileId,
      projectId: body.projectId,
      profile: body.profile,
    });

    if (!resolvedInput) {
      return c.json(
        {
          error:
            "Provide profileId, profile payload, or projectId with an existing effective profile",
        },
        400,
      );
    }

    const env: Record<string, string | undefined> = {};
    if (body.apiKey) {
      const envKey = inferApiKeyEnvVar(resolvedInput.profile);
      env[envKey] = body.apiKey;
      log.warn(
        { source: resolvedInput.source, envKey },
        "WARN [runtime-profile-route] Temporary API key received for validation only",
      );
    }

    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "runtime-validate",
      prompt: "Validate runtime connectivity",
      requiredCapabilities: [],
      sessionReusePolicy: "never",
    });

    const resolved = resolveRuntimeProfile({
      source: resolvedInput.source,
      profile: resolvedInput.profile,
      workflow,
      modelOverride: body.modelOverride ?? null,
      runtimeOptionsOverride: body.runtimeOptions ?? null,
      allowDisabled: true,
      env: Object.keys(env).length > 0 ? env : undefined,
    });

    try {
      const discovery = await getApiRuntimeModelDiscoveryService();
      const validation = await discovery.validateConnection(resolved, body.forceRefresh ?? true);

      log.info(
        {
          runtimeId: resolved.runtimeId,
          providerId: resolved.providerId,
          profileId: resolved.profileId,
          ok: validation.ok,
        },
        "INFO [runtime-profile-route] Validation completed",
      );

      return c.json({
        ok: validation.ok,
        message: validation.message,
        details: validation.details ?? null,
        profile: redactResolvedRuntimeProfile(resolved),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, runtimeId: resolved.runtimeId }, "Runtime profile validation failed");
      return c.json({
        ok: false,
        message,
        details: null,
        profile: redactResolvedRuntimeProfile(resolved),
      });
    }
  },
);

// POST /runtime-profiles/models
runtimeProfilesRouter.post(
  "/models",
  validationRateLimit,
  jsonValidator(runtimeProfileModelsSchema),
  async (c) => {
    const body = c.req.valid("json") as RuntimeProfileModelsPayload;
    const resolvedInput = resolveValidationProfile({
      profileId: body.profileId,
      projectId: body.projectId,
      profile: body.profile,
    });

    if (!resolvedInput) {
      return c.json(
        {
          error:
            "Provide profileId, profile payload, or projectId with an existing effective profile",
        },
        400,
      );
    }

    const env: Record<string, string | undefined> = {};
    if (body.apiKey) {
      const envKey = inferApiKeyEnvVar(resolvedInput.profile);
      env[envKey] = body.apiKey;
      log.warn(
        { source: resolvedInput.source, envKey },
        "WARN [runtime-profile-route] Temporary API key received for model discovery only",
      );
    }

    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "runtime-models",
      prompt: "List runtime models",
      requiredCapabilities: ["supportsModelDiscovery"],
      sessionReusePolicy: "never",
    });

    const resolved = resolveRuntimeProfile({
      source: resolvedInput.source,
      profile: resolvedInput.profile,
      workflow,
      modelOverride: body.modelOverride ?? null,
      runtimeOptionsOverride: body.runtimeOptions ?? null,
      allowDisabled: true,
      env: Object.keys(env).length > 0 ? env : undefined,
    });

    try {
      const discovery = await getApiRuntimeModelDiscoveryService();
      const models = await discovery.listModels(resolved, body.forceRefresh ?? true);

      log.info(
        {
          runtimeId: resolved.runtimeId,
          providerId: resolved.providerId,
          profileId: resolved.profileId,
          modelCount: models.length,
        },
        "INFO [runtime-profile-route] Model discovery completed",
      );

      return c.json({
        models,
        profile: redactResolvedRuntimeProfile(resolved),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, runtimeId: resolved.runtimeId }, "Runtime model discovery failed");
      return c.json(
        { error: message, models: [], profile: redactResolvedRuntimeProfile(resolved) },
        422,
      );
    }
  },
);
