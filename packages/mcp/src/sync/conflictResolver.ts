import { logger } from "@aif/shared";
import type { ConflictResolution } from "@aif/shared";

const log = logger("mcp:conflict");

export interface ConflictCheckInput {
  sourceTimestamp: string;
  targetTimestamp: string;
  field: string;
}

/**
 * Разрешение конфликтов: побеждает последняя запись.
 * Сравнивает исходную метку времени с целевой (updatedAt задачи Handoff).
 */
export function resolveConflict(input: ConflictCheckInput): ConflictResolution {
  let sourceTime = new Date(input.sourceTimestamp).getTime();
  const targetTime = new Date(input.targetTimestamp).getTime();

  // Защита: если sourceTimestamp действительно невалиден (NaN или нулевая эпоха — например,
  // полуночный заполнитель от LLM, округлившей «now»), берём время сервера.
  // Просто более старый, но валидный источник НЕ должен включать резерв;
  // вместо этого цель должна победить в конфликте обычным порядком.
  const EPOCH_ZERO = 0;
  if (Number.isNaN(sourceTime) || sourceTime === EPOCH_ZERO) {
    const now = Date.now();
    log.warn(
      { ...input, fallbackNow: new Date(now).toISOString() },
      "sourceTimestamp is invalid (NaN or epoch zero), using server time as fallback",
    );
    sourceTime = now;
  }

  if (sourceTime >= targetTime) {
    log.debug({ ...input, winner: "source" }, "Conflict resolved: source wins");
    return {
      applied: true,
      conflict: false,
      winner: "source",
      sourceTimestamp: input.sourceTimestamp,
      targetTimestamp: input.targetTimestamp,
      field: input.field,
    };
  }

  log.warn({ ...input, winner: "target" }, "Conflict detected: target is newer");
  return {
    applied: false,
    conflict: true,
    winner: "target",
    sourceTimestamp: input.sourceTimestamp,
    targetTimestamp: input.targetTimestamp,
    field: input.field,
  };
}
