/**
 * Уборка рабочего дерева задачи: снять незакоммиченную работу в stash и удалить
 * каталог worktree.
 *
 * Почему порядок шагов именно такой:
 *  - в worktree может лежать незакоммиченная работа, и удаление каталога
 *    уничтожило бы её безвозвратно; поэтому сначала snapshot, потом stash,
 *    потом проверка ссылок на каталог, и только затем remove и prune;
 *  - если тот же каталог упоминает другая живая задача, убирать нельзя: вторая
 *    задача потеряет свою рабочую копию прямо во время выполнения;
 *  - ветка намеренно не удаляется: по ней может быть открыт ещё не слитый
 *    PR/MR, а его закрытие - не задача этого модуля;
 *  - все git-мутации идут под локом проекта (withProjectGitLock), потому что
 *    два параллельных cleanup'а одного репозитория ломают его индекс.
 *
 * Модуль никогда не бросает исключение наружу: уборка фоновая, и её сбой не
 * должен ронять ни завершение задачи, ни цикл опроса координатора. Вместо этого
 * возвращается результат с полем reason, а причина остаётся в логах.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { countOtherLiveTasksReferencingWorktree } from "@aif/data";
import { logger, workingTreeClean } from "@aif/shared";
import { withProjectGitLock } from "./gitOperationLock.js";

// Имя логгера фиксировано: по нему сообщения уборки отличимы от сообщений
// остальных подсистем агента, которые пишут в общий поток.
const log = logger("worktree-lifecycle");

// Вход принимает уже разрешённые пути и имя ветки, а не сам объект задачи:
// вызывающий код (завершение задачи, сверка worktree) знает о задаче больше и
// не должен заставлять этот модуль лишний раз ходить в базу.
export interface StashAndRemoveWorktreeInput {
  taskId: string;
  projectId: string;
  projectRoot: string;
  branchName: string | null;
  worktreePath: string | null;
  /** Произвольная причина, записываемая в сообщение stash и в логи. */
  reason: string;
}

// Результат возвращается, а не бросается: cleanup фоновый, и падение на нём
// не должно ронять ни завершение задачи, ни цикл опроса координатора.
// skippedDueToReference отделяет "каталог ещё нужен" от "убрать не вышло".
export interface StashAndRemoveWorktreeResult {
  cleaned: boolean;
  reason?: string;
  skippedDueToReference?: boolean;
  /** SHA stash'а, созданного для незакоммиченной работы (null, если дерево было чистым). */
  stashSha?: string | null;
}

// execFileSync вместо склейки shell-строки: аргументы не проходят через
// интерпретатор, поэтому имена веток и пути со спецсимволами не могут
// превратиться в чужую команду.
// Ненулевой код возврата git - для нас ожидаемая ситуация (нет ветки, занятый
// каталог), поэтому ошибка превращается в обычный результат, а не исключение.
function runGit(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    // stdin не нужен, а stdout/stderr вычитываем сами: иначе git попытается
    // открыть терминал и процесс повиснет в фоне.
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: stdout.trim(), stderr: "" };
  } catch (err) {
    // Текст ошибки приходит буфером или строкой в зависимости от платформы,
    // поэтому оба поля приводятся к строке явно.
    const error = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      // Единица по умолчанию: вызывающему коду важен только факт "не ноль".
      status: typeof error.status === "number" ? error.status : 1,
      stdout: error.stdout ? error.stdout.toString().trim() : "",
      stderr: error.stderr ? error.stderr.toString().trim() : String(err),
    };
  }
}

/**
 * Снимок → stash → проверка ссылок → remove → prune рабочего дерева задачи.
 *
 * Порядок намеренный: незакоммиченная работа убирается в stash (никогда не
 * уничтожается) ДО удаления каталога, а удаление отклоняется, когда другая
 * живая задача всё ещё ссылается на тот же каталог. Ветка намеренно остаётся —
 * открытый PR/MR всё ещё может на неё опираться.
 */
