// Result aggregation for the gates runner.
//
// The `aif-gate-result.json` artifact is the machine-readable confirmation of
// a gate run (gates.md principle 9: «Гейт подтверждается артефактом
// проверки»). Every recorded gate contributes a status (`pass`/`warn`/`fail`)
// plus optional per-scope checks so failures are actionable.

import { randomUUID } from "node:crypto";

export const RESULT_SCHEMA_VERSION = "1.0.0";

/**
 * Create an empty aggregate for one run.
 * @param {{ repo?: string }} [options]
 * @returns {object}
 */
export function createResultSet({ repo = "aif-handoff" } = {}) {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    runId: randomUUID(),
    timestamp: new Date().toISOString(),
    repo,
    batch: { status: "pass", total: 0, passed: 0, warned: 0, failed: 0 },
    gates: [],
  };
}

const LEVEL_BY_STATUS = { pass: 0, warn: 1, fail: 2 };

/**
 * Compare two statuses; returns true when `a` is at least as severe as `b`.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isAtLeast(a, b) {
  return LEVEL_BY_STATUS[a] >= LEVEL_BY_STATUS[b];
}

/**
 * Record a gate into the result set.
 * @param {object} resultSet mutable aggregate from createResultSet
 * @param {object} gate `{ id, name, group, status, checks?, summary?, durationMs? }`
 * @returns {object} the recorded gate entry
 */
export function recordGate(resultSet, gate) {
  const checks = gate.checks ?? [];
  const status = gate.status ?? (checks.some((c) => c.status === "fail") ? "fail" : "pass");

  const entry = {
    id: gate.id,
    name: gate.name,
    group: gate.group,
    status,
    durationMs: gate.durationMs ?? 0,
    checks,
  };
  if (gate.summary !== undefined) entry.summary = gate.summary;

  resultSet.gates.push(entry);
  resultSet.batch.total += 1;
  if (status === "pass") resultSet.batch.passed += 1;
  else if (status === "warn") resultSet.batch.warned += 1;
  else resultSet.batch.failed += 1;

  if (isAtLeast(status, resultSet.batch.status)) resultSet.batch.status = status;
  return entry;
}

/**
 * Aggregate a per-check status list into a single gate status.
 * @param {{ status: string }[]} checks
 * @returns {string}
 */
export function aggregateStatus(checks) {
  let status = "pass";
  for (const check of checks) {
    if (isAtLeast(check.status, status)) status = check.status;
  }
  return status;
}
