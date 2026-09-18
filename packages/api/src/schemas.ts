/**
 * Zod-схемы валидации входящих HTTP-запросов API.
 *
 * Почему модуль устроен именно так:
 * - Схемы собраны в одном файле, потому что REST-маршруты и WebSocket-слой
 *   обязаны проверять одинаковые формы; продублированные описания расходятся
 *   и пропускают невалидные поля в базу.
 * - Значения по умолчанию задаются здесь, а не в обработчиках: так
 *   отсутствующее поле приходит в маршрут уже заполненным, и код не проверяет
 *   undefined в каждом втором месте.
 * - getEnv() вызывается на этапе разбора запроса, поэтому дефолты читают
 *   окружение момента запроса, а не момента импорта модуля.
 * - Схемы описывают только вход. Секреты (токены провайдеров, пароли) никогда
 *   не выводятся через эти схемы наружу.
 */
import { z } from "zod";
import { TASK_EVENTS, TASK_STATUSES, getEnv } from "@aif/shared";

export const participantLoginSchema = z.object({
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(10_000),
});

// Порог в 12 символов выше, чем у обычного логина: пароль участника открывает
// весь API, включая административные операции.
const participantPasswordSchema = z.string().min(12).max(10_000);

export const createParticipantSchema = z.object({
  username: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  password: participantPasswordSchema,
  role: z.enum(["admin", "member"]).default("member"),
});

// Пустое тело отвергается refine-ом ниже: запрос без изменений не должен
// считаться успешным обновлением, иначе UI покажет ложное подтверждение.
export const updateParticipantSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    role: z.enum(["admin", "member"]).optional(),
  })
  .refine((input) => input.displayName !== undefined || input.role !== undefined, {
    message: "At least one participant field is required",
  });

export const resetParticipantPasswordSchema = z.object({
  password: participantPasswordSchema,
});

// Требуем текущий пароль: смена только по активной сессии позволила бы
// угнанной cookie молча переписать учетные данные.
export const changeParticipantPasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(10_000),
    newPassword: participantPasswordSchema,
  })
  .refine((input) => input.currentPassword !== input.newPassword, {
    message: "New password must differ from the current password",
    path: ["newPassword"],
  });

// Query-параметры приходят строками, поэтому boolean разбирается через enum:
// z.coerce.boolean() превратил бы строку "false" в true.
export const listParticipantsQuerySchema = z.object({
  includeInactive: z
    // Явное перечисление значений отсекает мусор вроде "1" вместо флага.
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .default(false),
});

/**
 * Дату в формате ISO-8601 принимают с любым смещением, но перед
 * сохранением **нормализуют к виду UTC `Z`**. В БД `scheduledAt`
 * сравнивается как TEXT (`<=` против `new Date().toISOString()`), и
 * лексикографическое сравнение строк совпадает со сравнением моментов
 * времени, только если обе стороны в одиначной форме UTC `Z`. Без
 * нормализации значения `+03:00` молча никогда не сработают.
 *
 * `null` допустим, чтобы снять ранее назначенное выполнение.
 * Прошедшие метки времени отклоняются здесь, чтобы планировщику никогда
 * не приходилось запускать уже просроченное.
 */
export const scheduledAtSchema = z
  .string()
  .datetime({ offset: true, message: "scheduledAt must be ISO-8601" })
  // Приведение к UTC Z обязательно: сравнение с текущим временем идет по тексту.
  .transform((s) => new Date(s).toISOString())
  .refine((iso) => Date.parse(iso) > Date.now(), {
    message: "scheduledAt must be a future timestamp",
  })
  .nullable()
  .optional();

// Вложения ограничены по размеру и числу: контент приходит в JSON-теле, и без
// границ такой запрос становится вектором отказа в обслуживании.
const taskAttachmentSchema = z.object({
  name: z.string().min(1).max(500),
  mimeType: z.string().max(200),
  size: z.number().int().min(0).max(100_000_000),
  // content == null означает, что файл уже лежит в storage/ и путь указан в path.
  content: z.string().max(2_000_000).nullable(),
  /** Относительный путь в storage/ — есть у вложений, сохранённых в файл */
  path: z.string().max(1000).optional(),
});

