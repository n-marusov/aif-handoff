import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectConfig, logger } from "@aif/shared";

const log = logger("plan-review:git-conventions");

/** Where the resolved git conventions came from. */
export type GitConventionsSource = "rules" | "config" | "default";

/**
 * Deterministic, machine-readable git conventions for a target project.
 * Rules-file markers win over the ai-factory config file, which wins over the
 * Handoff defaults. Values are derived — never free-form text.
 */
export interface TargetProjectGitConventions {
  /** Branch prefix, normalized to end with "/" (e.g. "feature/" or "fix/"). */
  branchPrefix: string;
  /**
   * Conventional-commits subject prefix used for plan-only commits, e.g.
   * "docs(plan):". When null the caller falls back to "docs(plan):".
   */
  commitSubjectPrefix: string | null;
  source: GitConventionsSource;
  /** File that declared the convention, when one did. */
  sourceDetail: string | null;
}

export const DEFAULT_BRANCH_PREFIX = "feature/";
export const DEFAULT_COMMIT_SUBJECT_PREFIX = "docs(plan):";

const RULE_CANDIDATES = [".ai-factory/RULES.md", "RULES.md", "AGENTS.md", "CLAUDE.md"] as const;

const SECTION_HEADING = /^#{2,3}\s+git conventions\s*$/i;
const NEXT_HEADING = /^#{1,6}\s/;
const KEY_VALUE_LINE = /^\s*([a-zA-Z0-9_]+)\s*:\s*(.+?)\s*$/;

const MAX_RULES_BYTES = 64 * 1024;

interface RuleFieldValues {
  branchPrefix: string | null;
  commitSubjectPrefix: string | null;
}

/** Parse the "Git conventions" section of a markdown rule file. */
function readGitConventionsSection(filePath: string): RuleFieldValues | null {
  if (!existsSync(filePath)) return null;
  let content: string;
  try {
    content = readFileSync(filePath, "utf8").slice(0, MAX_RULES_BYTES);
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/);
  let inSection = false;
  const fields: RuleFieldValues = { branchPrefix: null, commitSubjectPrefix: null };

  for (const rawLine of lines) {
    if (!inSection) {
      if (SECTION_HEADING.test(rawLine.trim())) {
        inSection = true;
        continue;
      }
      continue;
    }
    if (NEXT_HEADING.test(rawLine)) {
      break;
    }
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
    const match = KEY_VALUE_LINE.exec(trimmed);
    if (!match) continue;
    const key = match[1].toLowerCase().replace(/-/g, "_");
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (!value) continue;
    if (key === "branch_prefix") {
      fields.branchPrefix = value;
    } else if (key === "commit_subject_prefix" || key === "commit_prefix") {
      fields.commitSubjectPrefix = value;
    }
    if (fields.branchPrefix && fields.commitSubjectPrefix) break;
  }

  return fields.branchPrefix || fields.commitSubjectPrefix ? fields : null;
}

function normalizeBranchPrefix(prefix: string): string {
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

/**
 * Detect an explicitly declared `branch_prefix` inside the `git:` section of
 * an `.ai-factory/config.yaml`. Raw-text check so a default value written by
 * the user still counts as "declared".
 */
function declaredConfigBranchPrefix(projectRoot: string): string | null {
  const configPath = join(projectRoot, ".ai-factory", "config.yaml");
  if (!existsSync(configPath)) return null;
  let content: string;
  try {
    content = readFileSync(configPath, "utf8").slice(0, MAX_RULES_BYTES);
  } catch {
    return null;
  }
  const gitSection = /^git:\s*\n(?:[ \t][^\n]*\n)*/m.exec(content)?.[0];
  if (!gitSection) return null;
  const branchLine = /[ \t]+branch_prefix:\s*["']?([^"'\n#]+)["']?\s*$/.exec(
    gitSection.split("\n").slice(1).join("\n"),
  );
  if (!branchLine) return null;
  const value = branchLine[1].trim();
  return value.length > 0 ? value : null;
}

/**
 * Resolve branch-naming and commit-message conventions from the target
 * project rooted at `projectRoot`. Priority:
 *
 * 1. A `## Git conventions` section in `RULES.md` / `AGENTS.md` / `CLAUDE.md`
 *    that declares `branch_prefix:` and/or `commit_subject_prefix:` keys.
 * 2. The `git.branch_prefix` declared in `.ai-factory/config.yaml`.
 * 3. Handoff defaults (`feature/` branches, `docs(plan):` commit prefix).
 *
 * Logging only derived values and the convention source — never file contents.
 */
export function resolveTargetProjectGitConventions(
  projectRoot: string,
): TargetProjectGitConventions {
  for (const candidate of RULE_CANDIDATES) {
    const fields = readGitConventionsSection(join(projectRoot, candidate));
    if (!fields) continue;
    const result: TargetProjectGitConventions = {
      branchPrefix: normalizeBranchPrefix(fields.branchPrefix ?? DEFAULT_BRANCH_PREFIX),
      commitSubjectPrefix: fields.commitSubjectPrefix,
      source: "rules",
      sourceDetail: candidate,
    };
    log.debug(
      {
        projectRoot,
        source: result.source,
        sourceDetail: result.sourceDetail,
        branchPrefix: result.branchPrefix,
        hasCommitSubjectPrefix: Boolean(result.commitSubjectPrefix),
      },
      "Resolved target-project git conventions from rules",
    );
    return result;
  }

  const configBranchPrefix = declaredConfigBranchPrefix(projectRoot);
  if (configBranchPrefix) {
    const config = getProjectConfig(projectRoot);
    const prefix = config.git.branch_prefix.trim();
    const result: TargetProjectGitConventions = {
      branchPrefix: normalizeBranchPrefix(prefix || DEFAULT_BRANCH_PREFIX),
      commitSubjectPrefix: null,
      source: "config",
      sourceDetail: ".ai-factory/config.yaml",
    };
    log.debug(
      {
        projectRoot,
        source: result.source,
        sourceDetail: result.sourceDetail,
        branchPrefix: result.branchPrefix,
      },
      "Resolved target-project git conventions from project config",
    );
    return result;
  }

  const fallback: TargetProjectGitConventions = {
    branchPrefix: DEFAULT_BRANCH_PREFIX,
    commitSubjectPrefix: null,
    source: "default",
    sourceDetail: null,
  };
  log.debug(
    { projectRoot, source: fallback.source, branchPrefix: fallback.branchPrefix },
    "Resolved target-project git conventions from defaults",
  );
  return fallback;
}

/**
 * Deterministic, non-LLM commit subject for a plan-only commit, honoring an
 * explicit target-project prefix when present.
 */
export function buildPlanCommitSubject(
  title: string,
  conventions: Pick<TargetProjectGitConventions, "commitSubjectPrefix">,
): string {
  const prefix = (conventions.commitSubjectPrefix ?? DEFAULT_COMMIT_SUBJECT_PREFIX).trim();
  const normalizedTitle = title.replace(/\s+/g, " ").trim();
  const separator = prefix.endsWith(":") ? " " : ": ";
  const subject = `${prefix}${separator}${normalizedTitle}`.trim();
  // Conventional-commits subjects are capped near 72 chars.
  return subject.length > 72 ? `${subject.slice(0, 69).replace(/\s+$/, "")}...` : subject;
}
