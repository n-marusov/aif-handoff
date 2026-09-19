/**
 * Репозиторий индекса Codex (read-model сессий + наложение лимитов).
 */
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  chatSessions,
  codexIndexCursors,
  codexLimitHeads,
  codexLimitHistory,
  codexSessionFiles,
  codexSessions,
  logger as createLogger,
  type RuntimeLimitSnapshot,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { isObjectRecord, parseRuntimeLimitSnapshot } from "./internal.js";

const log = createLogger("data");

export type CodexSessionIndexRow = typeof codexSessions.$inferSelect;
export type CodexSessionFileIndexRow = typeof codexSessionFiles.$inferSelect;
export type CodexLimitHeadIndexRow = typeof codexLimitHeads.$inferSelect;
export type CodexLimitHistoryIndexRow = typeof codexLimitHistory.$inferSelect;
export type CodexIndexCursorRow = typeof codexIndexCursors.$inferSelect;

export interface UpsertCodexSessionInput {
  sessionId: string;
  filePath: string;
  title?: string | null;
  projectRoot?: string | null;
  accountFingerprint?: string | null;
  sourceCreatedAt?: string | null;
  sourceUpdatedAt?: string | null;
  messageCount?: number;
  previewText?: string | null;
  sizeBytes: number;
  mtimeMs: number;
  lastIndexedAt?: string;
}

export interface UpsertCodexSessionFileInput {
  filePath: string;
  sessionId?: string | null;
  sizeBytes: number;
  mtimeMs: number;
  parsedOffset: number;
  pendingTail?: string;
  missing: boolean;
  importVersion: number;
  lastSeenAt?: string;
}

export interface UpsertCodexLimitHeadInput {
  accountFingerprint: string;
  projectRoot?: string | null;
  limitId: string;
  model?: string | null;
  source?: string;
  snapshot: RuntimeLimitSnapshot;
  observedAt: string;
  sessionId?: string | null;
  filePath?: string | null;
}

export interface AppendCodexLimitHistoryInput {
  accountFingerprint: string;
  projectRoot?: string | null;
  limitId: string;
  model?: string | null;
  snapshot: RuntimeLimitSnapshot;
  observedAt: string;
  sessionId?: string | null;
  filePath?: string | null;
  headKey?: string;
}

export interface CodexIndexCursorValue {
  cursorKey: string;
  cursorValue: string | null;
  cursorJson: Record<string, unknown> | null;
  updatedAt: string;
}

export interface ListCodexLimitHeadsForOverlayInput {
  accountFingerprint: string;
  projectRoot: string | null;
  includeGlobalFallback?: boolean;
  limitId?: string | null;
  model?: string | null;
  limit?: number;
}

export interface CodexLimitHeadWithSnapshot {
  headKey: string;
  accountFingerprint: string;
  projectRoot: string | null;
  limitId: string;
  model: string | null;
  source: string;
  snapshot: RuntimeLimitSnapshot | null;
  observedAt: string;
  sessionId: string | null;
  filePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CodexLimitHeadScopeRow {
  headKey: string;
  projectRoot: string | null;
  observedAt: string;
  filePath: string | null;
}

export interface PruneCodexLimitRowsBeforeObservedAtResult {
  deletedScopes: CodexLimitHeadScopeRow[];
  headRowsDeleted: number;
  historyRowsDeleted: number;
}

export interface PruneStaleCodexSessionIndexRowsResult {
  sessionRowsDeleted: number;
  fileRowsDeleted: number;
  linkedRowsRetained: number;
}

function normalizeCodexProjectRoot(projectRoot: string | null | undefined): string | null {
  if (typeof projectRoot !== "string") return null;
  const trimmed = projectRoot.trim();
  if (trimmed.length === 0) return null;
  const normalized = trimmed
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function sanitizeCodexCount(value: number | undefined, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
}

function parseCodexCursorJson(
  raw: string | null | undefined,
  cursorKey: string,
): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObjectRecord(parsed)) {
      log.warn({ cursorKey }, "Malformed codex index cursor JSON payload");
      return null;
    }
    return parsed;
  } catch (error) {
    log.warn(
      {
        cursorKey,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to parse codex index cursor JSON payload",
    );
    return null;
  }
}