// Лимиты бюджета опциональны: отсутствие значения означает отсутствие
// ограничения, а не нулевой бюджет.
export const createProjectSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  rootPath: z.string().min(1).optional(),
  plannerMaxBudgetUsd: z.number().positive().optional(),
  planCheckerMaxBudgetUsd: z.number().positive().optional(),
  implementerMaxBudgetUsd: z.number().positive().optional(),
  reviewSidecarMaxBudgetUsd: z.number().positive().optional(),
  parallelEnabled: z.boolean().optional(),
  defaultTaskRuntimeProfileId: z.string().min(1).nullable().optional(),
  defaultPlanRuntimeProfileId: z.string().min(1).nullable().optional(),
  defaultReviewRuntimeProfileId: z.string().min(1).nullable().optional(),
  defaultChatRuntimeProfileId: z.string().min(1).nullable().optional(),
});

export const githubConnectSchema = z.object({
  repository: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Repository must use owner/name format"),
  // В базе хранится только имя переменной окружения, сам токен не сохраняется.
  tokenEnvVar: z
    .string()
    .trim()
    .regex(
      /^GITHUB_[A-Z0-9_]+$/,
      "tokenEnvVar must be an uppercase GITHUB_* environment variable name",
    )
    .default("GITHUB_TOKEN"),
  enabled: z.boolean().default(true),
  // Пустой фильтр означает импорт всех задач; значения сужают выборку.
  eligibility: z
    .object({
      labels: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
      assignee: z.string().trim().min(1).max(100).nullable().default(null),
      milestone: z.string().trim().min(1).max(200).nullable().default(null),
    })
    .default({ labels: [], assignee: null, milestone: null }),
});

// Синхронизация не принимает полей: параметры берутся из настроек проекта.
export const githubSyncSchema = z.object({});

// Код публикуется в уже существующую ветку, поэтому коммит и логи
// необязательны: при отсутствии сервер берет их из состояния задачи.
export const githubPublishSchema = z.object({
  branch: z.string().trim().min(1).max(250),
  commitSha: z.string().trim().min(7).max(64).nullable().optional(),
  implementationLog: z.string().max(100_000).nullable().optional(),
  reviewComments: z.string().max(100_000).nullable().optional(),
});

/**
 * Тело запроса публикации PR плана изменений (режим plan-review). Текст
 * плана собирается на сервере из сохранённого плана; агент передаёт только
 * ветку (и опционально детерминированный sha коммита плана).
 */
export const githubPlanPublishSchema = z.object({
  branch: z.string().trim().min(1).max(250),
  commitSha: z.string().trim().min(7).max(64).nullable().optional(),
});

export const gitlabConnectSchema = z.object({
  repository: z
    .string()
    .trim()
    .regex(
      /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/,
      "Repository must use namespace/name format (nested groups supported)",
    ),
  // Хранится только имя переменной окружения, сам токен в базу не попадает.
  tokenEnvVar: z
    .string()
    .trim()
    .regex(
      /^GITLAB_[A-Z0-9_]+$/,
      "tokenEnvVar must be an uppercase GITLAB_* environment variable name",
    )
    .default("GITLAB_TOKEN"),
  enabled: z.boolean().default(true),
  // Пустой фильтр означает импорт всех задач; значения сужают выборку.
  eligibility: z
    .object({
      labels: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
      assignee: z.string().trim().min(1).max(100).nullable().default(null),
      milestone: z.string().trim().min(1).max(200).nullable().default(null),
    })
    .default({ labels: [], assignee: null, milestone: null }),
});

// Синхронизация не принимает полей: параметры берутся из настроек проекта.
export const gitlabSyncSchema = z.object({});

// Код публикуется в уже существующую ветку, поэтому коммит и логи
// необязательны: при отсутствии сервер берет их из состояния задачи.
export const gitlabPublishSchema = z.object({
  branch: z.string().trim().min(1).max(250),
  commitSha: z.string().trim().min(7).max(64).nullable().optional(),
  implementationLog: z.string().max(100_000).nullable().optional(),
  reviewComments: z.string().max(100_000).nullable().optional(),
});

/**
 * Тело запроса публикации MR плана изменений (режим plan-review). Описание
 * MR собирается на сервере из сохранённого плана.
 */