export async function stashAndRemoveWorktree(
  input: StashAndRemoveWorktreeInput,
): Promise<StashAndRemoveWorktreeResult> {
  const { taskId, projectId, projectRoot, branchName, worktreePath, reason } = input;

  // Первое сообщение доносит до лога все параметры запроса: если процесс упадёт
  // внутри git-вызова, по логу всё равно будет видно, что именно убирали.
  log.info(
    { taskId, branchName, worktreePath, step: "snapshot", reason },
    "Worktree cleanup requested",
  );

  // Задача могла ни разу не дойти до создания worktree - это не ошибка:
  // убирать нечего, и повторные попытки бессмысленны.
  if (!worktreePath) {
    log.warn({ taskId, reason }, "Worktree cleanup skipped: task has no recorded worktree");
    return { cleaned: false, reason: "no_worktree" };
  }

  // Каталог уже удалён извне (руками или прошлой уборкой), но регистрация в
  // .git/worktrees могла остаться и продолжает удерживать ветку.
  if (!existsSync(worktreePath)) {
    log.warn(
      { taskId, branchName, worktreePath },
      "Worktree cleanup skipped: folder no longer exists; pruning stale registrations",
    );
    await withProjectGitLock({ projectRoot, operation: "worktree-prune" }, () =>
      runGit(projectRoot, ["worktree", "prune"]),
    );
    return { cleaned: false, reason: "worktree_missing" };
  }

  // Один каталог может использоваться несколькими живыми задачами (наследие
  // ручных правок), поэтому ссылки проверяются по базе, а не по текущему taskId.
  const references = countOtherLiveTasksReferencingWorktree({
    projectId,
    branchName,
    worktreePath,
    excludeTaskId: taskId,
  });
  log.info(
    { taskId, branchName, worktreePath, step: "reference_check", references },
    "Worktree reference check completed",
  );
  // Чужая живая задача в этом же каталоге - не наша забота: уборку нужно просто
  // пропустить, а не ждать освобождения лока и повторять попытку.
  if (references > 0) {
    log.warn(
      { taskId, branchName, worktreePath, references },
      "Worktree cleanup skipped: another live task references the same worktree",
    );
    return { cleaned: false, reason: "referenced_by_live_task", skippedDueToReference: true };
  }

  // Весь блок stash -> remove -> prune идёт под ОДНИМ локом проекта: между
  // шагами не должен проскочить другой git-процесс, иначе индекс разъедется.
  return withProjectGitLock({ projectRoot, operation: "worktree-cleanup" }, () => {
    // SHA заполняется только если stash реально создан; null здесь означает
    // "снимать было нечего", и по этому признаку случай отличается от сбоя.
    let stashSha: string | null = null;

    // Stash на чистом дереве создал бы пустой коммит и засорил историю stash'ей,
    // поэтому сначала проверяем, есть ли вообще что снимать.
    if (workingTreeClean(worktreePath)) {
      log.info(
        { taskId, branchName, worktreePath, step: "stash", stashSha: null },
        "Worktree already clean; skipping stash",
      );
    } else {
      // Причина попадает в само сообщение stash'а: позже по нему можно понять,
      // из-за какого сценария работа была отложена, не поднимая логи агента.
      const stashMessage = `aif task ${taskId} cleanup: ${reason}`;
      const stashResult = runGit(worktreePath, ["stash", "push", "-u", "-m", stashMessage]);
      // Неудачный stash - единственный случай, когда каталог НЕ удаляется:
      // работа ещё лежит в нём, и удаление потеряло бы её безвозвратно.
      if (stashResult.status !== 0) {
        log.error(
          {
            taskId,
            branchName,
            worktreePath,
            step: "stash",
            stderr: stashResult.stderr,
          },
          "Worktree cleanup aborted: stash failed; worktree not removed",
        );
        return { cleaned: false, reason: "stash_failed" };
      }
      // refs/stash после успешного push указывает на свежий stash, поэтому его
      // SHA можно сохранить и показать оператору в карточке задачи.
      const shaResult = runGit(worktreePath, ["rev-parse", "refs/stash"]);
      stashSha = shaResult.status === 0 && shaResult.stdout ? shaResult.stdout : null;
      log.info(
        { taskId, branchName, worktreePath, step: "stash", stashSha },
        "Stashed uncommitted worktree changes",
      );
    }

    // --force здесь безопасен: незакоммиченное уже убрано в stash выше, а
    // задача шага - именно удалить каталог, а не сохранить его состояние.
    const removeResult = runGit(projectRoot, ["worktree", "remove", "--force", worktreePath]);
    if (removeResult.status !== 0) {
      log.error(
        { taskId, branchName, worktreePath, step: "remove", stderr: removeResult.stderr },
        "Worktree removal failed",
      );
      return { cleaned: false, reason: "remove_failed", stashSha };
    }
    log.info(
      { taskId, branchName, worktreePath, step: "remove", stashSha },
      "Removed task worktree",
    );

    // prune - добивка, а не обязательный шаг: remove уже освободил ветку,
    // поэтому его сбой только фиксируется в логе и не отменяет cleaned=true.
    const pruneResult = runGit(projectRoot, ["worktree", "prune"]);
    if (pruneResult.status !== 0) {
      log.warn(
        { taskId, step: "prune", stderr: pruneResult.stderr },
        "Worktree prune failed (best-effort)",
      );
    } else {
      log.info(
        { taskId, branchName, worktreePath, step: "prune", stashSha },
        "Pruned worktree registrations",
      );
    }

    return { cleaned: true, stashSha };
  });
}
