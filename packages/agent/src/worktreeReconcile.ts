/**
 * Сверка объявленного в базе состояния worktree с тем, что реально лежит на
 * диске, плюс чистка висячих ссылок на issue в VCS.
 *
 * Инварианты и причины такой формы:
 *  - источник истины - база: если живой задачи у каталога нет, каталог считается
 *    осиротевшим и подлежит уборке (именно такой бесхозный каталог, удерживающий
 *    ветку, был причиной инцидента);
 *  - чистим только предсказуемо: путь обязан лежать внутри корня worktree
 *    проекта, иначе легко тронуть соседний репозиторий или чужой каталог;
 *  - ветка живой задачи неприкосновенна: между созданием каталога и записью
 *    строки в базу есть окно провижининга, и в этот момент worktree выглядит
 *    осиротевшим, хотя им уже пользуются;
 *  - нездоровые регистрации (каталога нет, ссылка .git битая) снимаются
 *    принудительно: засташить их нельзя, а ветку они держат;
 *  - отсутствующий или испорченный каталог живой задачи восстанавливается по
 *    каноническому пути; если не вышло - задача паркуется в blocked_external,
 *    а не молча теряет рабочую копию.
 *
 * Всё best-effort: сбой сверки не должен ронять цикл опроса координатора, а сбой
 * по одному проекту не должен отменять сверку остальных.
 */

import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  clearDanglingVcsIssueLinks,
  findTaskById,
  listActiveTasksWithWorktrees,
  listProjects,
  setTaskFields,
  updateTaskStatus,
} from "@aif/data";
import {
  ensureTaskWorktree,
  isWorktreeUsable,
  listWorktrees,
  logger,
  pruneWorktrees,
  removeWorktreeForce,
  resolveWorktreeRoot,
} from "@aif/shared";
import { withProjectGitLock } from "./gitOperationLock.js";
import { stashAndRemoveWorktree } from "./worktreeLifecycle.js";

// Отдельный логгер на подсистему: сверка шумная, и её сообщения нужно уметь
// отфильтровать от остального потока агента.
const log = logger("worktree-reconcile");

// Один вызов - один репозиторий: так ошибка сверки остаётся локальной для
// проекта, и её можно показать оператору с конкретным корнем.
export interface ReconcileWorktreesInput {
  projectId: string;
  projectRoot: string;
  reason: string;
}

// Сводка возвращается наружу, потому что сверка идёт фоном: без неё ни лог, ни
// тест не смогли бы отличить "нечего чистить" от "не смогли почистить".
export interface ReconcileWorktreesSummary {
  scanned: number;
  removed: number;
  repaired: number;
  adoptedLegacy: number;
  danglingLinksCleared: number;
}

