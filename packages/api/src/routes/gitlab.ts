import { Hono, type Context } from "hono";
import { getEnv, logger, pullDefaultBranch } from "@aif/shared";
import {
  deleteGitLabRepository,
  findGitLabIssueByTaskId,
  findGitLabRepository,
  findProjectById,
  findTaskById,
  getGitLabIssueReviewFingerprint,
  importGitLabIssueTask,
  listGitLabIssues,
  markGitLabIssueUnavailable,
  markTaskPlanApproved,
  markTaskPlanChangesRequested,
  recordGitLabRepositorySync,
  setTaskFields,
  updateGitLabMergeRequest,
  updateGitLabMergeRequestLastReviewNoteId,
  updateGitLabMergeRequestMode,
  updateTaskStatus,
  upsertGitLabRepository,
} from "@aif/data";
import { jsonValidator } from "../middleware/zodValidator.js";
import {
  requestWorktreeCleanupAfterMerge,
  snapshotTaskWorktree,
} from "../services/agentInternal.js";
import {
  gitlabConnectSchema,
  gitlabPlanPublishSchema,
  gitlabPublishSchema,
  gitlabSyncSchema,
} from "../schemas.js";
import { callAgentGitPrepare, callAgentSubmoduleSync } from "../services/gitPrepareBridge.js";
import {
  GitLabApiError,
  GitLabClient,
  collectMergeRequestHumanFeedback,
  findLatestApprovalNote,
  findLatestApprovalResetNote,
  findLatestRequestChangesNote,
  findMergeRequestClosingIssue,
  issueIsEligible,
  reviewFingerprint,
  toIssueSnapshot,
} from "../services/gitlab.js";
import type { ParticipantApiEnv } from "../middleware/participantAuth.js";

const log = logger("gitlab-routes");
const REVIEW_MARKER = "<!-- aif-gitlab-review -->";

export const gitlabRouter = new Hono<ParticipantApiEnv>();

// Гейт только для GitLab-путей (/:id/gitlab + /:id/gitlab/*). Роутер смонтирован
// на /projects рядом с GitHub-роутером; голый use("*") здесь перехватывал бы
// GitHub-запросы первыми и блокировал их, когда GIT_PROVIDER не равен
// gitlab. Нужны два паттерна: wildcard `gitlab*` в Hono не совпадает с путём
// `/gitlab` без подпути, а только с его подпутями.
gitlabRouter.use("/:id/gitlab", async (c, next) => {
  const env = getEnv();
  if (env.GIT_PROVIDER !== "gitlab" || !env.AIF_GITLAB_ISSUE_MR_ENABLED) {
    log.debug(
      { method: c.req.method, path: c.req.path, gitProvider: env.GIT_PROVIDER },
      "GitLab issue-to-MR route blocked by provider selector or rollout flag",
    );
    return c.json({ error: "GitLab issue-to-MR mode is disabled", code: "feature_disabled" }, 403);
  }
  await next();
});
gitlabRouter.use("/:id/gitlab/*", async (c, next) => {
  const env = getEnv();
  if (env.GIT_PROVIDER !== "gitlab" || !env.AIF_GITLAB_ISSUE_MR_ENABLED) {
    log.debug(
      { method: c.req.method, path: c.req.path, gitProvider: env.GIT_PROVIDER },
      "GitLab issue-to-MR route blocked by provider selector or rollout flag",
    );
    return c.json({ error: "GitLab issue-to-MR mode is disabled", code: "feature_disabled" }, 403);
  }
  await next();
});

function tokenFor(envVar: string): string {
  if (!/^GITLAB_[A-Z0-9_]+$/.test(envVar)) {
    throw new GitLabApiError(
      "GitLab token environment variable must use the GITLAB_* prefix",
      400,
      "authentication",
    );
  }
  const token = process.env[envVar]?.trim();
  if (!token)
    throw new GitLabApiError(
      `GitLab token environment variable ${envVar} is not configured`,
      400,
      "authentication",
    );
  return token;
}

function gitlabErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof GitLabApiError)) {
    log.error({ err: error }, "Unexpected GitLab integration failure");
    return c.json({ error: "GitLab integration failed", code: "gitlab_upstream" }, 502);
  }
  const body = {
    error: error.message,
    code: `gitlab_${error.adapterCode}`,
    retryAt: error.retryAt,
  };
  if (
    error.httpStatus === 400 ||
    error.httpStatus === 401 ||
    error.httpStatus === 403 ||
    error.httpStatus === 404 ||
    error.httpStatus === 422 ||
    error.httpStatus === 429
  ) {
    return c.json(body, error.httpStatus);
  }
  return c.json(body, 502);
}

function clientFor(connection: { tokenEnvVar: string }): GitLabClient {
  return new GitLabClient(tokenFor(connection.tokenEnvVar), getEnv().AIF_GITLAB_BASE_URL);
}

gitlabRouter.get("/:id/gitlab", (c) => {
  const projectId = c.req.param("id");
  if (!findProjectById(projectId)) return c.json({ error: "Project not found" }, 404);
  return c.json({
    connection: findGitLabRepository(projectId) ?? null,
    issues: listGitLabIssues(projectId),
  });
});

gitlabRouter.put("/:id/gitlab", jsonValidator(gitlabConnectSchema), async (c) => {
  const projectId = c.req.param("id");
  if (!findProjectById(projectId)) return c.json({ error: "Project not found" }, 404);
  const body = c.req.valid("json");
  const repositoryPath = body.repository.trim().split("/");
  const requestedName = repositoryPath[repositoryPath.length - 1] ?? "";
  const requestedNamespace = repositoryPath.slice(0, -1).join("/");
  try {
    const client = clientFor({ tokenEnvVar: body.tokenEnvVar });
    const remote = await client.getRepository(body.repository);
    const remotePath = remote.path_with_namespace.split("/");
    const connection = upsertGitLabRepository({
      projectId,
      namespace: remotePath.slice(0, -1).join("/") || requestedNamespace,
      name: remotePath[remotePath.length - 1] || requestedName,
      webUrl: remote.web_url,
      defaultBranch: remote.default_branch,
      tokenEnvVar: body.tokenEnvVar,
      eligibility: body.eligibility,
      enabled: body.enabled,
    });
    // Git-prepare при подключении best-effort: агент извлекает ветку по умолчанию
    // и инициализирует файлы AI Factory. Сбои только логируются (не фатальны) —
    // следующая Синхронизация повторит prepare строго.
    const prepare = await callAgentGitPrepare(projectId, { provider: "gitlab", strict: false });
    if (!prepare.ok) {
      log.warn(
        { projectId, errorCode: prepare.errorCode, error: prepare.error },
        "GitLab git-prepare deferred on connect; Sync now will re-run it strictly",
      );
    }
    return c.json(connection);
  } catch (error) {
    return gitlabErrorResponse(c, error);
  }
});

gitlabRouter.delete("/:id/gitlab", (c) => {
  return deleteGitLabRepository(c.req.param("id"))
    ? c.body(null, 204)
    : c.json({ error: "GitLab connection not found" }, 404);
});

