/**
 * Публикация Change Plan для гейта plan_review: коммит только плана, push ветки и
 * создание PR/MR на стороне провайдера.
 *
 * Зачем отдельный модуль:
 *  - задача с привязанным issue (GitHub/GitLab) должна остановиться на
 *    plan_review и ждать решения человека в PR/MR, а не идти в реализацию;
 *  - на этом шаге коммитится ТОЛЬКО файл плана: если случайно отправить
 *    продуктовый код, ревью плана превратится в ревью реализации;
 *  - стадия зациклена сама на себя (задача остаётся в plan_review), поэтому
 *    публикация обязана быть идемпотентной - иначе каждый цикл опроса создавал
 *    бы новый PR/MR;
 *  - отсутствие ветки или файла плана - не авария, а отложенная попытка: задача
 *    остаётся в plan_review и будет опубликована в следующем цикле;
 *  - сбой push или API провайдера, наоборот, требует человека и выражается
 *    StageManualBlockError, по которому координатор уводит задачу в
 *    blocked_external.
 */

import {
  appendTaskActivityLog,
  findGitHubIssueByTaskId,
  findGitLabIssueByTaskId,
  findTaskById,
  markTaskPlanPublished,
} from "@aif/data";
import { getEnv, getHeadCommitSha, logger } from "@aif/shared";
import { ensurePlanReviewCommit } from "./planReviewCommit.js";
import { publishGitHubPlanTask } from "./githubWorkflow.js";
import { publishGitLabPlanTask } from "./gitlabWorkflow.js";
import { StageManualBlockError } from "./stageErrorHandler.js";

const log = logger("plan-review:publisher");

/**
 * True, если задача, связанная с VCS-issue, обязана остановиться на
 * `plan_review` и ждать человеческого одобрения в PR/MR перед реализацией.
 * Подходят только связи из включённых режимов провайдеров; чисто локальные
 * задачи сохраняют legacy-локальный поток. Флаг rollout'а и текущая связь
 * читаются живьём, чтобы тесты могли переключать и то и другое.
 */
export function taskRequiresPlanReview(taskId: string): boolean {
  // Окружение читается на каждом вызове, а не кэшируется на уровне модуля:
  // тесты переключают флаг rollout'а и должны видеть новое значение сразу.
  const env = getEnv();
  if (!env.AIF_PLAN_REVIEW_PR_ENABLED) return false;
  // ?? вместо ||: вторая проверка выполняется только если первой ссылки нет, и
  // мы не делаем лишний запрос к базе ради уже известного ответа.
  return Boolean(findGitHubIssueByTaskId(taskId) ?? findGitLabIssueByTaskId(taskId));
}

/**
 * Публикует Change Plan задачи plan-review и оставляет её ждать в
 * `plan_review`, пока человек не одобрит в VCS.
 *
 * Обязанности (по порядку):
 *  1. Отклоняет задачи, не подходящие для plan-review (они остаются на
 *     `plan_review` в self-loop и никогда не публикуются).
 *  2. Детерминированно коммитит только файл(ы) плана с non-LLM subject
 *     (ensurePlanReviewCommit) — никогда продуктовые файлы.
 *  3. Делегирует пуш ветки + публикацию plan PR/MR workflow провайдера
 *     (GitHub/GitLab), который не должен добавлять `Closes #...`.
 *  4. Атомарно фиксирует `planReviewState=published` и оставляет задачу на
 *     `plan_review` (self-loop) через markTaskPlanPublished (с аудитом).
 *
 * Отсутствие ветки/плана — откладывание только с WARN: задача остаётся на
 * `plan_review` для повторной попытки. Сбои push или API бросают
 * StageManualBlockError — координатор уведёт задачу в blocked_external оператору.
 */
