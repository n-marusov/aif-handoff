/**
 * Маршруты проектов: CRUD, привязка git-репозитория, настройки рантайма, roadmap и
 * проектная конфигурация.
 *
 * Почему файл устроен именно так:
 * - Все чтения и записи идут через @aif/data и локальный слой repositories/projects. API не
 *   строит SQL сам (это запрещено ESLint-правилом) и не дублирует правила владения данными.
 * - Любая мутация проекта сопровождается WS-событием: веб-клиент не опрашивает состояние
 *   циклически, а обновляет доску по пушу, поэтому broadcast здесь не опционален.
 * - Выбор runtime-профилей валидируется до записи. Профиль может принадлежать другому
 *   проекту, и молчаливое сохранение такой ссылки сломало бы резолвинг рантайма позже,
 *   в фоне, где диагностика намного дороже.
 * - Запрет "параллельная автоочередь + создание веток" проверяется на нескольких входах
 *   (создание, обновление, переключение автоочереди), а не в одном месте: флаг
 *   AIF_TASK_WORKTREES_ENABLED читается в момент запроса, а не при старте процесса, поэтому
 *   единая точка проверки могла бы работать с устаревшим представлением о среде.
 * - Warmup-сессии живут в БД и переживают перезапуск API, поэтому их состояние читается
 *   заново на каждый запрос, а не держится в памяти процесса.
 * - Роадмап-генерация запускается фоном и отвечает 202: она длится минуты, и удержание HTTP
 *   соединения привело бы к таймаутам прокси. Результат доставляется через WS-события.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { jsonValidator } from "../middleware/zodValidator.js";
import { internalBroadcastAuth } from "../middleware/internalBroadcastAuth.js";
import { logger, getEnv, getProjectConfig } from "@aif/shared";
import {
  clearActiveRuntimeWarmupSessions,
  createRuntimeWarmupSession,
  expireStaleRuntimeWarmupSessions,
  findActiveReadyRuntimeWarmupSession,
  findRuntimeProfileById,
  findTaskById,
  markRuntimeWarmupSessionFailed,
  markRuntimeWarmupSessionReady,
  type RuntimeWarmupSessionRow,
} from "@aif/data";
import {
  createProjectSchema,
  roadmapImportSchema,
  roadmapGenerateSchema,
  broadcastProjectSchema,
  autoQueueModeSchema,
  warmupCreateSchema,
  updateProjectOrganizationSchema,
} from "../schemas.js";
import { getAutoQueueMode, setAutoQueueMode } from "@aif/data";
import { broadcast } from "../ws.js";
import {
  listProjects,
  listProjectTaskOverviews,
  findProjectById,
  createProject,
  updateProject,
  updateProjectOrganization,
  deleteProject,
  getProjectMcpServers,
} from "../repositories/projects.js";
import { toTaskBroadcastPayload } from "../repositories/tasks.js";
import {
  generateRoadmapFile,
  generateRoadmapTasks,
  importGeneratedTasks,
  RoadmapGenerationError,
} from "../services/roadmapGeneration.js";
import { validateProjectScopedRuntimeProfileSelections } from "../services/runtimeProfileScope.js";
import {
  resolveApiWarmupSupport,
  resolveApiWarmupSupports,
  runApiRuntimeOneShot,
  type ApiWarmupSupport,
} from "../services/runtime.js";

const log = logger("projects-route");

// Роутер монтируется под /projects; порядок регистрации маршрутов важен - статические пути
// (/overview) объявлены раньше параметрических (/:id), иначе Hono матчил бы ":id" как проект.
export const projectsRouter = new Hono();

// Промпт прогревa намеренно запрещает правки и пересказ контекста: сессия не решает задачу, а
// создает префикс контекста, который потом форкается под реальные задачи. Пересказ в финальном
// ответе съел бы контекст и не дал бы ничего полезного для последующих форков.
const WARMUP_PROMPT =
  "Study the current project context, including its structure, architecture layers, package boundaries, conventions, and relevant documentation, so this session can be forked for future tasks. Do not edit files. Do not summarize the context; if a final response is required, reply only that warmup is complete.";

/**
 * Флаг прогрева читается из окружения на каждый вызов, а не кэшируется в модуле: значение
 * может меняться между запросами без перезапуска процесса, а также различаться между
 * экземплярами API за балансировщиком.
 */
function getWarmupEnabled(): boolean {
  return getEnv().AIF_WARMUP_ENABLED;
}

/**
 * Проверяет несовместимость параллельной автоочереди с созданием git-веток.
 *
 * Инвариант: без изоляции рабочих деревьев параллельные задачи писали бы в один и тот же
 * рабочий каталог и конфликтовали за одну ветку. Возвращает текст ошибки для клиента или
 * null, если конфигурация допустима. Проверка вызывается до записи, чтобы в БД не попало
 * состояние, которое агент не сможет отработать.
 */
function rejectsParallelAutoQueueWithBranches(input: {
  rootPath: string;
  parallelEnabled: boolean;
  autoQueueMode: boolean;
}): string | null {
  // Явно включенные рабочие деревья снимают ограничение полностью.
  if (getEnv().AIF_TASK_WORKTREES_ENABLED) return null;
  // Риск возникает только при одновременном включении параллелизма и автоочереди.
  if (!input.parallelEnabled || !input.autoQueueMode) return null;
  // Проект без git или без создания веток не страдает: задачи работают в одном каталоге,
  // но и не претендуют на отдельные ветки.
  const config = getProjectConfig(input.rootPath);
  if (!config.git.enabled || !config.git.create_branches) return null;
  return "Parallel auto-queue with git.create_branches=true requires AIF_TASK_WORKTREES_ENABLED=true";
}