gitlabRouter.post("/:id/gitlab/sync", jsonValidator(gitlabSyncSchema), async (c) => {
  const projectId = c.req.param("id");
  const connection = findGitLabRepository(projectId);
  if (!connection) return c.json({ error: "GitLab connection not found" }, 404);
  if (!connection.enabled)
    return c.json({ imported: 0, updated: 0, skipped: 0, issues: listGitLabIssues(projectId) });

  // Первая синхронизация (или переподключение) тоже запускает строгий git-prepare:
  // извлечь ветку по умолчанию + инициализировать файлы AI Factory. При сбое ошибка
  // показывается сразу (задача блокируется), а не импортирует issues в битый репозиторий.
  if (!connection.gitPreparedAt) {
    const prepare = await callAgentGitPrepare(projectId, { provider: "gitlab", strict: true });
    if (!prepare.ok) {
      log.warn(
        { projectId, errorCode: prepare.errorCode, error: prepare.error },
        "GitLab git-prepare failed on sync; aborting import",
      );
      return c.json(
        {
          error: prepare.error ?? "GitLab git-prepare failed",
          code: prepare.errorCode ?? "gitlab_prepare_failed",
        },
        502,
      );
    }
  }

  // Git pull перед синхронизацией issues best-effort, чтобы локальный репозиторий
  // отражал удалённую ветку по умолчанию. Сбой не блокирует (лог на уровне debug).
  const project = findProjectById(projectId);
  if (project?.rootPath) {
    pullDefaultBranch(project.rootPath);
  }

  // Синхронизация подмодулей best-effort: заполнить подмодули, если есть .gitmodules.
  // Не блокирует — сбой логируется, но импорт продолжается.
  callAgentSubmoduleSync(projectId).catch(() => {});

  try {
    const client = clientFor(connection);
    const remoteIssues = await client.listIssues(connection.namespace, connection.name);
    const existingByIid = new Map(listGitLabIssues(projectId).map((issue) => [issue.iid, issue]));
    const hasMrDiscoveryCandidates = remoteIssues.some(
      (issue) =>
        !existingByIid.get(issue.iid)?.mrIid && issueIsEligible(issue, connection.eligibility),
    );
    const openMergeRequests = hasMrDiscoveryCandidates
      ? await client.listMergeRequests(connection.namespace, connection.name)
      : [];
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const synchronizedIids = new Set<number>();
    for (const issue of remoteIssues) {
      const existing = existingByIid.get(issue.iid);
      const eligible = issueIsEligible(issue, connection.eligibility);
      synchronizedIids.add(issue.iid);
      if (!existing?.taskId && !eligible) {
        skipped += 1;
        continue;
      }
      const closingMr = existing?.mrIid
        ? null
        : findMergeRequestClosingIssue(openMergeRequests, issue.iid);
      if (closingMr) {
        log.debug(
          { projectId, iid: issue.iid, mrIid: closingMr.iid },
          "GitLab closing merge request discovered",
        );
      }
      const snapshot = await toIssueSnapshot(client, connection.namespace, connection.name, issue);
      const result = importGitLabIssueTask({
        projectId,
        namespace: connection.namespace,
        repository: connection.name,
        iid: issue.iid,
        globalId: `gid://gitlab/Issue/${issue.id}`,
        webUrl: issue.web_url,
        state: issue.state === "closed" ? "closed" : "open",
        sourceUpdatedAt: issue.updated_at,
        snapshot,
        ...(closingMr
          ? {
              mergeRequest: {
                iid: closingMr.iid,
                url: closingMr.web_url,
                state: "open" as const,
              },
            }
          : {}),
      });
      if (result.created) imported += 1;
      else updated += 1;

      const mrIid = existing?.mrIid ?? closingMr?.iid;
      if (mrIid) {
        const mr =
          closingMr ?? (await client.getMergeRequest(connection.namespace, connection.name, mrIid));
        const approvals = await client.getMergeRequestApprovals(
          connection.namespace,
          connection.name,
          mr.iid,
        );
        const mrState: "open" | "closed" | "merged" =
          mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed";
        const checks = await client.getCommitChecks(connection.namespace, connection.name, mr.sha);
        // "requested changes" и "approved" в GitLab доступны не на каждом
        // тарифе через detailed_merge_status или approvals API (EE/Free
        // сообщает `approved: true` вхолостую, без правил одобрения).
        // Надёжный канал событий — API системных заметок MR; детекция
        // реализована в хелперах сервиса, а маршрут потребляет только
        // структурированные id заметок для переходов по фронту события,
        // повторяя модель review-id из routes/github.ts.
        const mrNotes = await client.listMergeRequestNotes(
          connection.namespace,
          connection.name,
          mr.iid,
        );
        const requestChangesNote = findLatestRequestChangesNote(mrNotes);
        const approvalNote = findLatestApprovalNote(mrNotes);
        const approvalResetNote = findLatestApprovalResetNote(mrNotes);
        // Одобрение перестаёт быть действием, как только более новая заметка его
        // отзывает: и действие "unapproved this merge request", и вызванный push
        // сброс "reset approvals ..." оставляют исходную заметку об одобрении в
        // таймлайне MR, поэтому итог решают id заметок. Без этой проверки
        // отозванное одобрение всё равно перевело бы plan_review в implementing.
        // REQ-FR-integration.pr-mr.resolve-review-decision, критерии 3, 9, 10:
        // — действующее решение: последнее неотозванное;
        // — отзыв отменяет одобрение;
        // — при нескольких необработанных решениях действует последнее.
        const approvalNoteIsCurrent =
          approvalNote !== null &&
          (approvalResetNote === null || approvalResetNote.id < approvalNote.id);
        const effectiveApprovalNote = approvalNoteIsCurrent ? approvalNote : null;
        if (approvalNote && !effectiveApprovalNote) {
          log.info(
            {
              iid: issue.iid,
              mrIid: mr.iid,
              approvalNoteId: approvalNote.id,
              resetNoteId: approvalResetNote?.id ?? null,
            },
            "GitLab approval note superseded by a newer unapprove/reset note; ignoring it",
          );
        }
        // Краевой маркер lastReviewNoteId намеренно НЕ записывается здесь.
        // Он фиксируется только после успешного соответствующего перехода
        // состояния, чтобы преходящий конфликт CAS оставался повторимым на
        // следующей синхронизации, а не глотал событие ревью навсегда.
        updateGitLabMergeRequest({
          projectId,
          iid: issue.iid,
          mrIid: mr.iid,
          mrUrl: mr.web_url,
          mrState,
          mrChecksStatus: checks,
          reviewState: approvals.reviewState,
        });
        const processedReviewNoteId = existing?.lastReviewNoteId ?? 0;
        const pendingApprovalNote =
          effectiveApprovalNote && effectiveApprovalNote.id > processedReviewNoteId
            ? effectiveApprovalNote
            : null;
        const pendingRequestChangesNote =
          requestChangesNote && requestChangesNote.id > processedReviewNoteId
            ? requestChangesNote
            : null;
        // Если и одобрение, и changes-request остались необработанными,
        // больший id заметки — актуальное намерение ревьюера, он и побеждает.
        const pendingReviewNote =
          pendingApprovalNote && pendingRequestChangesNote
            ? pendingRequestChangesNote.id > pendingApprovalNote.id
              ? pendingRequestChangesNote
              : pendingApprovalNote
            : (pendingApprovalNote ?? pendingRequestChangesNote);
        const latestReviewActionIsApproval =
          pendingReviewNote !== null && pendingReviewNote === pendingApprovalNote;
        const latestReviewActionIsChangesRequest =
          pendingReviewNote !== null && pendingReviewNote === pendingRequestChangesNote;
        let task = findTaskById(result.taskId);
        const discoveredMrNeedsDone =
          closingMr && task && task.status !== "done" && task.status !== "accepted";
        if (discoveredMrNeedsDone && task) {
          updateTaskStatus(
            task.id,
            "done",
            {},
            { kind: "system", id: "gitlab-sync", displayNameSnapshot: "GitLab Sync" },
          );
          // Обновить строку задачи, чтобы последующие проверки статуса (merged → verified,
          // requested-changes → implementing) видели статус после перехода.
          task = findTaskById(result.taskId);
        }
        const planReviewMode = existing?.mrMode === "plan_review";
        if (task && mrState === "merged" && (task.status === "done" || task.status === "review")) {
          // Слияние MR реализации человеком и есть итоговое принятие:
          // когда конвейер ещё стоит на `review` (например, ручной переход
          // ревью или отключённый гейт авторевью), само слияние закрывает
          // эту стадию до принятия задачи.
          // REQ-FR-integration.pr-mr.resolve-review-decision, критерий 7:
          // слияние принимает результат, закрывая стадию ревью.
          if (task.status === "review") {
            updateTaskStatus(
              task.id,
              "done",
              {},
              { kind: "system", id: "gitlab-sync", displayNameSnapshot: "GitLab Sync" },
            );
            log.info(
              { taskId: task.id, iid: issue.iid, mrIid: mr.iid },
              "GitLab merge request merged; task completed the review stage",
            );
            task = findTaskById(task.id) ?? task;
          }
          if (task.status === "done") {
            const verifiedTask = task;
            updateTaskStatus(
              task.id,
              "accepted",
              {},
              { kind: "system", id: "gitlab-sync", displayNameSnapshot: "GitLab Sync" },
            );
            // GitLab автоматически закрывает issue при слиянии MR ("Closes #<iid>"), и
            // importGitLabIssueTask помечает связанную задачу как paused. Принятая задача
            // терминальна: снимаем paused, как это делает done-checker через CLEAN_STATE_RESET,
            // чтобы состояние accepted не осталось с признаком паузы.
            setTaskFields(task.id, { paused: false });
            // Закрытие жизненного цикла: удалить worktree, сохранить ветку.
            await requestWorktreeCleanupAfterMerge(
              snapshotTaskWorktree(
                verifiedTask,
                findProjectById(verifiedTask.projectId)?.rootPath ?? null,
              ),
              `MR !${mr.iid}`,
            );
          }
        } else if (task && mrState === "closed") {
          setTaskFields(task.id, { paused: true, updatedAt: new Date().toISOString() });
          if (planReviewMode && task.status === "plan_review") {
            log.warn(
              { taskId: task.id, iid: issue.iid, mrIid: mr.iid },
              "GitLab plan-mode merge request closed without merge; task paused",
            );
          }
        } else if (
          task &&
          planReviewMode &&
          task.status === "plan_review" &&
          latestReviewActionIsApproval &&
          pendingApprovalNote
        ) {
          const approved = markTaskPlanApproved({
            taskId: task.id,
            actor: {
              kind: "system",
              id: "gitlab-sync",
              displayNameSnapshot: "GitLab Sync",
            },
          });
          if (approved.ok) {
            // Записываем потреблённый id заметки только после успешного перехода,
            // чтобы преходящий сбой не блокировал повтор на следующей синхронизации.
            // REQ-FR-integration.pr-mr.resolve-review-decision, критерии 11-12:
            // отметка после успеха; при конфликте — ретрай.
            // REQ-NFR-integration.compliance.review-event-idempotency:
            // идемпотентность, отсутствие потери, наблюдаемость отказа.
            updateGitLabMergeRequestLastReviewNoteId({
              projectId,
              iid: issue.iid,
              lastReviewNoteId: pendingApprovalNote.id,
            });
            log.info(
              { taskId: task.id, iid: issue.iid, mrIid: mr.iid, noteId: pendingApprovalNote.id },
              "GitLab plan approved; task resumed at implementing",
            );
          } else {
            log.error(
              {
                taskId: task.id,
                iid: issue.iid,
                mrIid: mr.iid,
                noteId: pendingApprovalNote.id,
                code: approved.code,
                currentStatus: approved.currentStatus ?? null,
              },
              "markTaskPlanApproved failed; task will retry on next sync",
            );
          }
        } else if (
          task &&
          planReviewMode &&
          task.status === "plan_review" &&
          latestReviewActionIsChangesRequest &&
          pendingRequestChangesNote
        ) {
          const feedback = collectMergeRequestHumanFeedback(
            mrNotes,
            processedReviewNoteId,
            REVIEW_MARKER,
          );
          const requested = markTaskPlanChangesRequested({
            taskId: task.id,
            feedback,
            actor: {
              kind: "system",
              id: "gitlab-review",
              displayNameSnapshot: "GitLab Review",
            },
          });
          if (requested.ok) {
            updateGitLabMergeRequestLastReviewNoteId({
              projectId,
              iid: issue.iid,
              lastReviewNoteId: pendingRequestChangesNote.id,
            });
            log.info(
              {
                taskId: task.id,
                iid: issue.iid,
                mrIid: mr.iid,
                noteId: pendingRequestChangesNote.id,
                feedbackLength: feedback?.length ?? 0,
              },
              "GitLab plan review requested changes; task returned to planning",
            );
          } else {
            log.error(
              {
                taskId: task.id,
                iid: issue.iid,
                mrIid: mr.iid,
                noteId: pendingRequestChangesNote.id,
                code: requested.code,
                currentStatus: requested.currentStatus ?? null,
              },
              "markTaskPlanChangesRequested failed; task will retry on next sync",
            );
          }
        } else if (
          task &&
          latestReviewActionIsChangesRequest &&
          pendingRequestChangesNote &&
          (task.status === "done" || task.status === "review")
        ) {
          updateTaskStatus(
            task.id,
            "implementing",
            {
              reworkRequested: true,
              reviewComments: task.reviewComments,
              autoQueueCommitStatus: "pending",
              autoQueueCommitBaseSha: task.commitSha,
              commitSha: null,
              autoQueueCommitError: null,
              autoQueueCommitCompletedAt: null,
            },
            { kind: "system", id: "gitlab-review", displayNameSnapshot: "GitLab Review" },
          );
          updateGitLabMergeRequestLastReviewNoteId({
            projectId,
            iid: issue.iid,
            lastReviewNoteId: pendingRequestChangesNote.id,
          });
          log.info(
            { taskId: task.id, iid: issue.iid, noteId: pendingRequestChangesNote.id },
            "GitLab requested-changes review resumed task at implementing",
          );
        } else if (pendingReviewNote && task) {
          log.debug(
            {
              taskId: task.id,
              iid: issue.iid,
              noteId: pendingReviewNote.id,
              lastReviewNoteId: existing?.lastReviewNoteId ?? null,
              status: task.status,
            },
            "GitLab review note already processed or task not actionable; skipping",
          );
        }
      }
    }
    for (const existing of existingByIid.values()) {
      if (!synchronizedIids.has(existing.iid)) {
        markGitLabIssueUnavailable(
          projectId,
          existing.iid,
          "Issue is no longer available from the connected repository.",
        );
      }
    }
    recordGitLabRepositorySync(projectId, null);
    log.info({ projectId, imported, updated, skipped }, "GitLab issue synchronization completed");
    return c.json({ imported, updated, skipped, issues: listGitLabIssues(projectId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitLab sync failed";
    recordGitLabRepositorySync(projectId, message);
    return gitlabErrorResponse(c, error);
  }
});

gitlabRouter.post(
  "/:id/gitlab/tasks/:taskId/publish",
  jsonValidator(gitlabPublishSchema),
  async (c) => {
    const projectId = c.req.param("id");
    const taskId = c.req.param("taskId");
    const connection = findGitLabRepository(projectId);
    const task = findTaskById(taskId);
    const issue = findGitLabIssueByTaskId(taskId);
    if (!connection || !task || !issue || task.projectId !== projectId) {
      return c.json({ error: "GitLab task linkage not found" }, 404);
    }
    const body = c.req.valid("json");
    const approvedPlanSummary = [
      task.planReviewCommitSha
        ? `Approved plan commit: ${task.planReviewCommitSha}`
        : "Approved plan commit: not recorded",
      task.planReviewPublishedAt
        ? `Plan published at: ${task.planReviewPublishedAt}`
        : "Plan published at: not recorded",
      task.planReviewApprovedAt
        ? `Plan approved at: ${task.planReviewApprovedAt}`
        : "Plan approved at: not recorded",
    ].join("\n");
    const mrDescription = [
      "<!-- aif:mr-mode=implementation -->",
      "## Approved plan",
      approvedPlanSummary,
      `Closes #${issue.iid}`,
      "## Implementation",
      (body.implementationLog ?? "Implementation completed by AIF.").slice(-20_000),
      "## Test evidence",
      task.planTests
        ? "Tests requested by the implementation plan; see commits and CI checks."
        : "No test task was requested by the implementation plan.",
      "_AIF never merges this merge request; a human owns the final decision._",
    ].join("\n\n");
    try {
      const client = clientFor(connection);
      let mr = issue.mrIid
        ? await client.getMergeRequest(connection.namespace, connection.name, issue.mrIid)
        : await client.findMergeRequest(connection.namespace, connection.name, body.branch);
      if (mr) {
        mr = await client.updateMergeRequest({
          namespace: connection.namespace,
          name: connection.name,
          mrIid: mr.iid,
          title: task.title,
          description: mrDescription,
        });
      } else {
        try {
          mr = await client.createMergeRequest({
            namespace: connection.namespace,
            name: connection.name,
            sourceBranch: body.branch,
            targetBranch: connection.defaultBranch,
            title: task.title,
            description: mrDescription,
          });
        } catch (error) {
          if (!(error instanceof GitLabApiError) || error.httpStatus !== 422) throw error;
          const found = await client.findMergeRequest(
            connection.namespace,
            connection.name,
            body.branch,
          );
          if (!found) throw error;
          mr = await client.updateMergeRequest({
            namespace: connection.namespace,
            name: connection.name,
            mrIid: found.iid,
            title: task.title,
            description: mrDescription,
          });
        }
      }

      const reviewText = body.reviewComments?.trim() ?? "";
      const fingerprint = reviewText ? reviewFingerprint(reviewText) : null;
      if (reviewText && fingerprint !== getGitLabIssueReviewFingerprint(projectId, issue.iid)) {
        await client.upsertMarkerNote({
          namespace: connection.namespace,
          name: connection.name,
          mrIid: mr.iid,
          marker: REVIEW_MARKER,
          body: reviewText.slice(-50_000),
        });
      }
      const [checks, approvals] = await Promise.all([
        client.getCommitChecks(connection.namespace, connection.name, mr.sha),
        client.getMergeRequestApprovals(connection.namespace, connection.name, mr.iid),
      ]);
      const updated = updateGitLabMergeRequest({
        projectId,
        iid: issue.iid,
        mrIid: mr.iid,
        mrUrl: mr.web_url,
        mrState: mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed",
        mrChecksStatus: checks,
        reviewState: approvals.reviewState,
        reviewFingerprint: fingerprint,
      });
      const linked =
        updateGitLabMergeRequestMode(projectId, issue.iid, "implementation") ?? updated;
      return c.json(linked);
    } catch (error) {
      return gitlabErrorResponse(c, error);
    }
  },
);

/**
 * Публикация (или обновление) MR плана изменений для задачи, связанной с issue.
 * Задача остаётся в plan_review, пока человек не одобрит MR. Описание содержит
 * маркер ревью плана и намеренно без `Closes #...` — issue должен оставаться
 * открытым, пока не будет опубликован итоговый MR реализации.
 */
gitlabRouter.post(
  "/:id/gitlab/tasks/:taskId/publish-plan",
  jsonValidator(gitlabPlanPublishSchema),
  async (c) => {
    const projectId = c.req.param("id");
    const taskId = c.req.param("taskId");
    const connection = findGitLabRepository(projectId);
    const task = findTaskById(taskId);
    const issue = findGitLabIssueByTaskId(taskId);
    if (!connection || !task || !issue || task.projectId !== projectId) {
      return c.json({ error: "GitLab task linkage not found" }, 404);
    }
    const body = c.req.valid("json");
    const planText = (task.plan ?? "").trim();
    const mrDescription = [
      "<!-- aif:mr-mode=plan_review -->",
      "## Change Plan",
      planText.length > 0 ? planText.slice(-50_000) : "_No plan text recorded._",
      "## How to approve",
      "Approve this merge request to start implementation. Request changes to ask the agent to revise the plan — comments are fed back to the planner.",
      "_AIF never merges this merge request; a human owns the final decision._",
    ].join("\n\n");
    try {
      const client = clientFor(connection);
      let mr = issue.mrIid
        ? await client.getMergeRequest(connection.namespace, connection.name, issue.mrIid)
        : await client.findMergeRequest(connection.namespace, connection.name, body.branch);
      if (mr) {
        mr = await client.updateMergeRequest({
          namespace: connection.namespace,
          name: connection.name,
          mrIid: mr.iid,
          title: task.title,
          description: mrDescription,
        });
      } else {
        try {
          mr = await client.createMergeRequest({
            namespace: connection.namespace,
            name: connection.name,
            sourceBranch: body.branch,
            targetBranch: connection.defaultBranch,
            title: task.title,
            description: mrDescription,
          });
        } catch (error) {
          if (!(error instanceof GitLabApiError) || error.httpStatus !== 422) throw error;
          const found = await client.findMergeRequest(
            connection.namespace,
            connection.name,
            body.branch,
          );
          if (!found) throw error;
          mr = await client.updateMergeRequest({
            namespace: connection.namespace,
            name: connection.name,
            mrIid: found.iid,
            title: task.title,
            description: mrDescription,
          });
        }
      }

      const [checks, approvals] = await Promise.all([
        client.getCommitChecks(connection.namespace, connection.name, mr.sha),
        client.getMergeRequestApprovals(connection.namespace, connection.name, mr.iid),
      ]);
      updateGitLabMergeRequest({
        projectId,
        iid: issue.iid,
        mrIid: mr.iid,
        mrUrl: mr.web_url,
        mrState: mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed",
        mrChecksStatus: checks,
        reviewState: approvals.reviewState,
      });
      const linked = updateGitLabMergeRequestMode(projectId, issue.iid, "plan_review");
      return c.json(linked);
    } catch (error) {
      return gitlabErrorResponse(c, error);
    }
  },
);
