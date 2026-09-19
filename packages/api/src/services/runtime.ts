/**
 * Сервис runtime на стороне API: собирает реестр адаптеров, разрешает профиль
 * выполнения для задачи или проекта и запускает запросы через выбранный адаптер.
 *
 * Зачем файл устроен именно так:
 * - реестр адаптеров создается лениво и один раз на процесс: bootstrap дорогой
 *   (динамическая загрузка внешних модулей), а инициализация на каждый запрос
 *   была бы недопустимой тратой времени;
 * - при ошибке инициализации промис сбрасывается в null, чтобы следующий вызов
 *   повторил попытку, а не залип на отклоненном промисе навсегда;
 * - порядок разрешения профиля фиксирован: задача -> проект -> системный
 *   дефолт -> переменные окружения. Явный профиль от вызывающего имеет
 *   приоритет над всем, но проверяется на видимость в рамках проекта;
 * - наблюдение за лимитами вынесено в обертки, которые отключаются флагом
 *   AIF_USAGE_LIMITS_ENABLED: при выключенном флаге события потока не
 *   разбираются, снапшоты не пишутся в базу и не рассылаются по WebSocket;
 * - запись лимитов и рассылка дедуплицируются по сигнатуре с TTL-кешем:
 *   без этого повторные вызовы порождали бы шторм записей и сообщений.
 */
import {
  bootstrapRuntimeRegistry,
  buildRuntimeLimitBroadcastCacheKey,
  buildRuntimeLimitCacheSignature,
  checkRuntimeSessionForkSupport,
  checkRuntimeCapabilities,
  createRuntimeMemoryCache,
  createRuntimeModelDiscoveryService,
  createRuntimeWorkflowSpec,
  extractLatestRuntimeLimitSnapshot as extractLatestRuntimeLimitSnapshotRaw,
  extractRuntimeLimitSnapshotFromError as extractRuntimeLimitSnapshotFromErrorRaw,
  observeRuntimeLimitEvent as observeRuntimeLimitEventRaw,
  redactResolvedRuntimeProfile,
  resolveAdapterCapabilities,
  resolveRuntimeProfile,
  normalizeRuntimeLimitSnapshot,
  RUNTIME_TRUST_TOKEN,
  type RuntimeRunResult,
  type RuntimeCapabilityName,
  type RuntimeEvent,
  type RuntimeLimitSnapshot,
  type ResolvedRuntimeProfile,
  type RuntimeAdapter,
  type RuntimeModelDiscoveryService,
  type RuntimeRegistry,
  type RuntimeUsageContext,
  type RuntimeWorkflowSpec,
  type RuntimeSessionForkSkipReason,
} from "@aif/runtime";
import {
  DEFAULT_WARMUP_TARGET,
  WARMUP_TARGETS,
  getEnv,
  logger,
  toRuntimeProfileResponse,
} from "@aif/shared";
import type { WarmupTarget } from "@aif/shared";
import {
  clearRuntimeProfileLimitSnapshot,
  createDbUsageSink,
  type DbUsageEvent,
  findProjectById,
  findRuntimeProfileById,
  findTaskById,
  persistRuntimeProfileLimitSnapshot,
  getAppDefaultRuntimeProfileId,
  resolveEffectiveRuntimeProfile,
  type ProjectRow,
} from "@aif/data";
import { broadcast } from "../ws.js";

const log = logger("api-runtime");

// Ленивые синглтоны уровня процесса: хранится промис, а не готовое значение,
// чтобы параллельные вызовы делили одну инициализацию вместо гонки.
let runtimeRegistryPromise: Promise<RuntimeRegistry> | null = null;
let modelDiscoveryService: RuntimeModelDiscoveryService | null = null;
// Два независимых TTL-кеша: состояние лимитов (что уже записано в базу) и
// последняя разосланная сигнатура (что уже увидел UI). Разделены потому, что
// запись в базу и рассылка - разные побочные эффекты с разной ценой.
const runtimeLimitStateCache = createRuntimeMemoryCache<string>({ defaultTtlMs: 30_000 });
const runtimeLimitBroadcastCache = createRuntimeMemoryCache<string>({ defaultTtlMs: 30_000 });

/**
 * Обёртки, коротко замыкающие конвейер наблюдения лимитов, когда
 * `AIF_USAGE_LIMITS_ENABLED=false`. Вызывающие (этот файл + маршрут чата) импортируют
 * именно обёрнутые версии, чтобы при выключенном флаге никогда не парсить события
 * потока ради снапшотов лимитов, не сохранять их и не рассылать.
 */
export function observeRuntimeLimitEvent(
  ...args: Parameters<typeof observeRuntimeLimitEventRaw>
): ReturnType<typeof observeRuntimeLimitEventRaw> {
  // Ранний выход: возвращаем предыдущий снапшот как есть, не разбирая событие
  // и не порождая побочных эффектов при выключенном наблюдении за лимитами.
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) return args[1] ?? null;
  return observeRuntimeLimitEventRaw(...args);
}

