/**
 * Универсальная точка запуска субагента: прогоняет промпт через выбранный
 * runtime-адаптер и приводит результат к единому виду для всех стадий пайплайна
 * (planner, implementer, verifier, reviewer).
 *
 * Ключевые инварианты, из-за которых модуль устроен именно так:
 * - Резолвинг контекста выполнения (профиль, транспорт, модель, промпт) вынесен
 *   в отдельную фазу resolveExecutionContext. К моменту старта адаптера все
 *   решения уже приняты, а сам запуск остается максимально простым.
 * - Два независимых кэша лимитов (state и broadcast) гасят лишние записи в БД
 *   и лишние WebSocket-рассылки: провайдеры шлют лимиты пачками, а подписчику
 *   интересна только смена состояния.
 * - Любая ошибка наружу отдается обезличенной (buildSanitizedSubagentError):
 *   сырой текст провайдера может содержать ключи и промпты, поэтому он остается
 *   в логах, а в БД и UI уходит только безопасная причина.
 * - Warmup-форк сессии намеренно допускает отказ: это оптимизация холодного
 *   старта, и при любой неопределенности она отключается, а не роняет прогон.
 */

import {
  clearRuntimeProfileLimitSnapshot,
  createDbUsageSink,
  expireStaleRuntimeWarmupSessions,
  findActiveReadyRuntimeWarmupSession,
  findRuntimeProfileById,
  isRuntimeProfileVisibleToProject,
  findTaskById,
  getAppDefaultRuntimeProfileId,
  getTaskActiveRuntimeSelection,
  clearTaskActiveRuntimeSelection,
  getTaskSessionId,
  persistRuntimeProfileLimitSnapshot,
  renewTaskClaim,
  resolveEffectiveRuntimeProfile,
  saveTaskActiveRuntimeSelection,
  saveTaskSessionId,
  setTaskInFlightTool,
  updateTaskHeartbeat,
} from "@aif/data";
import {
  assertRuntimeCapabilities,
  buildRuntimeLimitBroadcastCacheKey,
  buildRuntimeLimitCacheSignature,
  bootstrapRuntimeRegistry,
  checkRuntimeSessionForkSupport,
  createRuntimeMemoryCache,
  createRuntimeWorkflowSpec,
  extractLatestRuntimeLimitSnapshot,
  extractRuntimeLimitSnapshotFromError,
  mapSafeRuntimeErrorReason,
  normalizeRuntimeLimitSnapshot,
  observeRuntimeLimitEvent,
  sanitizeProviderMeta,
  getResultSessionId,
  redactResolvedRuntimeProfile,
  resolveAdapterCapabilities,
  resolveRuntimeProfile,
  resolveRuntimePromptPolicy,
  RuntimeExecutionError,
  RuntimeCapabilityError,
  RuntimeValidationError,
  RuntimeTransport,
  RUNTIME_TRUST_TOKEN,
  UsageSource,
  type RuntimeAdapter,
  type RuntimeConversationMessage,
  type RuntimeCapabilities,
  type RuntimeCapabilityName,
  type ResolvedRuntimeProfile,
  type RuntimeRegistry,
  type RuntimeRegistryLogger,
  type RuntimeLimitSnapshot,
  type RuntimeSessionReusePolicy,
  type RuntimeWorkflowSpec,
} from "@aif/runtime";
import {
  getEnv,
  isWarmupWorkflowKind,
  logger,
  redactProviderTextForLogs,
  type TaskCurrentTool,
} from "@aif/shared";
import { logActivity } from "./hooks.js";
import { WorkspaceToolExecutor, WORKSPACE_TOOL_DEFINITIONS } from "./workspaceTools.js";
import { PROJECT_SCOPE_SYSTEM_APPEND, REVIEW_DIFF_SCOPE_SYSTEM_APPEND } from "./constants.js";
import { createStderrCollector } from "./stderrCollector.js";
import { LoopGuard } from "./loopGuard.js";
import { writeQueryAudit } from "./queryAudit.js";
import { getActiveStageAbortController } from "./stageAbort.js";
import {
  broadcastTaskActivityProgress,
  notifyProjectRuntimeLimitBroadcast,
  notifyTaskHeartbeat,
  notifyTaskUsageBroadcast,
} from "./notifier.js";

// Именованный логгер модуля: сообщения субагента нужно легко вычленять из
// общего потока координатора при разборе инцидентов.
const log = logger("subagent-query");

// Задача, отданная человеку, не должна исполняться агентом: это признак гонки
// между ручным вмешательством и автоочередью. Ошибка типизирована, потому что
// вызывающий код различает "задачу забрали" и "рантайм упал".
export class AiHandoffRequiredError extends Error {
  readonly code = "ai_handoff_required" as const;

  constructor(taskId: string) {
    super(`Task ${taskId} must be handed to AI before runtime execution`);
    this.name = "AiHandoffRequiredError";
  }
}

// Ошибка loop-guard (определена в loopGuard.ts, чтобы избежать циклического импорта).
export { AiLoopDetectedError, type LoopDetectedReason } from "./loopGuard.js";

// Проверка владения вызывается дважды: до резолвинга контекста и
// непосредственно перед запуском адаптера. Между этими точками проходит
// разрешение профиля и походы в кэш, за которые задачу могли успеть вернуть
// человеку, поэтому одной проверки в начале недостаточно.
function assertAiExecutionOwner(taskId: string): void {
  const task = findTaskById(taskId);
  if (task?.executionOwner === "human") {
    log.warn(
      { taskId, executionOwner: task.executionOwner },
      "Runtime execution rejected for human-owned task",
    );
    throw new AiHandoffRequiredError(taskId);
  }
}

// Heartbeat одновременно продлевает claim координатора, поэтому интервал
// должен быть заметно меньше срока аренды (см. getLockRenewalMs).
const HEARTBEAT_INTERVAL_MS = 30_000;

// Строковый маркер вместо флага: он попадает в reason у AbortController и
// позже сравнивается адаптерами при разборе причины прерывания.
const FIRST_ACTIVITY_TIMEOUT_ERROR = "first_activity_timeout";
// Одна повторная попытка сверх первой, плюс отдельный общий лимит ниже.
const FIRST_ACTIVITY_MAX_RETRIES = 2;
// Два кэша решают две разные задачи: state гасит повторные записи в БД,
// broadcast - повторные рассылки лимитов в UI. Ключи у них разные
// (profileId против projectId+taskId+profileId), объединять их нельзя.
const runtimeLimitStateCache = createRuntimeMemoryCache<string>({ defaultTtlMs: 30_000 });
const runtimeLimitBroadcastCache = createRuntimeMemoryCache<string>({ defaultTtlMs: 30_000 });

// Единая точка оповещения после записи usage: сначала адресное событие по
// задаче, затем сброс лимитов на уровне проекта. Оба уведомления
// fire-and-forget - сбой рассылки не должен ломать уже успешный запрос.
function notifyRuntimeUsageRefresh(input: {
  projectId?: string | null;
  runtimeProfileId?: string | null;
  taskId?: string | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd?: number;
  } | null;
}): void {
  if (input.taskId && input.projectId && input.usage) {
    void notifyTaskUsageBroadcast(input.taskId, input.projectId, input.usage);
  }
  if (!input.projectId || !input.runtimeProfileId) {
    return;
  }
  void notifyProjectRuntimeLimitBroadcast(input.projectId, input.runtimeProfileId, {
    taskId: input.taskId ?? null,
  });
}

// Ошибки адаптеров часто оборачиваются по пути, поэтому причина ищется по
// цепочке cause. Возвращается именно RuntimeExecutionError: только у него есть
// структурированные поля category, adapterCode и limitSnapshot, по которым
// принимаются решения выше по стеку (классификация ошибок по строке запрещена).
function findRuntimeExecutionError(error: unknown): RuntimeExecutionError | null {
  if (error instanceof RuntimeExecutionError) {
    return error;
  }
  if (error instanceof Error && "cause" in error && error.cause) {
    return findRuntimeExecutionError(error.cause);
  }
  return null;
}

// Наружу отдается новая ошибка с безопасным текстом, но с сохранением всех
// структурированных признаков исходной. Терять их нельзя: выше по стеку именно
// по category и limitSnapshot решается, повторять ли запрос и с какой задержкой.
function buildSanitizedSubagentError(
  error: unknown,
  safeReason: ReturnType<typeof mapSafeRuntimeErrorReason>,
  providerId?: string | null,
): Error {
  const runtimeError = findRuntimeExecutionError(error);
  if (!runtimeError) {
    return new Error(safeReason.reason);
  }

  const normalizedSnapshot = runtimeError.limitSnapshot
    ? normalizeRuntimeLimitSnapshot(runtimeError.limitSnapshot)
    : null;

  return new RuntimeExecutionError(safeReason.reason, undefined, runtimeError.category, {
    adapterCode: runtimeError.adapterCode,
    httpStatus: runtimeError.httpStatus,
    resetAt: normalizedSnapshot?.resetAt ?? runtimeError.resetAt,
    retryAfterMs: runtimeError.retryAfterMs,
    retryAfterSeconds: runtimeError.retryAfterSeconds,
    limitSnapshot: normalizedSnapshot,
    providerMeta:
      normalizedSnapshot?.providerMeta ??
      sanitizeProviderMeta(
        normalizedSnapshot?.providerId ?? runtimeError.limitSnapshot?.providerId ?? providerId,
        runtimeError.providerMeta ?? null,
      ),
  });
}