export const gitlabPlanPublishSchema = z.object({
  branch: z.string().trim().min(1).max(250),
  commitSha: z.string().trim().min(7).max(64).nullable().optional(),
});

// Меняется только организация проекта: refine запрещает пустое тело, чтобы
// PATCH без полей не выглядел успешной операцией.
export const updateProjectOrganizationSchema = z
  .object({
    pinned: z.boolean().optional(),
    groupName: z.string().trim().max(100).nullable().optional(),
  })
  .refine((value) => value.pinned !== undefined || value.groupName !== undefined, {
    message: "At least one organization field is required",
  });

export const createTaskSchema = z.object({
  projectId: z.string().min(1, "Project ID is required"),
  title: z.string().min(1, "Title is required").max(500),
  description: z.string().default(""),
  attachments: z.array(taskAttachmentSchema).max(100).default([]),
  priority: z.number().int().min(0).max(5).default(0),
  autoMode: z.boolean().default(true),
  executionOwner: z.enum(["ai", "human"]).default("ai"),
  assigneeIds: z.array(z.string().min(1)).max(100).default([]),
  isFix: z.boolean().default(false),
  plannerMode: z.enum(["fast", "full"]).default("fast"),
  planPath: z.string().max(500).optional(),
  planDocs: z.boolean().optional(),
  planTests: z.boolean().optional(),
  skipReview: z.boolean().optional(),
  // Дефолт берется из окружения: поведение по умолчанию задает развертывание,
  // а не конкретный клиент.
  useSubagents: z.boolean().default(getEnv().AGENT_USE_SUBAGENTS),
  runPlanImprove: z.boolean().default(false),
  runPostVerify: z.boolean().default(false),
  autoQa: z.boolean().optional(),
  maxReviewIterations: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(getEnv().AGENT_MAX_REVIEW_ITERATIONS),
  paused: z.boolean().default(false),
  runtimeProfileId: z.string().min(1).nullable().optional(),
  modelOverride: z.string().max(200).nullable().optional(),
  runtimeOptions: z.record(z.string(), z.unknown()).nullable().optional(),
  roadmapAlias: z.string().max(200).optional(),
  tags: z.array(z.string().max(100)).max(50).default([]),
  scheduledAt: scheduledAtSchema,
});

// Отдельная схема вместо createTaskSchema.partial(): при обновлении доступны
// поля, которых нет при создании (план, логи, heartbeat), а часть полей
// создания (projectId, executionOwner) менять напрямую нельзя.
export const updateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  attachments: z.array(taskAttachmentSchema).max(100).optional(),
  priority: z.number().int().min(0).max(5).optional(),
  autoMode: z.boolean().optional(),
  isFix: z.boolean().optional(),
  plannerMode: z.enum(["fast", "full"]).optional(),
  planPath: z.string().max(500).optional(),
  planDocs: z.boolean().optional(),
  planTests: z.boolean().optional(),
  skipReview: z.boolean().optional(),
  useSubagents: z.boolean().optional(),
  runPlanImprove: z.boolean().optional(),
  runPostVerify: z.boolean().optional(),
  autoQa: z.boolean().optional(),
  maxReviewIterations: z.number().int().min(1).max(50).optional(),
  plan: z.string().nullable().optional(),
  implementationLog: z.string().nullable().optional(),
  reviewComments: z.string().nullable().optional(),
  agentActivityLog: z.string().nullable().optional(),
  blockedReason: z.string().nullable().optional(),
  blockedFromStatus: z.enum(TASK_STATUSES).nullable().optional(),
  retryAfter: z.string().nullable().optional(),
  retryCount: z.number().int().min(0).optional(),
  roadmapAlias: z.string().max(200).nullable().optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  reworkRequested: z.boolean().optional(),
  paused: z.boolean().optional(),
  lastHeartbeatAt: z.string().nullable().optional(),
  runtimeProfileId: z.string().min(1).nullable().optional(),
  modelOverride: z.string().max(200).nullable().optional(),
  runtimeOptions: z.record(z.string(), z.unknown()).nullable().optional(),
  scheduledAt: scheduledAtSchema,
});

// Список событий берется из общей константы: новый переход в стейт-машине
// автоматически расширяет и валидацию API.
export const taskEventSchema = z.object({
  event: z.enum(TASK_EVENTS),
  deletePlanFile: z.boolean().optional(),
  commitOnApprove: z.boolean().optional(),
});