function mapCodexLimitHeadWithSnapshot(row: CodexLimitHeadIndexRow): CodexLimitHeadWithSnapshot {
  return {
    headKey: row.headKey,
    accountFingerprint: row.accountFingerprint,
    projectRoot: row.projectRoot,
    limitId: row.limitId,
    model: row.model,
    source: row.source,
    snapshot: parseRuntimeLimitSnapshot(row.snapshotJson, "codex_limit_head", row.headKey),
    observedAt: row.observedAt,
    sessionId: row.sessionId,
    filePath: row.filePath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function buildCodexLimitHeadKey(input: {
  accountFingerprint: string;
  projectRoot?: string | null;
  limitId: string;
  model?: string | null;
}): string {
  return JSON.stringify([
    input.accountFingerprint,
    normalizeCodexProjectRoot(input.projectRoot) ?? "",
    input.limitId,
    input.model ?? "",
  ]);
}

const CODEX_SESSION_UPSERT_BATCH = 50; // 14 колонок × 50 = 700
const CODEX_SESSION_FILE_UPSERT_BATCH = 70; // 11 колонок × 70 = 770
const CODEX_LIMIT_HEAD_UPSERT_BATCH = 70; // 12 колонок × 70 = 840
const CODEX_LIMIT_HISTORY_INSERT_BATCH = 90; // 10 колонок × 90 = 900
const CODEX_FILEPATH_IN_ARRAY_BATCH = 500; // одноколоночный inArray

export function upsertCodexSessions(rows: UpsertCodexSessionInput[]): number {
  // Пустой пакет не является ошибкой: инкрементальный обход каталога регулярно
  // не находит ничего нового, и такой вызов не должен доходить до БД.
  if (rows.length === 0) {
    log.debug({ requestedCount: 0 }, "Skipping codex session upsert (empty batch)");
    return 0;
  }

  // Одно время на весь пакет: строки одного вызова не должны различаться
  // метками создания и обновления, иначе сортировка по updatedAt перемешала бы
  // записи, записанные одной операцией.
  const nowIso = new Date().toISOString();
  const values = rows.map((row) => ({
    sessionId: row.sessionId,
    filePath: row.filePath,
    title: row.title ?? null,
    projectRoot: normalizeCodexProjectRoot(row.projectRoot),
    accountFingerprint: row.accountFingerprint ?? null,
    sourceCreatedAt: row.sourceCreatedAt ?? null,
    sourceUpdatedAt: row.sourceUpdatedAt ?? null,
    messageCount: sanitizeCodexCount(row.messageCount, 0),
    previewText: row.previewText ?? null,
    sizeBytes: sanitizeCodexCount(row.sizeBytes, 0),
    mtimeMs: sanitizeCodexCount(row.mtimeMs, 0),
    lastIndexedAt: row.lastIndexedAt ?? nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));

  // Пакет режется на куски фиксированного размера: у SQLite есть жёсткий лимит
  // на число параметров в одном выражении, а один пакет разворачивается в
  // произведение строк на колонки. Размер подобран так, чтобы оставаться под
  // лимитом с запасом (см. константу CODEX_SESSION_UPSERT_BATCH выше).
  let totalChanges = 0;
  for (let i = 0; i < values.length; i += CODEX_SESSION_UPSERT_BATCH) {
    const chunk = values.slice(i, i + CODEX_SESSION_UPSERT_BATCH);
    const result = getDb()
      .insert(codexSessions)
      .values(chunk)
      .onConflictDoUpdate({
        target: codexSessions.sessionId,
        // excluded.* — это строка, которую мы только что пытались вставить.
        // Ссылка на неё, а не на литеральные значения, позволяет описывать
        // обновление один раз для всего пакета, без сборки отдельного SET
        // на каждую строку. Значения в snake_case, потому что выражение
        // исполняется уже внутри SQL, а не в TypeScript.
        set: {
          filePath: sql`excluded.file_path`,
          title: sql`excluded.title`,
          projectRoot: sql`excluded.project_root`,
          accountFingerprint: sql`excluded.account_fingerprint`,
          sourceCreatedAt: sql`excluded.source_created_at`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
          messageCount: sql`excluded.message_count`,
          previewText: sql`excluded.preview_text`,
          sizeBytes: sql`excluded.size_bytes`,
          mtimeMs: sql`excluded.mtime_ms`,
          lastIndexedAt: sql`excluded.last_indexed_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .run();
    // changes суммируются по всем кускам: вызывающий код использует это число
    // как метрику прогресса индексации, поэтому оно должно отражать весь вызов,
    // а не последний чанк.
    totalChanges += result.changes;
  }

  log.debug(
    { requestedCount: rows.length, changedRows: totalChanges },
    "Upserted codex session index batch",
  );
  return totalChanges;
}

export function upsertCodexSessionFiles(rows: UpsertCodexSessionFileInput[]): number {
  if (rows.length === 0) {
    log.debug({ requestedCount: 0 }, "Skipping codex session-file upsert (empty batch)");
    return 0;
  }

  const nowIso = new Date().toISOString();
  const values = rows.map((row) => ({
    filePath: row.filePath,
    sessionId: row.sessionId ?? null,
    sizeBytes: sanitizeCodexCount(row.sizeBytes, 0),
    mtimeMs: sanitizeCodexCount(row.mtimeMs, 0),
    parsedOffset: sanitizeCodexCount(row.parsedOffset, 0),
    pendingTail: row.pendingTail ?? "",
    missing: row.missing,
    importVersion: sanitizeCodexCount(row.importVersion, 1),
    lastSeenAt: row.lastSeenAt ?? nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));

  let totalChanges = 0;
  for (let i = 0; i < values.length; i += CODEX_SESSION_FILE_UPSERT_BATCH) {
    const chunk = values.slice(i, i + CODEX_SESSION_FILE_UPSERT_BATCH);
    const result = getDb()
      .insert(codexSessionFiles)
      .values(chunk)
      .onConflictDoUpdate({
        target: codexSessionFiles.filePath,
        // importVersion входит в обновляемые поля намеренно: повышение версии
        // разбора должно перезаписывать старую строку, чтобы записи, собранные
        // прежним форматом, со временем переиндексировались.
        set: {
          sessionId: sql`excluded.session_id`,
          sizeBytes: sql`excluded.size_bytes`,
          mtimeMs: sql`excluded.mtime_ms`,
          parsedOffset: sql`excluded.parsed_offset`,
          pendingTail: sql`excluded.pending_tail`,
          missing: sql`excluded.missing`,
          importVersion: sql`excluded.import_version`,
          lastSeenAt: sql`excluded.last_seen_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .run();
    totalChanges += result.changes;
  }

  log.debug(
    { requestedCount: rows.length, changedRows: totalChanges },
    "Upserted codex session-file index batch",
  );
  return totalChanges;
}

export function listCodexSessionFileStates(): CodexSessionFileIndexRow[] {
  const rows = getDb()
    .select()
    .from(codexSessionFiles)
    // Сначала недавно обновлённые: при ручном разборе состояния индекса интересны
    // в первую очередь те файлы, которые менялись последними.
    .orderBy(desc(codexSessionFiles.updatedAt))
    .all();
  log.debug({ returnedCount: rows.length }, "Listed codex session-file index state rows");
  return rows;
}

export function listCodexSessionFileStatesByPaths(filePaths: string[]): CodexSessionFileIndexRow[] {
  if (filePaths.length === 0) {
    return [];
  }

  // IN-запрос тоже нарезается: у SQLite лимит считается по числу параметров
  // (placeholder-ов), а inArray разворачивается ровно в такое число. Здесь
  // режется только одно измерение, поэтому лимит куска выше, чем в upsert-ах,
  // где параметров rows x cols.
  const all: CodexSessionFileIndexRow[] = [];
  for (let i = 0; i < filePaths.length; i += CODEX_FILEPATH_IN_ARRAY_BATCH) {
    const chunk = filePaths.slice(i, i + CODEX_FILEPATH_IN_ARRAY_BATCH);
    const rows = getDb()
      .select()
      .from(codexSessionFiles)
      .where(inArray(codexSessionFiles.filePath, chunk))
      .all();
    all.push(...rows);
  }
  log.debug(
    { requestedCount: filePaths.length, returnedCount: all.length },
    "Listed codex session-file index rows by file path",
  );
  return all;
}

export function deleteCodexSessionsByFilePaths(filePaths: string[]): number {
  if (filePaths.length === 0) {
    return 0;
  }
  let totalChanges = 0;
  for (let i = 0; i < filePaths.length; i += CODEX_FILEPATH_IN_ARRAY_BATCH) {
    const chunk = filePaths.slice(i, i + CODEX_FILEPATH_IN_ARRAY_BATCH);
    const result = getDb()
      .delete(codexSessions)
      .where(inArray(codexSessions.filePath, chunk))
      .run();
    totalChanges += result.changes;
  }
  log.debug(
    { requestedCount: filePaths.length, deletedRows: totalChanges },
    "Deleted codex indexed sessions by file paths",
  );
  return totalChanges;
}

export function deleteCodexSessionFilesByFilePaths(filePaths: string[]): number {
  if (filePaths.length === 0) {
    return 0;
  }
  let totalChanges = 0;
  for (let i = 0; i < filePaths.length; i += CODEX_FILEPATH_IN_ARRAY_BATCH) {
    const chunk = filePaths.slice(i, i + CODEX_FILEPATH_IN_ARRAY_BATCH);
    const result = getDb()
      .delete(codexSessionFiles)
      .where(inArray(codexSessionFiles.filePath, chunk))
      .run();
    totalChanges += result.changes;
  }
  log.debug(
    { requestedCount: filePaths.length, deletedRows: totalChanges },
    "Deleted codex session-file rows by file paths",
  );
  return totalChanges;
}

export function pruneStaleCodexSessionIndexRows(input: {
  mtimeBeforeMs: number;
}): PruneStaleCodexSessionIndexRowsResult {
  if (!Number.isFinite(input.mtimeBeforeMs)) {
    return { sessionRowsDeleted: 0, fileRowsDeleted: 0, linkedRowsRetained: 0 };
  }

  const mtimeBeforeMs = Math.max(0, Math.trunc(input.mtimeBeforeMs));
  const staleLinkedSessionRows = getDb()
    .select({ filePath: codexSessions.filePath, sessionId: codexSessions.sessionId })
    .from(codexSessions)
    .where(
      and(
        lt(codexSessions.mtimeMs, mtimeBeforeMs),
        sql`EXISTS (
          SELECT 1 FROM ${chatSessions}
          WHERE ${chatSessions.runtimeSessionId} = ${codexSessions.sessionId}
             OR ${chatSessions.agentSessionId} = ${codexSessions.sessionId}
        )`,
      ),
    )
    .all();
  const staleLinkedFileRows = getDb()
    .select({ filePath: codexSessionFiles.filePath, sessionId: codexSessionFiles.sessionId })
    .from(codexSessionFiles)
    .where(
      and(
        lt(codexSessionFiles.mtimeMs, mtimeBeforeMs),
        sql`EXISTS (
          SELECT 1 FROM ${chatSessions}
          WHERE ${chatSessions.runtimeSessionId} = ${codexSessionFiles.sessionId}
             OR ${chatSessions.agentSessionId} = ${codexSessionFiles.sessionId}
        )`,
      ),
    )
    .all();

  const linkedPaths = new Set<string>();
  const retainedLinkedSessionIds = new Set<string>();
  for (const row of [...staleLinkedSessionRows, ...staleLinkedFileRows]) {
    linkedPaths.add(row.filePath);
    if (row.sessionId) {
      retainedLinkedSessionIds.add(row.sessionId);
    }
  }

  const staleSessionRows = getDb()
    .select({ filePath: codexSessions.filePath, sessionId: codexSessions.sessionId })
    .from(codexSessions)
    .where(
      and(
        lt(codexSessions.mtimeMs, mtimeBeforeMs),
        sql`NOT EXISTS (
          SELECT 1 FROM ${chatSessions}
          WHERE ${chatSessions.runtimeSessionId} = ${codexSessions.sessionId}
             OR ${chatSessions.agentSessionId} = ${codexSessions.sessionId}
        )`,
      ),
    )
    .all();
  const staleFileRows = getDb()
    .select({ filePath: codexSessionFiles.filePath, sessionId: codexSessionFiles.sessionId })
    .from(codexSessionFiles)
    .where(
      and(
        lt(codexSessionFiles.mtimeMs, mtimeBeforeMs),
        sql`NOT EXISTS (
          SELECT 1 FROM ${chatSessions}
          WHERE ${chatSessions.runtimeSessionId} = ${codexSessionFiles.sessionId}
             OR ${chatSessions.agentSessionId} = ${codexSessionFiles.sessionId}
        )`,
      ),
    )
    .all();

  const candidatePaths = new Set<string>();
  for (const row of [...staleSessionRows, ...staleFileRows]) {
    candidatePaths.add(row.filePath);
  }
  const filePaths = [...candidatePaths].filter((filePath) => !linkedPaths.has(filePath));
  const sessionRowsDeleted = deleteCodexSessionsByFilePaths(filePaths);
  const fileRowsDeleted = deleteCodexSessionFilesByFilePaths(filePaths);
  log.debug(
    {
      mtimeBeforeMs,
      candidateSessionRows: staleSessionRows.length,
      candidateFileRows: staleFileRows.length,
      deletedPathCount: filePaths.length,
      sessionRowsDeleted,
      fileRowsDeleted,
      linkedRowsRetained: retainedLinkedSessionIds.size,
    },
    "Pruned stale codex session index rows",
  );
  return {
    sessionRowsDeleted,
    fileRowsDeleted,
    linkedRowsRetained: retainedLinkedSessionIds.size,
  };
}

export function listCodexLimitHeadScopesByFilePaths(
  filePaths: string[],
): CodexLimitHeadScopeRow[] {
  if (filePaths.length === 0) {
    return [];
  }
  const all: CodexLimitHeadScopeRow[] = [];
  for (let i = 0; i < filePaths.length; i += CODEX_FILEPATH_IN_ARRAY_BATCH) {
    const chunk = filePaths.slice(i, i + CODEX_FILEPATH_IN_ARRAY_BATCH);
    const rows = getDb()
      .select({
        headKey: codexLimitHeads.headKey,
        projectRoot: codexLimitHeads.projectRoot,
        observedAt: codexLimitHeads.observedAt,
        filePath: codexLimitHeads.filePath,
      })
      .from(codexLimitHeads)
      .where(inArray(codexLimitHeads.filePath, chunk))
      .all();
    all.push(...rows);
  }
  log.debug(
    { requestedCount: filePaths.length, returnedCount: all.length },
    "Listed codex limit-head scopes by file paths",
  );
  return all;
}

export function deleteCodexLimitHeadsByFilePaths(filePaths: string[]): number {
  if (filePaths.length === 0) {
    return 0;
  }
  let totalChanges = 0;
  for (let i = 0; i < filePaths.length; i += CODEX_FILEPATH_IN_ARRAY_BATCH) {
    const chunk = filePaths.slice(i, i + CODEX_FILEPATH_IN_ARRAY_BATCH);
    const result = getDb()
      .delete(codexLimitHeads)
      .where(inArray(codexLimitHeads.filePath, chunk))
      .run();
    totalChanges += result.changes;
  }
  log.debug(
    { requestedCount: filePaths.length, deletedRows: totalChanges },
    "Deleted codex limit-head rows by file paths",
  );
  return totalChanges;
}

export function deleteCodexLimitHistoryByFilePaths(filePaths: string[]): number {
  if (filePaths.length === 0) {
    return 0;
  }
  let totalChanges = 0;
  for (let i = 0; i < filePaths.length; i += CODEX_FILEPATH_IN_ARRAY_BATCH) {
    const chunk = filePaths.slice(i, i + CODEX_FILEPATH_IN_ARRAY_BATCH);
    const result = getDb()
      .delete(codexLimitHistory)
      .where(inArray(codexLimitHistory.filePath, chunk))
      .run();
    totalChanges += result.changes;
  }
  log.debug(
    { requestedCount: filePaths.length, deletedRows: totalChanges },
    "Deleted codex limit-history rows by file paths",
  );
  return totalChanges;
}

export function pruneCodexLimitRowsBeforeObservedAt(
  observedBefore: string,
): PruneCodexLimitRowsBeforeObservedAtResult {
  const trimmedObservedBefore = observedBefore.trim();
  if (trimmedObservedBefore.length === 0) {
    return { deletedScopes: [], headRowsDeleted: 0, historyRowsDeleted: 0 };
  }

  const result = getDb().transaction((tx) => {
    const deletedScopes = tx
      .select({
        headKey: codexLimitHeads.headKey,
        projectRoot: codexLimitHeads.projectRoot,
        observedAt: codexLimitHeads.observedAt,
        filePath: codexLimitHeads.filePath,
      })
      .from(codexLimitHeads)
      .where(lt(codexLimitHeads.observedAt, trimmedObservedBefore))
      .all();
    const headRowsDeleted = tx
      .delete(codexLimitHeads)
      .where(lt(codexLimitHeads.observedAt, trimmedObservedBefore))
      .run().changes;
    const historyRowsDeleted = tx
      .delete(codexLimitHistory)
      .where(lt(codexLimitHistory.observedAt, trimmedObservedBefore))
      .run().changes;
    return { deletedScopes, headRowsDeleted, historyRowsDeleted };
  });

  log.debug(
    {
      observedBefore: trimmedObservedBefore,
      deletedScopeCount: result.deletedScopes.length,
      headRowsDeleted: result.headRowsDeleted,
      historyRowsDeleted: result.historyRowsDeleted,
    },
    "Pruned stale codex limit rows by observed time",
  );
  return result;
}

export function upsertCodexLimitHeads(rows: UpsertCodexLimitHeadInput[]): number {
  if (rows.length === 0) {
    log.debug({ requestedCount: 0 }, "Skipping codex limit-head upsert (empty batch)");
    return 0;
  }

  const nowIso = new Date().toISOString();
  const values = rows.map((row) => ({
    headKey: buildCodexLimitHeadKey(row),
    accountFingerprint: row.accountFingerprint,
    projectRoot: normalizeCodexProjectRoot(row.projectRoot),
    limitId: row.limitId,
    model: row.model ?? null,
    source: row.source ?? "codex",
    snapshotJson: JSON.stringify(row.snapshot),
    observedAt: row.observedAt,
    sessionId: row.sessionId ?? null,
    filePath: row.filePath ?? null,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));

  let totalChanges = 0;
  for (let i = 0; i < values.length; i += CODEX_LIMIT_HEAD_UPSERT_BATCH) {
    const chunk = values.slice(i, i + CODEX_LIMIT_HEAD_UPSERT_BATCH);
    const result = getDb()
      .insert(codexLimitHeads)
      .values(chunk)
      .onConflictDoUpdate({
        target: codexLimitHeads.headKey,
        set: {
          accountFingerprint: sql`excluded.account_fingerprint`,
          projectRoot: sql`excluded.project_root`,
          limitId: sql`excluded.limit_id`,
          model: sql`excluded.model`,
          source: sql`excluded.source`,
          snapshotJson: sql`excluded.snapshot_json`,
          observedAt: sql`excluded.observed_at`,
          sessionId: sql`excluded.session_id`,
          filePath: sql`excluded.file_path`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .run();
    totalChanges += result.changes;
  }

  log.debug(
    { requestedCount: rows.length, changedRows: totalChanges },
    "Upserted codex limit-head index batch",
  );
  return totalChanges;
}

export function appendCodexLimitHistory(rows: AppendCodexLimitHistoryInput[]): number {
  if (rows.length === 0) {
    log.debug({ requestedCount: 0 }, "Skipping codex limit-history append (empty batch)");
    return 0;
  }

  const nowIso = new Date().toISOString();
  const values = rows.map((row) => ({
    headKey: row.headKey ?? buildCodexLimitHeadKey(row),
    accountFingerprint: row.accountFingerprint,
    projectRoot: normalizeCodexProjectRoot(row.projectRoot),
    limitId: row.limitId,
    model: row.model ?? null,
    snapshotJson: JSON.stringify(row.snapshot),
    observedAt: row.observedAt,
    sessionId: row.sessionId ?? null,
    filePath: row.filePath ?? null,
    createdAt: nowIso,
  }));

  let totalChanges = 0;
  for (let i = 0; i < values.length; i += CODEX_LIMIT_HISTORY_INSERT_BATCH) {
    const chunk = values.slice(i, i + CODEX_LIMIT_HISTORY_INSERT_BATCH);
    const result = getDb().insert(codexLimitHistory).values(chunk).run();
    totalChanges += result.changes;
  }
  log.debug(
    { requestedCount: rows.length, changedRows: totalChanges },
    "Appended codex limit-history rows",
  );
  return totalChanges;
}

export function pruneCodexLimitHistoryByHead(input: {
  headKey: string;
  keepLatest: number;
}): number {
  const keepLatest = sanitizeCodexCount(input.keepLatest, 0);
  const ids = getDb()
    .select({ id: codexLimitHistory.id })
    .from(codexLimitHistory)
    .where(eq(codexLimitHistory.headKey, input.headKey))
    .orderBy(desc(codexLimitHistory.observedAt), desc(codexLimitHistory.id))
    .all();

  const staleIds = ids.slice(keepLatest).map((row) => row.id);
  if (staleIds.length === 0) {
    log.debug(
      { candidateRows: ids.length, keepLatest, deletedRows: 0 },
      "Pruned codex limit-history rows",
    );
    return 0;
  }

  let deleted = 0;
  for (let i = 0; i < staleIds.length; i += CODEX_FILEPATH_IN_ARRAY_BATCH) {
    const chunk = staleIds.slice(i, i + CODEX_FILEPATH_IN_ARRAY_BATCH);
    const result = getDb()
      .delete(codexLimitHistory)
      .where(inArray(codexLimitHistory.id, chunk))
      .run();
    deleted += result.changes;
  }
  log.debug(
    {
      candidateRows: ids.length,
      keepLatest,
      deletedRows: deleted,
    },
    "Pruned codex limit-history rows",
  );
  return deleted;
}

export function pruneCodexLimitHistoryRetention(maxRowsPerHead: number): number {
  const keepLatest = sanitizeCodexCount(maxRowsPerHead, 0);
  const headRows = getDb()
    .select({ headKey: codexLimitHistory.headKey })
    .from(codexLimitHistory)
    .groupBy(codexLimitHistory.headKey)
    .all();

  let deletedRows = 0;
  for (const row of headRows) {
    deletedRows += pruneCodexLimitHistoryByHead({ headKey: row.headKey, keepLatest });
  }

  log.debug(
    { headCount: headRows.length, keepLatest, deletedRows },
    "Completed codex limit-history retention cleanup",
  );
  return deletedRows;
}

export function upsertCodexIndexCursor(input: {
  cursorKey: string;
  cursorValue?: string | null;
  cursorJson?: Record<string, unknown> | null;
  updatedAt?: string;
}): CodexIndexCursorValue | undefined {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const cursorJson = input.cursorJson == null ? null : JSON.stringify(input.cursorJson);
  getDb()
    .insert(codexIndexCursors)
    .values({
      cursorKey: input.cursorKey,
      cursorValue: input.cursorValue ?? null,
      cursorJson,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: codexIndexCursors.cursorKey,
      set: {
        cursorValue: sql`excluded.cursor_value`,
        cursorJson: sql`excluded.cursor_json`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .run();

  log.debug({ cursorKey: input.cursorKey }, "Upserted codex index cursor");
  return findCodexIndexCursor(input.cursorKey);
}

export function findCodexIndexCursor(cursorKey: string): CodexIndexCursorValue | undefined {
  const row = getDb()
    .select()
    .from(codexIndexCursors)
    .where(eq(codexIndexCursors.cursorKey, cursorKey))
    .get();
  if (!row) return undefined;

  return {
    cursorKey: row.cursorKey,
    cursorValue: row.cursorValue,
    cursorJson: parseCodexCursorJson(row.cursorJson, row.cursorKey),
    updatedAt: row.updatedAt,
  };
}

export function listCodexSessionsByProjectRoot(input: {
  projectRoot: string | null;
  limit?: number;
}): CodexSessionIndexRow[] {
  const limit = sanitizeCodexCount(input.limit, 20);
  const projectRoot = normalizeCodexProjectRoot(input.projectRoot);
  const whereClause =
    projectRoot == null ? isNull(codexSessions.projectRoot) : eq(codexSessions.projectRoot, projectRoot);

  const rows = getDb()
    .select()
    .from(codexSessions)
    .where(whereClause)
    .orderBy(desc(codexSessions.sourceUpdatedAt), desc(codexSessions.mtimeMs), desc(codexSessions.updatedAt))
    .limit(limit)
    .all();

  log.debug(
    { scope: projectRoot == null ? "global" : "project", requestedLimit: limit, returnedCount: rows.length },
    "Listed codex indexed sessions for project scope",
  );
  return rows;
}

export function findCodexSessionFilePathBySessionId(sessionId: string): string | null {
  const sessionRow = getDb()
    .select({ filePath: codexSessions.filePath })
    .from(codexSessions)
    .where(eq(codexSessions.sessionId, sessionId))
    .get();
  if (sessionRow?.filePath) {
    log.debug({ sessionId, source: "codex_sessions", hit: true }, "Resolved codex session file path");
    return sessionRow.filePath;
  }

  const fileRow = getDb()
    .select({ filePath: codexSessionFiles.filePath })
    .from(codexSessionFiles)
    .where(eq(codexSessionFiles.sessionId, sessionId))
    .orderBy(desc(codexSessionFiles.updatedAt))
    .get();

  const filePath = fileRow?.filePath ?? null;
  log.debug(
    { sessionId, source: "codex_session_files", hit: filePath != null },
    "Resolved codex session file path",
  );
  return filePath;
}

export function listCodexLimitHeadsForOverlay(
  input: ListCodexLimitHeadsForOverlayInput,
): CodexLimitHeadWithSnapshot[] {
  const projectRoot = normalizeCodexProjectRoot(input.projectRoot);
  const includeGlobalFallback = input.includeGlobalFallback ?? true;
  const limit = sanitizeCodexCount(input.limit, 20);
  const predicates = [eq(codexLimitHeads.accountFingerprint, input.accountFingerprint)];

  if (input.limitId != null) {
    predicates.push(eq(codexLimitHeads.limitId, input.limitId));
  }
  if (input.model != null) {
    predicates.push(eq(codexLimitHeads.model, input.model));
  }

  if (projectRoot == null) {
    predicates.push(isNull(codexLimitHeads.projectRoot));
  } else if (includeGlobalFallback) {
    predicates.push(
      or(eq(codexLimitHeads.projectRoot, projectRoot), isNull(codexLimitHeads.projectRoot))!,
    );
  } else {
    predicates.push(eq(codexLimitHeads.projectRoot, projectRoot));
  }

  const whereClause = and(...predicates);
  const scopeOrder =
    projectRoot == null
      ? [desc(codexLimitHeads.observedAt), desc(codexLimitHeads.updatedAt)]
      : [
          desc(
            sql<number>`case when ${codexLimitHeads.projectRoot} = ${projectRoot} then 1 else 0 end`,
          ),
          desc(codexLimitHeads.observedAt),
          desc(codexLimitHeads.updatedAt),
        ];

  const rows = getDb()
    .select()
    .from(codexLimitHeads)
    .where(whereClause)
    .orderBy(...scopeOrder)
    .limit(limit)
    .all();

  const mapped = rows.map(mapCodexLimitHeadWithSnapshot);
  log.debug(
    {
      scope: projectRoot == null ? "global" : "project",
      includeGlobalFallback,
      requestedLimit: limit,
      returnedCount: mapped.length,
    },
    "Listed codex limit-head overlay rows",
  );
  return mapped;
}

export function findPreferredCodexLimitHeadForOverlay(
  input: ListCodexLimitHeadsForOverlayInput,
): CodexLimitHeadWithSnapshot | null {
  const rows = listCodexLimitHeadsForOverlay({ ...input, limit: input.limit ?? 20 });
  for (const row of rows) {
    if (row.snapshot) {
      log.debug(
        {
          scope: row.projectRoot == null ? "global" : "project",
          limitId: row.limitId,
        },
        "Resolved preferred codex limit-head overlay row",
      );
      return row;
    }
  }
  log.debug(
    {
      scope: normalizeCodexProjectRoot(input.projectRoot) == null ? "global" : "project",
      limitId: input.limitId ?? null,
      model: input.model ?? null,
    },
    "No codex limit-head overlay row available",
  );
  return null;
}
