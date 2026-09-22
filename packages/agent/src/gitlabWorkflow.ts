/**
 * Синхронизация проектов GitLab и публикация merge request-ов для пайплайна Handoff.
 *
 * Модуль держит две роли: фоновый опрос репозиториев (best-effort, ошибки только
 * логируются) и публикация MR-ов по стадиям (сбой блокирует стадию через
 * StageManualBlockError и ждет оператора).
 *
 * Почему форма такая: агент не хранит токены GitLab. Операции, требующие доступа к API,
 * делегируются API-сервису по внутреннему HTTP, а за агентом остается только git-часть
 * (пуш ветки) и детерминированный порядок шагов.
 *
 * Файл сознательно симметричен packages/agent/src/githubWorkflow.ts: те же точки входа
 * и тот же порядок "коммит - пуш - публикация"; отличаются только провайдерские детали
 * (merge request против pull request, /gitlab/ против /github/ в путях API, iid вместо
 * issueNumber в логах).
 */

import { execFileSync } from "node:child_process";
import {
  appendTaskActivityLog,
  findGitLabIssueByTaskId,
  findTaskById,
  listEnabledGitLabRepositories,
} from "@aif/data";
import { getEnv, logger } from "@aif/shared";
import { ensureAutoQueueTaskCommit } from "./autoQueueCommit.js";
import { internalApiHeaders } from "./notifier.js";
import { StageManualBlockError } from "./stageErrorHandler.js";

const log = logger("gitlab-workflow");

// Ограничение частоты опроса: синхронизация идет тем же циклом, что и обработка задач,
// и без троттлинга каждый тик дергал бы GitLab API по каждому репозиторию.
const SYNC_INTERVAL_MS = 60_000;

// Карта живет только в памяти процесса и прикрывает случай, когда lastSyncedAt в БД еще
// свежий, но попытка уже провалилась: повторять ее на каждом тике не нужно.
const lastSyncAttempts = new Map<string, number>();

interface GitLabSyncCorrelation {
  traceId: string | null;
  testId: string | null;
  projectScope: string[];
}

function parseScopedProjectIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function readGitLabSyncCorrelation(): GitLabSyncCorrelation {
  const traceId = process.env.AIF_GITLAB_SYNC_TRACE_ID?.trim() || null;
  const testId = process.env.AIF_GITLAB_SYNC_TEST_ID?.trim() || null;
  const projectScope = parseScopedProjectIds(process.env.AIF_GITLAB_SYNC_PROJECT_SCOPE);
  return { traceId, testId, projectScope };
}

interface GitLabApiFailure {
  error?: string;
  code?: string;
  retryAt?: string | null;
}

// Тело ошибки читается отдельным шагом: ответ может быть не JSON (прокси, HTML-страница),
// и падение парсинга не должно подменять исходную ошибку публикации.
async function readFailure(response: Response): Promise<GitLabApiFailure> {
  try {
    return (await response.json()) as GitLabApiFailure;
  } catch {
    return {};
  }
}

// Единая точка проверки режима: и синхронизация, и обе публикации должны отвечать на
// один и тот же вопрос. Дублирование условия по местам вызова быстро разъехалось бы.
function gitLabModeActive(): boolean {
  const env = getEnv();
  return env.GIT_PROVIDER === "gitlab" && env.AIF_GITLAB_ISSUE_MR_ENABLED;
}

