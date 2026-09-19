// Презентационные мапперы: преобразование строк БД (row-типов) в view-модели,
// которые отдаются наружу (HTTP API, WebSocket, MCP). Вынесены из @aif/data,
// чтобы слой данных занимался только чтением/записью, а не формой ответа.
//
// Модуль серверный (использует pino) и не входит в браузерный вход @aif/shared/browser.
//
// Ключевые инварианты (закреплены контрактными сьютами):
//  - вычисление прав (resolveTaskPermissions) и редакция текста провайдеров
//    (redactProviderText) выполняются здесь, на границе выдачи, с теми же
//    входами/выходами, что и раньше в data-слое;
//  - JSON-колонки разбираются защищённо: повреждённый JSON отдаётся как null/[],
//    а не бросает исключение.

import { parseAttachments } from "./attachments.js";
import { logger as createLogger } from "./logger.js";
import {
  normalizeRuntimeLimitSnapshot,
  redactProviderText,
  sanitizeRuntimeLimitSnapshotForExposure,
} from "./runtimeLimitUtils.js";
import { resolveTaskPermissions, type TaskActionContext } from "./stateMachine.js";
import {
  type AppSettingsRow,
  type ChatMessageRow,
  type ChatSessionRow,
  type RuntimeProfileRow,
  type TaskCommentRow,
  type TaskRow,
} from "./schema.js";
import {
  AUTO_REVIEW_FINDING_SOURCES,
  AUTO_REVIEW_STRATEGIES,
  type AppSettings,
  type AutoReviewState,
  type ChatMessageAttachment,
  type ChatSession,
  type ChatSessionMessage,
  type ParticipantSummary,
  type RuntimeLimitSnapshot,
  type RuntimeLimitWindow,
  type RuntimeProfile,
  type RuntimeProfileUsage,
  type Task,
  type TaskAssigneeSummary,
  type TaskComment,
  type TaskCurrentTool,
  type TaskListItem,
} from "./types.js";

const log = createLogger("shared");

// Множества-справочники для проверки значений из JSON-колонок: валидность
// восстанавливается вручную, потому что SQLite не типизирует такие колонки.
const AUTO_REVIEW_STRATEGY_SET = new Set<string>(AUTO_REVIEW_STRATEGIES);
const AUTO_REVIEW_FINDING_SOURCE_SET = new Set<string>(AUTO_REVIEW_FINDING_SOURCES);

// Контекст без участников: используется, когда вызывающий код не выполнил
// аутентификацию (например, MCP-инструменты или legacy-вызовы).
const LEGACY_TASK_ACTION_CONTEXT: TaskActionContext = {
  participantsModeEnabled: false,
  actor: {
    kind: "anonymous",
    id: null,
    displayNameSnapshot: null,
  },
};

// ---------- Типы строк-проекций для списков ----------
// Типы выведены из TaskRow (schema.ts), чтобы маппер принимал ровно те поля,
// которые выбираются SQL-проекциями данных. Ключ hasPlan добавляется в выборку
// аналогом SQL-выражения, поэтому в типе он опционален по диапазону boolean|number.

export type TaskListItemRow = Pick<
  TaskRow,
  | "id"
  | "projectId"
  | "title"
  | "description"
  | "status"
  | "priority"
  | "position"
  | "autoMode"
  | "executionOwner"
  | "ownershipRevision"
  | "skipReview"
  | "runPostVerify"
  | "isFix"
  | "paused"
  | "roadmapAlias"
  | "tags"
  | "runtimeProfileId"
  | "modelOverride"
  | "blockedReason"
  | "blockedFromStatus"
  | "retryAfter"
  | "retryCount"
  | "reworkRequested"
  | "reviewIterationCount"
  | "maxReviewIterations"
  | "manualReviewRequired"
  | "runtimeLimitSnapshotJson"
  | "runtimeLimitUpdatedAt"
  | "tokenInput"
  | "tokenOutput"
  | "tokenTotal"
  | "costUsd"
  | "lastSyncedAt"
  | "lastHeartbeatAt"
  | "lastActivityAt"
  | "currentToolJson"
  | "scheduledAt"
  | "createdAt"
  | "updatedAt"
