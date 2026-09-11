import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  findProjectById,
  findTaskById,
  getLatestReworkComment,
  listTaskExecutorHistory,
  persistTaskPlanForTask,
  setTaskFields,
  type TaskRow,
} from "@aif/data";
import {
  logger,
  formatAttachmentsForPrompt,
  looksLikeFullPlanUpdate,
  getEnv,
  getHeadCommitSha,
  getProjectConfig,
  listChangedFiles,
} from "@aif/shared";
import { createRuntimeWorkflowSpec } from "@aif/runtime";
import { logActivity } from "../hooks.js";
import { executeSubagentQuery } from "../subagentQuery.js";
import { taskRequiresPlanReview } from "../planReviewPublisher.js";
import {
  analyzeLayerDisjointness,
  collectDeclaredFiles,
  computePendingPlanLayers,
  computePlanLayers,
  formatLayerDecisions,
  formatLayerSummary,
  isOutsideDeclaredScope,
} from "../planLayers.js";
import { assertCurrentBranch, restorePersistedBranch } from "../gitBranch.js";

const log = logger("implementer");
const AGENT_NAME = "implement-coordinator";

function formatReworkCommentForPrompt(
  comment: {
    author: string;
    createdAt: string;
    message: string;
    attachments: string | null;
  } | null,
): string {
  if (!comment) return "No rework comments found for rework request.";
  return [
    `[${comment.createdAt}] ${comment.author}`,
    `message: ${comment.message}`,
    "attachments:",
    formatAttachmentsForPrompt(comment.attachments),
  ].join("\n");
}

function formatAutoReviewStateForPrompt(
  state:
    | {
        strategy: string;
        iteration: number;
        findings: Array<{ id: string; text: string; source: string }>;
      }
    | null
    | undefined,
): string {
  if (!state || state.findings.length === 0) {
    return "No persisted blocking findings snapshot.";
  }

  return [
    `strategy: ${state.strategy}`,
    `iteration: ${state.iteration}`,
    "findings:",
    ...state.findings.map((finding) => `- [${finding.id}] ${finding.source} | ${finding.text}`),
  ].join("\n");
}

function isBlockedImplementationResult(resultText: string): boolean {
  const normalized = resultText.toLowerCase();
  return (
    normalized.includes("status: blocked") ||
    normalized.includes("permission system") ||
    normalized.includes("permission denied") ||
    normalized.includes("write permission") ||
    normalized.includes("cannot proceed") ||
    normalized.includes("blocked —")
  );
}

function readCanonicalPlan(
  task: { isFix: boolean; planPath: string },
  projectRoot: string,
): string | null {
  const cfg = getProjectConfig(projectRoot);
  const preferredPath = resolve(
    projectRoot,
    task.isFix ? cfg.paths.fix_plan : task.planPath || cfg.paths.plan,
  );
  if (existsSync(preferredPath)) {
    const content = readFileSync(preferredPath, "utf8").trim();
    if (content.length > 0) return content;
  }

  const fallbackPath = resolve(projectRoot, task.isFix ? cfg.paths.plan : cfg.paths.fix_plan);
  if (existsSync(fallbackPath)) {
    const content = readFileSync(fallbackPath, "utf8").trim();
    if (content.length > 0) return content;
  }

  return null;
}

function getChecklistProgress(planText: string | null): {
  parsedTaskCount: number;
  pendingTaskCount: number;
} {
  if (!planText) return { parsedTaskCount: 0, pendingTaskCount: 0 };
  const parsed = computePlanLayers(planText);
  const pending = computePendingPlanLayers(planText);
  return {
    parsedTaskCount: parsed.tasks.length,
    pendingTaskCount: pending.tasks.length,
  };
}

