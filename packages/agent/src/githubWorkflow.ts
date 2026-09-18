/**
 * Синхронизация проектов GitHub и публикация pull request-ов для пайплайна Handoff.
 *
 * Модуль держит две роли: фоновый опрос репозиториев (best-effort, ошибки только
 * логируются) и публикация PR-ов по стадиям (сбой блокирует стадию через
 * StageManualBlockError и ждет оператора).
 *
 * Почему форма такая: агент не хранит токены GitHub. Операции, требующие доступа к API,
 * делегируются API-сервису по внутреннему HTTP, а за агентом остается только git-часть
 * (пуш ветки) и детерминированный порядок шагов.
 *
 * Файл сознательно симметричен packages/agent/src/gitlabWorkflow.ts: те же точки входа
 * и тот же порядок "коммит - пуш - публикация"; отличаются только провайдерские детали
 * (pull request против merge request, /github/ против /gitlab/ в путях API).
 */

import { execFileSync } from "node:child_process";
import {
  appendTaskActivityLog,
  findGitHubIssueByTaskId,
  findTaskById,
  listEnabledGitHubRepositories,
} from "@aif/data";
import { getEnv, logger } from "@aif/shared";
import { ensureAutoQueueTaskCommit } from "./autoQueueCommit.js";
import { internalApiHeaders } from "./notifier.js";
import { StageManualBlockError } from "./stageErrorHandler.js";

const log = logger("github-workflow");

// Ограничение частоты опроса: синхронизация идет тем же циклом, что и обработка задач,
// и без троттлинга каждый тик дергал бы GitHub API по каждому репозиторию.
const SYNC_INTERVAL_MS = 60_000;

// Карта живет только в памяти процесса и прикрывает случай, когда lastSyncedAt в БД еще
// свежий, но попытка уже провалилась: повторять ее на каждом тике не нужно.
const lastSyncAttempts = new Map<string, number>();

interface GitHubApiFailure {
  error?: string;
  code?: string;
  retryAt?: string | null;
}

// Тело ошибки читается отдельным шагом: ответ может быть не JSON (прокси, HTML-страница),
// и падение парсинга не должно подменять исходную ошибку публикации.
async function readFailure(response: Response): Promise<GitHubApiFailure> {
  try {
    return (await response.json()) as GitHubApiFailure;
  } catch {
    return {};
  }
}

