// Gate registry — the single source of truth for implemented gates.
//
// Each entry maps a catalog gate id (docs/qa/gates.md) to a validator module
// under `./validators/`. The runner iterates this list; `make gate-*` targets
// select entries by `group`.

import * as g1Fmt from "./validators/g1-fmt.mjs";
import * as g1Id from "./validators/g1-id.mjs";
import * as g1Link from "./validators/g1-link.mjs";
import * as g1Trace from "./validators/g1-trace.mjs";
import * as g1Prio from "./validators/g1-prio.mjs";
import * as g1Metric from "./validators/g1-metric.mjs";
import * as g1Gherkin from "./validators/g1-gherkin.mjs";
import * as g1Gloss from "./validators/g1-gloss.mjs";
import * as g1Dup from "./validators/g1-dup.mjs";
import * as g1Tbd from "./validators/g1-tbd.mjs";
import * as g1Machine from "./validators/g1-machine.mjs";
import * as agCycles from "./validators/ag-cycles.mjs";
import * as agLayers from "./validators/ag-layers.mjs";
import * as agBoundaries from "./validators/ag-boundaries.mjs";
import * as agStruct from "./validators/ag-struct.mjs";
import * as fgTestQuality from "./validators/fg-test-quality.mjs";
import * as fgMutationPolicy from "./validators/fg-mutation-policy.mjs";

// Каждый валидатор экспортирует `GATE` (метаданные) и `run`. Нормализуем в
// единую форму записи реестра: { id, name, group, run }.
const toGate = (module) => ({ ...module.GATE, run: module.run });

/** @type {object[]} ordered gate definitions; order is the run order. */
export const GATES = [
  toGate(g1Fmt),
  toGate(g1Id),
  toGate(g1Link),
  toGate(g1Trace),
  toGate(g1Prio),
  toGate(g1Metric),
  toGate(g1Gherkin),
  toGate(g1Gloss),
  toGate(g1Dup),
  toGate(g1Tbd),
  toGate(g1Machine),
  toGate(agCycles),
  toGate(agLayers),
  toGate(agBoundaries),
  toGate(agStruct),
  toGate(fgTestQuality),
  toGate(fgMutationPolicy),
];

/**
 * Look up a gate by id (case-insensitive).
 * @param {string} id gate id, e.g. "G1-ID"
 * @returns {object | undefined}
 */
export function findGate(id) {
  const needle = id.toUpperCase();
  return GATES.find((gate) => gate.id.toUpperCase() === needle);
}

/**
 * Filter gates by group or id.
 * @param {string[]} selectors `--group G1` / `--gate G1-ID`
 * @param {{ group?: string; gate?: string }} filters
 * @returns {object[]}
 */
export function selectGates(filters) {
  return GATES.filter((gate) => {
    if (filters.group && gate.group !== filters.group.toUpperCase()) return false;
    if (filters.gate && gate.id.toUpperCase() !== filters.gate.toUpperCase()) return false;
    return true;
  });
}