// Кэш снимается только если подпись не успела смениться: иначе можно затереть
// ключ, уже записанный более свежим состоянием, и спровоцировать повторную
// рассылку устаревших данных.
function clearRuntimeLimitBroadcastCacheKeyIfUnchanged(
  broadcastCacheKey: string,
  signature: string,
): void {
  if (runtimeLimitBroadcastCache.get(broadcastCacheKey) === signature) {
    runtimeLimitBroadcastCache.delete(broadcastCacheKey);
  }
}

// Синхронизирует состояние лимитов между адаптером, БД и UI. Функция
// сознательно не пробрасывает исключения: это фоновое обслуживание, и его сбой
// не должен превращать успешный прогон агента в ошибку стадии.
function refreshRuntimeProfileLimitState(input: {
  runtimeProfileId?: string | null;
  runtimeId?: string | null;
  providerId?: string | null;
  snapshot?: RuntimeLimitSnapshot | null;
  clearOnMissing?: boolean;
  taskId: string;
  workflowKind?: string | null;
  reason: string;
}): void {
  // Снимок нормализуется сразу: и сравнение подписей, и запись в БД должны
  // идти по канонической форме, иначе один и тот же лимит будет выглядеть как
  // новое состояние и вызовет лишний UPDATE и лишнее событие в UI.
  const normalizedSnapshot = input.snapshot ? normalizeRuntimeLimitSnapshot(input.snapshot) : null;
  const runtimeProfileId = input.runtimeProfileId ?? normalizedSnapshot?.profileId ?? null;
  if (!runtimeProfileId) {
    log.debug(
      {
        taskId: input.taskId,
        runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
        providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
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
        taskId: input.taskId,
        runtimeProfileId,
        runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
        providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
        workflowKind: input.workflowKind ?? null,
        reason: input.reason,
      },
      "No runtime limit snapshot or clear action available for refresh",
    );
    return;
  }

  // Подпись - дешевый ключ дедупликации: сравнивать сами снимки было бы
  // дороже и хрупче, а TTL кэша ограничивает окно доверия к этой памяти.
  const cachedSignature = runtimeLimitStateCache.get(runtimeProfileId);
  const shouldPersist = cachedSignature !== signature;
  if (!shouldPersist) {
    log.debug(
      {
        taskId: input.taskId,
        runtimeProfileId,
        runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
        providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
        workflowKind: input.workflowKind ?? null,
        reason: input.reason,
      },
      "Skipped runtime limit DB write because identical state is still cached",
    );
  }

  // Одна метка времени на запись и рассылку: строка в БД и событие в UI должны
  // ссылаться на один и тот же момент, иначе состояние выглядит рассинхронным.
  const persistedAt = new Date().toISOString();
  const taskRow = findTaskById(input.taskId);
  const projectId = taskRow?.projectId ?? null;
  const broadcastCacheKey = buildRuntimeLimitBroadcastCacheKey({
    projectId,
    taskId: input.taskId,
    runtimeProfileId,
  });
  const cachedBroadcastSignature = broadcastCacheKey
    ? runtimeLimitBroadcastCache.get(broadcastCacheKey)
    : null;
  // Рассылка дедуплицируется отдельным ключом: сброс кэша state (например, при
  // смене профиля) не должен порождать дубль события в UI.
  const shouldBroadcast = Boolean(broadcastCacheKey) && cachedBroadcastSignature !== signature;

  try {
    if (shouldPersist) {
      log.debug(
        {
          taskId: input.taskId,
          runtimeProfileId,
          runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
          providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
          workflowKind: input.workflowKind ?? null,
          reason: input.reason,
          action: normalizedSnapshot ? "persist" : "clear",
        },
        "Refreshing runtime profile limit state for subagent execution",
      );

      if (normalizedSnapshot) {
        persistRuntimeProfileLimitSnapshot(runtimeProfileId, normalizedSnapshot, persistedAt);
      } else {
        clearRuntimeProfileLimitSnapshot(runtimeProfileId, persistedAt);
      }
      runtimeLimitStateCache.set(runtimeProfileId, signature);
    }

    if (shouldBroadcast && projectId && broadcastCacheKey) {
      runtimeLimitBroadcastCache.set(broadcastCacheKey, signature);
      void notifyProjectRuntimeLimitBroadcast(projectId, runtimeProfileId, {
        taskId: input.taskId,
      })
        .then((sent) => {
          if (!sent) {
            clearRuntimeLimitBroadcastCacheKeyIfUnchanged(broadcastCacheKey, signature);
            log.warn(
              {
                taskId: input.taskId,
                projectId,
                runtimeProfileId,
              },
              "Runtime limit broadcast was not delivered",
            );
          }
        })
        .catch((error) => {
          clearRuntimeLimitBroadcastCacheKeyIfUnchanged(broadcastCacheKey, signature);
          log.warn(
            {
              taskId: input.taskId,
              projectId,
              runtimeProfileId,
              errorName: error instanceof Error ? error.name : typeof error,
              errorMessage:
                error instanceof Error
                  ? redactProviderTextForLogs(error.message)
                  : redactProviderTextForLogs(String(error)),
            },
            "Runtime limit broadcast failed",
          );
        });
    }
  } catch (error) {
    log.warn(
      {
        taskId: input.taskId,
        runtimeProfileId,
        runtimeId: input.runtimeId ?? normalizedSnapshot?.runtimeId ?? null,
        providerId: input.providerId ?? normalizedSnapshot?.providerId ?? null,
        workflowKind: input.workflowKind ?? null,
        reason: input.reason,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage:
          error instanceof Error
            ? redactProviderTextForLogs(error.message)
            : redactProviderTextForLogs(String(error)),
      },
      "Failed to refresh runtime profile limit state for subagent execution",
    );
  }
}

// Аренда координатора продлевается с запасом: таймаут стадии плюс пять минут,
// чтобы долгий прогон не потерял claim между двумя heartbeat.
function getLockRenewalMs(): number {
  return Math.max(getEnv().AGENT_STAGE_RUN_TIMEOUT_MS, 60_000) + 5 * 60 * 1000;
}

/**
 * Сторож первой активности: прерывает агента, если за AGENT_FIRST_ACTIVITY_TIMEOUT_MS
 * после «started» не приходит никакой активности runtime.
 * Ловит зависших агентов рано (~60 с) вместо ожидания 90-минутного stale-таймаута.
 */
function createFirstActivityWatchdog(
  timeoutMs: number,
  abortController: AbortController | undefined,
  onStall: () => void,
): { clear: () => void; markActivity: () => void; didFire: boolean } {
  // Нулевой таймаут означает "сторож выключен", а не "сработать немедленно":
  // так транспорт без инкрементального стрима просто отключает механизм.
  if (timeoutMs <= 0) {
    return { clear: () => {}, markActivity: () => {}, didFire: false };
  }

  // Два независимых флага: fired фиксирует факт срабатывания (его читает
  // retry-цикл), cleared - что таймер уже снят и повторно стрелять нечем.
  let fired = false;
  let cleared = false;

  const timer = setTimeout(() => {
    if (cleared) return;
    fired = true;
    onStall();
    if (abortController && !abortController.signal.aborted) {
      abortController.abort(new Error(FIRST_ACTIVITY_TIMEOUT_ERROR));
    }
  }, timeoutMs);

  return {
    get didFire() {
      return fired;
    },
    clear() {
      if (!fired && !cleared) {
        cleared = true;
        clearTimeout(timer);
      }
    },
    // markActivity одноразовый: первое же событие от рантайма снимает сторож
    // навсегда, чтобы таймер не выстрелил в середине долгого ответа.
    markActivity() {
      if (!fired && !cleared) {
        cleared = true;
        clearTimeout(timer);
      }
    },
  };
}

// Синглтон в виде промиса, а не готового значения: параллельные стадии должны
// разделить один bootstrap, а не поднять по реестру на каждую.
let runtimeRegistryPromise: Promise<RuntimeRegistry> | null = null;