async function runChecklistSyncQuery(input: {
  task: TaskRow;
  projectRoot: string;
  planText: string;
  implementationResult: string;
}): Promise<string> {
  const prompt = `You are finalizing task checklist state in a markdown implementation plan.

TASK TITLE:
${input.task.title}

TASK DESCRIPTION:
${input.task.description}

IMPLEMENTATION RESULT LOG (source of truth for what was done):
${input.implementationResult}

CURRENT PLAN MARKDOWN:
<<<CURRENT_PLAN
${input.planText}
CURRENT_PLAN

Requirements:
1) Return the FULL updated plan markdown.
2) Update only checkbox states ("- [ ]" / "- [x]") to reflect implemented work from the log.
3) Do not rewrite structure, titles, ordering, prose, or dependencies.
4) Preserve all unchecked tasks that are not completed yet.
5) Output markdown only.
6) Do not use tools or subagents.`;

  const workflowSpec = createRuntimeWorkflowSpec({
    workflowKind: "implementer_checklist_sync",
    prompt,
    requiredCapabilities: [],
    sessionReusePolicy: "never",
    systemPromptAppend: "Do not use tools or subagents. Reply directly with markdown only.",
    metadata: {
      checklistSync: true,
    },
  });

  const { resultText } = await executeSubagentQuery({
    taskId: input.task.id,
    projectRoot: input.projectRoot,
    agentName: "implement-checklist-sync",
    prompt,
    workflowSpec,
    workflowKind: "implementer_checklist_sync",
  });
  const normalizedResult = resultText.trim();
  if (!normalizedResult) {
    throw new Error("Checklist sync did not return plan markdown");
  }
  return normalizedResult;
}

