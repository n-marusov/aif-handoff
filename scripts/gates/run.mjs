#!/usr/bin/env node
/**
 * Gates runner — executes the deterministic gate suite and writes the
 * `aif-gate-result.json` artifact.
 *
 * Usage:
 *   node scripts/gates/run.mjs [--gate G1-ID] [--group G1] [--out <path>] [--quiet]
 *
 * Exit codes:
 *   0 — all selected gates passed (warn counts as pass for exit purposes)
 *   1 — at least one gate failed
 *   2 — usage error / unknown gate id
 *
 * Environment:
 *   LOG_LEVEL   DEBUG|INFO|WARN|ERROR (default INFO)
 *   GATE_RESULT_PATH   default output location override
 *
 * Output defaults to `scripts/gates/results/aif-gate-result.json` (gitignored).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { log } from "./lib/logger.mjs";
import { repoRoot } from "./lib/fs-tools.mjs";
import { aggregateStatus, createResultSet, recordGate } from "./lib/result.mjs";
import { findGate, GATES, selectGates } from "./registry.mjs";

const DEFAULT_OUT = resolve(repoRoot, "scripts/gates/results/aif-gate-result.json");

function parseArgs(argv) {
  const options = { gate: null, group: null, out: null, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--gate") options.gate = argv[++index];
    else if (arg === "--group") options.group = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--quiet") options.quiet = true;
    else {
      process.stderr.write(`[gate] unknown argument: ${arg}\n`);
      return null;
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    process.stderr.write(
      "Usage: node scripts/gates/run.mjs [--gate G1-ID] [--group G1] [--out <path>] [--quiet]\n",
    );
    process.exit(2);
  }

  const resultSet = createResultSet();
  const selected =
    options.group || options.gate
      ? selectGates({ group: options.group, gate: options.gate })
      : GATES;

  if (selected.length === 0) {
    const id = options.gate ?? options.group;
    process.stderr.write(`[gate] no gate found for selector: ${id}\n`);
    process.exit(2);
  }

  if (!options.quiet) {
    log.info(`running ${selected.length} gates`);
  }

  for (const gate of selected) {
    const startedAt = Date.now();
    let status = "pass";
    let checks = [];
    let summary = null;
    try {
      const outcome = await gate.run({ repoRoot, log });
      checks = outcome.checks ?? [];
      status = outcome.status ?? aggregateStatus(checks);
      summary = outcome.summary ?? null;
    } catch (err) {
      status = "fail";
      checks = [
        {
          scope: gate.id,
          status: "fail",
          message: `validator crashed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ];
      log.error(`gate ${gate.id} crashed: ${err instanceof Error ? err.stack : String(err)}`);
    }
    recordGate(resultSet, {
      id: gate.id,
      name: gate.name,
      group: gate.group,
      status,
      checks,
      summary,
      durationMs: Date.now() - startedAt,
    });
    if (!options.quiet) {
      log.info(`  ${gate.id}: ${status} (${Date.now() - startedAt}ms)`);
    }
  }

  const outPath = resolve(options.out ?? process.env.GATE_RESULT_PATH ?? DEFAULT_OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(resultSet, null, 2)}\n`, "utf8");

  if (!options.quiet) {
    const { total, passed, warned, failed } = resultSet.batch;
    log.info(`batch: ${passed}/${total} passed, ${warned} warned, ${failed} failed`);
    log.info(`report written to ${outPath}`);
  }
  process.exit(resultSet.batch.status === "fail" ? 1 : 0);
}

await main();
