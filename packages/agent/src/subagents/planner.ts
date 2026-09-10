import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  findProjectById,
  findGitHubIssueByTaskId,
  findTaskById,
  listTaskComments,
  persistTaskPlanForTask,
  setTaskFields,
} from "@aif/data";
import { createRuntimeWorkflowSpec } from "@aif/runtime";
import { logger, formatAttachmentsForPrompt, getEnv, getProjectConfig } from "@aif/shared";
import { executeSubagentQuery } from "../subagentQuery.js";
import { StageManualBlockError } from "../stageErrorHandler.js";
import {
  assertCurrentBranch,
  ensureFeatureBranch,
  ensureTaskWorktree,
  projectSupportsTaskWorktrees,
  restorePersistedBranch,
} from "../gitBranch.js";
import { withProjectGitLock } from "../gitOperationLock.js";
import { resolveIssueBranchName, type IssueProvider } from "../gitConventions.js";
import { logActivity } from "../hooks.js";

const log = logger("planner");
const AGENT_NAME = "plan-coordinator";
const FIX_SKILL_NAME = "aif-fix";

/** How the planner provisions the execution root for a task. */
export type WorktreeProvisionMode = "worktree" | "in_tree" | "serial_fix";

export interface ShouldProvisionWorktreeInput {
  hasVcsIssue: boolean;
  flagEnabled: boolean;
  parallelEnabled: boolean;
  supportsTaskWorktrees: boolean;
}

/**
 * Decide whether a task is provisioned into an isolated task worktree.
 *
 * The rollout flag (`AIF_TASK_WORKTREES_ENABLED`) gates BOTH issue-linked and
 * parallel projects: while it is off, even VCS-issue tasks stay in-tree on a
 * shared checkout with a deterministic issue branch, so the flag is a real
 * kill-switch. Issue tasks do not additionally require `parallelEnabled` —
 * their isolation is required for correctness (PR/MR publication), not only
 * for throughput.
 */
export function shouldProvisionWorktree(input: ShouldProvisionWorktreeInput): boolean {
  if (!input.flagEnabled || !input.supportsTaskWorktrees) return false;
  if (input.hasVcsIssue) return true;
  return input.parallelEnabled;
}

function extractPlanPathFromResult(resultText: string): string | null {
  const patterns = [/plan written to\s+([^\n]+)/i, /saved to\s+([^\n]+)/i];

  for (const pattern of patterns) {
    const match = resultText.match(pattern);
    if (!match) continue;
    const normalized = normalizeExtractedPlanPath(match[1]);
    if (normalized) return normalized;
  }

  return null;
}