export async function runPlanReviewPublisher(taskId: string, projectRoot: string): Promise<void> {
  const task = findTaskById(taskId);
  if (!task) {
    // Отсутствующая задача - это уже не отложенная попытка, а рассинхрон: молча
    // вернуться нельзя, иначе координатор будет вечно считать шаг успешным.
    log.error({ taskId }, "Plan review publish skipped: task not found");
    throw new Error(`Task ${taskId} not found`);
  }
  if (!taskRequiresPlanReview(taskId)) {
    // Ветка выхода без исключения: для локальной задачи или выключенного флага
    // шаг просто ничего не делает, и это нормальное завершение.
    log.debug(
      { taskId, status: task.status, planReviewState: task.planReviewState ?? null },
      "Plan review publish skipped: task is not VCS-linked or the feature flag is off",
    );
    return;
  }

  // План живёт там же, где потом пойдёт реализация: в worktree задачи, если он
  // есть, и в корне проекта в локальном режиме без worktree.
  const executionRoot = task.worktreePath ?? projectRoot;
  const branch = task.branchName;
  if (!branch) {
    // Ветка появляется только после провижининга worktree; до этого публиковать
    // нечего и незачем блокировать задачу - ждём следующего цикла опроса.
    log.warn(
      { taskId, projectRoot, executionRoot },
      "Plan review publish deferred: task has no persisted branch yet",
    );
    return;
  }

  // Коммит делает не LLM, а детерминированный код: так состав файлов в коммите
  // не зависит от того, что модель решила "заодно поправить" по пути.
  // Детерминированный коммит только с планом. Отклоняет грязные продуктовые
  // файлы до одобрения, чтобы ревью плана никогда не унесло реализацию.
  const report = ensurePlanReviewCommit({ taskId, projectRoot: executionRoot });
  if (report.status === "blocked_missing_plan") {
    // Плана ещё нет (планировщик мог не успеть) - это отложенная попытка, а не
    // ошибка: следующий проход повторит её.
    log.warn(
      { taskId, executionRoot, planPath: report.planPath },
      "Plan review publish deferred: plan file is missing",
    );
    return;
  }
  if (
    report.status === "blocked_dirty_product_files" ||
    report.status === "not_a_git_repo" ||
    report.status === "commit_failed"
  ) {
    // Грязные продуктовые файлы, не-репозиторий и упавший коммит не лечатся
    // повтором: дальше может уйти не тот код, поэтому нужен человек.
    log.error(
      {
        taskId,
        status: report.status,
        executionRoot,
        dirtyProductPaths: report.dirtyProductPaths,
        error: report.error ?? null,
      },
      "Plan review publish blocked before branch push",
    );
    throw new StageManualBlockError(
      `Plan review publish blocked (${report.status}). Inspect the work tree and retry.`,
    );
  }
  // Коммит мог и не создаваться (план уже был закоммичен) - тогда фиксируем
  // текущий HEAD, чтобы идемпотентность сравнивала именно состояние плана.
  const commitSha = report.commitSha ?? getHeadCommitSha(executionRoot);

  // Идемпотентность: пропускаем повторную публикацию, когда план уже опубликован и не менялся.
  // Иначе self-loop стадия переопубликовывала бы PR/MR на каждом цикле опроса.
  if (task.planReviewState === "published" && commitSha === task.planReviewCommitSha) {
    log.debug(
      { taskId, planReviewCommitSha: task.planReviewCommitSha },
      "Plan review publish skipped: already published",
    );
    return;
  }

  const githubIssue = findGitHubIssueByTaskId(taskId);
  const gitlabIssue = findGitLabIssueByTaskId(taskId);

  // Ссылки перечитываются перед публикацией: выше мог пройти коммит, и к этому
  // моменту связь задачи с issue могла появиться или исчезнуть.
  let published: boolean;
  if (githubIssue) {
    published = await publishGitHubPlanTask(taskId, projectRoot);
  } else if (gitlabIssue) {
    published = await publishGitLabPlanTask(taskId, projectRoot);
  } else {
    // Ссылка исчезла между проверкой и публикацией: без неё непонятно, куда
    // открывать PR/MR, поэтому просто ждём следующего цикла.
    log.debug({ taskId }, "Plan review publish skipped: issue link disappeared before publish");
    return;
  }

  if (!published) {
    // false - это не исключение: провайдер мог отложить публикацию (например,
    // сеть или лимиты), и задача остаётся в plan_review до следующей попытки.
    log.warn(
      { taskId, branch, provider: githubIssue ? "github" : "gitlab" },
      "Plan review publish did not complete; task stays at plan_review",
    );
    return;
  }

  const now = new Date().toISOString();
  // Сначала человекочитаемая запись в ленту задачи, потом атомарный переход
  // статуса: если переход упадёт, в ленте всё равно останется свидетельство
  // того, что план уже опубликован.
  appendTaskActivityLog(
    taskId,
    `[${now}] [plan-review] Published change plan on ${branch} (${commitSha}) for review`,
  );
  const result = markTaskPlanPublished({ taskId, commitSha });
  if (!result.ok) {
    // PR/MR уже создан, откатить публикацию нельзя: оператору нужно вручную
    // привести статус задачи в соответствие с реальностью.
    log.error(
      { taskId, code: result.code, currentStatus: result.currentStatus ?? null },
      "Failed to mark task plan as published",
    );
    throw new StageManualBlockError(
      `Plan review publish finished but the status transition failed (${result.code}).`,
    );
  }
  log.info(
    {
      taskId,
      branch,
      commitSha,
      githubIssue: Boolean(githubIssue),
      gitlabIssue: Boolean(gitlabIssue),
    },
    "Change plan published for review",
  );
}
