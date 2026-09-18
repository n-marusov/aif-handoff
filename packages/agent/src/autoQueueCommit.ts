/**
 * Гейт коммита перед переводом задачи в терминальный статус (auto-queue).
 *
 * Назначение: зафиксировать результат реализации в Git до закрытия задачи.
 * Гейт подтверждает два условия:
 * - рабочее дерево чистое;
 * - в ветке задачи появился ровно один новый коммит относительно baseSha.
 *
 * Инварианты:
 * - идемпотентность через autoQueueCommitStatus в БД;
 * - строгая верификация по baseSha/HEAD, а не только по текущему SHA;
 * - любое нарушение переводит задачу в ручную блокировку (StageManualBlockError);
 * - задача, закреплённая за человеком, не коммитится агентом.
 *
 * Потенциальное улучшение: вынести политику проверки "ровно один коммит" в общий
 * валидатор, чтобы переиспользовать её при публикации плана на ревью.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendTaskActivityLog, findTaskById, getAutoQueueMode, setTaskFields } from "@aif/data";
import { createRuntimeWorkflowSpec, UsageSource } from "@aif/runtime";
import {
  assertCurrentBranch,
  buildAutoQueueCommitPrompt,
  countCommitsBetween,
  describeDirtyWorkingTree,
  getHeadCommitSha,
  isGitRepo,
  logger,
  restorePersistedBranch,
} from "@aif/shared";
import { executeSubagentQuery } from "./subagentQuery.js";
import { StageManualBlockError } from "./stageErrorHandler.js";

const log = logger("auto-queue-commit");
// Правило области работ для сабагента коммита: работать только в текущем
// рабочем дереве задачи.
const PROJECT_SCOPE_APPEND =
  "Project scope rule: work strictly inside the current working directory. " +
  "Do not inspect or modify parent or sibling directories.";

// Исходы гейта разделяют доменные причины пропуска:
// not_required (контракт владения/режим) и not_applicable (нет Git-контекста).
export type AutoQueueCommitOutcome =
  | { status: "not_required" | "not_applicable" | "no_changes"; commitSha: null }
  | { status: "committed"; commitSha: string };

function recordCommitOutcome(
  taskId: string,
  outcome:
    | { status: "committed"; commitSha: string }
    | { status: "no_changes" | "not_applicable"; commitSha: null },
): void {
  // Единая запись успешного исхода: БД, журнал активности и системный лог
  // синхронизированы одной меткой времени.
  const completedAt = new Date().toISOString();
  setTaskFields(taskId, {
    autoQueueCommitStatus: outcome.status,
    commitSha: outcome.commitSha,
    autoQueueCommitError: null,
    autoQueueCommitCompletedAt: completedAt,
    updatedAt: completedAt,
  });
  appendTaskActivityLog(
    taskId,
    outcome.status === "committed"
      ? `[${completedAt}] [auto-queue-commit] Commit verified: ${outcome.commitSha}`
      : `[${completedAt}] [auto-queue-commit] ${outcome.status}`,
  );
  log.info(
    { taskId, status: outcome.status, commitSha: outcome.commitSha },
    "Auto-queue commit gate completed",
  );
}

// Провал гейта всегда фатален для авто-перехода: бросаем StageManualBlockError.
// never фиксирует, что выполнение дальше не продолжается.
function blockForCommitFailure(taskId: string, reason: string, err?: unknown): never {
  const failedAt = new Date().toISOString();
  setTaskFields(taskId, {
    autoQueueCommitStatus: "failed",
    commitSha: null,
    autoQueueCommitError: reason,
    autoQueueCommitCompletedAt: null,
    updatedAt: failedAt,
  });
  appendTaskActivityLog(taskId, `[${failedAt}] [auto-queue-commit] Failed: ${reason}`);
  log.error({ taskId, err, reason }, "Auto-queue commit gate failed");
  throw new StageManualBlockError(reason);
}

function isVerifiedSingleCommit(
  projectRoot: string,
  beforeSha: string | null,
  afterSha: string | null,
): afterSha is string {
  if (!afterSha || afterSha === beforeSha) return false;
  if (!beforeSha) return true;
  return countCommitsBetween(projectRoot, beforeSha, afterSha) === 1;
}

function reconcileCleanTree(input: {
  taskId: string;
  projectRoot: string;
  baseSha: string | null;
  currentSha: string | null;
}): AutoQueueCommitOutcome {
  const { taskId, projectRoot, baseSha, currentSha } = input;
  // Если worktree чист и HEAD изменился, коммит уже существует.
  // Повторный запуск сабагента не нужен.
  if (currentSha && currentSha !== baseSha) {
    recordCommitOutcome(taskId, { status: "committed", commitSha: currentSha });
    return { status: "committed", commitSha: currentSha };
  }
  recordCommitOutcome(taskId, { status: "no_changes", commitSha: null });
  log.debug({ taskId, projectRoot }, "Auto-queue commit skipped because work tree is clean");
  return { status: "no_changes", commitSha: null };
}

export async function ensureAutoQueueTaskCommit(input: {
  taskId: string;
  projectRoot: string;
}): Promise<AutoQueueCommitOutcome> {
  const task = findTaskById(input.taskId);
  if (!task) {
    throw new StageManualBlockError(`Auto-queue commit failed: task ${input.taskId} not found.`);
  }
  // Контракт владения: задача, закреплённая за человеком, не обрабатывается
  // гейтом коммита.
  if (task.executionOwner !== "ai") {
    log.debug(
      { taskId: task.id, executionOwner: task.executionOwner },
      "Auto-queue commit skipped for human-owned task",
    );
    return { status: "not_required", commitSha: null };
  }

  // Идемпотентный ранний выход по ранее записанному статусу/commitSha.
  if (task.autoQueueCommitStatus === "committed" && task.commitSha) {
    return { status: "committed", commitSha: task.commitSha };
  }
  if (
    task.autoQueueCommitStatus === "no_changes" ||
    task.autoQueueCommitStatus === "not_applicable"
  ) {
    return { status: task.autoQueueCommitStatus, commitSha: null };
  }

  // Если auto-queue выключен до старта гейта, задача пропускается.
  // Но начатый гейт доводится до терминального решения.
  const autoQueueEnabled = getAutoQueueMode(task.projectId);
  if (!autoQueueEnabled && task.autoQueueCommitStatus == null) {
    return { status: "not_required", commitSha: null };
  }

  // Проверка и коммит выполняются в execution root задачи (worktree либо root проекта).
  const executionRoot = task.worktreePath ?? input.projectRoot;
  if (!isGitRepo(executionRoot)) {
    recordCommitOutcome(task.id, { status: "not_applicable", commitSha: null });
    return { status: "not_applicable", commitSha: null };
  }

  // Восстанавливаем сохранённую ветку задачи для задач с веткой.
  // Fix-задачи используют отдельную политику ветвления.
  if (task.branchName && !task.isFix) {
    restorePersistedBranch({
      projectRoot: executionRoot,
      taskId: task.id,
      persistedBranchName: task.branchName,
    });
  }

  // На первом заходе фиксируем baseSha в БД.
  // Повторы используют этот baseSha для стабильной верификации.
  const currentSha = getHeadCommitSha(executionRoot);
  const baseSha = task.autoQueueCommitStatus == null ? currentSha : task.autoQueueCommitBaseSha;
  if (task.autoQueueCommitStatus == null) {
    setTaskFields(task.id, {
      autoQueueCommitStatus: "pending",
      autoQueueCommitBaseSha: baseSha,
      commitSha: null,
      autoQueueCommitError: null,
      autoQueueCommitCompletedAt: null,
      updatedAt: new Date().toISOString(),
    });
  }

  // Проверка грязного дерева до запуска сабагента определяет, нужен ли запуск коммита.
  const dirtyBefore = describeDirtyWorkingTree(executionRoot);
  log.info(
    {
      taskId: task.id,
      projectId: task.projectId,
      executionRoot,
      baseSha,
      currentSha,
      dirty: Boolean(dirtyBefore),
    },
    "Evaluating auto-queue commit gate",
  );

  // При чистом дереве решение делегируется reconcileCleanTree.
  if (!dirtyBefore) {
    return reconcileCleanTree({
      taskId: task.id,
      projectRoot: executionRoot,
      baseSha,
      currentSha,
    });
  }

  /**
   * Гигиена перед коммитом: удаляем `.llm-backup/`.
   * Это локальный артефакт редактора, он не должен попадать в историю задачи.
   * `.claude/` не удаляем: там могут быть определения агентов для самого
   * запуска коммита.
   */
  const llmBackupPath = join(executionRoot, ".llm-backup");
  if (existsSync(llmBackupPath)) {
    try {
      rmSync(llmBackupPath, { recursive: true, force: true });
      log.debug({ taskId: task.id }, "Removed .llm-backup/ before commit");
    } catch (cleanErr) {
      log.warn({ taskId: task.id, err: cleanErr }, "Failed to remove .llm-backup/");
    }
  }

  // Статус running фиксируем до вызова runtime для корректного восстановления.
  setTaskFields(task.id, {
    autoQueueCommitStatus: "running",
    autoQueueCommitError: null,
    updatedAt: new Date().toISOString(),
  });

  const prompt = buildAutoQueueCommitPrompt();
  const workflowSpec = createRuntimeWorkflowSpec({
    workflowKind: "commit",
    prompt,
    sessionReusePolicy: "never",
    systemPromptAppend: PROJECT_SCOPE_APPEND,
  });

  let runtimeError: unknown;
  try {
    // Перед вызовом runtime повторно проверяем executionOwner.
    // Это граница владения перед изменением Git.
    const executionBoundaryTask = findTaskById(task.id);
    if (!executionBoundaryTask || executionBoundaryTask.executionOwner !== "ai") {
      log.warn(
        {
          taskId: task.id,
          executionOwner: executionBoundaryTask?.executionOwner ?? null,
        },
        "Auto-queue commit aborted at ownership boundary",
      );
      return { status: "not_required", commitSha: null };
    }
    await executeSubagentQuery({
      taskId: task.id,
      projectRoot: executionRoot,
      agentName: "aif-commit",
      prompt,
      profileMode: "task",
      workflowSpec,
      workflowKind: "commit",
      sessionReusePolicy: "never",
      systemPromptAppend: PROJECT_SCOPE_APPEND,
      usageSource: UsageSource.COMMIT,
    });
  } catch (err) {
    // Runtime-ошибку откладываем: агент мог успеть сделать валидный коммит.
    runtimeError = err;
  }

  // Инвариант ветки: гейт запрещает успешный исход при смене ветки задачи.
  if (task.branchName && !task.isFix) {
    try {
      assertCurrentBranch(executionRoot, task.branchName);
    } catch (err) {
      return blockForCommitFailure(
        task.id,
        "Auto-queue commit changed the task branch. Restore the task branch and retry.",
        err,
      );
    }
  }

  // Успех только при паре условий: чистое рабочее дерево + ровно один проверенный коммит.
  const afterSha = getHeadCommitSha(executionRoot);
  const dirtyAfter = describeDirtyWorkingTree(executionRoot);
  const commitVerified = !dirtyAfter && isVerifiedSingleCommit(executionRoot, currentSha, afterSha);

  if (commitVerified) {
    recordCommitOutcome(task.id, { status: "committed", commitSha: afterSha });
    return { status: "committed", commitSha: afterSha };
  }

  // Причина ручной блокировки ранжируется по диагностической ценности:
  // ошибка runtime -> грязное дерево -> неверное число коммитов.
  const reason = runtimeError
    ? "Auto-queue commit runtime failed before a clean commit was verified. Inspect agent logs and retry."
    : dirtyAfter
      ? "Auto-queue commit left uncommitted changes. Inspect the work tree and retry."
      : "Auto-queue commit did not create exactly one commit. Inspect agent logs and retry.";
  return blockForCommitFailure(task.id, reason, runtimeError);
}