export async function runImplementer(taskId: string, projectRoot: string): Promise<void> {
  const task = findTaskById(taskId);

  if (!task) {
    log.error({ taskId }, "Task not found for implementation");
    throw new Error(`Task ${taskId} not found`);
  }

  // Plan-review gate guard (defense in depth). The coordinator only routes
  // approved plan-review tasks to the implementer stage, but a task can still
  // reach this runner without an approved plan (a legacy VCS task after the
  // feature flag was enabled, a manual status move, or a direct invocation).
  // Refuse to touch product files until the plan PR/MR is approved.
  if (taskRequiresPlanReview(taskId) && task.planReviewState !== "approved") {
    log.warn(
      { taskId, status: task.status, planReviewState: task.planReviewState ?? null },
      "Implementation blocked before plan approval; task stays on the plan-review gate",
    );
    return;
  }

  // Branch restore MUST happen before any repo/config/plan read. If the
  // planner prepared a feature branch but auto-queue (or a chat/manual
  // action) moved HEAD between stages, every downstream read — config,
  // canonical plan, pending-task detection, no-op early return — would
  // operate on the wrong branch and silently ship incorrect state.
  //
  // `task.branchName` is a source-of-truth contract: once planner set it,
  // every subsequent stage MUST land on that branch or fail loud. Config
  // drift (git.enabled / create_branches toggled off between stages) cannot
  // release us to the current HEAD — `restorePersistedBranch` throws instead
  // of the "skipped" shortcut `ensureFeatureBranch` uses.
  if (task.branchName && !task.isFix) {
    restorePersistedBranch({
      projectRoot,
      taskId,
      persistedBranchName: task.branchName,
    });
    logActivity(taskId, "Agent", `Restored feature branch: ${task.branchName}`);
  }

  const project = findProjectById(task.projectId);
  const implementerBudget = project?.implementerMaxBudgetUsd ?? null;
  const useSubagents = task.useSubagents;
  const executionName = useSubagents ? AGENT_NAME : "aif-implement";
  const cfg = getProjectConfig(projectRoot);
  const canonicalPlan = readCanonicalPlan(task, projectRoot);
  const selectedPlan = canonicalPlan ?? task.plan;
  const effectivePlanPath = task.isFix ? cfg.paths.fix_plan : task.planPath || cfg.paths.plan;
  const planSection = `@${effectivePlanPath}`;
  const layerComputation = selectedPlan
    ? computePendingPlanLayers(selectedPlan)
    : { tasks: [], layers: [] };
  const parsedPlanComputation = selectedPlan
    ? computePlanLayers(selectedPlan)
    : { tasks: [], layers: [] };
  const parsedTaskCount = parsedPlanComputation.tasks.length;
  const pendingTaskCount = layerComputation.tasks.length;
  const latestReworkComment = task.reworkRequested
    ? (getLatestReworkComment(taskId) ?? null)
    : null;
  const blockingFindingsSnapshot = task.reworkRequested
    ? formatAutoReviewStateForPrompt(task.autoReviewState)
    : "No persisted blocking findings snapshot.";
  const latestOwnershipEntry = listTaskExecutorHistory(taskId).at(-1);
  const handoffResponsibility = latestOwnershipEntry
    ? [
        `ownershipRevision=${latestOwnershipEntry.ownershipRevision}`,
        `executionOwner=${latestOwnershipEntry.executionOwner}`,
        `initiatedBy=${latestOwnershipEntry.actor.displayNameSnapshot ?? latestOwnershipEntry.actor.kind}`,
        `responsibleParticipants=${
          latestOwnershipEntry.assignees.map((assignee) => assignee.displayName).join(", ") ||
          "none"
        }`,
      ].join("; ")
    : "No executor handoff history.";

  if (selectedPlan && parsedTaskCount > 0 && pendingTaskCount === 0 && !task.reworkRequested) {
    const nowIso = new Date().toISOString();
    const noOpResult =
      "No pending tasks detected in plan (all tasks already completed). " +
      "Implementer skipped coordinator execution.";
    persistTaskPlanForTask({
      taskId,
      planText: selectedPlan,
      projectRoot,
      isFix: task.isFix,
      planPath: task.planPath,
      updatedAt: nowIso,
    });
    setTaskFields(taskId, {
      implementationLog: noOpResult,
      lastHeartbeatAt: nowIso,
      updatedAt: nowIso,
    });
    logActivity(taskId, "Agent", `${executionName} skipped — no pending tasks in plan`);
    log.info({ taskId }, "Implementer no-op: all plan tasks already completed");
    return;
  }

  log.info({ taskId, title: task.title, useSubagents }, "Starting implementation stage");

  // Level 2 planning: validate that each execution layer's tasks touch
  // disjoint files before allowing fan-out, and surface the worker contract.
  const layerAnalyses = analyzeLayerDisjointness(layerComputation.layers, layerComputation.tasks);
  const declaredFiles = collectDeclaredFiles(layerComputation.tasks);
  const maxWorkers = getEnv().AIF_IMPLEMENT_MAX_WORKERS;
  const maxWorkersSource = process.env.AIF_IMPLEMENT_MAX_WORKERS?.trim() ? "env" : "default";
  const hasParallelLayer = layerAnalyses.some((layer) => layer.decision === "parallel");
  // Baseline for post-run scope validation (declared-vs-actual touched files).
  const layerBaselineSha = task.branchName && !task.isFix ? getHeadCommitSha(projectRoot) : null;
  log.debug(
    {
      taskId,
      layers: layerComputation.layers,
      maxWorkers,
      maxWorkersSource,
      declaredFiles,
    },
    "Resolved implementer fan-out plan",
  );
  for (const layer of layerAnalyses) {
    if (layer.tasks.length <= 1) continue;
    if (layer.decision === "parallel") {
      log.info(
        { taskId, layerIndex: layer.layerIndex + 1, tasks: layer.tasks, maxWorkers },
        "Implementer layer scheduled for parallel fan-out",
      );
    } else {
      log.info(
        {
          taskId,
          layerIndex: layer.layerIndex + 1,
          tasks: layer.tasks,
          overlappingFiles: layer.overlappingFiles,
          undeclaredTasks: layer.undeclaredTasks,
        },
        "Implementer layer reduced to sequential execution",
      );
    }
  }

  const layerPlanSection =
    layerAnalyses.length > 0
      ? `

Execution layers (from the plan):
${formatLayerSummary(layerComputation.layers)}

Layer decisions (AUTHORITATIVE — obey them):
${formatLayerDecisions(layerAnalyses)}`
      : "\n\nExecution layers: none parsed from the plan — run the checklist sequentially.";

  const fanOutLine = `- Worker fan-out: at most ${maxWorkers} implement-worker subagent(s) per parallel layer (AIF_IMPLEMENT_MAX_WORKERS).`;

  const workerContractBlock = hasParallelLayer
    ? `

Parallel worker contract (mandatory for layers marked "parallel"):
- Workers are EDIT-ONLY: no git commands (checkout/commit/push/worktree), and never write the plan file.
- The coordinator owns git writes and the plan checklist; workers report changed files instead of committing.
- A worker may only edit the files declared for its own task: ${
        declaredFiles.length > 0 ? declaredFiles.join(", ") : "(none declared)"
      }.
- Run repo-wide builds/tests ONCE per layer, after all of the layer's workers finish.
- Take one checkpoint per layer so a failed layer can be rolled back before the next one starts.`
    : "";

  const scopeConstraint = `IMPORTANT: Your working directory is ${projectRoot}
All files must be created and modified inside this directory. Do NOT create files outside of it.`;
  const implementSlashCommand = `/aif-implement ${planSection}`;
  const handoffContext = `HANDOFF_MODE: 1
HANDOFF_TASK_ID: ${taskId}
HANDOFF_SKIP_REVIEW: ${task.skipReview ? "1" : "0"}`;

  const isRework = task.reworkRequested;

  // Rework header is surfaced loudly so the model cannot miss that this is
  // a reopened task with an explicit human/agent rework comment.
  const reworkHeaderBlock = isRework
    ? `================================================
  REWORK REQUEST — THIS IS THE PRIMARY TASK
================================================

You are addressing a REWORK REQUEST on a previously-completed task. The rework comment below is your PRIMARY instruction — it supersedes the checklist state of the plan. The task was previously marked DONE, but the reviewer is NOT satisfied and has requested changes. Address EXACTLY the request below. Do not re-do previously completed work unless the request explicitly asks for it.

<<<REWORK_COMMENT
${formatReworkCommentForPrompt(latestReworkComment)}
REWORK_COMMENT

<<<FULL_REVIEW_COMMENTS
${task.reviewComments ?? "No review comments available."}
FULL_REVIEW_COMMENTS

<<<BLOCKING_FINDINGS_SNAPSHOT
${blockingFindingsSnapshot}
BLOCKING_FINDINGS_SNAPSHOT

================================================
`
    : "";

  const reworkProtocolBlock = isRework
    ? `

Rework handling protocol:
1) FIRST, restate the rework request in your own words (1-2 sentences) so it's clear you understood it. Reference specific files, functions, or plan items mentioned in the request.
2) Identify which files in the codebase and/or plan items need to change to satisfy the request.
3) Make the minimal set of changes required. Do NOT refactor unrelated code.
4) If the rework request cannot be satisfied (e.g. it asks for something impossible or contradicts an earlier decision), say so EXPLICITLY in the final result text — do not silently skip it or claim "already done".
5) If the plan checklist shows all items completed, do not interpret that as "nothing to do" — the rework comment is the source of truth for this run.
6) In the final result text, explicitly list which blocking finding IDs from BLOCKING_FINDINGS_SNAPSHOT were addressed and which IDs remain unresolved.`
    : "";

  const reworkSystemAppend = isRework
    ? "\n\nREWORK MODE: A previously-completed task has been reopened. The rework comment inside the prompt is the primary instruction. Do not treat a fully-checked plan as 'nothing to do'."
    : "";

  const effectiveSystemAppend = `${scopeConstraint}${reworkSystemAppend}`;

  // For coordinator mode the rework header goes at the very top of the prompt
  // so it cannot be buried below the lead line. For skill mode we keep the
  // slash command on the first line so Claude Code still expands it, and
  // surface the rework header inside the body instead.
  const topReworkHeader = useSubagents ? reworkHeaderBlock : "";
  const bodyReworkHeader = useSubagents ? "" : reworkHeaderBlock;

  const nonSubagentExecutionBlock = useSubagents
    ? ""
    : `AUTOMATED EXECUTION INSTRUCTIONS (read carefully):
This is an automated implementation run. You MUST execute bash commands
or use file-writing tools to create/modify the required files. Do NOT just
describe what should be done — actually do it.

1. Read the plan at ${planSection}.
2. For each pending task in the plan, implement it by running concrete
   bash commands (echo, mkdir, cat, writeFile, etc.).
3. After creating/modifying files, verify they exist with ls/cat.
4. Update the plan's checklist (mark completed tasks as [x]).
5. If tests are required by the plan, run them and report results.
6. Output a brief summary of what was created/modified.`;

  const prompt = `${topReworkHeader}${useSubagents ? "Implement the task using the provided plan." : implementSlashCommand}

${
  useSubagents
    ? `${handoffContext}
Autonomous Handoff mode: true.
Do not ask interactive questions.
Do not perform Handoff MCP sync yourself.
`
    : ""
}

${scopeConstraint}

${bodyReworkHeader}Latest executor responsibility: ${handoffResponsibility}

Title: ${task.title}
Description: ${task.description}
Task attachments:
${formatAttachmentsForPrompt(task.attachments)}

Plan path:
${planSection}

${isRework ? "Rework mode: true (requested from done/request_changes)." : "Rework mode: false."}

Execution rules:
- Respect task dependencies and checklist state from the plan file.
- Keep plan checklist state accurate while implementing.
- Run tests/lint/verification relevant to the changes.
- IMPORTANT: The plan file is ${effectivePlanPath}. Always read from and annotate this exact file — do not create plan files at other paths.${fanOutLine}${layerPlanSection}${workerContractBlock}${
    useSubagents ? "" : `\n\n${nonSubagentExecutionBlock}`
  }${reworkProtocolBlock}`;
  const workflowSpec = createRuntimeWorkflowSpec({
    workflowKind: "implementer",
    prompt,
    requiredCapabilities: useSubagents ? ["supportsAgentDefinitions"] : [],
    agentDefinitionName: useSubagents ? AGENT_NAME : undefined,
    fallbackSlashCommand: implementSlashCommand,
    fallbackStrategy: useSubagents ? "slash_command" : "none",
    executionMode: useSubagents ? "native_subagents" : "standard",
    // A restarted task reuses the same worktree but must NOT carry stale model
    // context from the previous attempt — always start a fresh session.
    sessionReusePolicy: "never",
    systemPromptAppend: effectiveSystemAppend,
    metadata: {
      reworkRequested: task.reworkRequested,
      skipReview: task.skipReview ?? false,
      maxWorkers,
      parallelLayers: layerAnalyses.filter((layer) => layer.decision === "parallel").length,
      layerBaselineSha,
    },
  });

  log.info(
    {
      taskId,
      previousSessionId: null,
      reason: isRework ? "rework_requested" : "fresh_session_on_restart",
    },
    "Implementer starting a fresh session",
  );

  const { resultText } = await executeSubagentQuery({
    taskId,
    projectRoot,
    agentName: executionName,
    prompt,
    maxBudgetUsd: implementerBudget,
    agent: useSubagents ? AGENT_NAME : undefined,
    skipReview: task.skipReview ?? false,
    workflowSpec,
    workflowKind: "implementer",
    fallbackSlashCommand: implementSlashCommand,
  });

  // Post-run drift check: if the subagent switched branches during execution
  // (e.g. a rogue skill ran `git checkout` or plan-polisher followed legacy
  // Step 1.4), we MUST block before persisting plan/log — otherwise we
  // attribute diffs from a different branch to this task.
  if (task.branchName && !task.isFix) {
    assertCurrentBranch(projectRoot, task.branchName);
  }

  let finalResultText = resultText;

  if (isBlockedImplementationResult(resultText)) {
    throw new Error("Implementer blocked by permissions");
  }

  let syncedPlan = readCanonicalPlan(task, projectRoot) ?? task.plan;
  let checklistAutoSynced = false;
  const checklistBeforeSync = getChecklistProgress(syncedPlan);

  if (
    syncedPlan &&
    checklistBeforeSync.parsedTaskCount > 0 &&
    checklistBeforeSync.pendingTaskCount > 0
  ) {
    const repairedPlan = await runChecklistSyncQuery({
      task,
      projectRoot,
      planText: syncedPlan,
      implementationResult: finalResultText,
    });
    if (looksLikeFullPlanUpdate(syncedPlan, repairedPlan)) {
      syncedPlan = repairedPlan;
      checklistAutoSynced = true;
    } else {
      log.warn(
        { taskId },
        "Checklist auto-sync returned non-plan-like response, keeping original plan",
      );
    }
  }

  // Second post-run drift check: `runChecklistSyncQuery` itself spawns a
  // subagent. Even if the main implementer ended on the right HEAD, the sync
  // pass can switch branches mid-flow. Re-assert before persisting plan/log.
  if (task.branchName && !task.isFix) {
    assertCurrentBranch(projectRoot, task.branchName);
  }

  // Scope enforcement (Level 2 safety). When a layer actually fanned out, the
  // run's touched files must stay inside the union of declared change scopes.
  // The coordinator cannot attribute individual files to individual workers, so
  // a violation is surfaced loudly (log + reviewer note) instead of being
  // committed silently.
  const scopeViolations: string[] = [];
  if (hasParallelLayer && declaredFiles.length > 0 && layerBaselineSha) {
    const touchedFiles = listChangedFiles(projectRoot, layerBaselineSha);
    scopeViolations.push(
      ...touchedFiles.filter((file) => isOutsideDeclaredScope(file, declaredFiles)),
    );
    if (scopeViolations.length > 0) {
      log.warn(
        {
          taskId,
          baselineSha: layerBaselineSha,
          outOfScopeFiles: scopeViolations.slice(0, 20),
        },
        "Implementer touched files outside the layer's declared change scope",
      );
    } else {
      log.debug(
        { taskId, touchedFileCount: touchedFiles.length },
        "Implementer stayed inside the declared change scope",
      );
    }
  }

  const checklistAfterSync = getChecklistProgress(syncedPlan);
  const checklistWarning =
    syncedPlan && checklistAfterSync.parsedTaskCount > 0 && checklistAfterSync.pendingTaskCount > 0
      ? `[warning] Checklist remains incomplete after auto-sync: ${checklistAfterSync.pendingTaskCount} pending task(s).`
      : null;
  if (checklistWarning) {
    log.warn(
      { taskId, pendingTaskCount: checklistAfterSync.pendingTaskCount },
      "Checklist remains incomplete after auto-sync; continuing without blocking",
    );
  }

  const finalResultNotes: string[] = [];
  if (checklistAutoSynced) {
    finalResultNotes.push("[note] Plan checklist auto-synced after implementation.");
  }
  if (checklistWarning) {
    finalResultNotes.push(checklistWarning);
  }
  if (scopeViolations.length > 0) {
    const shown = scopeViolations.slice(0, 20).join(", ");
    const suffix = scopeViolations.length > 20 ? ` (+${scopeViolations.length - 20} more)` : "";
    finalResultNotes.push(
      `[warning] Files changed outside the declared layer scope: ${shown}${suffix}. The layer was scheduled for parallel fan-out — review before merging.`,
    );
  }

  // Concrete change summary — surface exactly which files this implementer
  // run touched so the PR/activity clearly reflects the plan work instead of
  // relying on the model's prose (which can claim success without any edits).
  // `listChangedFiles(projectRoot, ref)` only reports tracked changes, so also
  // capture untracked files (new files created but not yet `git add`ed) via
  // the porcelain variant and merge both lists.
  const trackedChanges =
    layerBaselineSha && task.branchName && !task.isFix
      ? listChangedFiles(projectRoot, layerBaselineSha)
      : [];
  const allDirty = listChangedFiles(projectRoot);
  const changedFiles = Array.from(new Set([...trackedChanges, ...allDirty])).sort();
  if (changedFiles.length > 0) {
    finalResultNotes.push(
      `[files] Files changed by this implementation:\n${changedFiles
        .map((file) => `- ${file}`)
        .join("\n")}`,
    );
  }

  // Change verification — if the plan expected product changes but this run
  // touched nothing, surface a loud warning so an empty "I implemented it"
  // result cannot pass silently. Uses the union of tracked + untracked files.
  const planDeclaredFiles = collectDeclaredFiles(layerComputation.tasks);
  if (layerComputation.tasks.length > 0 && changedFiles.length === 0) {
    const scope =
      planDeclaredFiles.length > 0
        ? planDeclaredFiles.join(", ")
        : "(files not parsable from plan)";
    const warning =
      `[error] The plan had ${layerComputation.tasks.length} pending task(s) but NO files were changed: ${scope}. ` +
      `The implementation produced no work-tree changes — inspect the implementation log and work tree.`;
    finalResultNotes.push(warning);
    log.error(
      {
        taskId,
        pendingTaskCount: layerComputation.tasks.length,
        declaredFiles: planDeclaredFiles,
        changedFiles,
      },
      "Implementer completed without changing any files despite pending plan tasks",
    );
  } else if (planDeclaredFiles.length > 0) {
    const missed = planDeclaredFiles.filter((file) => !changedFiles.includes(file));
    if (missed.length > 0) {
      finalResultNotes.push(
        `[warning] Plan declared file(s) not modified: ${missed.join(", ")}. Review before proceeding.`,
      );
    }
  }

  const enrichedResult =
    finalResultNotes.length > 0
      ? `${finalResultText}\n\n${finalResultNotes.join("\n")}`
      : finalResultText;

  const nowIso = new Date().toISOString();
  if (syncedPlan) {
    persistTaskPlanForTask({
      taskId,
      planText: syncedPlan,
      projectRoot,
      isFix: task.isFix,
      planPath: task.planPath,
      updatedAt: nowIso,
    });
  }

  setTaskFields(taskId, {
    implementationLog: enrichedResult,
    reworkRequested: false,
    lastHeartbeatAt: nowIso,
    updatedAt: nowIso,
  });

  log.debug({ taskId }, "Implementation log saved to task");
}