export function extractLatestRuntimeLimitSnapshot(
  ...args: Parameters<typeof extractLatestRuntimeLimitSnapshotRaw>
): ReturnType<typeof extractLatestRuntimeLimitSnapshotRaw> {
  // null означает "свежих данных о лимитах нет"; вызывающий код обязан
  // отличать это от явного сброса состояния.
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) return null;
  return extractLatestRuntimeLimitSnapshotRaw(...args);
}

export function extractRuntimeLimitSnapshotFromError(
  ...args: Parameters<typeof extractRuntimeLimitSnapshotFromErrorRaw>
): ReturnType<typeof extractRuntimeLimitSnapshotFromErrorRaw> {
  // Восстановление лимитов из ошибки адаптера тоже под флагом: иначе ошибки
  // продолжали бы писать снапшоты при отключенном интерфейсе.
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) return null;
  return extractRuntimeLimitSnapshotFromErrorRaw(...args);
}

/**
 * Возвращает общий реестр адаптеров, создавая его при первом обращении.
 * Промис кешируется целиком, поэтому конкурентные вызовы не запускают
 * bootstrap дважды.
 */
export async function getApiRuntimeRegistry(): Promise<RuntimeRegistry> {
  if (!runtimeRegistryPromise) {
    const env = getEnv();
    // Список внешних runtime-модулей и флаг discovery моделей читаются из
    // окружения в момент создания реестра, а не при каждом запросе.
    runtimeRegistryPromise = bootstrapRuntimeRegistry({
      logger: {
        debug(context, message) {
          log.debug({ ...context }, `[runtime-registry] ${message}`);
        },
        warn(context, message) {
          log.warn({ ...context }, `WARN [runtime-module] ${message}`);
        },
        error(context, message) {
          log.error({ ...context }, `ERROR [runtime-registry] ${message}`);
        },
      },
      runtimeModules: env.AIF_RUNTIME_MODULES ?? [],
      modelEffortDiscoveryEnabled: env.AIF_RUNTIME_MODEL_EFFORT_DISCOVERY_ENABLED,
      // DB-сток персистит каждый успешный прогон через обёртку реестра.
      // Структурно совпадает с RuntimeUsageSink из @aif/runtime —
      // кросс-пакетный импорт типов не нужен.
      usageSink: createDbUsageSink({
        onRecorded: broadcastRuntimeUsageRefresh,
      }),
    }).catch((error) => {
      // Сброс кеша обязателен: иначе отклоненный промис остался бы в поле
      // навсегда и все последующие вызовы падали бы с той же ошибкой.
      runtimeRegistryPromise = null;
      throw error;
    });
  }
  return runtimeRegistryPromise;
}

/**
 * Синглтон сервиса discovery моделей.
 * Два кеша с разным TTL: список моделей меняется редко, а результат проверки
 * соединения устаревает быстрее, поэтому кешируется на меньший срок.
 */
export async function getApiRuntimeModelDiscoveryService(): Promise<RuntimeModelDiscoveryService> {
  if (!modelDiscoveryService) {
    const registry = await getApiRuntimeRegistry();
    modelDiscoveryService = createRuntimeModelDiscoveryService({
      registry,
      cache: createRuntimeMemoryCache({ defaultTtlMs: 30_000 }),
      validationCache: createRuntimeMemoryCache({ defaultTtlMs: 15_000 }),
      logger: {
        debug(context, message) {
          log.debug({ ...context }, `[runtime-validation] ${message}`);
        },
        info(context, message) {
          log.info({ ...context }, `INFO [runtime-validation] ${message}`);
        },
        warn(context, message) {
          log.warn({ ...context }, `WARN [runtime-validation] ${message}`);
        },
      },
    });
  }
  return modelDiscoveryService;
}

/**
 * Рассылает уведомление об изменении лимитов только если сигнатура состояния
 * отличается от уже разосланной. Без дедупликации повторные вызовы из цикла
 * выполнения порождали бы лавину сообщений об одном и том же.
 */
function broadcastRuntimeLimitUpdate(input: {
  projectId?: string | null;
  taskId?: string | null;
  runtimeProfileId: string;
  signature: string;
}): void {
  // Полностью пропускаем WS-раздачу, когда функция лимитов использования выключена —
  // фронтенд, реагирующий на `project:runtime_limit_updated`, гейтится тем же
  // флагом, поэтому рассылка была бы бесполезной работой.
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) return;
  const projectId = input.projectId ?? null;
  if (!projectId) {
    log.debug(
      {
        runtimeProfileId: input.runtimeProfileId,
        taskId: input.taskId ?? null,
      },
      "Skipping runtime limit WS broadcast because no project is associated",
    );
    return;
  }

  // Пустой ключ означает, что дедупликация невозможна из-за нехватки scope:
  // лучше не рассылать вовсе, чем рассылать без контроля повторов.
  const broadcastCacheKey = buildRuntimeLimitBroadcastCacheKey(input);
  if (!broadcastCacheKey) {
    return;
  }

  // Сигнатура описывает состояние целиком, поэтому совпадение с последней
  // рассылкой означает, что UI уже видел эти данные и повтор избыточен.
  const cachedSignature = runtimeLimitBroadcastCache.get(broadcastCacheKey);
  if (cachedSignature === input.signature) {
    log.debug(
      {
        runtimeProfileId: input.runtimeProfileId,
        projectId,
        taskId: input.taskId ?? null,
      },
      "Skipped runtime limit WS broadcast because identical project/task state is still cached",
    );
    return;
  }

  // Сигнатура запоминается после отправки: сбойный вызов не должен быть
  // ошибочно признан доставленным.
  broadcast({
    type: "project:runtime_limit_updated",
    payload: {
      projectId,
      runtimeProfileId: input.runtimeProfileId,
      taskId: input.taskId ?? null,
    },
  });
  runtimeLimitBroadcastCache.set(broadcastCacheKey, input.signature);
}

