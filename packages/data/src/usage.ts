/**
 * События использования: приёмник usage-событий, агрегаты токенов и чтение
 * последнего расхода по профилям.
 */
import { and, eq, inArray, isNotNull, max, sql } from "drizzle-orm";
import {
  chatSessions,
  logger as createLogger,
  parseTaskTokenUsage,
  projects,
  tasks,
  usageEvents,
  type RuntimeProfileUsage,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";

const log = createLogger("data");

export function incrementTaskTokenUsage(
  taskId: string,
  usage: Record<string, unknown> | null | undefined,
) {
  const delta = parseTaskTokenUsage(usage);
  if (delta.total === 0 && delta.costUsd === 0) return delta;

  getDb()
    .update(tasks)
    .set({
      tokenInput: sql<number>`coalesce(${tasks.tokenInput}, 0) + ${delta.input}`,
      tokenOutput: sql<number>`coalesce(${tasks.tokenOutput}, 0) + ${delta.output}`,
      tokenTotal: sql<number>`coalesce(${tasks.tokenTotal}, 0) + ${delta.total}`,
      costUsd: sql<number>`coalesce(${tasks.costUsd}, 0) + ${delta.costUsd}`,
    })
    .where(eq(tasks.id, taskId))
    .run();

  return delta;
}

export function incrementProjectTokenUsage(
  projectId: string,
  usage: Record<string, unknown> | null | undefined,
) {
  const delta = parseTaskTokenUsage(usage);
  if (delta.total === 0 && delta.costUsd === 0) return delta;

  getDb()
    .update(projects)
    .set({
      tokenInput: sql<number>`coalesce(${projects.tokenInput}, 0) + ${delta.input}`,
      tokenOutput: sql<number>`coalesce(${projects.tokenOutput}, 0) + ${delta.output}`,
      tokenTotal: sql<number>`coalesce(${projects.tokenTotal}, 0) + ${delta.total}`,
      costUsd: sql<number>`coalesce(${projects.costUsd}, 0) + ${delta.costUsd}`,
    })
    .where(eq(projects.id, projectId))
    .run();

  return delta;
}

export function incrementChatSessionTokenUsage(
  chatSessionId: string,
  usage: Record<string, unknown> | null | undefined,
) {
  const delta = parseTaskTokenUsage(usage);
  if (delta.total === 0 && delta.costUsd === 0) return delta;

  getDb()
    .update(chatSessions)
    .set({
      tokenInput: sql<number>`coalesce(${chatSessions.tokenInput}, 0) + ${delta.input}`,
      tokenOutput: sql<number>`coalesce(${chatSessions.tokenOutput}, 0) + ${delta.output}`,
      tokenTotal: sql<number>`coalesce(${chatSessions.tokenTotal}, 0) + ${delta.total}`,
      costUsd: sql<number>`coalesce(${chatSessions.costUsd}, 0) + ${delta.costUsd}`,
    })
    .where(eq(chatSessions.id, chatSessionId))
    .run();

  return delta;
}

export interface DbUsageEvent {
  context: {
    source: string;
    projectId?: string | null;
    taskId?: string | null;
    chatSessionId?: string | null;
  };
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
  transport?: string;
  workflowKind?: string;
  usageReporting: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd?: number;
  };
  recordedAt: Date;
}

export interface DbUsageSink {
  record(event: DbUsageEvent): void;
}

export interface CreateDbUsageSinkOptions {
  onRecorded?: (event: DbUsageEvent) => void;
}

export function recordUsageEvent(event: DbUsageEvent): void {
  const { usage, context } = event;
  const db = getDb();

  // Вставка и обновление агрегатов выполняются в одной транзакции: если хотя бы одно
  // обновление не удастся, вся пачка откатится и расхождения не возникнет.
  db.transaction((tx) => {
    tx.insert(usageEvents)
      .values({
        source: context.source,
        projectId: context.projectId ?? null,
        taskId: context.taskId ?? null,
        chatSessionId: context.chatSessionId ?? null,
        runtimeId: event.runtimeId,
        providerId: event.providerId,
        profileId: event.profileId ?? null,
        transport: event.transport ?? null,
        workflowKind: event.workflowKind ?? null,
        usageReporting: event.usageReporting,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        costUsd: usage.costUsd ?? null,
      })
      .run();

    // Для всех агрегатов берётся usage.totalTokens - авторитетный итог провайдера, тот же
    // источник, что и у строки в usage_events. Пересчитывать его как inputTokens +
    // outputTokens нельзя: провайдеры включают в итог дополнительные категории
    // (кэш, рассуждения и другие), которые не видны в этих двух полях.
    const totalTokensDelta = usage.totalTokens;
    const costDelta = usage.costUsd ?? 0;

    if (context.taskId) {
      tx.update(tasks)
        .set({
          tokenInput: sql<number>`coalesce(${tasks.tokenInput}, 0) + ${usage.inputTokens}`,
          tokenOutput: sql<number>`coalesce(${tasks.tokenOutput}, 0) + ${usage.outputTokens}`,
          tokenTotal: sql<number>`coalesce(${tasks.tokenTotal}, 0) + ${totalTokensDelta}`,
          costUsd: sql<number>`coalesce(${tasks.costUsd}, 0) + ${costDelta}`,
        })
        .where(eq(tasks.id, context.taskId))
        .run();
    }
    if (context.projectId) {
      tx.update(projects)
        .set({
          tokenInput: sql<number>`coalesce(${projects.tokenInput}, 0) + ${usage.inputTokens}`,
          tokenOutput: sql<number>`coalesce(${projects.tokenOutput}, 0) + ${usage.outputTokens}`,
          tokenTotal: sql<number>`coalesce(${projects.tokenTotal}, 0) + ${totalTokensDelta}`,
          costUsd: sql<number>`coalesce(${projects.costUsd}, 0) + ${costDelta}`,
        })
        .where(eq(projects.id, context.projectId))
        .run();
    }
    if (context.chatSessionId) {
      tx.update(chatSessions)
        .set({
          tokenInput: sql<number>`coalesce(${chatSessions.tokenInput}, 0) + ${usage.inputTokens}`,
          tokenOutput: sql<number>`coalesce(${chatSessions.tokenOutput}, 0) + ${usage.outputTokens}`,
          tokenTotal: sql<number>`coalesce(${chatSessions.tokenTotal}, 0) + ${totalTokensDelta}`,
          costUsd: sql<number>`coalesce(${chatSessions.costUsd}, 0) + ${costDelta}`,
        })
        .where(eq(chatSessions.id, context.chatSessionId))
        .run();
    }
  });
}