/**
 * Описывает идентичность warmup-сессии: набор координат, по которым сессию можно переиспользовать.
 * Возвращает null, если рантайм не определился: без runtimeId/providerId сессия несопоставима
 * ни с одной будущей задачей, и хранить ее бессмысленно.
 */
function warmupScopeFromSupport(
  support: {
    runtimeId: string | null;
    providerId: string | null;
    runtimeProfileId: string | null;
    transport: string | null;
    model: string | null;
  },
  projectId: string,
) {
  // Неполный рантайм не дает стабильного ключа - такой прогрев нельзя переиспользовать.
  if (!support.runtimeId || !support.providerId) return null;
  return {
    projectId,
    runtimeProfileId: support.runtimeProfileId,
    runtimeId: support.runtimeId,
    providerId: support.providerId,
    transport: support.transport,
    model: support.model,
  };
}

/**
 * Стабильный ключ warmup-сессии для дедупликации.
 * JSON-массив с фиксированным порядком полей используется вместо конкатенации со склейкой:
 * склейка строк дала бы ложные совпадения на границах значений, а порядок ключей объекта в
 * JSON.stringify в этом случае не гарантирован.
 */
function warmupScopeKey(scope: NonNullable<ReturnType<typeof warmupScopeFromSupport>>): string {
  return JSON.stringify([
    scope.projectId,
    scope.runtimeProfileId ?? null,
    scope.runtimeId,
    scope.providerId,
    scope.transport ?? null,
    scope.model ?? null,
  ]);
}

/**
 * Отбирает поддерживаемые цели прогрева, убирая дубликаты по ключу сессии.
 * Дубликаты возможны, когда разные workflow-цели резолвятся в один и тот же рантайм и модель:
 * без дедупликации мы получили бы несколько одинаковых warmup-сессий и лишние запуски рантайма.
 */
function supportedWarmupScopes(projectId: string, supports: ApiWarmupSupport[]) {
  const seen = new Set<string>();
  const scopes: Array<{
    support: ApiWarmupSupport;
    scope: NonNullable<ReturnType<typeof warmupScopeFromSupport>>;
  }> = [];

  for (const support of supports) {
    // Неподдерживаемые цели пропускаются: прогрев по ним все равно упадет.
    if (!support.supported) continue;
    const scope = warmupScopeFromSupport(support, projectId);
    if (!scope) continue;
    const key = warmupScopeKey(scope);
    if (seen.has(key)) continue;
    seen.add(key);
    scopes.push({ support, scope });
  }

  return scopes;
}

/**
 * Преобразует строку warmup-сессии в payload для API и WS.
 * remainingSeconds считается на месте, а не хранится в БД: TTL должен убывать между запросами,
 * а записанное в БД значение застыло бы. Нижняя граница через Math.max не дает отрицательных
 * значений для уже истекших сессий, которые еще не успели вычиститься.
 */