export async function synchronizeGitHubProjects(now = Date.now()): Promise<void> {
  const env = getEnv();
  // Двойной гейт: провайдер проекта и флаг раскатки. Проверка стоит здесь, а не у
  // вызывающего кода, чтобы выключенный GitHub не давал ни одного сетевого вызова.
  if (env.GIT_PROVIDER !== "github" || !env.AIF_GITHUB_ISSUE_PR_ENABLED) {
    log.debug(
      "GitHub synchronization skipped because provider selector or rollout flag is disabled",
    );
    return;
  }
  const baseUrl = env.API_BASE_URL;
  for (const connection of listEnabledGitHubRepositories()) {
    // Сравниваются два независимых времени: успешная синхронизация по данным БД и
    // последняя попытка в этом процессе. Второе не дает ретраить упавший проект на
    // каждом тике.
    const lastSync = connection.lastSyncedAt ? Date.parse(connection.lastSyncedAt) : 0;
    const lastAttempt = lastSyncAttempts.get(connection.projectId) ?? 0;
    if (
      (Number.isFinite(lastSync) && now - lastSync < SYNC_INTERVAL_MS) ||
      now - lastAttempt < SYNC_INTERVAL_MS
    ) {
      continue;
    }
    // Отметка ставится до запроса: иначе медленный или зависший вызов разрешил бы
    // параллельный дубль на следующем тике.
    lastSyncAttempts.set(connection.projectId, now);

    // Сеть к GitHub закрыта внутри API-сервиса: агент не хранит токен и обращается к
    // нему по внутреннему HTTP с заголовками internalApiHeaders().
    const url = `${baseUrl}/projects/${connection.projectId}/github/sync`;
    try {
      // Жесткий таймаут: фоновый тик не должен зависать из-за недоступного API.
      const response = await fetch(url, {
        method: "POST",
        headers: internalApiHeaders(),
        body: "{}",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const failure = await readFailure(response);
        log.warn(
          {
            projectId: connection.projectId,
            status: response.status,
            code: failure.code ?? "github_sync_failed",
            retryAt: failure.retryAt ?? null,
          },
          "GitHub repository sync deferred",
        );
      }
    } catch (error) {
      // Синхронизация best-effort: сбой логируется и не прерывает обход остальных
      // репозиториев и работу координатора.
      log.warn(
        { projectId: connection.projectId, err: error },
        "GitHub repository sync unavailable",
      );
    }
  }
}

// Пуш выполняется execFileSync с массивом аргументов, а не через shell-строку: имя
// ветки приходит из данных задачи и не должно попадать в интерпретацию оболочки.
// stdio уводит вывод git в pipe, чтобы он не утек в лог координатора.
function pushBranch(projectRoot: string, branch: string): void {
  execFileSync("git", ["push", "--set-upstream", "origin", branch], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function publishGitHubPlanTask(taskId: string, projectRoot: string): Promise<boolean> {
  // false означает "не применимо" (чужой провайдер, выключенный флаг): настоящие сбои
  // бросают StageManualBlockError и останавливают стадию до вмешательства оператора.
  if (getEnv().GIT_PROVIDER !== "github" || !getEnv().AIF_GITHUB_ISSUE_PR_ENABLED) {
    log.debug(
      { taskId },
      "GitHub plan PR publication skipped because provider selector or rollout flag is disabled",
    );
    return false;
  }
  const issue = findGitHubIssueByTaskId(taskId);
  // Задача без синхронизированного issue не публикуется: привязывать PR не к чему.
  if (!issue) return false;

  const task = findTaskById(taskId);
  // Ветка обязательна: без нее пушить нечего, и это не временный сбой, а неверная
  // конфигурация потока, поэтому исключение, а не false.
  if (!task?.branchName) {
    throw new StageManualBlockError("GitHub plan PR publication requires a task branch.");
  }

  // Работа ведется в worktree задачи, если он есть: корень проекта может быть занят
  // другой задачей с собственной веткой.
  const executionRoot = task.worktreePath ?? projectRoot;

  // Пуш предшествует вызову API: сервис публикации исходит из того, что ветка уже
  // существует на remote.
  try {
    pushBranch(executionRoot, task.branchName);
  } catch (error) {
    log.error({ taskId, branch: task.branchName, err: error }, "GitHub plan branch push failed");
    throw new StageManualBlockError(
      "GitHub branch push failed. Check repository access and Git credentials, then retry.",
    );
  }

  // Публикация PR - операция API-сервиса: там живут токены и логика прав доступа.
  // Агент лишь сообщает, какую ветку нужно опубликовать.
  const url = `${getEnv().API_BASE_URL}/projects/${task.projectId}/github/tasks/${taskId}/publish-plan`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: internalApiHeaders(),
      body: JSON.stringify({ branch: task.branchName }),
      signal: AbortSignal.timeout(getEnv().AGENT_GIT_PUBLISH_TIMEOUT_MS),
    });
  } catch (error) {
    // Транспортный сбой отличается от отказа API по статусу: здесь сеть или таймаут.
    log.error({ taskId, branch: task.branchName, err: error }, "GitHub plan PR API unavailable");
    throw new StageManualBlockError(
      "GitHub plan PR publication is unavailable. Check the API service and retry.",
    );
  }
  if (!response.ok) {
    const failure = await readFailure(response);
    log.warn(
      {
        taskId,
        branch: task.branchName,
        status: response.status,
        code: failure.code ?? "github_plan_publish_failed",
        retryAt: failure.retryAt ?? null,
      },
      "GitHub plan PR publication failed",
    );
    // retryAt приходит от API при rate limit: сообщение говорит оператору, когда именно
    // повторять, вместо общего "попробуйте позже".
    throw new StageManualBlockError(
      failure.retryAt
        ? `GitHub rate limit reached until ${failure.retryAt}. Retry after that time.`
        : "GitHub plan PR publication failed. Check repository permissions and retry.",
    );
  }

  // Запись в лог активности идет только после успешного ответа: журнал отражает факт
  // публикации, а не попытку.
  const completedAt = new Date().toISOString();
  appendTaskActivityLog(
    taskId,
    `[${completedAt}] [github] Published plan PR for ${task.branchName} (issue #${issue.issueNumber})`,
  );
  log.info(
    { taskId, issueNumber: issue.issueNumber, branch: task.branchName },
    "GitHub plan pull request published",
  );
  return true;
}