export async function synchronizeGitLabProjects(now = Date.now()): Promise<void> {
  if (!gitLabModeActive()) {
    // В лог уходят оба входных условия: при выключенном режиме иначе не отличить
    // "выбран другой провайдер" от "флаг раскатки не включен".
    log.debug(
      { gitProvider: getEnv().GIT_PROVIDER, gitLabEnabled: getEnv().AIF_GITLAB_ISSUE_MR_ENABLED },
      "GitLab synchronization skipped because provider selector or rollout flag is disabled",
    );
    return;
  }
  const baseUrl = getEnv().API_BASE_URL;
  const correlation = readGitLabSyncCorrelation();
  const scopeSet = correlation.projectScope.length > 0 ? new Set(correlation.projectScope) : null;

  for (const connection of listEnabledGitLabRepositories()) {
    if (scopeSet && !scopeSet.has(connection.projectId)) {
      log.debug(
        {
          projectId: connection.projectId,
          traceId: correlation.traceId,
          testId: correlation.testId,
          projectScope: correlation.projectScope,
        },
        "Skipping GitLab repository sync outside scoped project set",
      );
      continue;
    }
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

    // Сеть к GitLab закрыта внутри API-сервиса: агент не хранит токен и обращается к
    // нему по внутреннему HTTP с заголовками internalApiHeaders().
    const url = `${baseUrl}/projects/${connection.projectId}/gitlab/sync`;
    try {
      // Жесткий таймаут: фоновый тик не должен зависать из-за недоступного API.
      const syncPayload: Record<string, unknown> = {};
      if (correlation.traceId) syncPayload.traceId = correlation.traceId;
      if (correlation.testId) syncPayload.testId = correlation.testId;
      if (correlation.projectScope.length > 0) {
        syncPayload.projectScope = correlation.projectScope;
      }

      const response = await fetch(url, {
        method: "POST",
        headers: internalApiHeaders(),
        body: Object.keys(syncPayload).length > 0 ? JSON.stringify(syncPayload) : "{}",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const failure = await readFailure(response);
        log.warn(
          {
            projectId: connection.projectId,
            status: response.status,
            code: failure.code ?? "gitlab_sync_failed",
            retryAt: failure.retryAt ?? null,
            traceId: correlation.traceId,
            testId: correlation.testId,
            projectScope: correlation.projectScope,
          },
          "GitLab repository sync deferred",
        );
      }
    } catch (error) {
      // Синхронизация best-effort: сбой логируется и не прерывает обход остальных
      // репозиториев и работу координатора.
      log.warn(
        {
          projectId: connection.projectId,
          err: error,
          traceId: correlation.traceId,
          testId: correlation.testId,
          projectScope: correlation.projectScope,
        },
        "GitLab repository sync unavailable",
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

export async function publishGitLabPlanTask(taskId: string, projectRoot: string): Promise<boolean> {
  // false означает "не применимо" (чужой провайдер, выключенный флаг): настоящие сбои
  // бросают StageManualBlockError и останавливают стадию до вмешательства оператора.
  if (!gitLabModeActive()) {
    log.debug(
      { taskId, gitProvider: getEnv().GIT_PROVIDER },
      "GitLab plan MR publication skipped because provider selector or rollout flag is disabled",
    );
    return false;
  }
  const issue = findGitLabIssueByTaskId(taskId);
  // Задача без синхронизированного issue не публикуется: привязывать MR не к чему.
  if (!issue) return false;

  const task = findTaskById(taskId);
  // Ветка обязательна: без нее пушить нечего, и это не временный сбой, а неверная
  // конфигурация потока, поэтому исключение, а не false.
  if (!task?.branchName) {
    throw new StageManualBlockError("GitLab plan MR publication requires a task branch.");
  }

  // Работа ведется в worktree задачи, если он есть: корень проекта может быть занят
  // другой задачей с собственной веткой.
  const executionRoot = task.worktreePath ?? projectRoot;

  // Пуш предшествует вызову API: сервис публикации исходит из того, что ветка уже
  // существует на remote.
  try {
    pushBranch(executionRoot, task.branchName);
  } catch (error) {
    log.error({ taskId, branch: task.branchName, err: error }, "GitLab plan branch push failed");
    throw new StageManualBlockError(
      "GitLab branch push failed. Check repository access and Git credentials, then retry.",
    );
  }

  // Публикация MR - операция API-сервиса: там живут токены и логика прав доступа.
  // Агент лишь сообщает, какую ветку нужно опубликовать.
  const url = `${getEnv().API_BASE_URL}/projects/${task.projectId}/gitlab/tasks/${taskId}/publish-plan`;
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
    log.error({ taskId, branch: task.branchName, err: error }, "GitLab plan MR API unavailable");
    throw new StageManualBlockError(
      "GitLab plan MR publication is unavailable. Check the API service and retry.",
    );
  }
  if (!response.ok) {
    const failure = await readFailure(response);
    log.warn(
      {
        taskId,
        branch: task.branchName,
        status: response.status,
        code: failure.code ?? "gitlab_plan_publish_failed",
        retryAt: failure.retryAt ?? null,
      },
      "GitLab plan MR publication failed",
    );
    // retryAt приходит от API при rate limit: сообщение говорит оператору, когда именно
    // повторять, вместо общего "попробуйте позже".
    throw new StageManualBlockError(
      failure.retryAt
        ? `GitLab rate limit reached until ${failure.retryAt}. Retry after that time.`
        : "GitLab plan MR publication failed. Check repository permissions and retry.",
    );
  }

  // Запись в лог активности идет только после успешного ответа: журнал отражает факт
  // публикации, а не попытку.
  const completedAt = new Date().toISOString();
  appendTaskActivityLog(
    taskId,
    `[${completedAt}] [gitlab] Published plan MR for ${task.branchName} (issue #${issue.iid})`,
  );
  log.info(
    { taskId, iid: issue.iid, branch: task.branchName },
    "GitLab plan merge request published",
  );
  return true;
}

export async function publishGitLabTask(taskId: string, projectRoot: string): Promise<boolean> {
  // Симметрично publishGitLabPlanTask: тот же гейт режима, но проверка через хелпер.
  if (!gitLabModeActive()) {
    log.debug(
      { taskId, gitProvider: getEnv().GIT_PROVIDER },
      "GitLab merge request publication skipped because provider selector or rollout flag is disabled",
    );
    return false;
  }
  const issue = findGitLabIssueByTaskId(taskId);
  if (!issue) return false;

  // Режим plan_review ожидается выставленным еще на этапе планирования. Его отсутствие
  // не блокирует финальную публикацию, но означает расхождение с ожидаемым потоком,
  // поэтому WARN, а не ERROR.
  if (getEnv().AIF_PLAN_REVIEW_PR_ENABLED && issue.mrMode !== "plan_review") {
    log.warn(
      {
        taskId,
        iid: issue.iid,
        mrIid: issue.mrIid ?? null,
        mrMode: issue.mrMode ?? null,
      },
      "Final GitLab publication started without a prior plan-review MR mode",
    );
  }

  const task = findTaskById(taskId);
  if (!task?.branchName) {
    throw new StageManualBlockError("GitLab merge request publication requires a task branch.");
  }
  const executionRoot = task.worktreePath ?? projectRoot;

  // Коммит-гейт выполняется с ожиданием и до пуша: незакоммиченные правки иначе остались
  // бы в рабочем дереве, а на remote ушла бы пустая ветка.
  const commit = await ensureAutoQueueTaskCommit({ taskId, projectRoot: executionRoot });

  // Порядок как в плановом пути: сначала ветка на remote, затем публикация MR.
  try {
    pushBranch(executionRoot, task.branchName);
  } catch (error) {
    log.error({ taskId, branch: task.branchName, err: error }, "GitLab task branch push failed");
    throw new StageManualBlockError(
      "GitLab branch push failed. Check repository access and Git credentials, then retry.",
    );
  }

  // Задача перечитывается после коммита: хук коммита мог дописать implementationLog, а в
  // тело запроса должно уйти актуальное состояние, а не снапшот до коммита.
  const refreshed = findTaskById(taskId);
  const url = `${getEnv().API_BASE_URL}/projects/${task.projectId}/gitlab/tasks/${taskId}/publish`;
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
      "GitLab merge request API unavailable",
    );
    throw new StageManualBlockError(
      "GitLab merge request publication is unavailable. Check the API service and retry.",
    );
  }
  if (!response.ok) {
    const failure = await readFailure(response);
    log.warn(
      {
        taskId,
        branch: task.branchName,
        status: response.status,
        code: failure.code ?? "gitlab_publish_failed",
        retryAt: failure.retryAt ?? null,
      },
      "GitLab merge request publication failed",
    );
    throw new StageManualBlockError(
      failure.retryAt
        ? `GitLab rate limit reached until ${failure.retryAt}. Retry after that time.`
        : "GitLab merge request publication failed. Check repository permissions and retry.",
    );
  }

  const completedAt = new Date().toISOString();
  appendTaskActivityLog(
    taskId,
    `[${completedAt}] [gitlab] Published ${task.branchName} for issue #${issue.iid}`,
  );
  log.info(
    { taskId, iid: issue.iid, branch: task.branchName },
    "GitLab merge request synchronized",
  );
  return true;
}