// expected* поля реализуют оптимистичную блокировку: передача владения
// отклоняется, если задачу успел изменить кто-то другой.
export const handoffTaskSchema = z.object({
  executionOwner: z.enum(["ai", "human"]),
  assigneeIds: z.array(z.string().min(1)).max(100).default([]),
  expectedOwnershipRevision: z.number().int().min(0),
  expectedExecutionOwner: z.enum(["ai", "human"]).optional(),
  expectedStatus: z.enum(TASK_STATUSES).optional(),
  reason: z.string().trim().min(1).max(2_000).optional(),
  resumeAction: z.enum(TASK_EVENTS).optional(),
});

export const createTaskCommentSchema = z.object({
  message: z.string().min(1, "Comment message is required").max(20_000),
  attachments: z.array(taskAttachmentSchema).max(100).default([]),
});

export const reorderTaskSchema = z.object({
  position: z.number(),
});

export const taskHeartbeatPayloadSchema = z.object({
  taskId: z.string().min(1),
  lastHeartbeatAt: z.string().nullable(),
});

export const taskUsagePayloadSchema = z.object({
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
    costUsd: z.number().optional(),
  }),
});

export const taskActivityPayloadSchema = z.object({
  taskId: z.string().min(1),
  lastActivityAt: z.string().nullable(),
  currentTool: z
    .object({
      name: z.string().min(1),
      detail: z.string().optional(),
      startedAt: z.string().min(1),
    })
    .nullable(),
});

// Тело рассылки проверяется по типу события: payload допустим только для тех
// типов, которые его реально несут, иначе клиенты получат мусор в WS-канале.
export const broadcastTaskSchema = z
  .object({
    type: z
      .enum([
        "task:updated",
        "task:moved",
        "task:activity",
        "task:scheduled_fired",
        "task:heartbeat",
        "task:usage_updated",
      ])
      .default("task:updated"),
    payload: z
      .union([taskHeartbeatPayloadSchema, taskUsagePayloadSchema, taskActivityPayloadSchema])
      .optional(),
  })
  // Перекрестная проверка type/payload: сам union не связывает выбранный тип
  // события с формой полезной нагрузки.
  .refine(
    (value) => {
      if (value.type === "task:heartbeat") {
        return taskHeartbeatPayloadSchema.safeParse(value.payload).success;
      }
      if (value.type === "task:usage_updated") {
        return taskUsagePayloadSchema.safeParse(value.payload).success;
      }
      if (value.type === "task:activity" && value.payload !== undefined) {
        return taskActivityPayloadSchema.safeParse(value.payload).success;
      }
      return true;
    },
    { message: "Broadcast payload does not match the event type" },
  );

export const autoQueueModeSchema = z.object({
  enabled: z.boolean(),
});

export const broadcastProjectSchema = z.object({
  type: z.enum([
    "project:auto_queue_mode_changed",
    "project:auto_queue_advanced",
    "project:runtime_limit_updated",
  ]),
  taskId: z.string().min(1).optional(),
  runtimeProfileId: z.string().min(1).nullable().optional(),
});

export const roadmapImportSchema = z.object({
  roadmapAlias: z.string().min(1, "Roadmap alias is required").max(200),
});

// vision опционален: без него генерация опирается на сохраненное описание
// проекта, с ним - на текст, введенный прямо в диалоге.
export const roadmapGenerateSchema = z.object({
  roadmapAlias: z.string().min(1, "Roadmap alias is required").max(200),
  vision: z.string().max(10000).optional(),
});

// Границы ttl держат прогрев в разумных рамках: от минуты до суток.
export const warmupCreateSchema = z.object({
  ttlSeconds: z.number().int().min(60).max(86_400).default(3_600),
});

// runtimeSessionId позволяет привязать чат к уже существующей сессии рантайма.
export const createChatSessionSchema = z.object({
  projectId: z.string().min(1, "Project ID is required"),
  title: z.string().max(200).optional(),
  runtimeProfileId: z.string().min(1).nullable().optional(),
  runtimeSessionId: z.string().min(1).nullable().optional(),
});

export const updateChatSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  runtimeProfileId: z.string().min(1).nullable().optional(),
  runtimeSessionId: z.string().min(1).nullable().optional(),
});