function normalizeExtractedPlanPath(pathText: string): string | null {
  const normalized = pathText
    .trim()
    .replace(/^[@`"'(\[]+/, "")
    .replace(/[)\].,`"']+$/, "")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizePlanPath(path: string | null | undefined, projectRoot: string): string {
  const defaultPlan = getProjectConfig(projectRoot).paths.plan;
  if (!path) return defaultPlan;
  return path.trim().replace(/^@+/, "") || defaultPlan;
}

function readPlanFromDisk(
  projectRoot: string,
  resultText: string,
  isFix: boolean,
  customPlanPath?: string,
  minModifiedMs?: number,
): string | null {
  const cfg = getProjectConfig(projectRoot);
  const normalizedPlanPath = normalizePlanPath(customPlanPath, projectRoot);
  const canonicalPlanPath = resolve(projectRoot, isFix ? cfg.paths.fix_plan : normalizedPlanPath);
  const candidatePaths: string[] = [canonicalPlanPath];
  const pathFromResult = extractPlanPathFromResult(resultText);
  if (pathFromResult) {
    const resolved = pathFromResult.startsWith("/")
      ? pathFromResult
      : resolve(projectRoot, pathFromResult);
    candidatePaths.push(resolved);
  }

  // Skill runs may write fallback paths even when @path is requested.
  if (isFix) {
    candidatePaths.push(resolve(projectRoot, "FIX_PLAN.md"));
  } else {
    candidatePaths.push(resolve(projectRoot, cfg.paths.plan));
    candidatePaths.push(resolve(projectRoot, "PLAN.md"));
  }

  const seen = new Set<string>();
  for (const candidatePath of candidatePaths) {
    if (seen.has(candidatePath)) continue;
    seen.add(candidatePath);
    if (!existsSync(candidatePath)) continue;
    if (minModifiedMs != null && statSync(candidatePath).mtimeMs < minModifiedMs) {
      log.warn(
        { planPath: candidatePath, minModifiedMs },
        "[FIX] Ignoring stale plan file that was not modified during this planning run",
      );
      continue;
    }
    const content = readFileSync(candidatePath, "utf8").trim();
    if (content.length > 0) return content;
  }

  return null;
}

function normalizePlannerResult(resultText: string): string {
  const cleaned = resultText
    .replace(/^plan written to .*$/im, "")
    .replace(/^saved to .*$/im, "")
    .trim();

  return cleaned.length > 0 ? cleaned : resultText.trim();
}

function clearPlanFileBeforeFreshPlanning(input: {
  taskId: string;
  executionRoot: string;
  planPath: string;
  hasPersistedPlan: boolean;
  hasPlanReviewFeedback: boolean;
  isFix: boolean;
}): void {
  if (input.isFix || input.hasPlanReviewFeedback || input.hasPersistedPlan) return;

  const planFileOnDisk = resolve(input.executionRoot, input.planPath);
  if (!existsSync(planFileOnDisk)) return;

  try {
    rmSync(planFileOnDisk, { force: true });
    log.warn(
      { taskId: input.taskId, planPath: planFileOnDisk },
      "[FIX] Deleted pre-existing plan file before fresh planning; planner will generate a new task-specific plan",
    );
  } catch (error) {
    log.error(
      {
        taskId: input.taskId,
        planPath: planFileOnDisk,
        error: error instanceof Error ? error.message : String(error),
      },
      "[FIX] Failed to delete pre-existing plan file before fresh planning",
    );
    throw new StageManualBlockError(
      `Unable to prepare a fresh plan file for task ${input.taskId}. Inspect ${planFileOnDisk} and retry.`,
    );
  }
}

function formatCommentsForPrompt(
  comments: Array<{
    author: "human" | "agent";
    message: string;
    attachments: string | null;
    createdAt: string;
  }>,
): string {
  if (comments.length === 0) return "No user comments were provided.";

  const latest = comments.slice(-1);
  return latest
    .map((comment, index) => {
      const formatted = formatAttachmentsForPrompt(comment.attachments);
      const attachmentLines =
        formatted === "No task attachments were provided." ? "    none" : formatted;

      return [
        `${index + 1}. [${comment.createdAt}] ${comment.author}`,
        `   message: ${comment.message}`,
        "   attachments:",
        attachmentLines,
      ].join("\n");
    })
    .join("\n\n");
}

function buildFixCommandText(taskContext: string): string {
  return `/aif-fix --plan-first ${JSON.stringify(taskContext)}`;
}

export async function runPlanner(taskId: string, projectRoot: string): Promise<void> {
  const task = findTaskById(taskId);
  const comments = listTaskComments(taskId).sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );

  if (!task) {
    log.error({ taskId }, "Task not found for planning");
    throw new Error(`Task ${taskId} not found`);
  }

  const useSubagents = task.useSubagents;
  const executionName = task.isFix ? FIX_SKILL_NAME : useSubagents ? AGENT_NAME : "aif-plan";
  log.info({ taskId, title: task.title, isFix: task.isFix }, "Starting planning flow");
  const project = findProjectById(task.projectId);
  const plannerBudget = project?.plannerMaxBudgetUsd ?? null;
  let executionRoot = task.worktreePath ?? projectRoot;

  const taskAttachmentsForPrompt = formatAttachmentsForPrompt(task.attachments);
  const commentsForPrompt = formatCommentsForPrompt(comments);

  // VCS plan-review feedback (GitHub review body / GitLab MR notes) is a
  // first-class replanning input: when the published plan PR/MR was rejected,
  // the planner must revise the same plan addressing the reviewer's comments.
  const planReviewFeedback = task.planReviewFeedback?.trim();
  if (planReviewFeedback) {
    log.debug(
      { taskId, feedbackLength: planReviewFeedback.length },
      "Attached VCS plan review feedback to planner prompt",
    );
  }
  const planReviewFeedbackSection = planReviewFeedback
    ? `\nVCS plan review feedback (address every point in the revised plan):\n${planReviewFeedback}`
    : "";

  const plannerMode = task.plannerMode || "full";
  const planPath = normalizePlanPath(task.planPath, executionRoot);
  const planDocs = task.planDocs ? "true" : "false";
  const planTests = task.planTests ? "true" : "false";

  // Deterministic branch handling. Two contracts, applied in order:
  //
  //  1. RESTORE for ANY bound non-fix task — runs regardless of plannerMode
  //     (full or fast). `task.branchName` is the source-of-truth: once a
  //     prior run persisted it, every subsequent stage MUST land on it or
  //     fail loud. A replan triggered with mode=fast (manual replanning,
  //     comment-driven re-run) used to skip the restore entirely and let
  //     the planner write to whatever HEAD happened to be.
  //
  //  2. CREATE only in full mode for unbound non-fix tasks. Fast mode stays
  //     on the current branch by design (see aif-handoff#83) — first-time
  //     branch provisioning is a full-mode-only concern.
  //
  // Failures throw BranchIsolationError (dirty worktree, missing base branch,
  // checkout failure, branch_missing, etc). The coordinator classifies it as
  // blocked_external with retryAfter=null so an operator can inspect the work
  // tree instead of the stage silently reverting into a bad state.
  let preparedBranch: string | null = task.branchName ?? null;
  if (!task.isFix && task.worktreePath) {
    if (task.branchName) {
      restorePersistedBranch({
        projectRoot: executionRoot,
        taskId,
        persistedBranchName: task.branchName,
      });
      preparedBranch = task.branchName;
      logActivity(taskId, "Agent", `Restored task worktree branch: ${task.branchName}`);
    }
  } else if (!task.isFix && task.branchName) {
    restorePersistedBranch({
      projectRoot: executionRoot,
      taskId,
      persistedBranchName: task.branchName,
    });
    preparedBranch = task.branchName;
    logActivity(taskId, "Agent", `Restored feature branch: ${task.branchName}`);
  } else if (!task.isFix && plannerMode === "full") {
    const env = getEnv();
    const provider: IssueProvider = env.GIT_PROVIDER === "gitlab" ? "gitlab" : "github";
    // Only the GitHub issue link is wired into the planner today; GitLab tasks
    // follow the same code path once their issue lookup lands.
    const githubIssue =
      provider === "github" && env.AIF_GITHUB_ISSUE_PR_ENABLED
        ? findGitHubIssueByTaskId(taskId)
        : null;
    const issueNumber = githubIssue?.issueNumber ?? null;
    const hasVcsIssue = issueNumber !== null;
    const useWorktree = shouldProvisionWorktree({
      hasVcsIssue,
      flagEnabled: env.AIF_TASK_WORKTREES_ENABLED,
      parallelEnabled: Boolean(project?.parallelEnabled),
      supportsTaskWorktrees: projectSupportsTaskWorktrees(projectRoot),
    });
    const issueBranchName = hasVcsIssue
      ? resolveIssueBranchName({ projectRoot, provider, issueNumber }).branchName
      : null;
    const mode: WorktreeProvisionMode = useWorktree ? "worktree" : "in_tree";
    log.info(
      {
        taskId,
        flagEnabled: env.AIF_TASK_WORKTREES_ENABLED,
        provider,
        branchName: issueBranchName,
        mode,
      },
      "Planner provisioning decision",
    );

    // Repo-mutating git provisioning is serialized per project root so
    // parallel scheduling cannot race git's own ref locks.
    await withProjectGitLock({ projectRoot, operation: `planner-${mode}` }, () => {
      if (useWorktree) {
        const worktreeResult = ensureTaskWorktree({
          projectRoot,
          taskId,
          title: task.title,
          projectId: task.projectId,
          explicitBranchName: issueBranchName,
        });
        if (
          worktreeResult.action !== "skipped" &&
          worktreeResult.branchName &&
          worktreeResult.worktreePath
        ) {
          preparedBranch = worktreeResult.branchName;
          executionRoot = worktreeResult.worktreePath;
          setTaskFields(taskId, {
            branchName: worktreeResult.branchName,
            worktreePath: worktreeResult.worktreePath,
            updatedAt: new Date().toISOString(),
          });
          logActivity(
            taskId,
            "Agent",
            `Task worktree ${worktreeResult.action}: ${worktreeResult.worktreePath} (${worktreeResult.branchName})`,
          );
        } else if (worktreeResult.reason) {
          throw new StageManualBlockError(
            `This task requires an isolated Git worktree: ${worktreeResult.reason}`,
          );
        }
        return;
      }

      const branchResult = ensureFeatureBranch({
        projectRoot: executionRoot,
        taskId,
        title: task.title,
        explicitBranchName: issueBranchName,
      });
      if (branchResult.action !== "skipped" && branchResult.branchName) {
        preparedBranch = branchResult.branchName;
        setTaskFields(taskId, {
          branchName: branchResult.branchName,
          updatedAt: new Date().toISOString(),
        });
        logActivity(
          taskId,
          "Agent",
          `Feature branch ${branchResult.action}: ${branchResult.branchName}`,
        );
      } else if (branchResult.reason) {
        if (hasVcsIssue) {
          throw new StageManualBlockError(
            `Issue #${issueNumber} requires a feature branch: ${branchResult.reason}`,
          );
        }
        log.debug({ taskId, reason: branchResult.reason }, "Branch creation skipped");
      }
    });
  }

  // A fresh Handoff task must not treat an existing plan artifact in the
  // prepared branch/worktree as context. VCS issue tasks use deterministic
  // branch names and plan paths (`github-issue-N.md` / `gitlab-issue-N.md`),
  // so deleting and recreating a task for the same external issue can check out
  // a branch that still contains an old plan file. If we leave that file in
  // place, `/aif-plan` and the post-run disk read can pick it up and downstream
  // implementer logic may no-op against the old checklist. Replanning and tasks
  // that already have a persisted DB plan intentionally keep their artifact.
  const shouldRequireFreshPlanFile = !task.isFix && !planReviewFeedback && !task.plan?.trim();

  clearPlanFileBeforeFreshPlanning({
    taskId,
    executionRoot,
    planPath,
    hasPersistedPlan: Boolean(task.plan?.trim()),
    hasPlanReviewFeedback: Boolean(planReviewFeedback),
    isFix: task.isFix,
  });

  const taskContext = `Title: ${task.title}
Description: ${task.description}
Task attachments:
${taskAttachmentsForPrompt}
User comments and replanning feedback:
${commentsForPrompt}${planReviewFeedbackSection}`;
  let prompt: string;
  let workflowSpec: ReturnType<typeof createRuntimeWorkflowSpec>;
  // HANDOFF_BRANCH_PREPARED=1 tells the aif-plan / plan-polisher skill that
  // Handoff already owns branch creation for this run. The skill MUST NOT
  // execute its own `git checkout -b`; it should validate that the current
  // branch matches HANDOFF_BRANCH_NAME and report a blocker if not. See
  // ai-factory#96.
  const handoffBranchLines = preparedBranch
    ? `\nHANDOFF_BRANCH_PREPARED: 1\nHANDOFF_BRANCH_NAME: ${preparedBranch}`
    : "";
  const handoffContext = `HANDOFF_MODE: 1\nHANDOFF_TASK_ID: ${taskId}${handoffBranchLines}`;
  const scopeConstraint = `IMPORTANT: Your working directory is ${executionRoot}\nAll files must be created and modified inside this directory. Do NOT navigate to parent directories or other projects.`;
  const plannerSlashCommand = `/aif-plan ${plannerMode} @${planPath} docs:${planDocs} tests:${planTests}`;

  if (task.isFix) {
    prompt = `${handoffContext}\n${scopeConstraint}\n\n${buildFixCommandText(taskContext)}`;
    workflowSpec = createRuntimeWorkflowSpec({
      workflowKind: "planner",
      prompt,
      requiredCapabilities: [],
      sessionReusePolicy: "resume_if_available",
      systemPromptAppend: scopeConstraint,
    });
  } else if (useSubagents) {
    prompt = `Plan the implementation for the following task.

${handoffContext}
${scopeConstraint}

Autonomous Handoff mode: true.
Do not ask interactive questions.
Do not perform Handoff MCP sync yourself.

Mode: ${plannerMode}, tests: ${planTests}, docs: ${planDocs}.
Plan file: @${planPath}

${taskContext}

Create or refine an implementation-ready markdown checklist plan.
Always write the final plan to @${planPath}.`;
    workflowSpec = createRuntimeWorkflowSpec({
      workflowKind: "planner",
      prompt,
      requiredCapabilities: ["supportsAgentDefinitions"],
      agentDefinitionName: AGENT_NAME,
      fallbackSlashCommand: plannerSlashCommand,
      fallbackStrategy: "slash_command",
      executionMode: "native_subagents",
      sessionReusePolicy: "resume_if_available",
      systemPromptAppend: scopeConstraint,
      metadata: {
        plannerMode,
        planDocs,
        planTests,
      },
    });
  } else {
    prompt = `${handoffContext}\n${scopeConstraint}\n\n${plannerSlashCommand}

${taskContext}`;
    workflowSpec = createRuntimeWorkflowSpec({
      workflowKind: "planner",
      prompt,
      requiredCapabilities: [],
      sessionReusePolicy: "resume_if_available",
      systemPromptAppend: scopeConstraint,
      metadata: {
        plannerMode,
        planDocs,
        planTests,
      },
    });
  }

  const planRunStartedAtMs = shouldRequireFreshPlanFile ? Date.now() : undefined;
  const { resultText: rawResult } = await executeSubagentQuery({
    taskId,
    projectRoot: executionRoot,
    agentName: executionName,
    prompt,
    profileMode: "plan",
    maxBudgetUsd: plannerBudget,
    agent: task.isFix || !useSubagents ? undefined : AGENT_NAME,
    workflowSpec,
    workflowKind: "planner",
    fallbackSlashCommand: task.isFix ? undefined : plannerSlashCommand,
  });

  // Detect skill-level branch drift: if the planner subagent (or its
  // nested plan-polisher) silently created or switched to a different
  // branch than the one we prepared, the plan we're about to persist
  // belongs to the wrong HEAD. Surface as BranchIsolationError so the
  // coordinator blocks the task instead of committing the drift.
  if (preparedBranch) {
    assertCurrentBranch(executionRoot, preparedBranch);
  }

  const diskPlan = readPlanFromDisk(
    executionRoot,
    rawResult,
    !!task.isFix,
    planPath,
    planRunStartedAtMs,
  );
  const resultText = diskPlan ?? normalizePlannerResult(rawResult);

  persistTaskPlanForTask({
    taskId,
    planText: resultText,
    projectRoot: executionRoot,
    isFix: task.isFix,
    planPath,
    updatedAt: new Date().toISOString(),
  });

  log.debug({ taskId }, "Plan saved to task");
}
