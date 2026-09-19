/**
 * Репозиторий runtime-профилей и прогрева runtime-сессий.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import {
  isRuntimeLimitAwarenessEnabled,
  logger as createLogger,
  normalizeRuntimeLimitSnapshot,
  runtimeProfiles,
  runtimeWarmupSessions,
  type CreateRuntimeProfileInput,
  type RuntimeLimitSnapshot,
  type RuntimeWarmupSessionStatus,
  type UpdateRuntimeProfileInput,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { serializeRuntimeLimitSnapshot } from "./internal.js";
import {
  findLatestRuntimeProfileUsageByIds,
  type RuntimeProfileUsageState,
} from "./usage.js";

const log = createLogger("data");

export type RuntimeProfileRow = typeof runtimeProfiles.$inferSelect;

export type RuntimeWarmupSessionRow = typeof runtimeWarmupSessions.$inferSelect;

export interface RuntimeWarmupScopeInput {
  projectId: string;
  runtimeProfileId?: string | null;
  runtimeId: string;
  providerId: string;
  transport?: string | null;
  model?: string | null;
}

export interface CreateRuntimeWarmupSessionInput extends RuntimeWarmupScopeInput {
  ttlSeconds: number;
  expiresAt: string;
  sourceSessionId?: string | null;
  summary?: string | null;
  createdAt?: string;
}

function toJsonPayload(value: Record<string, unknown> | null | undefined): string {
  return JSON.stringify(value ?? {});
}

function toHeadersJsonPayload(value: Record<string, string> | null | undefined): string {
  return JSON.stringify(value ?? {});
}

const ACTIVE_RUNTIME_WARMUP_STATUSES: RuntimeWarmupSessionStatus[] = ["creating", "ready"];

function runtimeWarmupScopeConditions(input: RuntimeWarmupScopeInput) {
  return [
    eq(runtimeWarmupSessions.projectId, input.projectId),
    input.runtimeProfileId == null
      ? isNull(runtimeWarmupSessions.runtimeProfileId)
      : eq(runtimeWarmupSessions.runtimeProfileId, input.runtimeProfileId),
    eq(runtimeWarmupSessions.runtimeId, input.runtimeId),
    eq(runtimeWarmupSessions.providerId, input.providerId),
    input.transport == null
      ? isNull(runtimeWarmupSessions.transport)
      : eq(runtimeWarmupSessions.transport, input.transport),
    input.model == null
      ? isNull(runtimeWarmupSessions.model)
      : eq(runtimeWarmupSessions.model, input.model),
  ];
}

export function findRuntimeWarmupSessionById(
  id: string,
): RuntimeWarmupSessionRow | undefined {
  return getDb()
    .select()
    .from(runtimeWarmupSessions)
    .where(eq(runtimeWarmupSessions.id, id))
    .get();
}

export function createRuntimeWarmupSession(
  input: CreateRuntimeWarmupSessionInput,
): RuntimeWarmupSessionRow | undefined {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = input.createdAt ?? new Date().toISOString();

  db.insert(runtimeWarmupSessions)
    .values({
      id,
      projectId: input.projectId,
      runtimeProfileId: input.runtimeProfileId ?? null,
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      transport: input.transport ?? null,
      model: input.model ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      status: "creating",
      ttlSeconds: input.ttlSeconds,
      expiresAt: input.expiresAt,
      summary: input.summary ?? null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return findRuntimeWarmupSessionById(id);
}

export function markRuntimeWarmupSessionReady(
  id: string,
  input: {
    sourceSessionId: string;
    summary?: string | null;
    expiresAt?: string;
    ttlSeconds?: number;
    updatedAt?: string;
  },
): RuntimeWarmupSessionRow | undefined {
  const now = input.updatedAt ?? new Date().toISOString();
  getDb().transaction((tx) => {
    const existing = tx
      .select()
      .from(runtimeWarmupSessions)
      .where(eq(runtimeWarmupSessions.id, id))
      .get();
    if (!existing) return;

    const readyUpdate = tx
      .update(runtimeWarmupSessions)
      .set({
        status: "ready",
        sourceSessionId: input.sourceSessionId,
        summary: input.summary ?? null,
        errorMessage: null,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
        updatedAt: now,
      })
      .where(and(eq(runtimeWarmupSessions.id, id), eq(runtimeWarmupSessions.status, "creating")))
      .run();
    if (readyUpdate.changes === 0) return;

    // Готовая сессия может быть только одна на область (профиль, проект, ветка):
    // смысл прогрева — держать разогретым один рабочий контекст. Поэтому при
    // успехе все остальные активные сессии той же области закрываются одним
    // UPDATE. Чужие области не трогаются: они прогреваются параллельно.
    tx.update(runtimeWarmupSessions)
      .set({ status: "cleared", updatedAt: now })
      .where(
        and(
          // Область берётся из уже прочитанной строки, а не из аргументов:
          // источник истины — то, что фактически лежит в БД.
          ...runtimeWarmupScopeConditions(existing),
          inArray(runtimeWarmupSessions.status, ACTIVE_RUNTIME_WARMUP_STATUSES),
          // Себя исключаем: только что установленный статус ready не должен
          // быть затёрт этим же вызовом.
          ne(runtimeWarmupSessions.id, id),
        ),
      )
      .run();
  });
  // Строка перечитывается после транзакции, а не собирается в памяти: так
  // вызывающий код получает ровно то состояние, которое зафиксировано в БД,
  // включая поля, пересчитанные триггерами или значениями по умолчанию.
  return findRuntimeWarmupSessionById(id);
}

export function markRuntimeWarmupSessionFailed(
  id: string,
  errorMessage: string,
  updatedAt = new Date().toISOString(),
): RuntimeWarmupSessionRow | undefined {
  getDb()
    .update(runtimeWarmupSessions)
    .set({
      status: "failed",
      errorMessage,
      updatedAt,
    })
    .where(eq(runtimeWarmupSessions.id, id))
    .run();
  return findRuntimeWarmupSessionById(id);
}

export function clearActiveRuntimeWarmupSessions(
  input: RuntimeWarmupScopeInput,
  updatedAt = new Date().toISOString(),
): number {
  const result = getDb()
    .update(runtimeWarmupSessions)
    .set({ status: "cleared", updatedAt })
    .where(
      and(
        ...runtimeWarmupScopeConditions(input),
        inArray(runtimeWarmupSessions.status, ACTIVE_RUNTIME_WARMUP_STATUSES),
      ),
    )
    .run();
  return result.changes;
}

export function expireStaleRuntimeWarmupSessions(
  nowIso = new Date().toISOString(),
): number {
  const result = getDb()
    .update(runtimeWarmupSessions)
    .set({ status: "expired", updatedAt: nowIso })
    .where(
      and(
        inArray(runtimeWarmupSessions.status, ACTIVE_RUNTIME_WARMUP_STATUSES),
        lte(runtimeWarmupSessions.expiresAt, nowIso),
      ),
    )
    .run();
  return result.changes;
}

export function findActiveReadyRuntimeWarmupSession(
  input: RuntimeWarmupScopeInput,
  nowIso = new Date().toISOString(),
): RuntimeWarmupSessionRow | undefined {
  return getDb()
    .select()
    .from(runtimeWarmupSessions)
    .where(
      and(
        ...runtimeWarmupScopeConditions(input),
        eq(runtimeWarmupSessions.status, "ready"),
        isNotNull(runtimeWarmupSessions.sourceSessionId),
        gt(runtimeWarmupSessions.expiresAt, nowIso),
      ),
    )
    .orderBy(desc(runtimeWarmupSessions.updatedAt))
    .limit(1)
    .get();
}

export function findRuntimeProfileById(id: string): RuntimeProfileRow | undefined {
  return getDb().select().from(runtimeProfiles).where(eq(runtimeProfiles.id, id)).get();
}

export function getRuntimeProfileWithUsageById(
  id: string,
): { row: RuntimeProfileRow; usageState: RuntimeProfileUsageState | null } | undefined {
  const row = findRuntimeProfileById(id);
  if (!row) return undefined;
  const usageState = findLatestRuntimeProfileUsageByIds([id]).get(id) ?? null;
  return { row, usageState };
}

export function listRuntimeProfiles(input: {
  projectId?: string;
  includeGlobal?: boolean;
  enabledOnly?: boolean;
} = {}): RuntimeProfileRow[] {
  const conditions = [];
  if (input.projectId) {
    if (input.includeGlobal) {
      conditions.push(or(eq(runtimeProfiles.projectId, input.projectId), isNull(runtimeProfiles.projectId)));
    } else {
      conditions.push(eq(runtimeProfiles.projectId, input.projectId));
    }
  }
  if (input.enabledOnly) {
    conditions.push(eq(runtimeProfiles.enabled, true));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  log.debug(
    {
      projectId: input.projectId ?? null,
      includeGlobal: input.includeGlobal ?? false,
      enabledOnly: input.enabledOnly ?? false,
    },
    "Listing runtime profiles",
  );
  return getDb()
    .select()
    .from(runtimeProfiles)
    .where(where)
    .orderBy(asc(runtimeProfiles.createdAt))
    .all();
}

export function listRuntimeProfilesWithUsage(input: {
  projectId?: string;
  includeGlobal?: boolean;
  enabledOnly?: boolean;
} = {}): Array<{ row: RuntimeProfileRow; usageState: RuntimeProfileUsageState | null }> {
  const rows = listRuntimeProfiles(input);
  const usageByProfileId = findLatestRuntimeProfileUsageByIds(rows.map((row) => row.id));
  return rows.map((row) => ({ row, usageState: usageByProfileId.get(row.id) ?? null }));
}

export function createRuntimeProfile(input: CreateRuntimeProfileInput): RuntimeProfileRow | undefined {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  log.debug(
    {
      runtimeProfileId: id,
      projectId: input.projectId ?? null,
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      enabled: input.enabled ?? true,
    },
    "Creating runtime profile",
  );
  getDb()
    .insert(runtimeProfiles)
    .values({
      id,
      projectId: input.projectId ?? null,
      name: input.name,
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      transport: input.transport ?? null,
      baseUrl: input.baseUrl ?? null,
      apiKeyEnvVar: input.apiKeyEnvVar ?? null,
      defaultModel: input.defaultModel ?? null,
      headersJson: toHeadersJsonPayload(input.headers),
      optionsJson: toJsonPayload(input.options),
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return findRuntimeProfileById(id);
}

export function updateRuntimeProfile(
  id: string,
  input: UpdateRuntimeProfileInput,
): RuntimeProfileRow | undefined {
  const patch: Partial<RuntimeProfileRow> = {
    updatedAt: new Date().toISOString(),
  };

  if (input.projectId !== undefined) patch.projectId = input.projectId;
  if (input.name !== undefined) patch.name = input.name;
  if (input.runtimeId !== undefined) patch.runtimeId = input.runtimeId;
  if (input.providerId !== undefined) patch.providerId = input.providerId;
  if (input.transport !== undefined) patch.transport = input.transport;
  if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl;
  if (input.apiKeyEnvVar !== undefined) patch.apiKeyEnvVar = input.apiKeyEnvVar;
  if (input.defaultModel !== undefined) patch.defaultModel = input.defaultModel;
  if (input.headers !== undefined) patch.headersJson = toHeadersJsonPayload(input.headers);
  if (input.options !== undefined) patch.optionsJson = toJsonPayload(input.options);
  if (input.enabled !== undefined) patch.enabled = input.enabled;

  log.debug(
    {
      runtimeProfileId: id,
      runtimeId: input.runtimeId ?? null,
      providerId: input.providerId ?? null,
      enabled: input.enabled ?? null,
    },
    "Updating runtime profile",
  );
  getDb().update(runtimeProfiles).set(patch).where(eq(runtimeProfiles.id, id)).run();
  return findRuntimeProfileById(id);
}

export function persistRuntimeProfileLimitSnapshot(
  runtimeProfileId: string,
  snapshot: RuntimeLimitSnapshot,
  persistedAt = new Date().toISOString(),
): RuntimeProfileRow | undefined {
  if (!isRuntimeLimitAwarenessEnabled()) {
    return findRuntimeProfileById(runtimeProfileId);
  }

  const normalizedSnapshot = normalizeRuntimeLimitSnapshot(snapshot);
  log.info(
    {
      runtimeProfileId,
      status: normalizedSnapshot.status,
      source: normalizedSnapshot.source,
      precision: normalizedSnapshot.precision,
      resetAt: normalizedSnapshot.resetAt ?? null,
      persistedAt,
    },
    "Persisting runtime profile limit snapshot",
  );
  getDb()
    .update(runtimeProfiles)
    .set({
      runtimeLimitSnapshotJson: serializeRuntimeLimitSnapshot(normalizedSnapshot),
      runtimeLimitUpdatedAt: persistedAt,
    })
    .where(eq(runtimeProfiles.id, runtimeProfileId))
    .run();
  return findRuntimeProfileById(runtimeProfileId);
}

export function clearRuntimeProfileLimitSnapshot(
  runtimeProfileId: string,
  persistedAt = new Date().toISOString(),
): RuntimeProfileRow | undefined {
  if (!isRuntimeLimitAwarenessEnabled()) {
    return findRuntimeProfileById(runtimeProfileId);
  }

  log.debug({ runtimeProfileId, persistedAt }, "Clearing runtime profile limit snapshot");
  getDb()
    .update(runtimeProfiles)
    .set({
      runtimeLimitSnapshotJson: null,
      runtimeLimitUpdatedAt: persistedAt,
    })
    .where(eq(runtimeProfiles.id, runtimeProfileId))
    .run();
  return findRuntimeProfileById(runtimeProfileId);
}

export function deleteRuntimeProfile(id: string): void {
  log.debug({ runtimeProfileId: id }, "Deleting runtime profile");
  getDb().delete(runtimeProfiles).where(eq(runtimeProfiles.id, id)).run();
}

export function isRuntimeProfileVisibleToProject(input: {
  projectId: string;
  runtimeProfileId: string | null;
}): boolean {
  if (input.runtimeProfileId == null) {
    log.debug({ projectId: input.projectId, runtimeProfileId: null }, "Null runtime profile is visible");
    return true;
  }

  const profile = findRuntimeProfileById(input.runtimeProfileId);
  const isVisible =
    profile != null && (profile.projectId == null || profile.projectId === input.projectId);

  log.debug(
    {
      projectId: input.projectId,
      runtimeProfileId: input.runtimeProfileId,
      ownerProjectId: profile?.projectId ?? null,
      isVisible,
    },
    "Checked runtime profile visibility for project",
  );

  return isVisible;
}

export function isRuntimeProfileEligibleForAppDefaults(runtimeProfileId: string | null): boolean {
  if (runtimeProfileId == null) {
    log.debug({ runtimeProfileId: null }, "Null runtime profile is eligible for app defaults");
    return true;
  }

  const profile = findRuntimeProfileById(runtimeProfileId);
  const isEligible = profile != null && profile.projectId == null && profile.enabled;

  log.debug(
    {
      runtimeProfileId,
      ownerProjectId: profile?.projectId ?? null,
      enabled: profile?.enabled ?? null,
      isEligible,
    },
    "Checked runtime profile eligibility for app defaults",
  );

  return isEligible;
}