/**
 * Публичная точка входа для других модулей API: нормализует необязательный
 * taskId в явный null и делегирует в общую функцию рассылки, чтобы правила
 * дедупликации жили в одном месте.
 */
export function notifyRuntimeLimitProjectUpdate(input: {
  projectId: string;
  runtimeProfileId: string;
  signature: string;
  taskId?: string | null;
}): void {
  broadcastRuntimeLimitUpdate({
    projectId: input.projectId,
    runtimeProfileId: input.runtimeProfileId,
    signature: input.signature,
    taskId: input.taskId ?? null,
  });
}

/**
 * Превращает запись об использовании в сигнатуру и передает ее в рассылку.
 * Запись без проекта или профиля не к чему привязать в интерфейсе, поэтому
 * такие события отбрасываются молча.
 */
function broadcastRuntimeUsageRefresh(event: DbUsageEvent): void {
  const projectId = event.context.projectId ?? null;
  const runtimeProfileId = event.profileId ?? null;
  if (!projectId || !runtimeProfileId) {
    return;
  }

  // Сигнатура включает время записи, источник и разбивку токенов: два прогона
  // с одинаковыми токенами, но разным временем должны разойтись в UI.
  broadcastRuntimeLimitUpdate({
    projectId,
    taskId: event.context.taskId ?? null,
    runtimeProfileId,
    signature: `usage:${event.recordedAt.toISOString()}:${event.context.source}:${event.usage.totalTokens}:${event.usage.inputTokens}:${event.usage.outputTokens}:${event.usage.costUsd ?? ""}`,
  });
}

/**
 * Приводит сохраненное состояние лимитов профиля в соответствие со снапшотом
 * и уведомляет интерфейс об изменении.
 *
 * Инварианты:
 * - профиль обязателен: без него некуда писать и нечего идентифицировать;
 * - отсутствие снапшота при clearOnMissing=false не стирает данные: сброс
 *   возможен только по явному запросу, иначе успешный прогон без сигнала о
 *   лимитах обнулял бы полезное состояние;
 * - ошибки записи и рассылки не пробрасываются наружу: это диагностический
 *   побочный эффект, а не часть основного сценария.
 */
export function refreshRuntimeProfileLimitState(input: {
  runtimeProfileId?: string | null;
  runtimeId?: string | null;
  providerId?: string | null;
  snapshot?: RuntimeLimitSnapshot | null;
  clearOnMissing?: boolean;
  taskId?: string | null;
  projectId?: string | null;
  conversationId?: string | null;
  workflowKind?: string | null;
  reason: string;
}): void {
  // Профиль может прийти явным аргументом или из самого снапшота: второй путь
  // нужен адаптерам, которые знают профиль, но не участвуют в его разрешении.
  const normalizedSnapshot = input.snapshot ? normalizeRuntimeLimitSnapshot(input.snapshot) : null;
  const runtimeProfileId = input.runtimeProfileId ?? normalizedSnapshot?.profileId ?? null;
  if (!runtimeProfileId) {
    log.debug(
      {
        runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
        providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        conversationId: input.conversationId ?? null,
        workflowKind: input.workflowKind ?? null,
        reason: input.reason,
      },
      "Skipping runtime limit state refresh because no runtime profile is associated",
    );
    return;
  }

  const signature = buildRuntimeLimitCacheSignature(
    normalizedSnapshot,
    input.clearOnMissing === true,
  );
  if (!signature) {
    log.debug(
      {
        runtimeProfileId,
        runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
        providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        conversationId: input.conversationId ?? null,
        workflowKind: input.workflowKind ?? null,
        reason: input.reason,
      },
      "No runtime limit snapshot or clear action available for refresh",
    );
    return;
  }

  // Кеш хранит то, что уже лежит в базе. Совпадение сигнатуры позволяет
  // пропустить запись, но рассылка ниже выполняется все равно: UI мог
  // потерять соединение и должен получить состояние повторно.
  const cachedSignature = runtimeLimitStateCache.get(runtimeProfileId);
  const shouldPersist = cachedSignature !== signature;
  if (!shouldPersist) {
    log.debug(
      {
        runtimeProfileId,
        runtimeId: input.runtimeId ?? input.snapshot?.runtimeId ?? null,
        providerId: input.providerId ?? input.snapshot?.providerId ?? null,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        conversationId: input.conversationId ?? null,
        workflowKind: input.workflowKind ?? null,
        reason: input.reason,
      },
      "Skipping runtime limit DB write because identical profile state is still cached; project-scoped broadcast will still be evaluated",
    );
  }

  // Побочные эффекты изолированы в try: сбой записи лимитов не должен
  // ломать основной сценарий запроса к runtime.
  try {
    if (shouldPersist) {
      // Время фиксируется до записи и передается в слой данных явно: так
      // отметка в базе совпадает с моментом решения, а не с моментом коммита.
      const persistedAt = new Date().toISOString();
      log.debug(
        {
          runtimeProfileId,
          runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
          providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
          taskId: input.taskId ?? null,
          projectId: input.projectId ?? null,
          conversationId: input.conversationId ?? null,
          workflowKind: input.workflowKind ?? null,
          reason: input.reason,
          cacheHit: false,
          action: normalizedSnapshot ? "persist" : "clear",
        },
        "Refreshing runtime profile limit state",
      );

      // Пустой снапшот означает явный сброс, а не отсутствие данных: это
      // единственная ветка, которая удаляет сохраненное состояние лимитов.
      if (normalizedSnapshot) {
        persistRuntimeProfileLimitSnapshot(runtimeProfileId, normalizedSnapshot, persistedAt);
      } else {
        clearRuntimeProfileLimitSnapshot(runtimeProfileId, persistedAt);
      }
      runtimeLimitStateCache.set(runtimeProfileId, signature);
    }
    broadcastRuntimeLimitUpdate({
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      runtimeProfileId,
      signature,
    });
  } catch (error) {
    log.warn(
      {
        err: error,
        runtimeProfileId,
        runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
        providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        conversationId: input.conversationId ?? null,
        workflowKind: input.workflowKind ?? null,
        reason: input.reason,
      },
      "Failed to refresh runtime profile limit state",
    );
  }
}

