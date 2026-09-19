/**
 * Внутренние парсеры/хелперы, разделяемые между тематическими модулями data-слоя.
 * Не реэкспортируются из барреля — это частные помощники пакета.
 */
import {
  normalizeRuntimeLimitSnapshot,
  logger as createLogger,
  type RuntimeLimitSnapshot,
  type RuntimeLimitWindow,
} from "@aif/shared";

const log = createLogger("data");

export {
  parseRuntimeObject,
  isObjectRecord,
  hasOwnProperty,
  readStoredOptionalFiniteNumber,
  readStoredOptionalString,
  parseRuntimeLimitWindow,
  parseRuntimeLimitSnapshot,
  serializeRuntimeLimitSnapshot,
};

function parseRuntimeObject(raw: string | null | undefined): Record<string, unknown> | null {
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
    log.warn(
      { entity, entityId, index, rawLength },
      "Malformed persisted runtime-limit window",
    );
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

function parseRuntimeLimitSnapshot(
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

function serializeRuntimeLimitSnapshot(
  snapshot: RuntimeLimitSnapshot | null | undefined,
): string | null {
  return snapshot == null ? null : JSON.stringify(snapshot);
}