> & { hasPlan: boolean | number };

export type TaskSummaryRow = Pick<
  TaskRow,
  | "id"
  | "projectId"
  | "title"
  | "status"
  | "priority"
  | "position"
  | "autoMode"
  | "executionOwner"
  | "ownershipRevision"
  | "skipReview"
  | "runPostVerify"
  | "isFix"
  | "paused"
  | "roadmapAlias"
  | "tags"
  | "runtimeProfileId"
  | "modelOverride"
  | "blockedReason"
  | "blockedFromStatus"
  | "retryAfter"
  | "retryCount"
  | "reworkRequested"
  | "reviewIterationCount"
  | "maxReviewIterations"
  | "manualReviewRequired"
  | "runtimeLimitSnapshotJson"
  | "runtimeLimitUpdatedAt"
  | "tokenTotal"
  | "costUsd"
  | "lastSyncedAt"
  | "createdAt"
  | "updatedAt"
> & { assignees?: TaskAssigneeSummary[] };

// ---------- Приватные парсеры JSON-колонок ----------
// Живут здесь, а не в data-слое: они нужны именно мапперам при формировании
// view-моделей. Парсеры не бросают исключений — повреждённые данные отдаются
// как null/пустая структура, иначе одна битая строка сломала бы весь ответ.

export function parseRuntimeObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasOwnProperty(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readStoredOptionalFiniteNumber(
  record: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (!hasOwnProperty(record, key)) return undefined;
  const value = record[key];
  if (value == null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStoredOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!hasOwnProperty(record, key)) return undefined;
  const value = record[key];
  if (value == null) return null;
  return typeof value === "string" ? value : undefined;
}

function parseRuntimeLimitWindow(
  value: unknown,
  entity: "task" | "runtime_profile" | "codex_limit_head" | "codex_limit_history",
  entityId: string,
  index: number,
  rawLength: number,
): RuntimeLimitWindow | null {
  if (!isObjectRecord(value) || typeof value.scope !== "string") {
    log.warn({ entity, entityId, index, rawLength }, "Malformed persisted runtime-limit window");
    return null;
  }

  const name = readStoredOptionalString(value, "name");
  const unit = readStoredOptionalString(value, "unit");
  const limit = readStoredOptionalFiniteNumber(value, "limit");
  const remaining = readStoredOptionalFiniteNumber(value, "remaining");
  const used = readStoredOptionalFiniteNumber(value, "used");
  const percentUsed = readStoredOptionalFiniteNumber(value, "percentUsed");
  const percentRemaining = readStoredOptionalFiniteNumber(value, "percentRemaining");
  const resetAt = readStoredOptionalString(value, "resetAt");
  const retryAfterSeconds = readStoredOptionalFiniteNumber(value, "retryAfterSeconds");
  const warningThreshold = readStoredOptionalFiniteNumber(value, "warningThreshold");

  return {
    scope: value.scope as RuntimeLimitWindow["scope"],
    ...(name !== undefined ? { name } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(percentUsed !== undefined ? { percentUsed } : {}),
    ...(percentRemaining !== undefined ? { percentRemaining } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(warningThreshold !== undefined ? { warningThreshold } : {}),
  };
}

export function parseRuntimeLimitSnapshot(
  raw: string | null | undefined,
  entity: "task" | "runtime_profile" | "codex_limit_head" | "codex_limit_history",
  entityId: string,
): RuntimeLimitSnapshot | null {
  if (!raw) return null;

  const warnMalformed = (reason: string, extra: Record<string, unknown> = {}) => {
    log.warn(
      { entity, entityId, reason, rawLength: raw.length, ...extra },
      "Malformed persisted runtime-limit snapshot",
    );
  };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObjectRecord(parsed)) {
      warnMalformed("root_not_object");
      return null;
    }

    if (
      typeof parsed.source !== "string" ||
      typeof parsed.status !== "string" ||
      typeof parsed.precision !== "string" ||
      typeof parsed.checkedAt !== "string" ||
      typeof parsed.providerId !== "string" ||
      !Array.isArray(parsed.windows)
    ) {
      warnMalformed("missing_required_fields", {
        hasSource: typeof parsed.source === "string",
        hasStatus: typeof parsed.status === "string",
        hasPrecision: typeof parsed.precision === "string",
        hasCheckedAt: typeof parsed.checkedAt === "string",
        hasProviderId: typeof parsed.providerId === "string",
        hasWindows: Array.isArray(parsed.windows),
      });
      return null;
    }

    const windows: RuntimeLimitWindow[] = [];
    for (const [index, window] of parsed.windows.entries()) {
      const normalized = parseRuntimeLimitWindow(window, entity, entityId, index, raw.length);
      if (!normalized) {
        return null;
      }
      windows.push(normalized);
    }

    const runtimeId = readStoredOptionalString(parsed, "runtimeId");
    const profileId = readStoredOptionalString(parsed, "profileId");
    const primaryScope = readStoredOptionalString(parsed, "primaryScope");
    const resetAt = readStoredOptionalString(parsed, "resetAt");
    const retryAfterSeconds = readStoredOptionalFiniteNumber(parsed, "retryAfterSeconds");
    const warningThreshold = readStoredOptionalFiniteNumber(parsed, "warningThreshold");
    const providerMeta = hasOwnProperty(parsed, "providerMeta")
      ? isObjectRecord(parsed.providerMeta)
        ? parsed.providerMeta
        : parsed.providerMeta == null
          ? null
          : undefined
      : undefined;

    return normalizeRuntimeLimitSnapshot({
      source: parsed.source as RuntimeLimitSnapshot["source"],
      status: parsed.status as RuntimeLimitSnapshot["status"],
      precision: parsed.precision as RuntimeLimitSnapshot["precision"],
      checkedAt: parsed.checkedAt,
      providerId: parsed.providerId,
      ...(runtimeId !== undefined ? { runtimeId } : {}),
      ...(profileId !== undefined ? { profileId } : {}),
      ...(primaryScope !== undefined
        ? { primaryScope: primaryScope as RuntimeLimitSnapshot["primaryScope"] }
        : {}),
      ...(resetAt !== undefined ? { resetAt } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...(warningThreshold !== undefined ? { warningThreshold } : {}),
      windows,
      ...(providerMeta !== undefined ? { providerMeta } : {}),
    });
  } catch (error) {
    warnMalformed("json_parse_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function parseTaskCurrentTool(raw: string | null | undefined): TaskCurrentTool | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed.name !== "string" || typeof parsed.startedAt !== "string") {
      return null;
    }
    return {
      name: parsed.name,
      detail: typeof parsed.detail === "string" ? parsed.detail : undefined,
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

function parseAutoReviewState(raw: string | null | undefined): AutoReviewState | null {
  if (!raw) return null;

  const warnMalformed = (reason: string, extra: Record<string, unknown> = {}) => {
    log.warn(
      { reason, rawLength: raw.length, ...extra },
      "Malformed persisted auto-review payload",
    );
  };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnMalformed("root_not_object");
      return null;
    }

    const candidate = parsed as Record<string, unknown>;

    const strategy =
      typeof candidate.strategy === "string" && AUTO_REVIEW_STRATEGY_SET.has(candidate.strategy)
        ? candidate.strategy
        : null;
    const iteration =
      typeof candidate.iteration === "number" &&
      Number.isFinite(candidate.iteration) &&
      Number.isInteger(candidate.iteration) &&
      candidate.iteration >= 0
        ? candidate.iteration
        : null;
    const findings = Array.isArray(candidate.findings) ? candidate.findings : null;

    if (!strategy || iteration == null || !findings) {
      warnMalformed("missing_required_fields", {
        hasStrategy: Boolean(strategy),
        hasIteration: iteration != null,
        hasFindings: Boolean(findings),
      });
      return null;
    }

    const normalizedFindings: AutoReviewState["findings"] = [];
    for (const item of findings) {
      if (!item || typeof item !== "object") {
        warnMalformed("invalid_finding_shape");
        return null;
      }

      const finding = item as Record<string, unknown>;
      if (
        typeof finding.id !== "string" ||
        typeof finding.text !== "string" ||
        typeof finding.source !== "string" ||
        !AUTO_REVIEW_FINDING_SOURCE_SET.has(finding.source)
      ) {
        warnMalformed("invalid_finding_fields", {
          findingId: finding.id,
          findingSource: finding.source,
        });
        return null;
      }

      normalizedFindings.push({
        id: finding.id,
        text: finding.text,
        source: finding.source as AutoReviewState["findings"][number]["source"],
      });
    }

    if (normalizedFindings.length !== findings.length) {
      warnMalformed("dropped_invalid_findings", {
        expectedCount: findings.length,
        actualCount: normalizedFindings.length,
      });
      return null;
    }

    return {
      strategy: strategy as AutoReviewState["strategy"],
      iteration,
      findings: normalizedFindings,
    };
  } catch (error) {
    warnMalformed("json_parse_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function redactTaskTextForExternalUse(text: string | null | undefined): {
  value: string | null;
  stripped: boolean;
} {
  if (typeof text !== "string") {
    return { value: text ?? null, stripped: false };
  }
  const lines = text.split(/\r?\n/);
  const redactedLines = lines.map((line) => redactProviderText(line));
  return {
    value: redactedLines.join("\n"),
    stripped: redactedLines.some((line, index) => line !== lines[index]),
  };
}

function parseTaskRuntimeLimitSnapshot(
  raw: string | null | undefined,
  taskId: string,
): RuntimeLimitSnapshot | null {
  const snapshot = parseRuntimeLimitSnapshot(raw, "task", taskId);
  if (!snapshot) return null;
  return sanitizeRuntimeLimitSnapshotForExposure(snapshot, "task");
}

function toBooleanFlag(value: boolean | number): boolean {
  return value === true || value === 1;
}

// ---------- Публичные мапперы ----------

export function toTaskResponse(
  task: TaskRow & { assignees?: TaskAssigneeSummary[] },
  actionContext: TaskActionContext = LEGACY_TASK_ACTION_CONTEXT,
): Task {
  // Внутренние ссылки рантайма не покидают процесс: в ответе они отбрасываются,
  // а из JSON-колонок раскрываются только те поля, которые нужны клиенту.
  const {
    attachments,
    tags,
    assignees = [],
    runtimeOptionsJson,
    autoReviewStateJson,
    currentToolJson,
    activeRuntimeSelectionJson: _activeRuntimeSelectionJson,
    activeRuntimeStatus: _activeRuntimeStatus,
    runtimeLimitSnapshotJson,
    ...rest
  } = task;

  const redactedActivity = redactTaskTextForExternalUse(task.agentActivityLog);
  if (redactedActivity.stripped) {
    log.warn(
      { taskId: task.id, field: "agentActivityLog" },
      "Redacted provider text in task response",
    );
  }

  return {
    ...rest,
    attachments: parseAttachments(attachments),
    tags: parseTags(tags),
    assignees,
    permissions: resolveTaskPermissions(
      {
        id: task.id,
        status: task.status,
        autoMode: task.autoMode,
        executionOwner: task.executionOwner,
        assignees,
        blockedFromStatus: task.blockedFromStatus,
        skipReview: task.skipReview,
        runPostVerify: task.runPostVerify,
      },
      actionContext,
    ),
    autoReviewState: parseAutoReviewState(autoReviewStateJson),
    runtimeOptions: parseRuntimeObject(runtimeOptionsJson),
    agentActivityLog: redactedActivity.value,
    runtimeLimitSnapshot: parseTaskRuntimeLimitSnapshot(runtimeLimitSnapshotJson, task.id),
    currentTool: parseTaskCurrentTool(currentToolJson),
  };
}

export function toTaskListItem(
  row: TaskListItemRow,
  assignees: TaskAssigneeSummary[] = [],
  actionContext: TaskActionContext = LEGACY_TASK_ACTION_CONTEXT,
): TaskListItem {
  const {
    tags,
    runtimeLimitSnapshotJson,
    currentToolJson,
    hasPlan,
    skipReview,
    runPostVerify,
    ...rest
  } = row;
  return {
    ...rest,
    tags: parseTags(tags),
    assignees,
    permissions: resolveTaskPermissions(
      {
        id: row.id,
        status: row.status,
        autoMode: row.autoMode,
        executionOwner: row.executionOwner,
        assignees,
        blockedFromStatus: row.blockedFromStatus,
        skipReview,
        runPostVerify,
      },
      actionContext,
    ),
    runtimeLimitSnapshot: parseTaskRuntimeLimitSnapshot(runtimeLimitSnapshotJson, row.id),
    currentTool: parseTaskCurrentTool(currentToolJson),
    hasPlan: toBooleanFlag(hasPlan),
  };
}

export function toTaskSummary(
  row: TaskSummaryRow,
  actionContext: TaskActionContext = LEGACY_TASK_ACTION_CONTEXT,
) {
  const {
    tags,
    runtimeLimitSnapshotJson,
    assignees = [],
    skipReview,
    runPostVerify,
    ...rest
  } = row;
  return {
    ...rest,
    tags: parseTags(tags),
    assignees,
    permissions: resolveTaskPermissions(
      {
        id: row.id,
        status: row.status,
        autoMode: row.autoMode,
        executionOwner: row.executionOwner,
        assignees,
        blockedFromStatus: row.blockedFromStatus,
        skipReview,
        runPostVerify,
      },
      actionContext,
    ),
    runtimeLimitSnapshot: parseTaskRuntimeLimitSnapshot(runtimeLimitSnapshotJson, row.id),
  };
}

export function toCommentResponse(
  comment: TaskCommentRow & { participant?: ParticipantSummary | null },
): TaskComment {
  return {
    id: comment.id,
    taskId: comment.taskId,
    author: comment.author,
    participantId: comment.participantId,
    participant: comment.participant ?? null,
    message: comment.message,
    attachments: parseAttachments(comment.attachments),
    createdAt: comment.createdAt,
  };
}

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

function parseRuntimeHeaders(raw: string | null | undefined): Record<string, string> {
  const parsed = parseRuntimeObject(raw);
  if (!parsed) return {};

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  return headers;
}

export function toRuntimeProfileResponse(
  row: RuntimeProfileRow,
  usageState: RuntimeProfileUsageState | null = null,
): RuntimeProfile {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    runtimeId: row.runtimeId,
    providerId: row.providerId,
    transport: row.transport,
    baseUrl: row.baseUrl,
    apiKeyEnvVar: row.apiKeyEnvVar,
    defaultModel: row.defaultModel,
    headers: parseRuntimeHeaders(row.headersJson),
    options: parseRuntimeObject(row.optionsJson) ?? {},
    enabled: row.enabled,
    runtimeLimitSnapshot: parseRuntimeLimitSnapshot(
      row.runtimeLimitSnapshotJson,
      "runtime_profile",
      row.id,
    ),
    runtimeLimitUpdatedAt: row.runtimeLimitUpdatedAt ?? null,
    lastUsage: usageState?.lastUsage ?? null,
    lastUsageAt: usageState?.lastUsageAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface RuntimeProfileUsageState {
  lastUsage: RuntimeProfileUsage;
  lastUsageAt: string;
}

export function toChatSessionResponse(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    agentSessionId: row.agentSessionId,
    runtimeProfileId: row.runtimeProfileId,
    runtimeSessionId: row.runtimeSessionId ?? row.agentSessionId,
    source: "web",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toChatMessageResponse(row: ChatMessageRow): ChatSessionMessage {
  let attachments: ChatMessageAttachment[] | undefined;
  if (row.attachments) {
    try {
      attachments = JSON.parse(row.attachments) as ChatMessageAttachment[];
    } catch {
      // Повреждённый JSON: вложения молча считаются отсутствующими.
    }
  }
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    ...(attachments?.length ? { attachments } : {}),
    createdAt: row.createdAt,
  };
}