export async function publishGitHubTask(taskId: string, projectRoot: string): Promise<boolean> {
  // Симметрично publishGitHubPlanTask: тот же гейт провайдера и флага раскатки.
  if (getEnv().GIT_PROVIDER !== "github" || !getEnv().AIF_GITHUB_ISSUE_PR_ENABLED) {
    log.debug(
      { taskId },
      "GitHub pull request publication skipped because provider selector or rollout flag is disabled",
    );
    return false;
  }
  const issue = findGitHubIssueByTaskId(taskId);
  if (!issue) return false;

  // Режим plan_review ожидается выставленным еще на этапе планирования. Его отсутствие
  // не блокирует финальную публикацию, но означает расхождение с ожидаемым потоком,
  // поэтому WARN, а не ERROR.
  if (getEnv().AIF_PLAN_REVIEW_PR_ENABLED && issue.prMode !== "plan_review") {
    log.warn(
      {
        taskId,
        issueNumber: issue.issueNumber,
        prNumber: issue.prNumber ?? null,
        prMode: issue.prMode ?? null,
      },
      "Final GitHub publication started without a prior plan-review PR mode",
    );
  }

  const task = findTaskById(taskId);
  if (!task?.branchName) {
    throw new StageManualBlockError("GitHub pull request publication requires a task branch.");
  }
  const executionRoot = task.worktreePath ?? projectRoot;

  // Коммит-гейт выполняется с ожиданием и до пуша: незакоммиченные правки иначе остались
  // бы в рабочем дереве, а на remote ушла бы пустая ветка.
  const commit = await ensureAutoQueueTaskCommit({ taskId, projectRoot: executionRoot });

  // Порядок как в плановом пути: сначала ветка на remote, затем публикация PR.
  try {
    pushBranch(executionRoot, task.branchName);
  } catch (error) {
    log.error({ taskId, branch: task.branchName, err: error }, "GitHub task branch push failed");
    throw new StageManualBlockError(
      "GitHub branch push failed. Check repository access and Git credentials, then retry.",
    );
  }

  // Задача перечитывается после коммита: хук коммита мог дописать implementationLog, а в
  // тело запроса должно уйти актуальное состояние, а не снапшот до коммита.
  const refreshed = findTaskById(taskId);
  const url = `${getEnv().API_BASE_URL}/projects/${task.projectId}/github/tasks/${taskId}/publish`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: internalApiHeaders(),
      body: JSON.stringify({
        branch: task.branchName,
        commitSha: commit.commitSha,
        implementationLog: refreshed?.implementationLog ?? null,
        reviewComments: refreshed?.reviewComments ?? null,
      }),
      signal: AbortSignal.timeout(getEnv().AGENT_GIT_PUBLISH_TIMEOUT_MS),
    });
  } catch (error) {
    log.error(
      { taskId, branch: task.branchName, err: error },
      "GitHub pull request API unavailable",
    );
    throw new StageManualBlockError(
      "GitHub pull request publication is unavailable. Check the API service and retry.",
    );
  }
  if (!response.ok) {
    const failure = await readFailure(response);
    log.warn(
      {
        taskId,
        branch: task.branchName,
        status: response.status,
        code: failure.code ?? "github_publish_failed",
        retryAt: failure.retryAt ?? null,
      },
      "GitHub pull request publication failed",
    );
    throw new StageManualBlockError(
      failure.retryAt
        ? `GitHub rate limit reached until ${failure.retryAt}. Retry after that time.`
        : "GitHub pull request publication failed. Check repository permissions and retry.",
    );
  }

  const completedAt = new Date().toISOString();
  appendTaskActivityLog(
    taskId,
    `[${completedAt}] [github] Published ${task.branchName} for issue #${issue.issueNumber}`,
  );
  log.info(
    { taskId, issueNumber: issue.issueNumber, branch: task.branchName },
    "GitHub pull request synchronized",
  );
  return true;
}
