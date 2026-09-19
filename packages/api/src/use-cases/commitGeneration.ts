/**
 * Use case: генерация коммита (generateCommit).
 *
 * Перенесено из packages/api/src/services/commitGeneration.ts при clean-architecture
 * refactoring. Fire-and-forget прогон runtime-адаптера, который сам выполняет
 * git commit внутри проекта. Модуль не знает про HTTP: результат возвращается
 * структурой, а маршрут транслирует его в WS-события.
 *
 * Почему fire-and-forget: вызов идёт из HTTP-хендлера, который должен ответить
 * пользователю быстро, а генерация сообщения и сам git-коммит занимают секунды.
 * Функция поэтому никогда не бросает: результат возвращается структурой и
 * транслируется клиенту через WebSocket.
 *
 * Самые важные инварианты (без изменений относительно исходника):
 *  - Коммит обязан попасть на persisted-ветку задачи или упасть явно: перед
 *    запуском ветка восстанавливается, после - проверяется, потому что субагент
 *    вызывает git напрямую и мог уехать на другой HEAD.
 *  - Задачи с executionOwner === "human" не получают AI-коммит; проверка
 *    делается дважды (до try и внутри), так как владелец мог смениться.
 *  - Неизвестный проект - не исключение, а ok: false с текстом ошибки.
 */
import {
  assertCurrentBranch,
  buildCommitPrompt,
  getProjectConfig,
  isBranchIsolationError,
  logger,
  restorePersistedBranch,
} from "@aif/shared";
import { findProjectById, findTaskById } from "@aif/data";
import { UsageSource } from "@aif/runtime";
import { runApiRuntimeOneShot } from "../services/runtime.js";
import type { GenerateCommitInput, GenerateCommitResult } from "./types.js";

const log = logger("use-case:commit-generation");

// Явный запрет выходить за корень проекта: адаптеры без песочницы иначе могут
// сканировать весь монорепозиторий - это и медленно, и небезопасно.
const PROJECT_SCOPE_APPEND =
  "Project scope rule: work strictly inside the current working directory (project root). " +
  "Do not inspect or modify files in the orchestrator monorepo or in parent/sibling directories " +
  "unless the user explicitly asks for that path. Avoid broad discovery outside the current project root.";

export { buildCommitPrompt } from "@aif/shared";

/**
 * Точка входа fire-and-forget: выполняет рабочий процесс коммита через общий
 * runtime в корне проекта. Возвращает структурированный результат, чтобы
 * вызывающий мог разослать успех/ошибку по WS. Никогда не бросает.
 */