// null сбрасывает дефолт обратно к неявному выбору рантайма; отсутствие поля
// означает, что значение не трогают.
export const updateAppRuntimeDefaultsSchema = z
  .object({
    defaultTaskRuntimeProfileId: z.string().min(1).nullable().optional(),
    defaultPlanRuntimeProfileId: z.string().min(1).nullable().optional(),
    defaultReviewRuntimeProfileId: z.string().min(1).nullable().optional(),
    defaultChatRuntimeProfileId: z.string().min(1).nullable().optional(),
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: "At least one field is required",
  });

export const chatAttachmentSchema = z.object({
  name: z.string().min(1).max(500),
  mimeType: z.string().max(200),
  size: z.number().int().min(0).max(100_000_000),
  content: z.string().max(2_000_000).nullable(),
});

// sessionId и conversationId необязательны: первый адресует диалог рантайма,
// второй - ветку в UI, и клиент может не знать ни одного из них.
export const chatRequestSchema = z.object({
  projectId: z.string().min(1, "Project ID is required"),
  message: z.string().min(1, "Message is required").max(50_000),
  clientId: z.string().min(1, "Client ID is required").optional(),
  conversationId: z.string().optional(),
  sessionId: z.string().optional(),
  explore: z.boolean().default(false),
  taskId: z.string().optional(),
  runtimeProfileId: z.string().min(1).nullable().optional(),
  attachments: z.array(chatAttachmentSchema).max(100).optional(),
});

// Заголовки описаны как строковые пары: секреты подставляются по имени
// переменной окружения, а не приходят в открытом виде с клиента.
const runtimeHeadersSchema = z.record(z.string(), z.string());
const runtimeOptionsSchema = z.record(z.string(), z.unknown());
const runtimeEnvVarSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9_.-]+$/,
    "apiKeyEnvVar must contain only letters, numbers, dot, underscore, or hyphen",
  )
  .nullable()
  .optional();

// projectId == null означает глобальный профиль, доступный всем проектам.
export const createRuntimeProfileSchema = z.object({
  projectId: z.string().min(1).nullable().optional(),
  name: z.string().min(1).max(200),
  runtimeId: z.string().min(1).max(100),
  providerId: z.string().min(1).max(100),
  transport: z.string().max(100).nullable().optional(),
  baseUrl: z.string().max(1000).nullable().optional(),
  apiKeyEnvVar: runtimeEnvVarSchema,
  defaultModel: z.string().max(200).nullable().optional(),
  headers: runtimeHeadersSchema.optional(),
  options: runtimeOptionsSchema.optional(),
  enabled: z.boolean().optional(),
});

// partial() разрешает точечные правки профиля, а refine не дает отправить
// пустой PATCH, который молча ничего не изменит.
export const updateRuntimeProfileSchema = createRuntimeProfileSchema
  .partial()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: "At least one field is required",
  });

export const runtimeProfileValidationSchema = z.object({
  projectId: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  profile: createRuntimeProfileSchema.optional(),
  modelOverride: z.string().max(200).nullable().optional(),
  runtimeOptions: runtimeOptionsSchema.nullable().optional(),
  // Временный ключ доступа, только для проверки. Никогда не сохраняется.
  apiKey: z.string().min(1).optional(),
  // forceRefresh обходит кэш проверки подключения после смены ключа.
  forceRefresh: z.boolean().optional(),
});

// Отдельная от validation схема без обязательного profile: список моделей
// запрашивают и для уже сохраненного профиля по profileId.
export const runtimeProfileModelsSchema = z.object({
  projectId: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  profile: createRuntimeProfileSchema.optional(),
  modelOverride: z.string().max(200).nullable().optional(),
  runtimeOptions: runtimeOptionsSchema.nullable().optional(),
  apiKey: z.string().min(1).optional(),
  forceRefresh: z.boolean().optional(),
});

// Флаги остаются строками: маршрут сам решает, как трактовать "false" и
// отсутствие значения, чтобы не терять разницу между ними.
export const runtimeProfileListQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  includeGlobal: z.string().optional(),
  enabledOnly: z.string().optional(),
  scope: z.enum(["global", "project", "visible"]).optional(),
});