// resolve приводит относительные пути к абсолютным, а регистр и хвостовой
// разделитель убираются потому, что Windows отдаёт тот же путь в другом регистре
// и с обратными слешами.
function normalizePath(value: string): string {
  return resolve(value)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

// Разделитель добавляется перед сравнением: без него каталог-сосед с общим
// префиксом (например, worktrees-old) считался бы вложенным в worktrees.
function isUnderWorktreeRoot(candidate: string, worktreeRoot: string): boolean {
  const normalizedRoot = resolve(worktreeRoot)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
  return normalizePath(candidate).startsWith(`${normalizedRoot}${sep}`);
}

// Последняя линия обороны: задача, которую не удалось восстановить, паркуется в
// blocked_external, а не остаётся в рабочем статусе без рабочей копии.
function parkTask(taskId: string, reason: string): void {
  // Статус читается до перехода, чтобы сохранить его в blockedFromStatus и потом
  // вернуть задачу туда же при снятии блокировки.
  const task = findTaskById(taskId);
  try {
    // Актор system: парковку выполнил не человек и не LLM, и это должно быть
    // явно видно в аудите перехода.
    updateTaskStatus(
      taskId,
      "blocked_external",
      {
        blockedReason: reason,
        blockedFromStatus: task?.status ?? null,
        retryAfter: null,
      },
      {
        kind: "system",
        id: "worktree-reconcile",
        displayNameSnapshot: "Worktree reconciliation",
      },
    );
    log.error({ taskId, reason }, "Parked task as blocked_external after reconciliation failure");
  } catch (error) {
    // Сбой парковки только логируется: вызов уже идёт по ветке обработки ошибки,
    // и вторая ошибка не должна её перекрыть.
    log.error(
      { taskId, reason, err: error instanceof Error ? error.message : String(error) },
      "Failed to park task after reconciliation failure",
    );
  }
}

/**
 * Сверяет БД (объявленный источник истины по worktree) с каталогами на диске
 * и связями задач с VCS:
 *
 *  - удаляет и чистит worktree без ссылок на живые задачи;
 *  - удаляет нездоровые регистрации (каталог удалён / ссылка `.git` сломана),
 *    чтобы они не удерживали ветку;
 *  - восстанавливает отсутствующий или непригодный каталог живой задачи по
 *    каноническому пути, иначе паркует задачу в blocked_external;
 *  - очищает висячие ссылки `github_issues`/`gitlab_issues`.
 *
 * Режим best-effort: сбой здесь не должен ронять цикл опроса.
 */
export async function reconcileWorktrees(
  input: ReconcileWorktreesInput,
): Promise<ReconcileWorktreesSummary> {
  const { projectId, projectRoot, reason } = input;
  // Счётчики живут только внутри вызова: они описывают текущий проход и не
  // должны переживать его между запусками.
  let scanned = 0;
  let removed = 0;
  let repaired = 0;
  let adoptedLegacy = 0;

  // Снимок живых задач берётся один раз, до обоих циклов: решения внутри одного
  // прохода должны опираться на одно и то же состояние базы.
  const activeTasks = listActiveTasksWithWorktrees(projectId);
  // Множества дают O(1) ответ на вопрос "каталог ещё чей-то?" внутри цикла по
  // файловой системе, где этот вопрос задаётся для каждой записи.
  const referencedPaths = new Set(activeTasks.map((task) => normalizePath(task.worktreePath)));
  const referencedBranches = new Set(
    activeTasks
      .map((task) => task.branchName)
      // null-ветки отбрасываются здесь же, чтобы дальше не тащить проверку на
      // null и не сужать ветку в каждой итерации цикла.
      .filter((branch): branch is string => Boolean(branch)),
  );
  // Корень worktree - граница ответственности: всё, что лежит вне него, сверка
  // не трогает, даже если git о нём знает.
  const { worktreeRoot } = resolveWorktreeRoot(projectRoot);

  // Проход идёт по файловой системе, а не по базе: ищем именно каталоги, о
  // которых база уже забыла, поэтому список из базы здесь бы не помог.
  for (const entry of listWorktrees(projectRoot)) {
    if (!isUnderWorktreeRoot(entry.path, worktreeRoot)) continue;
    // scanned считает только каталоги внутри корня worktree, то есть те, за
    // которые этот модуль отвечает.
    scanned += 1;
    // Путь закреплён за живой задачей - это не осиротевший worktree, уборка не
    // наша, даже если сам каталог выглядит заброшенным.
    if (referencedPaths.has(normalizePath(entry.path))) continue;

    // Ветка живой задачи может быть в окне провижининга (каталог уже создан,
    // строка в БД ещё не записана). Такой worktree удалять нельзя.
    if (entry.branch && referencedBranches.has(entry.branch)) {
      adoptedLegacy += 1;
      log.warn(
        { projectId, projectRoot, worktreePath: entry.path, branch: entry.branch },
        "Retaining worktree whose branch belongs to a live task (provisioning window)",
      );
      continue;
    }

    // Нездоровье определяется по двум признакам: git уже пометил регистрацию как
    // prunable, либо каталог перестал быть рабочей копией.
    const healthy = !entry.prunable && isWorktreeUsable(entry.path, entry.branch);
    if (!healthy) {
      // Устаревшая регистрация (нет каталога, сломана `.git` ссылка) удерживает
      // ветку и не поддаётся stash. Удаляем, чтобы следующий провижининг снова
      // смог выгрузить ветку.
      const forceRemoved = await withProjectGitLock(
        { projectRoot, operation: "reconcile-remove-unhealthy" },
        () => removeWorktreeForce(projectRoot, entry.path),
      );
      const prunedRegistrations = await withProjectGitLock(
        { projectRoot, operation: "reconcile-prune" },
        () => pruneWorktrees(projectRoot),
      );
      // remove может не сработать, поэтому очистка подтверждается фактом:
      // регистрации либо больше нет в списке worktree, либо она не удалилась.
      const registrationCleared =
        forceRemoved || !listWorktrees(projectRoot).some((item) => item.path === entry.path);
      // В счётчик попадают только реально снятые регистрации, иначе сводка
      // вводила бы оператора в заблуждение.
      if (registrationCleared) removed += 1;
      log.warn(
        {
          projectId,
          projectRoot,
          worktreePath: entry.path,
          branch: entry.branch,
          prunable: entry.prunable,
          forceRemoved,
          prunedRegistrations,
          registrationCleared,
        },
        registrationCleared
          ? "Removed unhealthy worktree registration"
          : "Could not remove unhealthy worktree registration; manual cleanup required",
      );
      continue;
    }

    // taskId синтетический: строки в базе у этого каталога нет, но stash всё
    // равно нужен, чтобы не потерять чужую незакоммиченную работу.
    const result = await stashAndRemoveWorktree({
      taskId: `orphan:${entry.path}`,
      projectId,
      projectRoot,
      branchName: entry.branch,
      worktreePath: entry.path,
      reason: `reconcile_orphan:${reason}`,
    });
    // При отказе (например, stash_failed) каталог остаётся на диске: это видно
    // оператору по логу, а следующий проход повторит попытку.
    if (result.cleaned) {
      removed += 1;
      log.warn(
        { projectId, projectRoot, worktreePath: entry.path, branch: entry.branch },
        "Removed orphan worktree not referenced by any live task",
      );
    }
  }

  // Второй проход идёт уже по базе: теперь чиним то, что объявлено живым, но на
  // диске непригодно.
  for (const task of activeTasks) {
    // Здоровые задачи пропускаются без единого git-вызова: это горячий путь, и
    // опрос не должен тормозить на тех, у кого всё в порядке.
    if (isWorktreeUsable(task.worktreePath, task.branchName)) continue;

    // Если каталог отсутствует или больше не пригоден как checkout
    // (последствие частичного/неуспешного удаления), сначала снимаем stale
    // регистрации, освобождаем ветку и затем создаём канонический branch-scoped
    // worktree вместо попытки оживить повреждённый старый путь.
    // Старый путь сохраняется только для логов и текста блокировки: восстанавливать
    // будем по каноническому пути, а не по нему.
    const recordedPath = task.worktreePath;
    // Факт наличия каталога нужен позже, чтобы подсказать оператору про остаток,
    // который может держать ветку.
    const recordedPathExists = existsSync(recordedPath);
    // prune до провижининга: освобождаем ветку от stale-регистрации, иначе новый
    // worktree не сможет её занять и провижининг упрётся в занятую ветку.
    const prunedRegistrations = await withProjectGitLock(
      { projectRoot, operation: "reconcile-prune" },
      () => pruneWorktrees(projectRoot),
    );
    log.warn(
      {
        taskId: task.id,
        recordedWorktreePath: recordedPath,
        recordedPathExists,
        branchName: task.branchName,
        prunedRegistrations,
      },
      "Task worktree is missing or unusable; provisioning a fresh canonical worktree",
    );

    // title нужен только для имени каталога и логов, поэтому при сбое чтения
    // подставляется id: сверка не должна прерываться из-за косметики.
    const title = findTaskById(task.id)?.title ?? task.id;
    // Провиджининг идёт под локом: он меняет .git/worktrees, и параллельный
    // git-процесс затёр бы это изменение вслепую.
    try {
      const result = await withProjectGitLock({ projectRoot, operation: "reconcile-repair" }, () =>
        ensureTaskWorktree({
          projectRoot,
          taskId: task.id,
          title,
          projectId,
          explicitBranchName: task.branchName,
        }),
      );
      // Путь в результате означает, что каталог действительно создан; только
      // тогда его можно записать в базу как действующий.
      if (result.worktreePath) {
        // База догоняет диск сразу после успеха: это единственное место, где
        // сохраняется восстановленный путь.
        setTaskFields(task.id, {
          worktreePath: result.worktreePath,
          updatedAt: new Date().toISOString(),
        });
        repaired += 1;
        log.warn(
          {
            taskId: task.id,
            previousWorktreePath: recordedPath,
            worktreePath: result.worktreePath,
          },
          "Repaired task worktree",
        );
      } else {
        // Каталог не создан, но и исключения нет: причину берём из reason и
        // паркуем задачу, чтобы потеря worktree не осталась незамеченной.
        parkTask(
          task.id,
          `Worktree ${recordedPath} is missing or unusable and could not be recreated (${
            result.reason ?? "unknown reason"
          }).`,
        );
      }
    } catch (error) {
      // Подсказка про оставшийся каталог: именно он чаще всего держит ветку,
      // и без неё оператор искал бы причину отказа намного дольше.
      const manualHint = recordedPathExists
        ? ` Leftover folder at ${recordedPath} may still hold the branch; remove it or run 'git worktree prune'.`
        : "";
      parkTask(
        task.id,
        `Worktree ${recordedPath} is missing or unusable and recreation failed: ${
          error instanceof Error ? error.message : String(error)
        }.${manualHint}`,
      );
    }
  }

  // Висячие ссылки на issue чистятся в самом конце: до этого момента задача
  // могла быть опубликована, и ссылка ещё актуальна.
  const { githubLinksCleared, gitlabLinksCleared } = clearDanglingVcsIssueLinks();
  const danglingLinksCleared = githubLinksCleared + gitlabLinksCleared;

  // Сводка логируется целиком: сверка идёт фоном, поэтому другого способа
  // увидеть её результат у оператора нет.
  const summary: ReconcileWorktreesSummary = {
    scanned,
    removed,
    repaired,
    adoptedLegacy,
    danglingLinksCleared,
  };
  log.info({ projectId, projectRoot, reason, ...summary }, "Worktree reconciliation completed");
  return summary;
}

/**
 * Запускает сверку для каждого проекта.
 * Для каждого проекта используется best-effort, чтобы один проблемный
 * репозиторий не останавливал общий проход и цикл опроса.
 */
export async function reconcileAllProjectWorktrees(reason: string): Promise<void> {
  for (const project of listProjects()) {
    // У проекта без локального корня (например, чисто удалённого) сверять
    // нечего: список worktree просто не из чего получить.
    if (!project.rootPath) continue;
    try {
      await reconcileWorktrees({
        projectId: project.id,
        projectRoot: project.rootPath,
        reason,
      });
    } catch (error) {
      // Ошибка одного проекта гасится здесь, чтобы цикл продолжился и остальные
      // репозитории всё равно были сверены.
      log.error(
        {
          projectId: project.id,
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        "Worktree reconciliation failed for project; continuing",
      );
    }
  }
}