function toWarmupPayload(row: RuntimeWarmupSessionRow | undefined | null, now = new Date()) {
  if (!row) return null;
  const remainingSeconds = Math.max(
    0,
    Math.floor((Date.parse(row.expiresAt) - now.getTime()) / 1000),
  );
  return {
    id: row.id,
    projectId: row.projectId,
    runtimeProfileId: row.runtimeProfileId,
    runtimeId: row.runtimeId,
    providerId: row.providerId,
    transport: row.transport,
    model: row.model,
    status: row.status,
    ttlSeconds: row.ttlSeconds,
    expiresAt: row.expiresAt,
    remainingSeconds,
    summary: row.summary,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Сообщает всем открытым клиентам об изменении состояния прогрева.
 * Статус передается строкой, а не сессией: клиенту достаточно понять, нужно ли перезапросить
 * полное состояние через GET /projects/:id/warmup, и не тащить в событие чувствительные данные.
 */
function broadcastWarmupUpdate(
  projectId: string,
  status: "ready" | "failed" | "partial" | "cleared" | "expired",
) {
  broadcast({ type: "project:warmup_updated", payload: { projectId, status } });
  log.debug({ projectId, status }, "Warmup state broadcast");
}

/**
 * Собирает сводку по прогреву проекта: поддержка рантаймов, активная сессия и все готовые сессии.
 *
 * Почему так:
 * - Сначала ищется список целей, и только при их отсутствии выполняется одиночный резолв: это
 *   экономит вызовы провайдера в обычном случае.
 * - Просроченные сессии вычищаются здесь же, на чтении: отдельного планировщика уборки нет,
 *   поэтому каждый статус-запрос заодно приводит хранилище в порядок.
 * - Флаг enabled применяется к поддержке поверх ее собственного значения: при выключенной фиче
 *   UI должен видеть причину feature_disabled, а не техническую неподдерживаемость рантайма.
 */
async function buildWarmupOverview(projectId: string) {
  const enabled = getWarmupEnabled();
  const targetSupports = await resolveApiWarmupSupports(projectId);
  const support =
    targetSupports.find((target) => target.supported) ??
    targetSupports[0] ??
    (await resolveApiWarmupSupport(projectId));
  const scope = warmupScopeFromSupport(support, projectId);
  expireStaleRuntimeWarmupSessions();
  const active = scope ? findActiveReadyRuntimeWarmupSession(scope) : undefined;
  const warmups = supportedWarmupScopes(projectId, targetSupports)
    .map(({ scope }) => findActiveReadyRuntimeWarmupSession(scope))
    .filter((row): row is RuntimeWarmupSessionRow => Boolean(row))
    .map((row) => toWarmupPayload(row));
  return {
    enabled,
    support: {
      ...support,
      supported: enabled && support.supported,
      skipReason: !enabled ? "feature_disabled" : (support.skipReason ?? null),
    },
    targets: targetSupports.map((target) => ({
      ...target,
      supported: enabled && target.supported,
      skipReason: !enabled ? "feature_disabled" : (target.skipReason ?? null),
    })),
    warmup: toWarmupPayload(active),
    warmups,
  };
}

// GET /projects - полный список проектов для селектора в UI.
// Пагинации нет намеренно: проектов в инсталляции десятки, и клиент держит их целиком
// в памяти, чтобы фильтровать и группировать без дополнительных запросов.
// GET /projects
projectsRouter.get("/", (c) => {
  const all = listProjects();
  log.debug({ count: all.length }, "Listed all projects");
  return c.json(all);
});

// Отдельный маршрут для обзорного экрана: считает метрики задач сразу по всем проектам.
// Сделано на сервере, а не агрегацией на клиенте, чтобы не тянуть все задачи в браузер -
// сводка возвращает только счетчики и превью.
// GET /projects/overview - компактные метрики задач и превью для экрана сводки
projectsRouter.get("/overview", (c) => {
  const overview = listProjectTaskOverviews();
  log.debug(
    { projectCount: overview.length, responseType: "ProjectTaskOverview" },
    "Listed project task overview",
  );
  return c.json(overview);
});

// POST /projects
// Создание проверяет три независимые вещи в порядке возрастания цены: сначала аргументы
// (runtime-профили), затем данные (имя, путь), и только потом инициализация репозитория.
// Разные коды ответов не случайны: 400 - клиент может исправить ввод и повторить, 500 -
// проблема среды (нет доступа к каталогу, не прошла инициализация git), повтор не поможет.
projectsRouter.post("/", jsonValidator(createProjectSchema), async (c) => {
  const body = c.req.valid("json");
  const runtimeValidation = validateProjectScopedRuntimeProfileSelections({
    // projectId = null: проекта еще нет, поэтому допустимы только глобальные профили.
    // Ссылку на профиль другого проекта сохранить нельзя - она станет висячей.
    projectId: null,
    selections: {
      defaultTaskRuntimeProfileId: body.defaultTaskRuntimeProfileId,
      defaultPlanRuntimeProfileId: body.defaultPlanRuntimeProfileId,
      defaultReviewRuntimeProfileId: body.defaultReviewRuntimeProfileId,
      defaultChatRuntimeProfileId: body.defaultChatRuntimeProfileId,
    },
  });
  if (runtimeValidation) {
    log.warn({ fieldErrors: runtimeValidation.fieldErrors }, "Rejected invalid project defaults");
    return c.json(runtimeValidation, 400);
  }
  const { project: created, pathError, initError, nameError } = await createProject(body);
  // Ошибка имени проверяется первой: это самая частая причина отказа и самая понятная
  // пользователю, остальные проверки до нее просто не доходят.
  if (nameError) {
    log.warn({ name: body.name }, "Rejected duplicate project name");
    return c.json({ error: nameError }, 400);
  }
  if (pathError) return c.json({ error: pathError }, 400);
  if (initError) return c.json({ error: initError }, 500);
  if (!created) return c.json({ error: "Failed to create project" }, 500);

  // 201 и явный broadcast: клиент узнает о проекте из события, а не из периодического опроса.
  log.debug({ projectId: created.id, name: body.name }, "Project created");
  broadcast({ type: "project:created", payload: created });
  return c.json(created, 201);
});

// PUT /projects/:id
// Обновление сперва убеждается, что проект существует: без этого updateProject молча создал бы
// запись с чужим id или вернул невнятную ошибку на уровне данных.
// Схема та же, что при создании (createProjectSchema): тело PUT - полное представление проекта,
// частичных обновлений здесь нет, для точечных правок есть PATCH-маршруты ниже.
projectsRouter.put("/:id", jsonValidator(createProjectSchema), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid("json");

  const existing = findProjectById(id);
  if (!existing) {
    return c.json({ error: "Project not found" }, 404);
  }

  const runtimeValidation = validateProjectScopedRuntimeProfileSelections({
    // projectId = id: при обновлении допустимы как глобальные профили, так и профили самого
    // проекта - функция валидации различает эти два случая по переданному идентификатору.
    projectId: id,
    selections: {
      defaultTaskRuntimeProfileId: body.defaultTaskRuntimeProfileId,
      defaultPlanRuntimeProfileId: body.defaultPlanRuntimeProfileId,
      defaultReviewRuntimeProfileId: body.defaultReviewRuntimeProfileId,
      defaultChatRuntimeProfileId: body.defaultChatRuntimeProfileId,
    },
  });
  if (runtimeValidation) {
    log.warn(
      { projectId: id, fieldErrors: runtimeValidation.fieldErrors },
      "Rejected invalid project defaults",
    );
    return c.json(runtimeValidation, 400);
  }

  // Проверка использует эффективные значения: если клиент не прислал parallelEnabled, берется
  // текущее значение из БД, иначе можно было бы обойти запрет, не упомянув спорное поле.
  const unsupportedParallelAutoQueue = rejectsParallelAutoQueueWithBranches({
    rootPath: existing.rootPath,
    parallelEnabled: body.parallelEnabled ?? existing.parallelEnabled,
    autoQueueMode: existing.autoQueueMode,
  });
  if (unsupportedParallelAutoQueue) {
    return c.json({ error: unsupportedParallelAutoQueue }, 400);
  }

  // Ошибки валидации данных возвращаются до записи, чтобы в БД не осталось частично
  // примененного состояния: updateProject атомарен, но клиент должен получить причину отказа.
  const { project: updated, pathError, nameError } = updateProject(id, body);
  if (nameError) {
    log.warn({ projectId: id, name: body.name }, "Rejected duplicate project name");
    return c.json({ error: nameError }, 400);
  }
  if (pathError) return c.json({ error: pathError }, 400);

  log.debug({ projectId: id }, "Project updated");
  return c.json(updated);
});

// PATCH /projects/:id/organization - обновить метаданные организации в селекторе
// Частичное обновление только метаданных выбора (закрепление, группа): не затрагивает ни
// путь проекта, ни настройки рантайма, поэтому не требует полного тела createProjectSchema.
projectsRouter.patch(
  "/:id/organization",
  jsonValidator(updateProjectOrganizationSchema),
  async (c) => {
    const { id } = c.req.param();
    const body = c.req.valid("json");
    const updated = updateProjectOrganization(id, body);
    if (!updated) return c.json({ error: "Project not found" }, 404);

    log.debug(
      // pinnedAt == null - единственный надежный признак "не закреплен": пустая строка или
      // нулевая метка времени дали бы ложное срабатывание.
      { projectId: id, pinned: updated.pinnedAt != null, groupName: updated.groupName },
      "[FIX:147] Project organization updated",
    );
    broadcast({ type: "project:organization_updated", payload: updated });
    return c.json(updated);
  },
);

// GET /projects/:id/mcp — прочитать .mcp.json из каталога проекта
// Чтение на сервере, а не в браузере: каталог проекта недоступен клиенту, а здесь он читается
// уже проверенными средствами (путь проекта - доверенные данные из БД, не ввод запроса).
projectsRouter.get("/:id/mcp", (c) => {
  const { id } = c.req.param();
  const project = findProjectById(id);
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json({ mcpServers: getProjectMcpServers(id) });
});

// GET /projects/:id/defaults — вернуть разрешённые значения конфигурации по умолчанию для проекта
// Наружу отдаются только paths и workflow: остальная конфигурация проекта не является
// публичным контрактом API, а сохранение ее формы затормозило бы эволюцию схемы.
projectsRouter.get("/:id/defaults", (c) => {
  const { id } = c.req.param();
  const project = findProjectById(id);
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  const cfg = getProjectConfig(project.rootPath);
  return c.json({ paths: cfg.paths, workflow: cfg.workflow });
});

// GET /projects/:id/roadmap/status — проверить, есть ли ROADMAP.md у проекта
// Путь к роадмапу берется из конфигурации проекта, а не хардкодится: разные проекты могут
// держать его в разных местах, и проверка существования должна идти по фактическому пути.
projectsRouter.get("/:id/roadmap/status", (c) => {
  const { id } = c.req.param();
  const project = findProjectById(id);
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  const cfg = getProjectConfig(project.rootPath);
  const roadmapPath = join(project.rootPath, cfg.paths.roadmap);
  const exists = existsSync(roadmapPath);
  log.debug({ projectId: id, roadmapPath, exists }, "Roadmap status check");
  if (exists) {
    log.info({ projectId: id }, "ROADMAP.md found");
  }

  return c.json({ exists });
});

// POST /projects/:id/roadmap/generate — запустить асинхронную генерацию роадмапа и импорт
// Ответ 202 сразу после запуска: генерация длится минуты, и держать HTTP-соединение открытым
// нельзя - прокси и браузеры рвут такие запросы раньше, чем приходит результат.
projectsRouter.post("/:id/roadmap/generate", jsonValidator(roadmapGenerateSchema), async (c) => {
  const { id } = c.req.param();
  const { roadmapAlias, vision } = c.req.valid("json");

  const project = findProjectById(id);
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  log.info({ projectId: id, roadmapAlias, hasVision: !!vision }, "Roadmap generation requested");

  // Fire-and-forget: генерация идёт в фоне, результат рассылается через WS
  // catch здесь обязателен: без него упавшая фоновая задача стала бы unhandled rejection и
  // уронила бы процесс API, а ошибка все равно должна быть только залогирована.
  runRoadmapGenerationJob(id, roadmapAlias, vision).catch((err) => {
    log.error({ projectId: id, roadmapAlias, err }, "Background roadmap generation crashed");
  });

  return c.json({ status: "started", projectId: id, roadmapAlias }, 202);
});

// POST /projects/:id/roadmap/import — запустить импорт роадмапа и создать задачи в backlog
// Импорт синхронный, в отличие от генерации: он только читает готовый файл и создает задачи,
// а это секунды, поэтому клиенту удобнее дождаться итогового результата одним ответом.
projectsRouter.post("/:id/roadmap/import", jsonValidator(roadmapImportSchema), async (c) => {
  const { id } = c.req.param();
  const { roadmapAlias } = c.req.valid("json");

  const project = findProjectById(id);
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  log.info({ projectId: id, roadmapAlias }, "Roadmap import requested");

  try {
    // Вся работа идет под одним try: генерация, импорт с дедупликацией и рассылка событий -
    // любая из них может упасть, и клиент должен получить осмысленный код, а не 500 без деталей.
    // Генерация задач из роадмапа через Agent SDK
    const generation = await generateRoadmapTasks({
      projectId: id,
      roadmapAlias,
    });

    // Импорт с дедупликацией и обогащением тегов
    const result = importGeneratedTasks(id, generation);

    // Рассылка каждой созданной задачи
    // Рассылается каждая задача отдельным событием, а не одним пакетом: клиент добавляет карточки
    // инкрементально и не перерисовывает доску целиком на большом импорте.
    for (const taskId of result.taskIds) {
      const task = findTaskById(taskId);
      if (task) {
        broadcast({ type: "task:created", payload: toTaskBroadcastPayload(task) });
      }
    }

    // Разбудить координатор для обработки новых задач из backlog
    // Побудка только при наличии созданных задач: при полном пропуске (все дубли) поднимать
    // агента незачем - работы для него нет.
    if (result.created > 0) {
      broadcast({ type: "agent:wake", payload: { id } });
      log.info(
        { projectId: id, roadmapAlias, created: result.created },
        "Batch wake event sent after roadmap import",
      );
    }

    log.info(
      { projectId: id, roadmapAlias, created: result.created, skipped: result.skipped },
      "Roadmap import completed",
    );

    return c.json(result, 201);
  } catch (err) {
    if (err instanceof RoadmapGenerationError) {
      // Доменные ошибки различаются по код: отсутствие проекта или файла роадмапа - это 404
      // (ситуация исправима пользователем), все прочие ошибки генерации - 500.
      const status =
        err.code === "PROJECT_NOT_FOUND" || err.code === "ROADMAP_NOT_FOUND" ? 404 : 500;
      log.warn(
        { projectId: id, roadmapAlias, code: err.code, error: err.message },
        "Roadmap import failed",
      );
      return c.json({ error: err.message, code: err.code }, status);
    }
    log.error({ projectId: id, roadmapAlias, err }, "Roadmap import unexpected error");
    return c.json({ error: "Internal server error" }, 500);
  }
});

// GET /projects/:id/auto-queue-mode
// Состояние читается из БД, а не из памяти процесса: флаг переживает перезапуск API и должен
// быть одинаковым для всех экземпляров, включая агент.
projectsRouter.get("/:id/auto-queue-mode", (c) => {
  const { id } = c.req.param();
  const project = findProjectById(id);
  if (!project) return c.json({ error: "Project not found" }, 404);
  const enabled = getAutoQueueMode(id);
  log.debug({ projectId: id, enabled }, "Read auto-queue-mode");
  return c.json({ enabled });
});

// PATCH /projects/:id/auto-queue-mode
// Переключение автоочереди проверяется тем же запретом, что и создание/обновление проекта:
// включение автоочереди может сделать уже сохраненную конфигурацию небезопасной.
projectsRouter.patch("/:id/auto-queue-mode", jsonValidator(autoQueueModeSchema), async (c) => {
  const { id } = c.req.param();
  const { enabled } = c.req.valid("json");
  const project = findProjectById(id);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const unsupportedParallelAutoQueue = rejectsParallelAutoQueueWithBranches({
    // parallelEnabled берется из БД: запрос меняет только автоочередь, но решение зависит от
    // обоих флагов вместе.
    rootPath: project.rootPath,
    parallelEnabled: project.parallelEnabled,
    autoQueueMode: enabled,
  });
  if (unsupportedParallelAutoQueue) {
    return c.json({ error: unsupportedParallelAutoQueue }, 400);
  }

  setAutoQueueMode(id, enabled);
  // Проект перечитывается после записи, чтобы в WS ушло полное актуальное состояние, а не
  // только изменившееся поле: клиент применяет payload как замену объекта проекта.
  const updated = findProjectById(id);
  log.info({ projectId: id, enabled }, "Toggled auto-queue-mode");

  if (updated) {
    // Если запись не нашлась, отвечаем успешно (флаг уже сохранен), но событие не шлем:
    // рассылать нечего, а ошибка здесь только запутала бы клиента.
    broadcast({ type: "project:auto_queue_mode_changed", payload: updated });
  }
  return c.json({ enabled });
});

// GET /projects/:id/warmup
// Составной ответ: поддержка рантаймов, активная сессия и список всех готовых сессий.
// Отдается одним запросом намеренно - UI рисует панель прогрева сразу и не должен собирать
// ее из нескольких обращений, между которыми состояние успело бы измениться.
projectsRouter.get("/:id/warmup", async (c) => {
  const { id } = c.req.param();
  const project = findProjectById(id);
  if (!project) return c.json({ error: "Project not found" }, 404);

  log.debug({ projectId: id }, "Warmup status requested");
  const overview = await buildWarmupOverview(id);
  return c.json(overview);
});

// POST /projects/:id/warmup
// Создает warmup-сессии для всех поддерживаемых целей проекта.
// Семантика частичного успеха заложена в контракт: 207 при частичном успехе и 502 при полном
// провале - клиенту важно знать, что часть сессий уже готова и выбрасывать их не нужно.
projectsRouter.post("/:id/warmup", jsonValidator(warmupCreateSchema), async (c) => {
  const { id } = c.req.param();
  const { ttlSeconds } = c.req.valid("json");
  const project = findProjectById(id);
  if (!project) return c.json({ error: "Project not found" }, 404);

  if (!getWarmupEnabled()) {
    // 403, а не 400: запрос корректен, но фича выключена на уровне развертывания.
    log.warn({ projectId: id }, "Rejected warmup create because feature flag is disabled");
    return c.json({ error: "Warmup is disabled", code: "feature_disabled" }, 403);
  }

  const targetSupports = await resolveApiWarmupSupports(id);
  // Приоритет у поддерживаемой цели: поддержка, выбранная для логирования и ответов,
  // должна совпадать с той, по которой реально создавались сессии, иначе диагностика врет.
  const supportedScopes = supportedWarmupScopes(id, targetSupports);
  const support =
    supportedScopes[0]?.support ?? targetSupports[0] ?? (await resolveApiWarmupSupport(id));
  log.info(
    {
      projectId: id,
      runtimeId: support.runtimeId,
      providerId: support.providerId,
      runtimeProfileId: support.runtimeProfileId,
      transport: support.transport,
      model: support.model,
      supported: support.supported,
      skipReason: support.skipReason ?? null,
      supportedTargetCount: supportedScopes.length,
      ttlSeconds,
    },
    "Warmup create requested",
  );

  if (supportedScopes.length === 0) {
    // 409: конфликт с текущим состоянием среды (проект обслуживается рантаймом, который не
    // умеет прогрев). Код skipReason прокидывается как есть - UI показывает причину пользователю,
    // и подменять ее общим текстом значило бы лишать его возможности исправить конфигурацию.
    return c.json(
      {
        error: "Warmup is not supported by the project's effective runtime",
        code: support.skipReason ?? "unsupported_runtime",
        support,
        targets: targetSupports,
      },
      409,
    );
  }

  const now = new Date();
  // Один expiresAt на все цели: TTL задает пользователь для операции целиком, и одинаковое
  // время истечения делает набор сессий предсказуемым для переиспользования.
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const readyRows: RuntimeWarmupSessionRow[] = [];
  let firstReady: RuntimeWarmupSessionRow | undefined;

  // Вспомогательные замыкания читают readyRows в момент вызова, а не при создании: набор
  // уже готовых целей растет по мере цикла, и статус отказа зависит от итогового состояния.
  const activeWarmupPayloads = () =>
    supportedScopes
      .map(({ scope }) => findActiveReadyRuntimeWarmupSession(scope))
      .filter((row): row is RuntimeWarmupSessionRow => Boolean(row))
      .map((row) => toWarmupPayload(row));
  // 207 (Multi-Status), если хотя бы одна цель уже прогрелась: клиент не должен считать
  // частичный результат полным провалом и терять валидные сессии.
  const warmupFailureStatus = () => (readyRows.length > 0 ? 207 : 502);
  const warmupFailureCode = (code: string) =>
    readyRows.length > 0 ? "partial_warmup_failed" : code;
  const broadcastWarmupFailure = () => {
    broadcastWarmupUpdate(id, readyRows.length > 0 ? "partial" : "failed");
  };

  for (const { support: targetSupport, scope } of supportedScopes) {
    // Строка создается до запуска рантайма: она фиксирует намерение и дает id для
    // маркировки успеха или отказа, даже если процесс упадет на середине.
    const pending = createRuntimeWarmupSession({
      ...scope,
      ttlSeconds,
      expiresAt,
      createdAt: now.toISOString(),
    });
    if (!pending) {
      // Не удалось записать строку - продолжать бессмысленно: результат негде сохранить.
      log.error(
        { projectId: id, workflowKind: targetSupport.workflowKind },
        "Failed to create warmup persistence row",
      );
      return c.json({ error: "Failed to create warmup" }, 500);
    }

    try {
      const { result } = await runApiRuntimeOneShot({
        projectId: id,
        projectRoot: project.rootPath,
        prompt: WARMUP_PROMPT,
        workflowKind: targetSupport.workflowKind,
        profileMode: targetSupport.profileMode,
        usageContext: { source: "warmup" as const },
        includePartialMessages: false,
        maxTurns: 1,
      });

      const seedSessionId = result.sessionId ?? result.session?.id ?? null;
      if (!seedSessionId) {
        // Без идентификатора сессии прогрев бесполезен: форкнуть нечего, и такая сессия
        // не сможет быть сопоставлена с будущими задачами. Это отказ, а не успех с пустым id.
        const failed = markRuntimeWarmupSessionFailed(
          pending.id,
          "Runtime did not return a seed session id",
        );
        log.warn(
          {
            projectId: id,
            warmupId: pending.id,
            runtimeId: scope.runtimeId,
            workflowKind: targetSupport.workflowKind,
          },
          "Warmup create failed because runtime did not return a seed session id",
        );
        broadcastWarmupFailure();
        c.status(warmupFailureStatus());
        return c.json({
          error: "Runtime did not return a seed session id",
          code: warmupFailureCode("missing_seed_session"),
          failedTarget: targetSupport.workflowKind,
          partial: readyRows.length > 0,
          warmup: toWarmupPayload(failed),
          warmups: activeWarmupPayloads(),
          support,
          targets: targetSupports,
        });
      }

      const ready = markRuntimeWarmupSessionReady(pending.id, {
        sourceSessionId: seedSessionId,
        summary: result.outputText || null,
        expiresAt,
        ttlSeconds,
      });
      if (ready) {
        // firstReady запоминается отдельно от массива: в ответе исторически есть и "главная"
        // сессия, и полный список, а порядок целей задан резолвером рантайма.
        readyRows.push(ready);
        firstReady ??= ready;
      }
      log.info(
        {
          projectId: id,
          warmupId: pending.id,
          runtimeId: scope.runtimeId,
          runtimeProfileId: scope.runtimeProfileId,
          workflowKind: targetSupport.workflowKind,
          profileMode: targetSupport.profileMode,
          ttlSeconds,
          expiresAt,
        },
        "Warmup create succeeded",
      );
    } catch (error) {
      // Сообщение приводится к строке явно: в ошибку может прийти что угодно, а оно идет
      // и в БД, и в ответ клиенту, поэтому должно быть строкой в любом случае.
      const message = error instanceof Error ? error.message : String(error);
      const failed = markRuntimeWarmupSessionFailed(pending.id, message);
      log.warn(
        {
          projectId: id,
          warmupId: pending.id,
          runtimeId: scope.runtimeId,
          workflowKind: targetSupport.workflowKind,
          err: error,
        },
        "Warmup create failed during runtime execution",
      );
      broadcastWarmupFailure();
      c.status(warmupFailureStatus());
      return c.json({
        error: message,
        code: warmupFailureCode("runtime_failed"),
        failedTarget: targetSupport.workflowKind,
        partial: readyRows.length > 0,
        warmup: toWarmupPayload(failed),
        warmups: activeWarmupPayloads(),
        support,
        targets: targetSupports,
      });
    }
  }

  broadcastWarmupUpdate(id, "ready");
  return c.json(
    {
      enabled: true,
      support,
      targets: targetSupports,
      warmup: toWarmupPayload(firstReady),
      warmups: readyRows.map((row) => toWarmupPayload(row)),
    },
    201,
  );
});

// DELETE /projects/:id/warmup
// Очистка идемпотентна и не падает, если активных сессий нет: повторный вызов возвращает
// cleared: 0, а не ошибку.
projectsRouter.delete("/:id/warmup", async (c) => {
  const { id } = c.req.param();
  const project = findProjectById(id);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const targetSupports = await resolveApiWarmupSupports(id);
  const supportedScopes = supportedWarmupScopes(id, targetSupports);
  const support =
    supportedScopes[0]?.support ?? targetSupports[0] ?? (await resolveApiWarmupSupport(id));
  const cleared = supportedScopes.reduce(
    // Суммируется число закрытых сессий по всем поддерживаемым целям: очистка должна задеть
    // все варианты рантайма, а не только тот, который выбран для новых задач.
    (count, { scope }) => count + clearActiveRuntimeWarmupSessions(scope),
    0,
  );
  log.info(
    {
      projectId: id,
      runtimeId: support.runtimeId,
      runtimeProfileId: support.runtimeProfileId,
      supportedTargetCount: supportedScopes.length,
      cleared,
    },
    "Warmup cleared",
  );
  if (cleared > 0) {
    broadcastWarmupUpdate(id, "cleared");
  }
  return c.json({ success: true, cleared });
});

// POST /projects/:id/broadcast — отправить событие WS уровня проекта (используется координатором агента)
// Внутренний маршрут: агент шлет события в тот же WS-канал, что и API, чтобы клиент видел
// единый поток без отдельного соединения к агенту. Защищен internalBroadcastAuth.
// Здесь же выполняется проверка состава события: агент не должен уметь разослать событие
// с taskId или runtimeProfileId, не принадлежащими целевому проекту, иначе клиент получил бы
// обновление о чужом проекте и открыл бы доступ к чужим данным в UI.
projectsRouter.post(
  "/:id/broadcast",
  internalBroadcastAuth,
  jsonValidator(broadcastProjectSchema),
  async (c) => {
    const { id } = c.req.param();
    const { type, taskId, runtimeProfileId } = c.req.valid("json");
    // Проект обязателен даже для событий, чей payload строится по taskId: событие привязано
    // к каналу проекта, и несуществующий id - признак ошибки вызывающей стороны.
    const project = findProjectById(id);
    if (!project) return c.json({ error: "Project not found" }, 404);

    if (type === "project:auto_queue_advanced" && taskId) {
      // Проверка владения задачей: без нее агент мог бы продвинуть карточку в чужом проекте,
      // а клиент применил бы обновление к своему открытому проекту.
      const task = findTaskById(taskId);
      if (!task || task.projectId !== id) {
        return c.json({ error: "taskId does not belong to the target project" }, 400);
      }
    }

    if (type === "project:runtime_limit_updated" && !runtimeProfileId) {
      // Для события обновления лимитов профиль обязателен: без него payload не несет смысла,
      // а клиент не знает, к какому профилю применить новое состояние.
      return c.json(
        { error: "runtimeProfileId is required for project:runtime_limit_updated" },
        400,
      );
    }

    if (type === "project:runtime_limit_updated" && runtimeProfileId) {
      const runtimeProfile = findRuntimeProfileById(runtimeProfileId);
      // Проектный профиль должен принадлежать тому же проекту; глобальные профили (projectId
      // == null) допустимы везде, потому что они и так видны всем проектам.
      const belongsToProject =
        runtimeProfile?.projectId === id || runtimeProfile?.projectId == null;
      if (!runtimeProfile || !belongsToProject) {
        return c.json(
          { error: "runtimeProfileId must belong to the target project or be global" },
          400,
        );
      }
    }

    if (type === "project:auto_queue_advanced" && taskId) {
      // Payload здесь только с id задачи: клиент уже знает проект, а лишние поля создавали бы
      // вторую копию состояния, которую пришлось бы синхронизировать.
      broadcast({ type, payload: { id: taskId } });
    } else if (type === "project:runtime_limit_updated") {
      broadcast({
        type,
        payload: {
          projectId: id,
          runtimeProfileId: runtimeProfileId ?? null,
          taskId: taskId ?? null,
        },
      });
    } else {
      // Фолбэк для обычных событий проекта (created/updated/organization_updated): payload -
      // сам проект. Поддержка произвольных типов не открыта намеренно - маршрут внутренний,
      // но валидация схемы все равно ограничивает набор допустимых типов.
      broadcast({ type, payload: project });
    }
    log.debug(
      { projectId: id, type, taskId: taskId ?? null, runtimeProfileId: runtimeProfileId ?? null },
      "Project WS broadcast triggered",
    );
    return c.json({ success: true });
  },
);

// DELETE /projects/:id
// Удаляется только запись проекта: файлы на диске и git-репозиторий не трогаются, потому что
// каталог мог быть создан до регистрации проекта и может использоваться вручную.
projectsRouter.delete("/:id", (c) => {
  const { id } = c.req.param();
  const existing = findProjectById(id);
  if (!existing) {
    return c.json({ error: "Project not found" }, 404);
  }

  deleteProject(id);
  // Broadcast на удаление не шлется: событие было бы отправлено в канал уже удаленного
  // проекта, а клиент обновляет список проектов отдельным запросом.
  log.debug({ projectId: id }, "Project deleted");
  return c.json({ success: true });
});

// -- Фоновая задача генерации роадмапа --
// Запускается из POST /projects/:id/roadmap/generate и живет вне жизненного цикла HTTP-запроса:
// к моменту завершения соединение уже закрыто, поэтому весь прогресс и результат доставляются
// WS-событиями, а не телом ответа.

async function runRoadmapGenerationJob(
  projectId: string,
  roadmapAlias: string,
  vision?: string,
): Promise<void> {
  try {
    // Шаги идут строго последовательно и не параллелятся: каждый следующий читает артефакт
    // предыдущего (сначала файл роадмапа, затем задачи из него), порядок здесь - часть контракта.
    // Шаг 1: создать ROADMAP.md
    const generated = await generateRoadmapFile({ projectId, vision });
    log.info({ projectId, roadmapPath: generated.roadmapPath }, "ROADMAP.md generated");

    // Шаг 2: извлечь задачи из созданного роадмапа
    const extraction = await generateRoadmapTasks({ projectId, roadmapAlias });

    // Шаг 3: импорт с дедупликацией и обогащением тегов
    const result = importGeneratedTasks(projectId, extraction);

    // Шаг 4: разослать каждую созданную задачу
    for (const taskId of result.taskIds) {
      const task = findTaskById(taskId);
      if (task) {
        broadcast({ type: "task:created", payload: toTaskBroadcastPayload(task) });
      }
    }

    // Разбудить координатор
    if (result.created > 0) {
      broadcast({ type: "agent:wake", payload: { id: projectId } });
    }

    // Рассылка завершения
    // Отдельное событие завершения нужно потому, что task:created и agent:wake не говорят
    // клиенту, когда генерация закончилась и можно снимать индикатор ожидания.
    broadcast({
      type: "roadmap:complete",
      payload: {
        projectId,
        roadmapAlias: result.roadmapAlias,
        created: result.created,
        skipped: result.skipped,
        taskIds: result.taskIds,
        byPhase: result.byPhase,
      },
    });

    log.info(
      { projectId, roadmapAlias, created: result.created, skipped: result.skipped },
      "Roadmap generation and import completed",
    );
  } catch (err) {
    // Код известен только для доменных ошибок генерации; для всего остального используется
    // UNKNOWN. Текст ошибки уходит клиенту намеренно: без него фоновый сбой никак не увидеть
    // в UI, а соединения, которое могло бы вернуть ошибку, уже нет.
    const code = err instanceof RoadmapGenerationError ? err.code : "UNKNOWN";
    const message = err instanceof Error ? err.message : String(err);
    log.error({ projectId, roadmapAlias, code, error: message }, "Roadmap generation job failed");

    broadcast({
      type: "roadmap:error",
      payload: { projectId, roadmapAlias, error: message, code },
    });
  }
}