export interface SubagentQueryOptions {
  taskId: string;
  projectRoot: string;
  agentName: string;
  prompt: string;
  maxBudgetUsd?: number | null;
  /** Предпочтительное имя agent definition. Prompt-политика runtime может откатиться к слэш-стратегии. */
  agent?: string;
  /** Запасной слэш-команд, используемый, когда agent definitions недоступны. */
  fallbackSlashCommand?: string;
  /** Режим разрешения runtime-профиля — определяет, какой проектный дефолт используется. */
  profileMode?: "task" | "plan" | "review";
  /** Пропускать ли стадию ревью кода (implementing → done вместо implementing → review). */
  skipReview?: boolean;
  /** Необязательное переопределение для тестов/настройки: таймаут ожидания первого сообщения из потока запроса. */
  queryStartTimeoutMs?: number;
  /** Необязательное переопределение для тестов/настройки: задержка перед повтором после query_start_timeout. */
  queryStartRetryDelayMs?: number;
  /** AbortController для отмены выполняемого запроса извне (например, таймаут стадии). */
  abortController?: AbortController;
  /** Необязательная явная спецификация workflow. Если пропущена, генерируется дефолтная из опций. */
  workflowSpec?: RuntimeWorkflowSpec;
  /** Необязательный вид workflow при автогенерации спецификации. */
  workflowKind?: string;
  /** Обязательные возможности для этого workflow. */
  requiredCapabilities?: RuntimeCapabilityName[];
  /** Политика переиспользования сессий для этого workflow. */
  sessionReusePolicy?: RuntimeSessionReusePolicy;
  /** Переопределение модели уровня runtime для этого вызова. */
  modelOverride?: string | null;
  /** Отключает запасную модель задачи/профиля и вызывает адаптер без модели. */
  suppressModelFallback?: boolean;
  /** Необязательная собственная системная добавка для runtime workflow. */
  systemPromptAppend?: string;
  /** Необязательный режим потока частичных сообщений (чатоподобные workflow). */
  includePartialMessages?: boolean;
  /** Необязательный максимум ходов для runtime-адаптеров, которые его поддерживают. */
  maxTurns?: number;
  /** Источник учёта использования. Стадии Координатора по умолчанию — SUBAGENT. */
  usageSource?: UsageSource;
}

export interface SubagentQueryResult {
  resultText: string;
}