/**
 * Разбирает JSON с опциями runtime из строки задачи.
 * Возвращает undefined для отсутствующих или битых данных: вызывающий код
 * трактует это как "взять значения профиля по умолчанию", а не как ошибку.
 */
function parseRuntimeOptions(
  raw: string | null | undefined,
): Record<string, unknown> | null | undefined {
  if (raw == null) return undefined;
  try {
    const parsed = JSON.parse(raw);
    // Массивы и примитивы картой опций не являются, поэтому отбрасываются:
    // ожидается именно объект с произвольными ключами.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // невалидный JSON опций runtime игнорируем и продолжаем с дефолтами профиля
  }
  return undefined;
}

/**
 * Результат разрешения runtime для конкретного запроса: адаптер, эффективный
 * профиль и источник выбора. Источник хранится отдельно от профиля, чтобы
 * логи и ответы API могли объяснить, почему выбран именно этот runtime.
 */
export interface RuntimeExecutionContext {
  project: ProjectRow;
  adapter: RuntimeAdapter;
  resolvedProfile: ResolvedRuntimeProfile;
  selectionSource: "task_override" | "project_default" | "system_default" | "none" | "profile_id";
}

/**
 * Описание поддержки warmup для одной цели: нужно интерфейсу, чтобы не
 * предлагать прогрев сессии там, где адаптер или транспорт его не умеет.
 * Отдельный skipReason отличает "не поддерживается" от "не удалось разрешить".
 */
export interface ApiWarmupSupport {
  supported: boolean;
  skipReason?: RuntimeSessionForkSkipReason | "resolution_failed";
  workflowKind: string;
  profileMode: WarmupTarget["profileMode"];
  runtimeId: string | null;
  providerId: string | null;
  runtimeProfileId: string | null;
  transport: string | null;
  model: string | null;
  selectionSource: RuntimeExecutionContext["selectionSource"] | null;
}

/**
 * Разрешает контекст выполнения по цепочке: задача -> проект -> системный
 * дефолт, где явный идентификатор профиля имеет высший приоритет.
 *
 * Почему проверки выполняются именно здесь:
 * - идентификатор задачи необязателен, но если задача есть, ее проект
 *   считается истиной в последней инстанции: иначе запрос мог бы утечь в
 *   чужой проект;
 * - явный профиль дополнительно проверяется на видимость: глобальный виден
 *   всем, проектный - только своему проекту;
 * - приоритет полей модели: аргумент вызова -> поле задачи -> дефолт профиля,
 *   что позволяет точечно переопределять модель без правки профиля;
 * - адаптер ищется по идентификатору рантайма, а не профиля, потому что один
 *   рантайм может обслуживать много профилей с разной конфигурацией.
 */