export function createDbUsageSink(options: CreateDbUsageSinkOptions = {}): DbUsageSink {
  return {
    record(event) {
      try {
        recordUsageEvent(event);
        try {
          options.onRecorded?.(event);
        } catch (callbackError) {
          log.warn(
            {
              err: callbackError,
              runtimeId: event.runtimeId,
              source: event.context.source,
            },
            "Usage sink onRecorded callback failed",
          );
        }
      } catch (err) {
        log.error(
          {
            err,
            runtimeId: event.runtimeId,
            source: event.context.source,
          },
          "Failed to record usage event — dropping silently",
        );
      }
    },
  };
}

export interface RuntimeProfileUsageState {
  lastUsage: RuntimeProfileUsage;
  lastUsageAt: string;
}

function toRuntimeProfileUsage(row: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
}): RuntimeProfileUsage {
  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd,
  };
}

// Внутренний экспорт для тематических модулей (runtimeProfiles/runtimeLimits),
// не входит в публичную поверхность @aif/data и не реэкспортируется баррелем.
export function findLatestRuntimeProfileUsageByIds(
  profileIds: string[],
): Map<string, RuntimeProfileUsageState> {
  // Дедупликация и отсев пустых id: список приходит от вызывающего кода и может
  // содержать повторы после сборки из нескольких источников. Без этого шага
  // в inArray попали бы лишние параметры, а на больших списках это упирается
  // в лимит параметров SQLite.
  const uniqueProfileIds = Array.from(new Set(profileIds.filter((value) => value.length > 0)));
  if (uniqueProfileIds.length === 0) {
    return new Map();
  }

  const db = getDb();
  // CTE с group by по профилю: isNotNull отсекает события без профиля (они не
  // привязаны к конкретной конфигурации рантайма и для отчёта бесполезны).
  const latestUsageByProfile = db
    .select({
      profileId: usageEvents.profileId,
      latestCreatedAt: max(usageEvents.createdAt).as("latest_created_at"),
    })
    .from(usageEvents)
    .where(and(isNotNull(usageEvents.profileId), inArray(usageEvents.profileId, uniqueProfileIds)))
    .groupBy(usageEvents.profileId)
    .as("latest_usage_by_profile");

  // Соединение по паре (profileId, createdAt) восстанавливает полную строку
  // события. Совпадение по времени уникально не гарантировано, поэтому
  // результат может содержать несколько кандидатов на профиль — это нормально,
  // конкретную строку выбирает код ниже.
  const rows = db
    .select({
      profileId: usageEvents.profileId,
      inputTokens: usageEvents.inputTokens,
      outputTokens: usageEvents.outputTokens,
      totalTokens: usageEvents.totalTokens,
      costUsd: usageEvents.costUsd,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .innerJoin(
      latestUsageByProfile,
      and(
        eq(usageEvents.profileId, latestUsageByProfile.profileId),
        eq(usageEvents.createdAt, latestUsageByProfile.latestCreatedAt),
      ),
    )
    .all();

  // Первая встреченная строка на профиль побеждает, остальные отбрасываются.
  // При совпадении времени события выбор между кандидатами неразличим снаружи,
  // поэтому дополнительная сортировка не имеет смысла — важно лишь получить
  // по одному значению на профиль, чтобы карта не "мигала" между запросами.
  const usageByProfileId = new Map<string, RuntimeProfileUsageState>();
  for (const row of rows) {
    // profileId в выборке типизирован как nullable, потому что колонка допускает
    // null; для строк, попавших в CTE, он уже не пуст, но приведение типа
    // сознательно не делается — проверка дешевле и защищает от изменения SQL.
    if (!row.profileId) continue;
    if (usageByProfileId.has(row.profileId)) continue;
    usageByProfileId.set(row.profileId, {
      lastUsage: toRuntimeProfileUsage(row),
      lastUsageAt: row.createdAt,
    });
  }

  return usageByProfileId;
}