// Настройки рантайма лежат в БД JSON-строкой, которую писал UI. Любая
// некорректность здесь не ошибка выполнения: считаем, что переопределений нет,
// и работаем на настройках профиля.
function parseRuntimeOptions(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Причины отказа от warmup-форка пишутся в лог: по ним видно, была ли это
// осознанная политика (фича выключена) или несовпадение профиля с прогревом.
type WarmupSkipReason =
  | "feature_disabled"
  | "workflow_not_enabled"
  | "existing_task_session"
  | "expired"
  | "unsupported_runtime"
  | "missing_adapter_method"
  | "runtime_mismatch";

// В логи уходит только хвост идентификатора: полный sessionId ничего не дает
// при чтении и является чувствительной строкой подключения к провайдеру.
function sessionIdSuffix(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return sessionId.slice(-8);
}

// Ключ reasoning-effort для каждого runtime: claude/openrouter используют `effort`,
// codex — `modelReasoningEffort`, opencode — `reasoningEffort`.
// Повторяет MANAGED_OPTION_KEYS из packages/web/src/components/settings/RuntimeProfileForm.tsx.
const EFFORT_OPTION_KEYS = ["effort", "modelReasoningEffort", "reasoningEffort"] as const;

function pickEffort(options: Record<string, unknown>): string | null {
  for (const key of EFFORT_OPTION_KEYS) {
    const value = options[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Пин действителен только пока профиль совпадает с ним по всем значимым полям.
// Заголовки и options сравниваются через JSON: это дешево и покрывает вложенные
// структуры, а порядок ключей в форме настроек стабилен. Любое расхождение
// трактуется как "профиль отредактировали" - пин снимается, чтобы задача не ушла
// в рантайм с устаревшей моделью или ключом.
//
// Отсутствие строки профиля НЕ инвалидирует пин: снимок пина самодостаточен
// (hydratePinnedRuntimeProfile восстанавливает профиль из него), а пин в первую
// очередь фиксирует выбор стадии для повторных запусков той же стадии.
function isPinnedRuntimeProfileCurrent(
  selection: ReturnType<typeof getTaskActiveRuntimeSelection>,
  taskProjectId: string | null | undefined,
): boolean {
  if (!selection || !taskProjectId) return false;
  if (selection.profileId) {
    const profile = findRuntimeProfileById(selection.profileId);
    if (!profile) {
      // Снимок доверяется как есть: задача продолжала бы стадию на том же
      // рантайме, даже если запись профиля была удалена между попытками.
      return true;
    }
    if (!profile.enabled) return false;
    if (
      !isRuntimeProfileVisibleToProject({ projectId: taskProjectId, runtimeProfileId: profile.id })
    )
      return false;
    let profileHeaders: Record<string, string>;
    let profileOptions: Record<string, unknown>;
    // Битый JSON в профиле означает неработоспособный пин: молча считаем его
    // устаревшим, а не роняем резолвинг контекста прямо здесь.
    try {
      profileHeaders = JSON.parse(profile.headersJson) as Record<string, string>;
      profileOptions = JSON.parse(profile.optionsJson) as Record<string, unknown>;
    } catch {
      return false;
    }
    return (
      profile.runtimeId === selection.runtimeId &&
      profile.providerId === selection.providerId &&
      (profile.transport ?? null) === selection.transport &&
      (profile.baseUrl ?? null) === selection.baseUrl &&
      (profile.apiKeyEnvVar ?? null) === selection.apiKeyEnvVar &&
      (profile.defaultModel ?? null) === selection.model &&
      JSON.stringify(profileHeaders) === JSON.stringify(selection.headers) &&
      JSON.stringify(profileOptions) === JSON.stringify(selection.options)
    );
  }
  return selection != null;
}

// Пин хранит лишь снимок профиля, поэтому секрет достается из окружения по
// имени переменной: сам API-ключ в БД не попадает - это осознанное решение.
function hydratePinnedRuntimeProfile(
  selection: ReturnType<typeof getTaskActiveRuntimeSelection>,
  workflow: RuntimeWorkflowSpec,
): ResolvedRuntimeProfile | null {
  if (!selection) return null;
  const apiKeyEnvVar = normalizeOptionalString(selection.apiKeyEnvVar);
  const apiKey = apiKeyEnvVar ? normalizeOptionalString(process.env[apiKeyEnvVar]) : null;

  return {
    source: selection.source,
    profileId: selection.profileId,
    runtimeId: selection.runtimeId,
    providerId: selection.providerId,
    transport: selection.transport,
    baseUrl: selection.baseUrl,
    apiKeyEnvVar,
    apiKey,
    model: selection.model,
    headers: selection.headers,
    options: selection.options,
    workflow,
  };
}

// Логгер реестра выносит контекст отдельным объектом, а не склеивает его в
// строку: pino должен сохранить структурные поля для фильтрации по логам.
function createRuntimeRegistryLogger(): RuntimeRegistryLogger {
  return {
    debug(context, message) {
      log.debug({ ...context }, `[runtime-registry] ${message}`);
    },
    warn(context, message) {
      log.warn({ ...context }, `WARN [runtime-module] ${message}`);
    },
    error(context, message) {
      log.error({ ...context }, `ERROR [runtime-registry] ${message}`);
    },
  };
}

async function getRuntimeRegistry(): Promise<RuntimeRegistry> {
  if (runtimeRegistryPromise) return runtimeRegistryPromise;

  const env = getEnv();
  runtimeRegistryPromise = bootstrapRuntimeRegistry({
    logger: createRuntimeRegistryLogger(),
    runtimeModules: env.AIF_RUNTIME_MODULES,
    modelEffortDiscoveryEnabled: env.AIF_RUNTIME_MODEL_EFFORT_DISCOVERY_ENABLED,
    usageSink: createDbUsageSink({
      onRecorded: (event) => {
        notifyRuntimeUsageRefresh({
          projectId: event.context.projectId ?? null,
          runtimeProfileId: event.profileId ?? null,
          taskId: event.context.taskId ?? null,
          usage: event.usage ?? null,
        });
      },
    }),
    // Сброс синглтона при ошибке: иначе единственный сбой инициализации
    // закэшировался бы навсегда и каждая следующая стадия падала бы с той же
    // ошибкой, даже когда причина уже исчезла.
  }).catch((error) => {
    runtimeRegistryPromise = null;
    throw error;
  });

  return runtimeRegistryPromise;
}

/**
 * Разрешает RuntimeAdapter, который обработал бы данную задачу.
 * Полезно для чтения метаданных адаптера (например lightModel) без запуска запроса.
 * Помощник намеренно ограничен режимами стадий задач; разрешение для чата
 * идёт через сервис runtime в API.
 */
export async function resolveAdapterForTask(
  taskId: string,
  mode: "task" | "plan" | "review" = "task",
): Promise<RuntimeAdapter> {
  const task = findTaskById(taskId);
  const systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId(mode);
  const effective = resolveEffectiveRuntimeProfile({
    taskId,
    projectId: task?.projectId,
    mode,
    systemDefaultRuntimeProfileId,
  });
  const resolved = resolveRuntimeProfile({
    source: effective.source,
    profile: effective.profile,
    fallbackRuntimeId: getEnv().AIF_DEFAULT_RUNTIME_ID,
    fallbackProviderId: getEnv().AIF_DEFAULT_PROVIDER_ID,
  });
  const registry = await getRuntimeRegistry();
  return registry.resolveRuntime(resolved.runtimeId);
}

function buildWorkflowSpec(options: SubagentQueryOptions): RuntimeWorkflowSpec {
  if (options.workflowSpec) {
    const workflow = options.workflowSpec;
    // Явный workflow spec и fallback-команда приходят разными путями и могут
    // не знать друг о друге. Сохраняем fallback: без него рантайм без поддержки
    // agent definitions останется без запасного пути и упадет на старте.
    const fallbackSlashCommand = options.fallbackSlashCommand?.trim();
    if (fallbackSlashCommand && !workflow.promptInput.fallbackSlashCommand?.trim()) {
      log.debug(
        {
          taskId: options.taskId,
          workflowKind: workflow.workflowKind,
          fallbackSlashCommand,
        },
        "[FIX] Preserved slash fallback supplied alongside explicit workflow spec",
      );
      return {
        ...workflow,
        promptInput: {
          ...workflow.promptInput,
          fallbackSlashCommand,
        },
        fallbackStrategy:
          workflow.fallbackStrategy === "none" ? "slash_command" : workflow.fallbackStrategy,
      };
    }
    return workflow;
  }

  // Без явного spec он синтезируется из опций: вид workflow по умолчанию
  // совпадает с именем агента, а scope-преамбула подставляется всегда.
  return createRuntimeWorkflowSpec({
    workflowKind: options.workflowKind ?? options.agentName,
    prompt: options.prompt,
    requiredCapabilities: options.requiredCapabilities ?? [],
    agentDefinitionName: options.agent,
    fallbackSlashCommand: options.fallbackSlashCommand,
    sessionReusePolicy: options.sessionReusePolicy ?? "resume_if_available",
    systemPromptAppend: options.systemPromptAppend ?? PROJECT_SCOPE_SYSTEM_APPEND,
  });
}

// Редактирование воркспейса нужно только реализатору, и только если выбранный
// рантайм заявляет такую возможность в своих capabilities.
function needsWorkspaceTools(workflow: RuntimeWorkflowSpec): boolean {
  return (
    workflow.workflowKind === "implementer" &&
    workflow.requiredCapabilities.includes("supportsWorkspaceTools")
  );
}

async function fallbackToWorkspaceToolRuntime(input: {
  options: SubagentQueryOptions;
  workflow: RuntimeWorkflowSpec;
  resolved: ResolvedRuntimeProfile;
  registry: RuntimeRegistry;
}): Promise<{ resolved: ResolvedRuntimeProfile; capabilities: RuntimeCapabilities }> {
  const adapter = input.registry.resolveRuntime(input.resolved.runtimeId);
  const capabilities = resolveAdapterCapabilities(adapter, input.resolved.transport);
  // Поддержки вызова инструментов достаточно: адаптер со своим циклом
  // tool-calls сам решит, как применить правки в воркспейсе.
  if (
    !needsWorkspaceTools(input.workflow) ||
    capabilities.supportsWorkspaceTools === true ||
    capabilities.supportsToolCalling === true
  ) {
    return { resolved: input.resolved, capabilities };
  }

  // Runtime-профиль, выбранный в GUI, авторитетен. Никогда не подменяйте его
  // адаптером из реестра: регистрация не доказывает, что runtime настроен,
  // аутентифицирован или одобрен для этого проекта.
  log.warn(
    {
      taskId: input.options.taskId,
      workflowKind: input.workflow.workflowKind,
      runtimeId: input.resolved.runtimeId,
      providerId: input.resolved.providerId,
      profileId: input.resolved.profileId,
      transport: input.resolved.transport,
    },
    "[FIX] Selected runtime lacks workspace execution capability; refusing implicit runtime fallback",
  );
  logActivity(
    input.options.taskId,
    "Agent",
    `[FIX] Selected implementation runtime ${input.resolved.runtimeId}/${input.resolved.transport} cannot edit the workspace. Configure a workspace-capable GUI runtime profile or enable API tool execution.`,
  );
  // Падаем громко и с понятной причиной: пытаться писать код рантаймом,
  // который этого не умеет, хуже, чем остановить стадию до запуска.
  throw new RuntimeCapabilityError(
    `Selected runtime "${input.resolved.runtimeId}" does not support workspace tools for workflow "${input.workflow.workflowKind}"`,
  );
}

// Резолвинг идет тремя фазами: выбрать профиль (пин или обычный порядок
// задача -> проект -> система), проверить его пригодность для workflow и только
// потом собрать промпт с политикой fallback на slash-команду. К концу функции
// все решения приняты, и запуск адаптера становится тривиальным.
async function resolveExecutionContext(options: SubagentQueryOptions): Promise<{
  workflow: RuntimeWorkflowSpec;
  runtimeId: string;
  providerId: string;
  profileId: string | null;
  transport: RuntimeTransport;
  capabilities: RuntimeCapabilities;
  model: string | null;
  effort: string | null;
  headers: Record<string, string>;
  options: Record<string, unknown>;
  prompt: string;
  systemPromptAppend: string;
  agentDefinitionName?: string;
  canResume: boolean;
  usedIsolatedSkillCommand: boolean;
  usedNativeSubagentWorkflow: boolean;
  usedApiSkillExpansion: boolean;
}> {
  const task = findTaskById(options.taskId);
  const profileMode = options.profileMode ?? "task";
  const env = getEnv();
  const systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId(profileMode);
  const workflow = buildWorkflowSpec(options);
  // Пин стадии существует потому, что стадии одной задачи идут подолгу: если
  // посреди пайплайна сменить дефолтный профиль проекта, вторая половина задачи
  // уехала бы в другой рантайм, а резюм сессии стал бы невозможен.
  const stageRuntimePinEnabled = env.AIF_STAGE_RUNTIME_PIN_ENABLED;
  const pinnedSelection =
    stageRuntimePinEnabled && task ? getTaskActiveRuntimeSelection(options.taskId) : null;
  const canUsePinnedSelection =
    pinnedSelection != null &&
    task?.status != null &&
    pinnedSelection.status === task.status &&
    pinnedSelection.profileMode === profileMode;
  // Устаревший или недоступный пин снимаем, но только если он действительно был
  // бы использован на этом шаге: иначе можно случайно стереть валидный пин
  // другой стадии, просто заглянув в контекст.
  if (!isPinnedRuntimeProfileCurrent(pinnedSelection, task?.projectId)) {
    if (canUsePinnedSelection) {
      log.warn(
        { taskId: options.taskId, profileId: pinnedSelection?.profileId ?? null },
        "[FIX] Discarding stale or unavailable pinned runtime profile",
      );
      clearTaskActiveRuntimeSelection(options.taskId);
    }
  }
  let resolved =
    canUsePinnedSelection && isPinnedRuntimeProfileCurrent(pinnedSelection, task?.projectId)
      ? hydratePinnedRuntimeProfile(pinnedSelection, workflow)
      : null;

  // Пина нет или он отброшен - идем обычным порядком приоритетов: сначала
  // настройка задачи, затем дефолт проекта, затем системный дефолт.
  if (!resolved) {
    const effective = resolveEffectiveRuntimeProfile({
      taskId: options.taskId,
      projectId: task?.projectId,
      mode: profileMode,
      systemDefaultRuntimeProfileId,
    });
    const runtimeOptionsOverride = parseRuntimeOptions(task?.runtimeOptionsJson);
    const suppressModelFallback = options.suppressModelFallback === true;
    const modelOverride =
      options.modelOverride ?? (suppressModelFallback ? null : (task?.modelOverride ?? null));

    resolved = resolveRuntimeProfile({
      source: effective.source,
      profile: effective.profile,
      workflow,
      modelOverride,
      suppressModelFallback,
      runtimeOptionsOverride,
      fallbackRuntimeId: env.AIF_DEFAULT_RUNTIME_ID,
      fallbackProviderId: env.AIF_DEFAULT_PROVIDER_ID,
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

    // Фиксируем результат сразу, чтобы следующая стадия той же задачи взяла
    // ровно этот профиль и могла резюмировать уже начатую сессию.
    if (stageRuntimePinEnabled && task?.status) {
      saveTaskActiveRuntimeSelection(options.taskId, {
        status: task.status,
        profileMode,
        source: resolved.source,
        profileId: resolved.profileId,
        runtimeId: resolved.runtimeId,
        providerId: resolved.providerId,
        transport: resolved.transport,
        model: resolved.model,
        baseUrl: resolved.baseUrl,
        apiKeyEnvVar: resolved.apiKeyEnvVar,
        headers: resolved.headers,
        options: resolved.options,
        pinnedAt: new Date().toISOString(),
      });
    }
  } else {
    log.info(
      {
        taskId: options.taskId,
        profileMode,
        status: task?.status ?? null,
        runtimeId: resolved.runtimeId,
        providerId: resolved.providerId,
        profileId: resolved.profileId,
      },
      "Using pinned task runtime selection for subagent query",
    );
  }
  const suppressModelFallback = options.suppressModelFallback === true;

  const registry = await getRuntimeRegistry();
  // Пригодность проверяется уже после пина, и подмена рантайма не проходит
  // молча: факт смены фиксируется, чтобы результат попал в лог и в новый пин.
  const runtimeSelection = await fallbackToWorkspaceToolRuntime({
    options,
    workflow,
    resolved,
    registry,
  });
  const selectionChanged =
    runtimeSelection.resolved.runtimeId !== resolved.runtimeId ||
    runtimeSelection.resolved.transport !== resolved.transport ||
    runtimeSelection.resolved.profileId !== resolved.profileId;
  resolved = runtimeSelection.resolved;
  const capabilities = runtimeSelection.capabilities;

  // Если проверка пригодности подменила рантайм, пин нужно перезаписать: иначе
  // следующая стадия снова возьмет непригодный профиль из БД и упадет так же.
  if (stageRuntimePinEnabled && task?.status && (!canUsePinnedSelection || selectionChanged)) {
    saveTaskActiveRuntimeSelection(options.taskId, {
      status: task.status,
      profileMode,
      source: resolved.source,
      profileId: resolved.profileId,
      runtimeId: resolved.runtimeId,
      providerId: resolved.providerId,
      transport: resolved.transport,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      apiKeyEnvVar: resolved.apiKeyEnvVar,
      headers: resolved.headers,
      options: resolved.options,
      pinnedAt: new Date().toISOString(),
    });
  }

  // Проверяем жёсткие требования, но исключаем supportsAgentDefinitions —
  // promptPolicy сам откатывается к слэш-командам, когда agent defs не поддерживаются.
  const hardRequired = workflow.requiredCapabilities.filter(
    (cap) =>
      cap !== "supportsAgentDefinitions" &&
      !(cap === "supportsWorkspaceTools" && capabilities.supportsToolCalling === true),
  );
  if (hardRequired.length > 0) {
    assertRuntimeCapabilities({
      runtimeId: resolved.runtimeId,
      workflowKind: workflow.workflowKind,
      capabilities,
      required: hardRequired,
      logger: {
        debug(context, message) {
          log.debug({ ...context }, `[runtime-capabilities] ${message}`);
        },
        warn(context, message) {
          log.warn({ ...context }, `WARN [runtime-capabilities] ${message}`);
        },
      },
    });
  }

  const promptPolicy = resolveRuntimePromptPolicy({
    runtimeId: resolved.runtimeId,
    projectRoot: options.projectRoot,
    capabilities,
    runtimeOptions: resolved.options,
    workflow,
    transport: resolved.transport,
    codexNativeSubagentsEnabled: getEnv().AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED,
    logger: {
      debug(context, message) {
        log.debug({ ...context }, `[runtime-workflow] ${message}`);
      },
      warn(context, message) {
        log.warn({ ...context }, `WARN [runtime-workflow] ${message}`);
      },
    },
  });

  // Сабагенты стадии Review (review-sidecar, security-sidecar) должны аудировать
  // только диф текущей задачи, а не всю кодовую базу. Правило scope внедряется
  // здесь, чтобы его получил каждый review-запрос независимо от файла agent definition.
  const effectiveSystemPromptAppend =
    (options.profileMode ?? "task") === "review"
      ? `${promptPolicy.systemPromptAppend}\n\n${REVIEW_DIFF_SCOPE_SYSTEM_APPEND}`.trim()
      : promptPolicy.systemPromptAppend;

  // Резюм - это и экономия контекста, и источник утечек: стратегии изолированной
  // skill-команды и нативного субагента подразумевают чистую сессию, иначе
  // изоляция ломается и агент видит лишнюю историю предыдущих стадий.
  const baseCanResume =
    workflow.sessionReusePolicy === "resume_if_available" && capabilities.supportsResume;
  const requiresFreshSession =
    promptPolicy.usedIsolatedSkillCommand || promptPolicy.usedNativeSubagentWorkflow;
  const canResume = requiresFreshSession ? false : baseCanResume;
  if (baseCanResume && requiresFreshSession) {
    log.debug(
      {
        taskId: options.taskId,
        runtimeId: resolved.runtimeId,
        workflowKind: workflow.workflowKind,
      },
      "Workflow selected a fresh-session subagent strategy; forcing new session instead of resume",
    );
  }

  const profileLogContext = redactResolvedRuntimeProfile(resolved);
  log.info(
    {
      taskId: options.taskId,
      workflowKind: workflow.workflowKind,
      ...profileLogContext,
      usedFallbackSlashCommand: promptPolicy.usedFallbackSlashCommand,
      usedIsolatedSkillCommand: promptPolicy.usedIsolatedSkillCommand,
      usedNativeSubagentWorkflow: promptPolicy.usedNativeSubagentWorkflow,
      usedApiSkillExpansion: promptPolicy.usedApiSkillExpansion,
      nativeSubagentFallbackReason: promptPolicy.nativeSubagentFallbackReason ?? null,
      suppressModelFallback,
      canResume,
    },
    "Resolved runtime execution context for subagent query",
  );

  // CLI-транспорты аутентифицируются собственным логином на машине, поэтому
  // отсутствие ключа в окружении для них - норма, а не повод для предупреждения.
  if (!resolved.apiKey && resolved.transport !== "cli") {
    log.warn(
      {
        taskId: options.taskId,
        runtimeId: resolved.runtimeId,
        apiKeyEnvVar: resolved.apiKeyEnvVar,
      },
      "Runtime execution resolved without API key; adapter may fail depending on provider setup",
    );
  }

  return {
    workflow,
    runtimeId: resolved.runtimeId,
    providerId: resolved.providerId,
    profileId: resolved.profileId,
    transport: resolved.transport,
    capabilities,
    model: resolved.model,
    effort: pickEffort(resolved.options),
    headers: resolved.headers,
    // Плоские поля профиля подмешиваются в options: адаптеры читают только
    // options и не должны знать устройство ResolvedRuntimeProfile.
    options: {
      ...resolved.options,
      ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
      ...(resolved.apiKeyEnvVar ? { apiKeyEnvVar: resolved.apiKeyEnvVar } : {}),
      projectRoot: options.projectRoot,
    },
    prompt: promptPolicy.prompt,
    systemPromptAppend: effectiveSystemPromptAppend,
    agentDefinitionName: promptPolicy.agentDefinitionName,
    canResume,
    usedIsolatedSkillCommand: promptPolicy.usedIsolatedSkillCommand,
    usedNativeSubagentWorkflow: promptPolicy.usedNativeSubagentWorkflow,
    usedApiSkillExpansion: promptPolicy.usedApiSkillExpansion,
  };
}

// Собирает изменяемые настройки запуска в один объект, который адаптеры читают,
// но не переопределяют: таймауты, окружение, guard на зацикливание и колбэки
// активности. Какие поля адаптеру понятны, решает сам адаптер.
function buildExecutionIntent(
  options: SubagentQueryOptions,
  systemPromptAppend: string,
  agentDefinitionName: string | undefined,
  stderr: (chunk: string) => void,
): import("@aif/runtime").RuntimeExecutionIntent {
  const env = getEnv();
  // Обход подтверждений включается только из окружения и работает в паре с
  // trust-токеном ниже: адаптеры принимают его как доказательство, что вызов
  // пришел из доверенного координатора, а не от внешнего клиента.
  const bypassPermissions = env.AGENT_BYPASS_PERMISSIONS;
  // Guard создается на каждый запрос: счетчики не должны переноситься между
  // стадиями, иначе лимит израсходуется уже на второй задаче.
  const loopGuard = new LoopGuard({
    maxToolCalls: env.AGENT_MAX_TOOL_CALLS_PER_STAGE,
    readOnlyBurst: env.AGENT_LOOP_READ_ONLY_BURST,
  });
  // Явный контроллер от вызывающего кода важнее стадийного: вызывающий вправе
  // отменять только часть работы внутри одной стадии.
  const explicitAbort =
    options.abortController ?? getActiveStageAbortController(options.taskId) ?? undefined;
  const task = findTaskById(options.taskId);
  // Ветка передается в целевой проект переменными окружения: у хуков и команд
  // проекта нет другого способа узнать, куда именно подготовлен checkout.
  const branchEnvironment: Record<string, string> = task?.branchName
    ? {
        HANDOFF_BRANCH_PREPARED: "1",
        HANDOFF_BRANCH_NAME: task.branchName,
      }
    : {};

  return {
    maxBudgetUsd: options.maxBudgetUsd ?? null,
    maxTurns: options.maxTurns,
    startTimeoutMs: options.queryStartTimeoutMs ?? env.AGENT_QUERY_START_TIMEOUT_MS,
    startRetryDelayMs: options.queryStartRetryDelayMs ?? env.AGENT_QUERY_START_RETRY_DELAY_MS,
    runTimeoutMs: env.AGENT_STAGE_RUN_TIMEOUT_MS,
    includePartialMessages: options.includePartialMessages ?? false,
    agentDefinitionName,
    systemPromptAppend,
    bypassPermissions,
    // Флаги режима и идентификатор задачи пробрасываются в окружение процесса:
    // их читают инструменты, которые агент запускает внутри проекта.
    environment: {
      HANDOFF_MODE: "1",
      HANDOFF_TASK_ID: options.taskId,
      ...branchEnvironment,
      ...(options.skipReview ? { HANDOFF_SKIP_REVIEW: "1" } : {}),
    },
    abortController: explicitAbort,
    onStderr: stderr,
    // Каждый вызов инструмента проходит через guard и одновременно пишется в
    // activity: по этим строкам UI показывает текущий прогресс стадии.
    onToolUse: (toolName, detail) => {
      loopGuard.onToolUse(toolName, detail);
      logActivity(options.taskId, "Tool", `${toolName}${detail}`);
      trackTaskInFlight(options.taskId, null);
    },
    onSubagentStart: (name, id) => {
      const idSuffix = id ? ` (${id.slice(0, 8)})` : "";
      logActivity(options.taskId, "Subagent", `${name} started${idSuffix}`);
    },
    // Специфичные для адаптера опции — адаптеры читают нужное, остальное игнорируют
    // Секция hooks - единственный канал передачи токена доверия и настроек
    // адаптеру: они не попадают ни в аудит, ни в логи резолвинга профиля.
    hooks: {
      _trustToken: RUNTIME_TRUST_TOKEN,
      settings: { attribution: { commit: "", pr: "" } },
      settingSources: ["project"],
    },
  };
}

/**
 * Выполняет запрос сабагента на runtime со стандартизированными:
 * - таймером heartbeat
 * - сбором stderr
 * - аудит-логированием
 * - журналированием активности
 * - учётом расхода токенов
 * - диагностикой ошибок
 */
// Переменные для ошибки объявлены до try, потому что catch тоже должен
// сообщить о сбое: к моменту исключения контекст может быть еще не разрешен,
// и приходится довольствоваться значением по умолчанию.
export async function executeSubagentQuery(
  options: SubagentQueryOptions,
): Promise<SubagentQueryResult> {
  const { taskId, projectRoot, agentName } = options;
  // Первая проверка владения: отсекаем заведомо чужую задачу до всех затратных
  // операций - резолвинга профиля, bootstrap реестра, запроса к провайдеру.
  assertAiExecutionOwner(taskId);
  // Хвост stderr собирается всегда: он нужен и для диагностики ошибки, и для
  // адаптеров, умеющих разбирать собственный вывод.
  const stderrCollector = createStderrCollector();
  // Heartbeat стартует до резолвинга: долгий bootstrap тоже должен продлевать
  // claim, иначе координатор сочтет задачу брошенной.
  const heartbeatTimer = startHeartbeat(taskId);

  let runtimeIdForError = getEnv().AIF_DEFAULT_RUNTIME_ID;
  let providerIdForError = getEnv().AIF_DEFAULT_PROVIDER_ID;
  let runtimeProfileIdForError: string | null = null;
  let workflowKindForError: string | null = null;
  let latestLimitSnapshot: RuntimeLimitSnapshot | null = null;
  let adapter: RuntimeAdapter | null = null;
  let watchdog: ReturnType<typeof createFirstActivityWatchdog> | null = null;
  // Флаг читается один раз на прогон: включение лимитов в середине запроса дало
  // бы несогласованное состояние, когда часть событий уже учтена, а часть нет.
  const runtimeUsageLimitsEnabled = getEnv().AIF_USAGE_LIMITS_ENABLED;

  try {
    const context = await resolveExecutionContext(options);
    runtimeIdForError = context.runtimeId;
    providerIdForError = context.providerId;
    runtimeProfileIdForError = context.profileId;
    workflowKindForError = context.workflow.workflowKind;
    const effortSuffix = context.effort ? `, effort=${context.effort}` : "";
    logActivity(
      taskId,
      "Agent",
      `${agentName} started (runtime=${context.runtimeId}, transport=${context.transport}, model=${context.model ?? "default"}${effortSuffix})`,
    );
    // Сессия запрашивается из БД только когда политика workflow вообще допускает
    // резюм: иначе один факт наличия sessionId уже влиял бы на выбор warmup.
    const existingSessionId = context.canResume ? getTaskSessionId(taskId) : null;
    const shouldResume = Boolean(existingSessionId && context.canResume);

    // Аудит пишется до запуска специально: если агент упадет, промпт и профиль
    // все равно останутся в истории, и инцидент можно будет разобрать.
    writeQueryAudit({
      timestamp: new Date().toISOString(),
      taskId,
      agentName,
      projectRoot,
      prompt: context.prompt,
      options: {
        runtimeId: context.runtimeId,
        providerId: context.providerId,
        profileId: context.profileId,
        workflowKind: context.workflow.workflowKind,
        model: context.model,
        systemPromptAppend: context.systemPromptAppend,
        maxBudgetUsd: options.maxBudgetUsd ?? null,
        usedIsolatedSkillCommand: context.usedIsolatedSkillCommand,
        usedNativeSubagentWorkflow: context.usedNativeSubagentWorkflow,
        usedApiSkillExpansion: context.usedApiSkillExpansion,
      },
    });

    const registry = await getRuntimeRegistry();
    adapter = registry.resolveRuntime(context.runtimeId);
    let warmupSourceSessionId: string | null = null;
    let warmupId: string | null = null;
    let usedWarmupFork = false;

    const logWarmupSkip = (skipReason: WarmupSkipReason) => {
      log.debug(
        {
          taskId,
          workflowKind: context.workflow.workflowKind,
          runtimeId: context.runtimeId,
          runtimeProfileId: context.profileId,
          transport: context.transport,
          model: context.model,
          skipReason,
        },
        "Skipping warmup fork",
      );
    };

    if (!getEnv().AIF_WARMUP_ENABLED) {
      logWarmupSkip("feature_disabled");
    } else if (!isWarmupWorkflowKind(context.workflow.workflowKind)) {
      logWarmupSkip("workflow_not_enabled");
    } else if (existingSessionId) {
      logWarmupSkip("existing_task_session");
    } else {
      // Форк поддерживается не всеми рантаймами, поэтому сначала спрашиваем
      // адаптер и capabilities, и только потом ищем готовую прогревающую сессию.
      const forkSupport = checkRuntimeSessionForkSupport({
        runtimeId: context.runtimeId,
        transport: context.transport,
        capabilities: context.capabilities,
        hasForkSessionMethod: typeof adapter.forkSession === "function",
        sourceSessionId: "__warmup_probe__",
        logger: {
          debug(runtimeContext, message) {
            log.debug({ taskId, ...runtimeContext }, `[runtime-warmup] ${message}`);
          },
          warn(runtimeContext, message) {
            log.warn({ taskId, ...runtimeContext }, `WARN [runtime-warmup] ${message}`);
          },
        },
      });
      if (!forkSupport.ok) {
        logWarmupSkip(
          forkSupport.skipReason === "missing_adapter_method"
            ? "missing_adapter_method"
            : "unsupported_runtime",
        );
      } else {
        const expiredCount = expireStaleRuntimeWarmupSessions();
        const projectId = findTaskById(taskId)?.projectId ?? null;
        // Сессия ищется строго под тот же профиль, провайдера и модель: форк
        // чужой сессии дал бы агенту контекст другой задачи или проекта.
        const warmup =
          projectId == null
            ? undefined
            : findActiveReadyRuntimeWarmupSession({
                projectId,
                runtimeProfileId: context.profileId,
                runtimeId: context.runtimeId,
                providerId: context.providerId,
                transport: context.transport,
                model: context.model,
              });
        // Готовой сессии нет: различаем "прогрев не успел" и "прогрев под
        // другой профиль" по числу только что просроченных записей.
        if (!warmup?.sourceSessionId) {
          logWarmupSkip(expiredCount > 0 ? "expired" : "runtime_mismatch");
        } else {
          warmupSourceSessionId = warmup.sourceSessionId;
          warmupId = warmup.id;
          log.info(
            {
              taskId,
              warmupId,
              runtimeId: context.runtimeId,
              runtimeProfileId: context.profileId,
              sourceSessionIdSuffix: sessionIdSuffix(warmupSourceSessionId),
            },
            "Warmup fork selected",
          );
        }
      }
    }

    // Сторож первой активности требует транспорт, который в реальном времени
    // показывает инкрементальную активность runtime. SDK / CLI адаптеры шлют
    // колбэки RuntimeEvent для стримингового текста, рассуждений и сводок
    // инструментов, поэтому любое такое событие доказывает живость runtime,
    // даже если workflow не делает ни одного вызова инструмента. API-транспорт
    // — чистый HTTP, промежуточных событий нет, и сторож обязан быть выключен.
    //
    // CLI получает 2x буфер относительно SDK, потому что несёт дополнительный
    // холодный старт, которого нет на пути SDK: спавн бинарника (~1-3 с) и
    // начальный обмен system/init с полным каталогом инструментов/MCP. Без
    // буфера медленный первый запуск на CLI мог ложно взвести сторож.
    const baseFirstActivityTimeoutMs = getEnv().AGENT_FIRST_ACTIVITY_TIMEOUT_MS;
    const firstActivityTimeoutMs =
      context.transport === "api"
        ? 0
        : context.transport === "cli"
          ? baseFirstActivityTimeoutMs * 2
          : baseFirstActivityTimeoutMs;
    let result: Awaited<ReturnType<RuntimeAdapter["run"]>> | undefined;

    // Цикл повторов: если агент завис (нет активности runtime после старта), убить и перезапустить
    for (let attempt = 0; attempt <= FIRST_ACTIVITY_MAX_RETRIES; attempt++) {
      // Снимок сбрасывается на каждой попытке: упавшая попытка не должна
      // передать свой устаревший лимит в итог успешной.
      latestLimitSnapshot = null;
      // Новый AbortController на попытку — AbortController одноразовый
      const attemptAbort = new AbortController();
      // Цепляемся к внешней отмене, если она задана (таймаут стадии, завершение)
      const externalAbort =
        options.abortController ?? getActiveStageAbortController(taskId) ?? undefined;
      // Если внешняя отмена уже случилась, подписываться поздно: прерываем
      // попытку немедленно, сохранив ту же причину.
      if (externalAbort?.signal.aborted) {
        attemptAbort.abort(externalAbort.signal.reason);
      } else {
        externalAbort?.signal.addEventListener(
          "abort",
          () => attemptAbort.abort(externalAbort.signal.reason),
          { once: true },
        );
      }

      const executionIntent = buildExecutionIntent(
        options,
        context.systemPromptAppend,
        context.agentDefinitionName,
        stderrCollector.onStderr,
      );
      // Подменяем abort-контроллер на наш, отдельный для попытки
      executionIntent.abortController = attemptAbort;
      // API-транспорт — чистый HTTP, без инкрементального потока, поэтому
      // сторожу start-timeout нечего наблюдать и он обязан быть выключен.
      // SDK стримит в процессе, а CLI теперь стримит JSONL-события (system/init
      // приходит в первые сотни мс), поэтому оба выдерживают start timeout.
      if (context.transport === "api") {
        executionIntent.startTimeoutMs = 0;
      }

      // Настраиваем сторож первой активности для этой попытки
      watchdog = createFirstActivityWatchdog(firstActivityTimeoutMs, attemptAbort, () => {
        const timeoutSec = Math.round(firstActivityTimeoutMs / 1000);
        logActivity(
          taskId,
          "Agent",
          `${agentName} stalled — no runtime activity within ${timeoutSec}s after start (attempt ${attempt + 1}/${FIRST_ACTIVITY_MAX_RETRIES + 1}), restarting`,
        );
        log.warn(
          { taskId, agentName, firstActivityTimeoutMs, attempt: attempt + 1 },
          "First-activity watchdog triggered: killing and restarting agent",
        );
      });

      // Устанавливаем мост onEvent, даже когда вызывающий код не запрашивал
      // стриминговые события напрямую: сторожу нужен колбэк, чтобы наблюдать
      // активность runtime в workflow без инструментов, например checklist sync.
      const wd = watchdog!;
      const originalOnEvent = executionIntent.onEvent ?? (() => undefined);
      const originalOnToolUse = executionIntent.onToolUse;
      const originalOnSubagentStart = executionIntent.onSubagentStart;
      executionIntent.onEvent = (event) => {
        wd.markActivity();
        if (event.type === "tool:use") {
          const data = (event.data ?? {}) as Record<string, unknown>;
          if (typeof data.name === "string") {
            trackTaskInFlight(taskId, {
              name: data.name,
              startedAt: new Date().toISOString(),
            });
          }
        }
        // Лимиты вылавливаются прямо из стрима: последний валидный снимок
        // заменяет предыдущий, но при отсутствии новых событий старый не
        // затирается, чтобы состояние лимита осталось актуальным.
        if (runtimeUsageLimitsEnabled) {
          latestLimitSnapshot = observeRuntimeLimitEvent(event, latestLimitSnapshot, {
            logger: log,
            observedMessage: "Observed runtime limit event during subagent execution",
            malformedMessage: "Dropped runtime limit event with malformed snapshot payload",
            logContext: {
              taskId,
              runtimeId: context.runtimeId,
              runtimeProfileId: context.profileId,
              workflowKind: context.workflow.workflowKind,
              attempt: attempt + 1,
            },
          });
        }
        originalOnEvent(event);
      };
      if (originalOnToolUse) {
        executionIntent.onToolUse = (toolName, detail) => {
          wd.markActivity();
          originalOnToolUse(toolName, detail);
        };
      }
      if (originalOnSubagentStart) {
        executionIntent.onSubagentStart = (name, id) => {
          wd.markActivity();
          originalOnSubagentStart(name, id);
        };
      }

      // Проект перечитывается заново на каждой попытке, чтобы повтор,
      // увидевший перепривязанную задачу, писал в правильный проект.
      const projectIdForUsage = findTaskById(taskId)?.projectId ?? null;

      const runInput = {
        runtimeId: context.runtimeId,
        providerId: context.providerId,
        profileId: context.profileId,
        workflowKind: context.workflow.workflowKind,
        transport: context.transport,
        prompt: context.prompt,
        // Сообщения и определения инструментов нужны только API-транспорту с
        // поддержкой tool calling: SDK и CLI собирают диалог сами из prompt.
        messages:
          context.transport === RuntimeTransport.API && context.capabilities.supportsToolCalling
            ? ([
                ...(context.systemPromptAppend
                  ? [{ role: "system" as const, content: context.systemPromptAppend }]
                  : []),
                { role: "user" as const, content: context.prompt },
              ] satisfies RuntimeConversationMessage[])
            : undefined,
        tools:
          context.transport === RuntimeTransport.API && context.capabilities.supportsToolCalling
            ? WORKSPACE_TOOL_DEFINITIONS
            : undefined,
        toolChoice:
          context.transport === RuntimeTransport.API && context.capabilities.supportsToolCalling
            ? ("auto" as const)
            : undefined,
        sessionId: existingSessionId,
        resume: shouldResume,
        projectRoot,
        cwd: projectRoot,
        headers: context.headers,
        options: context.options,
        model: context.model ?? undefined,
        execution: executionIntent,
        // Источник usage по умолчанию SUBAGENT: расходы координатора и
        // пользовательского чата считаются раздельно.
        usageContext: {
          source: options.usageSource ?? UsageSource.SUBAGENT,
          projectId: projectIdForUsage,
          taskId,
        },
      } as const;

      try {
        assertAiExecutionOwner(taskId);
        // Порядок ветвления важен: warmup-форк дает свежую сессию с прогретым
        // контекстом, и только без него имеет смысл резюм или новый запуск.
        if (warmupSourceSessionId && adapter.forkSession) {
          result = await adapter.forkSession({
            ...runInput,
            sourceSessionId: warmupSourceSessionId,
          });
          usedWarmupFork = true;
        } else if (shouldResume && adapter.resume) {
          result = await adapter.resume({ ...runInput, sessionId: existingSessionId as string });
        } else {
          const toolExecutor =
            context.transport === RuntimeTransport.API && context.capabilities.supportsToolCalling
              ? new WorkspaceToolExecutor(projectRoot)
              : null;
          // Ручной цикл tool-calls для API-транспорта: адаптер не повторяет
          // запрос сам, поэтому результат каждого инструмента дописывается в
          // диалог и отправляется обратно модели. Лимит шагов защищает от
          // бесконечного самоповтора.
          let conversation: RuntimeConversationMessage[] | undefined = runInput.messages;
          for (let toolStep = 0; ; toolStep += 1) {
            if (toolStep >= 20) {
              throw new RuntimeValidationError("Workspace tool loop exceeded 20 steps");
            }
            const currentInput = conversation ? { ...runInput, messages: conversation } : runInput;
            result = await adapter.run(currentInput);
            const toolCalls = result.toolCalls ?? [];
            if (!toolExecutor || toolCalls.length === 0) break;
            conversation = [
              ...(conversation ?? []),
              {
                role: "assistant" as const,
                content: result.outputText ?? null,
                toolCalls,
              },
            ];
            for (const toolCall of toolCalls) {
              const toolResult = await toolExecutor
                .execute(toolCall)
                .catch(
                  (error) => `ERROR: ${error instanceof Error ? error.message : String(error)}`,
                );
              // Результат обрезается: вывод команды может быть огромным, а
              // контекстное окно модели - нет.
              conversation.push({
                role: "tool" as const,
                toolCallId: toolCall.id,
                content: toolResult.slice(0, 8_000),
              });
            }
          }
        }
        // Успех — выход из цикла повторов
        watchdog.clear();
        break;
      } catch (err) {
        // Различаем два исхода: сторож убил зависшую попытку (есть смысл
        // повторить) и настоящая ошибка рантайма (повтор бессмыслен, пробрасываем).
        const stalledByWatchdog = watchdog.didFire;
        watchdog.clear();
        if (stalledByWatchdog && attempt < FIRST_ACTIVITY_MAX_RETRIES) {
          // Агент завис — убить и повторить
          trackTaskInFlight(taskId, null);
          log.info(
            { taskId, agentName, attempt: attempt + 1, maxRetries: FIRST_ACTIVITY_MAX_RETRIES },
            "Restarting agent after first-activity stall",
          );
          continue;
        }
        // Не зависание или повторы исчерпаны — пробрасываем дальше
        trackTaskInFlight(taskId, null);
        throw err;
      }
    }

    // Страховка: сюда попадаем, только если все попытки истекли по сторожу,
    // а последняя не подняла исключения сама.
    if (!result) {
      throw new Error(
        `${agentName}: all ${FIRST_ACTIVITY_MAX_RETRIES + 1} attempts stalled without runtime activity`,
      );
    }

    if (runtimeUsageLimitsEnabled) {
      // Финальный снимок берется из событий: он авторитетнее всего, что было
      // замечено по ходу стрима, и именно его увидят подписчики UI.
      latestLimitSnapshot = extractLatestRuntimeLimitSnapshot(result.events) ?? latestLimitSnapshot;
      if (latestLimitSnapshot) {
        refreshRuntimeProfileLimitState({
          runtimeProfileId: context.profileId,
          runtimeId: context.runtimeId,
          providerId: context.providerId,
          snapshot: latestLimitSnapshot,
          taskId,
          workflowKind: context.workflow.workflowKind,
          reason: "subagent:success",
        });
      } else {
        log.debug(
          {
            taskId,
            runtimeProfileId: context.profileId,
            runtimeId: context.runtimeId,
            providerId: context.providerId,
            workflowKind: context.workflow.workflowKind,
          },
          "Preserving runtime limit state after successful subagent execution without an authoritative recovery signal",
        );
      }
    }

    // Идентификатор сохраняется не всегда: для workflow без резюма он бесполезен
    // и только засорял бы запись задачи. Исключение - warmup-форк, после которого
    // сессия нужна последующим стадиям.
    const runtimeSessionId = getResultSessionId(result, context.capabilities);
    if (runtimeSessionId && (context.canResume || usedWarmupFork)) {
      saveTaskSessionId(taskId, runtimeSessionId);
      log.debug(
        {
          taskId,
          agentName,
          runtimeSessionIdSuffix: sessionIdSuffix(runtimeSessionId),
          usedWarmupFork,
          warmupId,
        },
        "Captured runtime session ID",
      );
      if (usedWarmupFork) {
        log.info(
          {
            taskId,
            warmupId,
            runtimeId: context.runtimeId,
            runtimeProfileId: context.profileId,
            childSessionIdSuffix: sessionIdSuffix(runtimeSessionId),
          },
          "Warmup fork succeeded",
        );
      }
    } else if (runtimeSessionId) {
      log.debug(
        {
          taskId,
          agentName,
          runtimeSessionId,
          sessionReusePolicy: context.workflow.sessionReusePolicy,
        },
        "Skipped runtime session persistence for non-resumable workflow",
      );
    }

    // Usage записывается автоматически обёрткой реестра через БД-приёмник
    // (см. packages/data createDbUsageSink + packages/runtime
    // registry.wrapAdapter). Ручной инкремент здесь не нужен.

    // Пустая строка вместо null: контракт результата стадии - всегда строка,
    // чтобы потребителям не приходилось проверять на null.
    const resultText = result.outputText ?? "";

    log.info(
      {
        taskId,
        agentName,
        runtimeId: context.runtimeId,
        profileId: context.profileId,
        model: context.model,
        resumed: shouldResume,
      },
      "Subagent query completed successfully",
    );
    logActivity(
      taskId,
      "Agent",
      `${agentName} complete (runtime=${context.runtimeId}, transport=${context.transport}, model=${context.model ?? "default"}${effortSuffix})`,
    );

    trackTaskInFlight(taskId, null);
    return { resultText };
  } catch (error) {
    trackTaskInFlight(taskId, null);
    if (runtimeUsageLimitsEnabled) {
      refreshRuntimeProfileLimitState({
        runtimeProfileId: runtimeProfileIdForError,
        runtimeId: runtimeIdForError,
        providerId: providerIdForError,
        snapshot: extractRuntimeLimitSnapshotFromError(error),
        clearOnMissing: false,
        taskId,
        workflowKind: workflowKindForError,
        reason: "subagent:error",
      });
    }
    // Причина наружу формируется классификатором, а не текстом ошибки: он
    // раскладывает сбой по категориям и решает, что безопасно показать.
    const safeReason = mapSafeRuntimeErrorReason(error);
    let diagnosticsReason: string | null = null;
    // Диагностику предпочитаем брать у адаптера: он знает свой формат вывода и
    // может вытащить причину из stderr, недоступную общей классификации.
    if (adapter?.diagnoseError) {
      diagnosticsReason = await adapter.diagnoseError({
        error,
        stderrTail: stderrCollector.getTail(),
        projectRoot,
      });
    } else {
      diagnosticsReason = error instanceof Error ? error.message : String(error);
    }
    if (
      diagnosticsReason &&
      diagnosticsReason.trim().length > 0 &&
      diagnosticsReason.trim() !== safeReason.reason
    ) {
      log.debug(
        {
          taskId,
          runtimeId: runtimeIdForError,
          category: safeReason.category,
          diagnosticsReason: redactProviderTextForLogs(diagnosticsReason),
        },
        "Redacted runtime diagnostics before writing task activity",
      );
    }
    logActivity(
      taskId,
      "Agent",
      `${agentName} failed (runtime=${runtimeIdForError}) — ${safeReason.reason}`,
    );
    log.error(
      {
        taskId,
        runtimeId: runtimeIdForError,
        category: safeReason.category,
        errorName: error instanceof Error ? error.name : typeof error,
        diagnosticsReason:
          diagnosticsReason && diagnosticsReason.trim().length > 0
            ? redactProviderTextForLogs(diagnosticsReason)
            : null,
        runtimeStderr: redactProviderTextForLogs(stderrCollector.getTail()),
      },
      `${agentName} execution failed`,
    );
    // Наверх уходит только обезличенная ошибка: исходный текст остался в логах.
    throw buildSanitizedSubagentError(error, safeReason, providerIdForError);
  } finally {
    // Уборка ресурсов обернута в try: падение в finally затёрло бы исходную
    // ошибку выполнения, которая для разбора инцидента гораздо важнее.
    try {
      watchdog?.clear();
    } catch {
      // страховка
    }
    try {
      clearInterval(heartbeatTimer);
    } catch {
      // страховка
    }
  }
}

// ID Координатора внедряется при старте, чтобы избежать циклических импортов
let _coordinatorId: string | null = null;
export function setCoordinatorId(id: string): void {
  _coordinatorId = id;
}

/** Обновляет текущий инструмент в БД и рассылает новое состояние активности. */
function trackTaskInFlight(taskId: string, tool: TaskCurrentTool | null): void {
  setTaskInFlightTool(taskId, tool);
  broadcastTaskActivityProgress(taskId);
}

/** Запускает периодический heartbeat, обновляющий lastHeartbeatAt задачи и продлевающий лок. */
export function startHeartbeat(taskId: string): NodeJS.Timeout {
  return setInterval(() => {
    const lastHeartbeatAt = updateTaskHeartbeat(taskId);
    void notifyTaskHeartbeat(taskId, lastHeartbeatAt);
    if (_coordinatorId) {
      renewTaskClaim(taskId, _coordinatorId, getLockRenewalMs());
    }
  }, HEARTBEAT_INTERVAL_MS);
}