export async function resolveApiRuntimeContext(input: {
  projectId?: string | null;
  taskId?: string | null;
  mode: "task" | "plan" | "review" | "chat";
  workflow: RuntimeWorkflowSpec;
  modelOverride?: string | null;
  runtimeOptionsOverride?: Record<string, unknown> | null;
  runtimeProfileId?: string | null;
  allowDisabled?: boolean;
}): Promise<RuntimeExecutionContext> {
  // Проект выводится из задачи, только если он не задан явно: явный аргумент
  // выигрывает, но при отсутствии обоих контекст разрешить невозможно.
  const task = input.taskId ? findTaskById(input.taskId) : undefined;
  const projectId = input.projectId ?? task?.projectId;
  if (!projectId) {
    throw new Error("Project ID is required to resolve runtime context");
  }

  const project = findProjectById(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  // Системный дефолт зависит от режима (задача, план, ревью, чат): у каждого
  // сценария может быть свой профиль по умолчанию.
  const systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId(input.mode);
  const explicitProfileRow =
    input.runtimeProfileId != null ? findRuntimeProfileById(input.runtimeProfileId) : undefined;
  if (input.runtimeProfileId != null && !explicitProfileRow) {
    throw new Error(`Runtime profile ${input.runtimeProfileId} not found`);
  }
  // Профиль без projectId считается глобальным; профиль с чужим projectId
  // использовать нельзя - это защита от подстановки чужой конфигурации.
  if (explicitProfileRow?.projectId != null && explicitProfileRow.projectId !== projectId) {
    throw new Error(
      `Runtime profile ${explicitProfileRow.id} is not visible to project ${projectId}`,
    );
  }

  // Явный профиль формирует синтетический результат выбора с источником
  // "profile_id": остальные ветки разрешения при этом не выполняются.
  const explicitProfile = explicitProfileRow
    ? toRuntimeProfileResponse(explicitProfileRow)
    : undefined;
  const selection = explicitProfile
    ? {
        source: "profile_id" as const,
        profile: explicitProfile,
        taskRuntimeProfileId: task?.runtimeProfileId ?? null,
        projectRuntimeProfileId: null,
        systemRuntimeProfileId: systemDefaultRuntimeProfileId,
      }
    : resolveEffectiveRuntimeProfile({
        taskId: task?.id,
        projectId,
        mode: input.mode,
        systemDefaultRuntimeProfileId,
      });

  // Строка профиля перечитывается из базы, чтобы получить актуальные поля:
  // выбранный профиль мог быть изменен после разрешения.
  const profileRow =
    explicitProfileRow ??
    (selection.profile?.id ? findRuntimeProfileById(selection.profile.id) : undefined);
  const profile =
    explicitProfile ?? (profileRow ? toRuntimeProfileResponse(profileRow) : selection.profile);
  const runtimeOptionsFromTask = parseRuntimeOptions(task?.runtimeOptionsJson);
  // Приоритет значений: аргумент вызова -> опции задачи -> дефолт профиля.
  // Это позволяет тестам и внутренним вызовам переопределять модель точечно.
  const resolvedProfile = resolveRuntimeProfile({
    source: selection.source,
    profile,
    fallbackRuntimeId: getEnv().AIF_DEFAULT_RUNTIME_ID,
    fallbackProviderId: getEnv().AIF_DEFAULT_PROVIDER_ID,
    workflow: input.workflow,
    modelOverride: input.modelOverride ?? task?.modelOverride ?? profile?.defaultModel ?? null,
    runtimeOptionsOverride: input.runtimeOptionsOverride ?? runtimeOptionsFromTask,
    allowDisabled: input.allowDisabled,
    env: process.env,
    logger: {
      debug(context, message) {
        log.debug({ ...context }, `[runtime-resolution] ${message}`);
      },
      info(context, message) {
        log.info({ ...context }, `INFO [runtime-validation] ${message}`);
      },
      warn(context, message) {
        log.warn({ ...context }, `WARN [runtime-validation] ${message}`);
      },
    },
  });

  // Адаптер ищется по идентификатору рантайма, а не профиля: профиль хранит
  // конфигурацию, а исполняет запрос именно адаптер рантайма.
  const registry = await getApiRuntimeRegistry();
  const adapter = registry.resolveRuntime(resolvedProfile.runtimeId);

  // Профиль логируется через redactResolvedRuntimeProfile: ключи и заголовки
  // не должны попадать в логи даже при подробном логировании.
  log.info(
    {
      projectId,
      taskId: task?.id ?? null,
      workflowKind: input.workflow.workflowKind,
      selectionSource: selection.source,
      ...redactResolvedRuntimeProfile(resolvedProfile),
    },
    "Resolved API runtime context",
  );

  return {
    project,
    adapter,
    resolvedProfile,
    selectionSource: selection.source,
  };
}

/**
 * Проверяет, что выбранный адаптер умеет все, что требует workflow, и падает
 * до запуска. Ранний отказ дешевле: иначе запрос дошел бы до адаптера и упал
 * уже внутри прогона, потратив время и токены впустую.
 */
export function assertApiRuntimeCapabilities(input: {
  adapter: RuntimeAdapter;
  resolvedProfile: ResolvedRuntimeProfile;
  workflow: RuntimeWorkflowSpec;
}): void {
  const capabilities = resolveAdapterCapabilities(input.adapter, input.resolvedProfile.transport);
  const result = checkRuntimeCapabilities({
    runtimeId: input.resolvedProfile.runtimeId,
    workflowKind: input.workflow.workflowKind,
    capabilities,
    required: input.workflow.requiredCapabilities,
    logger: {
      debug(context, message) {
        log.debug({ ...context }, `[runtime-capabilities] ${message}`);
      },
      warn(context, message) {
        log.warn({ ...context }, `WARN [runtime-capabilities] ${message}`);
      },
    },
  });

  // В сообщение попадают только отсутствующие возможности: так вызывающий
  // сразу видит, чего именно не хватает, без чтения логов адаптера.
  // В сообщение попадают только отсутствующие возможности: так вызывающий
  // сразу видит, чего именно не хватает, без чтения логов адаптера.
  if (!result.ok) {
    throw new Error(
      `Runtime "${input.resolvedProfile.runtimeId}" cannot execute "${input.workflow.workflowKind}": ${result.missing.join(", ")}`,
    );
  }
}

/**
 * Проверяет поддержку прогрева для одной цели. Прогрев - это форк сессии,
 * поэтому проверяются и возможности адаптера, и наличие метода forkSession.
 * Любая ошибка разрешения превращается в supported=false с причиной
 * "resolution_failed": прогрев не критичен и не должен ломать вызывающий код.
 */
async function resolveApiWarmupSupportForTarget(
  projectId: string,
  target: WarmupTarget,
): Promise<ApiWarmupSupport> {
  const workflow = createRuntimeWorkflowSpec({
    workflowKind: target.workflowKind,
    prompt: "",
    sessionReusePolicy: "new_session",
  });

  try {
    const context = await resolveApiRuntimeContext({
      projectId,
      mode: target.profileMode,
      workflow,
    });
    const capabilities = resolveAdapterCapabilities(
      context.adapter,
      context.resolvedProfile.transport,
    );
    const forkSupport = checkRuntimeSessionForkSupport({
      runtimeId: context.resolvedProfile.runtimeId,
      transport: context.resolvedProfile.transport,
      capabilities,
      hasForkSessionMethod: typeof context.adapter.forkSession === "function",
      sourceSessionId: "__warmup_probe__",
      logger: {
        debug(runtimeContext, message) {
          log.debug({ projectId, ...runtimeContext }, `[runtime-warmup] ${message}`);
        },
        warn(runtimeContext, message) {
          log.warn({ projectId, ...runtimeContext }, `WARN [runtime-warmup] ${message}`);
        },
      },
    });

    return {
      supported: forkSupport.ok,
      ...(forkSupport.skipReason ? { skipReason: forkSupport.skipReason } : {}),
      workflowKind: target.workflowKind,
      profileMode: target.profileMode,
      runtimeId: context.resolvedProfile.runtimeId,
      providerId: context.resolvedProfile.providerId,
      runtimeProfileId: context.resolvedProfile.profileId,
      transport: context.resolvedProfile.transport,
      model: context.resolvedProfile.model,
      selectionSource: context.selectionSource,
    };
  } catch (error) {
    log.warn({ projectId, err: error }, "Failed to resolve warmup runtime support");
    return {
      supported: false,
      skipReason: "resolution_failed",
      workflowKind: target.workflowKind,
      profileMode: target.profileMode,
      runtimeId: null,
      providerId: null,
      runtimeProfileId: null,
      transport: null,
      model: null,
      selectionSource: null,
    };
  }
}

export async function resolveApiWarmupSupports(projectId: string): Promise<ApiWarmupSupport[]> {
  return Promise.all(
    WARMUP_TARGETS.map((target) => resolveApiWarmupSupportForTarget(projectId, target)),
  );
}

export async function resolveApiWarmupSupport(projectId: string): Promise<ApiWarmupSupport> {
  const supports = await resolveApiWarmupSupports(projectId);
  return (
    supports.find((support) => support.supported) ??
    supports[0] ??
    (await resolveApiWarmupSupportForTarget(projectId, DEFAULT_WARMUP_TARGET))
  );
}

/**
 * Разрешает lightModel для активного runtime проекта/задачи.
 * Возвращает null, если у адаптера нет лёгкой модели (использовать дефолт).
 */
export async function resolveApiLightModel(
  projectId: string,
  taskId?: string | null,
): Promise<string | null> {
  // Режим фиксирован как "task": легкая модель нужна только для служебных
  // задач вроде проверки ревью, а не для планирования или чата.
  const systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId("task");
  const selection = resolveEffectiveRuntimeProfile({
    taskId: taskId ?? undefined,
    projectId,
    mode: "task",
    systemDefaultRuntimeProfileId,
  });
  const resolved = resolveRuntimeProfile({
    source: selection.source,
    profile: selection.profile,
    fallbackRuntimeId: getEnv().AIF_DEFAULT_RUNTIME_ID,
    fallbackProviderId: getEnv().AIF_DEFAULT_PROVIDER_ID,
  });
  const registry = await getApiRuntimeRegistry();
  const adapter = registry.resolveRuntime(resolved.runtimeId);
  // null означает "использовать основную модель": не все адаптеры объявляют
  // отдельную легкую модель, и подменять ее своим значением здесь нельзя.
  return adapter.descriptor.lightModel ?? null;
}

/**
 * Единый путь одиночного запуска runtime для служебных сценариев API
 * (быстрое исправление, коммит, генерация роадмапа и подобные).
 *
 * Инварианты и решения:
 * - сессия никогда не переиспользуется: служебные вызовы не должны влиять на
 *   основную ветку диалога задачи;
 * - возможности проверяются до запуска, а не по факту ошибки адаптера;
 * - снапшот лимитов обновляется и при успехе, и при ошибке: при ошибке он
 *   извлекается из тела ошибки, а отсутствие данных не стирает предыдущее
 *   состояние (clearOnMissing=false);
 * - привязка HANDOFF_MODE и HANDOFF_TASK_ID передается адаптеру через
 *   окружение: так процесс задачи узнает свой контекст без правки кода;
 * - функция возвращает и результат, и контекст, чтобы вызывающий мог продолжить
 *   работу тем же адаптером без повторного разрешения профиля.
 */
export async function runApiRuntimeOneShot(input: {
  projectId: string;
  projectRoot: string;
  taskId?: string | null;
  profileMode?: "task" | "plan" | "review" | "chat";
  prompt: string;
  workflowKind?: string;
  requiredCapabilities?: RuntimeCapabilityName[];
  modelOverride?: string | null;
  systemPromptAppend?: string;
  includePartialMessages?: boolean;
  maxTurns?: number;
  /**
   * Подсказка для адаптеров с разрешением slash-команд / скиллов (напр.
   * Claude Code CLI). Передаётся в спеку workflow, чтобы совместимые
   * адаптеры могли вызвать названный скилл, а не полагаться только на текст
   * промпта. Адаптеры без поддержки игнорируют это поле.
   */
  fallbackSlashCommand?: string;
  /**
   * Метаданные области для учёта использования. Вызывающие обязаны выбрать одно
   * значение `UsageSource`, идентифицирующее логический поток (fast-fix, commit, roadmap-*, ...).
   * `projectId` включается автоматически всегда; `taskId` добавляется, когда
   * вызывающий передаёт его в `input.taskId`.
   */
  usageContext: RuntimeUsageContext;
}): Promise<{
  result: RuntimeRunResult;
  context: RuntimeExecutionContext;
}> {
  const env = getEnv();
  // Спецификация собирается из аргументов вызова: она же участвует в проверке
  // возможностей и передается адаптеру как единый контракт прогона.
  const workflow = createRuntimeWorkflowSpec({
    workflowKind: input.workflowKind ?? "oneshot",
    prompt: input.prompt,
    requiredCapabilities: input.requiredCapabilities ?? [],
    sessionReusePolicy: "never",
    systemPromptAppend: input.systemPromptAppend,
    fallbackSlashCommand: input.fallbackSlashCommand,
  });

  const context = await resolveApiRuntimeContext({
    projectId: input.projectId,
    taskId: input.taskId,
    mode: input.profileMode ?? "task",
    workflow,
    modelOverride: input.modelOverride,
  });

  assertApiRuntimeCapabilities({
    adapter: context.adapter,
    resolvedProfile: context.resolvedProfile,
    workflow,
  });

  // Обход подтверждений берется из окружения, а не из аргументов запроса:
  // это серверная политика, которую вызывающий не может поднять сам.
  const bypassPermissions = env.AGENT_BYPASS_PERMISSIONS;
  const task = input.taskId ? findTaskById(input.taskId) : null;
  // Если у задачи уже есть ветка, адаптер должен знать, что она подготовлена:
  // иначе он создаст вторую ветку или выполнит лишний checkout.
  const branchEnvironment: Record<string, string> = task?.branchName
    ? {
        HANDOFF_BRANCH_PREPARED: "1",
        HANDOFF_BRANCH_NAME: task.branchName,
      }
    : {};
  // Снапшот копится по мере событий потока: последний валидный снапшот
  // считается самым свежим, поэтому состояние обновляется накопительно.
  let latestLimitSnapshot: RuntimeLimitSnapshot | null = null;
  const onRuntimeEvent = (event: RuntimeEvent) => {
    latestLimitSnapshot = observeRuntimeLimitEvent(event, latestLimitSnapshot, {
      logger: log,
      observedMessage: "Observed runtime limit event during API execution",
      malformedMessage: "Dropped runtime limit event with malformed snapshot payload",
      logContext: {
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        workflowKind: workflow.workflowKind,
        runtimeId: context.resolvedProfile.runtimeId,
        runtimeProfileId: context.resolvedProfile.profileId,
      },
    });
  };
  // Запуск обернут в try: ошибка прогона еще может нести снапшот лимитов,
  // поэтому состояние обновляется до проброса исключения наружу.
  let result: RuntimeRunResult;
  try {
    result = await context.adapter.run({
      runtimeId: context.resolvedProfile.runtimeId,
      providerId: context.resolvedProfile.providerId,
      profileId: context.resolvedProfile.profileId,
      transport: context.resolvedProfile.transport,
      workflowKind: workflow.workflowKind,
      prompt: input.prompt,
      model: context.resolvedProfile.model ?? undefined,
      projectRoot: input.projectRoot,
      cwd: input.projectRoot,
      headers: context.resolvedProfile.headers,
      // Сливаем usageContext вызывающего с полями области, которые уже известны здесь.
      // Источник выбирает вызывающий (commit, fast-fix, ...); мы дописываем
      // projectId + taskId, чтобы сток получил полную область автоматически.
      usageContext: {
        ...input.usageContext,
        projectId: input.projectId,
        taskId: input.taskId ?? null,
      },
      // Опции профиля дополняются адресом и именем переменной с ключом, но
      // только если они заданы: пустые поля не должны затирать значения
      // адаптера по умолчанию.
      options: {
        ...context.resolvedProfile.options,
        ...(context.resolvedProfile.baseUrl ? { baseUrl: context.resolvedProfile.baseUrl } : {}),
        ...(context.resolvedProfile.apiKeyEnvVar
          ? { apiKeyEnvVar: context.resolvedProfile.apiKeyEnvVar }
          : {}),
      },
      // Настройки исполнения: таймауты, окружение и крючки безопасности.
      // Значения берутся из окружения сервера, а не из аргументов запроса.
      execution: {
        // CLI/API транспорты выдают вывод только после полного завершения прогона,
        // поэтому таймаут старта бессмысленен — отключаем и полагаемся только на таймаут прогона.
        startTimeoutMs:
          context.resolvedProfile.transport === "sdk" ? env.API_RUNTIME_START_TIMEOUT_MS : 0,
        runTimeoutMs: env.API_RUNTIME_RUN_TIMEOUT_MS,
        includePartialMessages: input.includePartialMessages ?? false,
        maxTurns: input.maxTurns,
        onEvent: onRuntimeEvent,
        systemPromptAppend: input.systemPromptAppend,
        bypassPermissions,
        environment: input.taskId
          ? { HANDOFF_MODE: "1", HANDOFF_TASK_ID: input.taskId, ...branchEnvironment }
          : { HANDOFF_MODE: "1" },
        // Крючки задают режим подтверждений и доверенный токен: он нужен,
        // чтобы внутренний вызов прошел проверки без ручного одобрения.
        hooks: {
          permissionMode: bypassPermissions ? "bypassPermissions" : "acceptEdits",
          allowDangerouslySkipPermissions: bypassPermissions,
          _trustToken: RUNTIME_TRUST_TOKEN,
          settings: { attribution: { commit: "", pr: "" } },
          settingSources: ["project"],
        },
      },
    });

    // Снапшот из результатов прогона имеет приоритет над накопленным: он
    // собран адаптером целиком, а не по отдельным событиям потока.
    latestLimitSnapshot = extractLatestRuntimeLimitSnapshot(result.events) ?? latestLimitSnapshot;
    if (latestLimitSnapshot) {
      refreshRuntimeProfileLimitState({
        runtimeProfileId: context.resolvedProfile.profileId,
        runtimeId: context.resolvedProfile.runtimeId,
        providerId: context.resolvedProfile.providerId,
        snapshot: latestLimitSnapshot,
        taskId: input.taskId ?? null,
        projectId: input.projectId,
        workflowKind: workflow.workflowKind,
        reason: "oneshot:success",
      });
    } else {
      // Отсутствие сигнала о лимитах не повод стирать прежнее значение:
      // состояние сбрасывается только по явному признаку.
      log.debug(
        {
          runtimeProfileId: context.resolvedProfile.profileId,
          runtimeId: context.resolvedProfile.runtimeId,
          providerId: context.resolvedProfile.providerId,
          taskId: input.taskId ?? null,
          projectId: input.projectId,
          workflowKind: workflow.workflowKind,
        },
        "Preserving runtime limit state after successful API execution without an authoritative recovery signal",
      );
    }
  } catch (error) {
    // clearOnMissing=false: ошибка без снапшота оставляет прошлое состояние
    // лимитов в силе, иначе временный сбой обнулял бы счетчики в интерфейсе.
    refreshRuntimeProfileLimitState({
      runtimeProfileId: context.resolvedProfile.profileId,
      runtimeId: context.resolvedProfile.runtimeId,
      providerId: context.resolvedProfile.providerId,
      snapshot: extractRuntimeLimitSnapshotFromError(error),
      clearOnMissing: false,
      taskId: input.taskId ?? null,
      projectId: input.projectId,
      workflowKind: workflow.workflowKind,
      reason: "oneshot:error",
    });
    throw error;
  }

  // Итоговая строка лога содержит профиль и модель, но не ключи доступа:
  // те же поля, что и при разрешении контекста, для сквозной корреляции.
  log.info(
    {
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      workflowKind: workflow.workflowKind,
      runtimeId: context.resolvedProfile.runtimeId,
      profileId: context.resolvedProfile.profileId,
      providerId: context.resolvedProfile.providerId,
      model: context.resolvedProfile.model,
    },
    "INFO [api-runtime] One-shot runtime query completed",
  );

  // Контекст возвращается вместе с результатом, чтобы вызывающий использовал
  // тот же адаптер и профиль на следующих шагах без повторного разрешения.
  return { result, context };
}
