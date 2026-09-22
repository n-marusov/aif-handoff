import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getProjectConfig, logger } from "@aif/shared";

const log = logger("evolve-trigger");

const EVOLVE_THRESHOLD = 5;
const EVOLVE_STATE_FILE = "patch-cursor.evolve-trigger.json";

interface EvolveTriggerState {
  lastSuggestedAt: string | null;
  lastPatchCount: number;
}

function parseEvolveState(raw: string): EvolveTriggerState | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const lastSuggestedAt =
      typeof parsed.lastSuggestedAt === "string" ? parsed.lastSuggestedAt : null;
    const lastPatchCount =
      typeof parsed.lastPatchCount === "number" && Number.isFinite(parsed.lastPatchCount)
        ? parsed.lastPatchCount
        : 0;
    return { lastSuggestedAt, lastPatchCount };
  } catch {
    return null;
  }
}

function isLikelyFixPatch(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    normalized.includes("aif-fix") ||
    normalized.includes("/aif-fix") ||
    normalized.includes("fix plan") ||
    normalized.includes("[fix")
  );
}

function countFixPatches(patchesDir: string): number {
  if (!existsSync(patchesDir)) return 0;

  const patchFiles = readdirSync(patchesDir)
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .sort();

  let count = 0;
  for (const fileName of patchFiles) {
    const patchPath = resolve(patchesDir, fileName);
    let content = "";
    try {
      content = readFileSync(patchPath, "utf8");
    } catch {
      continue;
    }
    if (isLikelyFixPatch(content)) {
      count += 1;
    }
  }

  return count;
}

function loadState(statePath: string): EvolveTriggerState {
  if (!existsSync(statePath)) {
    return { lastSuggestedAt: null, lastPatchCount: 0 };
  }

  try {
    const raw = readFileSync(statePath, "utf8");
    return parseEvolveState(raw) ?? { lastSuggestedAt: null, lastPatchCount: 0 };
  } catch {
    return { lastSuggestedAt: null, lastPatchCount: 0 };
  }
}

function saveState(statePath: string, state: EvolveTriggerState): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

export function maybeBuildEvolveRecommendation(projectRoot: string): string | null {
  const cfg = getProjectConfig(projectRoot);
  const patchesDir = resolve(projectRoot, cfg.paths.patches);
  const evolutionsDir = resolve(projectRoot, cfg.paths.evolutions);
  const statePath = resolve(evolutionsDir, EVOLVE_STATE_FILE);

  const fixPatchCount = countFixPatches(patchesDir);
  if (fixPatchCount < EVOLVE_THRESHOLD) {
    return null;
  }

  const state = loadState(statePath);
  if (fixPatchCount <= state.lastPatchCount) {
    return null;
  }

  mkdirSync(evolutionsDir, { recursive: true });
  const nextState: EvolveTriggerState = {
    lastSuggestedAt: new Date().toISOString(),
    lastPatchCount: fixPatchCount,
  };
  try {
    saveState(statePath, nextState);
  } catch (err) {
    log.warn({ err, statePath }, "Failed to persist evolve trigger state");
  }

  return (
    `[note] Detected ${fixPatchCount} fix patch(es) in ${cfg.paths.patches}. ` +
    "Consider running /aif-evolve to refresh project skill-context rules."
  );
}
