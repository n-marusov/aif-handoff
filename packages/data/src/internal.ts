/**
 * Внутренние парсеры/хелперы, разделяемые между тематическими модулями data-слоя.
 * Не реэкспортируются из барреля — это частные помощники пакета.
 *
 * Парсеры разбора JSON-колонок снимков лимитов (parseRuntimeObject,
 * parseRuntimeLimitSnapshot) переехали в @aif/shared/src/presenters.ts — они
 * нужны и презентационным мапперам на границе выдачи. Здесь они только
 * реэкспортируются, чтобы data-модули продолжали обращаться к ним как раньше
 * (без правки мест вызова).
 */
import {
  parseRuntimeLimitSnapshot,
  parseRuntimeObject,
  type RuntimeLimitSnapshot,
} from "@aif/shared";

export { parseRuntimeObject, parseRuntimeLimitSnapshot };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export { isObjectRecord };

export function serializeRuntimeLimitSnapshot(
  snapshot: RuntimeLimitSnapshot | null | undefined,
): string | null {
  return snapshot == null ? null : JSON.stringify(snapshot);
}