export async function generateCommit(input: GenerateCommitInput): Promise<GenerateCommitResult> {
  const { projectId, taskId = null } = input;
  log.debug({ useCase: "generateCommit", projectId, taskId }, "use case entry");
  const project = findProjectById(projectId);
  if (!project) {
    const msg = `Project not found: ${projectId}`;
    log.error({ projectId }, msg);
    return { ok: false, error: msg };
  }

  const task = taskId ? findTaskById(taskId) : null;
  if (task?.executionOwner === "human") {
    log.warn(
      { projectId, taskId, executionOwner: task.executionOwner },
      "Commit runtime rejected for human-owned task",
    );
    return {
      ok: false,
      code: "ai_handoff_required",
      error: "The task must be handed to AI before commit generation can run",
    };
  }
  // Работаем в worktree задачи, если он есть: коммит должен лечь в изолированное
  // дерево, а не в общий клон проекта, который могут смотреть другие процессы.
  const executionRoot = task?.worktreePath ?? project.rootPath;
  // isFix-задачи живут без собственной ветки, поэтому проверка изоляции
  // применяется только к обычным задачам с зафиксированным branchName.
  if (task?.branchName && !task.isFix) {
    // task.branchName — контракт источника истины: коммит ДОЛЖЕН попасть на
    // сохранённую ветку или громогласно упасть. `ensureFeatureBranch({switchOnly:true})`
    // может вернуть `skipped` при `git.enabled=false` / не-git projectRoot —
    // и коммит уйдёт на какой окажется HEAD. Пост-проверка поймает расхождение,
    // но коммит к тому моменту уже может быть записан. Вместо неё используем
    // `restorePersistedBranch`, который бросает
    // `git_disabled_with_persisted_branch` / `not_a_repo_with_persisted_branch`
    // до любого вызова runtime.
    try {
      restorePersistedBranch({
        projectRoot: executionRoot,
        taskId: task.id,
        persistedBranchName: task.branchName,
      });
    } catch (err) {
      const message = isBranchIsolationError(err)
        ? `Branch isolation failure (${err.kind}): ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
      log.error(
        { err, projectId, taskId, branchName: task.branchName },
        "Commit runtime aborted before start due to branch isolation failure",
      );
      return { ok: false, error: message };
    }
  }

  // Конфиг читаем из executionRoot, а не из project.rootPath: у worktree может
  // быть собственный набор настроек, и push должен решаться по нему.
  const { git } = getProjectConfig(executionRoot);
  // Push гасится либо выключенным git, либо явным флагом проекта; от этого
  // зависит текст промпта, поэтому решение принимается до сборки промпта.
  const shouldPush = git.enabled && !git.skip_push_after_commit;
  const prompt = buildCommitPrompt(shouldPush);

  log.info(
    {
      projectId,
      taskId,
      projectRoot: executionRoot,
      sourceProjectRoot: project.rootPath,
      skipPushAfterCommit: git.skip_push_after_commit,
      shouldPush,
      promptLength: prompt.length,
    },
    "Starting commit runtime run",
  );

  try {
    // Задачу перечитываем непосредственно перед вызовом runtime: между стартом
    // обработки и запуском владелец мог смениться на человека, и коммит
    // сгенерировал бы ИИ у задачи, которая уже передана человеку.
    const executionBoundaryTask = taskId ? findTaskById(taskId) : null;
    if (executionBoundaryTask?.executionOwner === "human") {
      return {
        ok: false,
        code: "ai_handoff_required",
        error: "The task must be handed to AI before commit generation can run",
      };
    }
    // usageContext.source помечает расход токенов как COMMIT: иначе он смешался
    // бы с расходами этапов пайплайна в отчётах.
    const { result } = await runApiRuntimeOneShot({
      projectId,
      projectRoot: executionRoot,
      taskId,
      prompt,
      workflowKind: "commit",
      fallbackSlashCommand: "/aif-commit",
      systemPromptAppend: PROJECT_SCOPE_APPEND,
      usageContext: { source: UsageSource.COMMIT },
    });

    // Пост-проверка расхождения: сабагент коммита вызывает git напрямую, поэтому
    // `git checkout` посреди прогона (незваный скилл, неверный резервный путь)
    // мог записать коммит не в ту ветку. Показываем расхождение, а не молча
    // возвращаем ok.
    if (task?.branchName && !task.isFix) {
      try {
        assertCurrentBranch(executionRoot, task.branchName);
      } catch (err) {
        const message = isBranchIsolationError(err)
          ? `Branch isolation failure (${err.kind}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
        log.error(
          { err, projectId, taskId, branchName: task.branchName },
          "Commit runtime aborted after run due to branch drift",
        );
        return { ok: false, error: message };
      }
    }

    log.info(
      {
        projectId,
        taskId,
        shouldPush,
        outputPreview: result.outputText?.slice(0, 200) ?? "",
      },
      "Commit runtime run completed successfully",
    );
    log.debug({ useCase: "generateCommit", projectId, taskId, outcome: "ok" }, "use case exit");
    return { ok: true };
  } catch (err) {
    // Сюда попадают ошибки рантайма и транспорта; текст уже сформирован
    // адаптером, поэтому пробрасываем его без дополнительной обёртки.
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, projectId, taskId }, "Commit runtime error");
    log.debug({ useCase: "generateCommit", projectId, taskId, outcome: "error" }, "use case exit");
    return { ok: false, error: message };
  }
}
