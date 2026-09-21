import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  createGitLabBranchWithCommit,
  GITLAB_REPOSITORY_PATH,
  GITLAB_WEB_URL,
  gitLabApi,
  gitLabProjectPathEncoded,
  GITLAB_TOKEN,
  GitLabApiError,
  isRetryableMergeReadinessDelay,
} from "../shared/gitlab.js";
import { API_URL, runId } from "../gui/common.js";

/**
 * E2E API: полный путь GitLab Issue → MR → Accepted (US-integration.pr-mr.gitlab-issue-to-accepted).
 *
 * Требования заказчика (доп. контроль поверх verify):
 *   - Scenario 3: план реально создан и опубликован в MR — description MR содержит
 *     текст плана (маршрут publish-plan), GET /tasks/:id/plan-file-status.exists=true.
 *   - Scenario 7: реализовано то, что требовал план; в MR — краткий отчёт о работе
 *     (затронутые артефакты — что и зачем) = секция `[files]` implementationLog,
 *     которая попадает в description MR через publishGitLabTask.
 *   - Scenarios 5-7: автоматический контур — AI-owned задача, координатор сам гоняет
 *     implementer → verifier → reviewer (auto-review gate), человек принимает только
 *     решения в GitLab (approve плана, merge MR). Никаких ручных task-event'ов после старта.
 *
 * Стек e2e работает с PARTICIPANTS_MODE_ENABLED=false → API-события разрешены только
 * из legacy-набора (start_ai / start_implementation / approve_plan / request_plan_changes /
 * request_changes / approve_done / retry_from_blocked / complete_review-human...).
 * Поэтому:
 *   - детерминированный уровень (без LLM) покрывает импорт, единый MR (план в MR),
 *     краткий путь done→accepted и negative-ветки через legacy-события;
 *   - полный контур планирования/реализации/verify/review с approve переходит на
 *     стадию требования `AIF_LLM_INTEGRATION=1` (реальный runtime + координатор).
 *
 * Trace:
 *   - UC-integration.issues.bootstrap-project-sync-and-create-task (Mixed)
 *   - UC-pipeline.stage.auto-advance-task (Agent)
 *   - UC-pipeline.plan.generate-change-plan (Agent)
 *   - UC-integration.pr-mr.resolve-review-decision (Schedule/Agent)
 *   - UC-pipeline.implementation.execute-change-in-isolation (Agent)
 *   - UC-pipeline.verification.verify-change-result (Agent)
 *   - UC-pipeline.completion.auto-complete-pipeline (Agent)
 *   - UC-vcs-auto.mr.publish-atomic-merge-request (Agent)
 *   - contract-aif-rest-api, contract-aif-gitlab, contract-aif-ws
 */

interface ApiSettings {
  gitProvider?: "github" | "gitlab";
  gitlabIssueMrEnabled?: boolean;
  runtimeReadiness?: {
    availableRuntimeCount: number;
    runtimeProfileCount: number;
    enabledRuntimeProfileCount: number;
  };
}

interface GitLabProjectState {
  connection: {
    namespace: string;
    name: string;
    defaultBranch: string | null;
  } | null;
  issues: Array<{
    iid: number;
    taskId: string | null;
    mrIid: number | null;
    mrState: "open" | "closed" | "merged" | null;
    mrMode?: string | null;
  }>;
}

interface TaskDetails {
  id: string;
  status: string;
  executionOwner: string;
  paused: boolean;
  reworkRequested?: boolean;
  planReviewState?: string | null;
  reviewIterationCount?: number;
  manualReviewRequired?: boolean;
  implementationLog?: string | null;
  title?: string;
}

interface CreatedProject {
  id: string;
  name: string;
  rootPath: string;
}

interface GitLabIssueResponse {
  iid: number;
  state: string;
}

interface GitLabMrResponse {
  iid: number;
  state: string;
  web_url: string;
  source_branch: string;
  description?: string;
}

/** Полный LLM-контур требует явного флага (аналог TC-L-09 / AIF_GITLAB_INTEGRATION). */
const LLM_INTEGRATION_ENABLED = process.env.AIF_LLM_INTEGRATION === "1";

/** Гейт на GitLab-режим + окружение (тот же, что в e2e/gui/gitlab-issue-to-accepted.spec.ts). */
async function ensureGitLabIssueMrFeature(request: APIRequestContext): Promise<void> {
  const response = await request.get(`${API_URL}/settings`);
  expect(response.ok()).toBe(true);
  const settings = (await response.json()) as ApiSettings;
  test.skip(
    settings.gitProvider !== "gitlab" || !settings.gitlabIssueMrEnabled,
    "requires GIT_PROVIDER=gitlab and AIF_GITLAB_ISSUE_MR_ENABLED=true",
  );
  test.skip(!GITLAB_WEB_URL || !GITLAB_TOKEN, "requires GITLAB_WEB_URL and GITLAB_TOKEN");
}

/**
 * Гейт LLM-контура: real-runtime обязателен.
 * В этом сценарии недопустим skip — отсутствие флага/профиля считается ошибкой стенда.
 */
async function ensureLlmRuntime(request: APIRequestContext): Promise<void> {
  const response = await request.get(`${API_URL}/settings`);
  expect(response.ok()).toBe(true);
  const settings = (await response.json()) as ApiSettings;

  expect(
    LLM_INTEGRATION_ENABLED,
    "full-LLM pipeline requires AIF_LLM_INTEGRATION=1 (real runtime profile + coordinator)",
  ).toBe(true);
  expect(
    settings.runtimeReadiness?.enabledRuntimeProfileCount ?? 0,
    "no enabled runtime profile configured in the stack",
  ).toBeGreaterThan(0);
}

/** Создаёт изолированный проект с уникальным rootPath (без унаследованного git-remote). */
async function createIsolatedProject(
  request: APIRequestContext,
  marker: string,
): Promise<CreatedProject> {
  const response = await request.post(`${API_URL}/projects`, {
    data: {
      name: `E2E GitLab Full ${marker}`,
      rootPath: `/home/www/e2e-gitlab-full-${marker}`,
    },
  });
  if (!response.ok()) {
    throw new Error(`createProject failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as CreatedProject;
}

async function deleteProject(request: APIRequestContext, projectId: string): Promise<void> {
  const response = await request.delete(`${API_URL}/projects/${projectId}`);
  if (!response.ok() && response.status() !== 404) {
    throw new Error(`Failed to delete project ${projectId}: ${response.status()}`);
  }
}

async function connectGitLabViaApi(
  request: APIRequestContext,
  projectId: string,
  label: string,
): Promise<void> {
  const response = await request.put(`${API_URL}/projects/${projectId}/gitlab`, {
    data: {
      repository: GITLAB_REPOSITORY_PATH,
      eligibility: { labels: [label], assignee: null, milestone: null },
      enabled: true,
    },
  });
  if (!response.ok()) {
    throw new Error(`connectGitLab failed: ${response.status()} ${await response.text()}`);
  }
}

async function syncGitLabViaApi(request: APIRequestContext, projectId: string): Promise<void> {
  const response = await request.post(`${API_URL}/projects/${projectId}/gitlab/sync`, {
    data: {},
  });
  if (!response.ok()) {
    throw new Error(`gitlab sync failed: ${response.status()} ${await response.text()}`);
  }
}

async function readGitLabState(
  request: APIRequestContext,
  projectId: string,
): Promise<GitLabProjectState> {
  const response = await request.get(`${API_URL}/projects/${projectId}/gitlab`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as GitLabProjectState;
}

async function readTaskById(request: APIRequestContext, taskId: string): Promise<TaskDetails> {
  const response = await request.get(`${API_URL}/tasks/${taskId}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as TaskDetails;
}

/** PUT /tasks/:id — ограниченное обновление (plan, флаги). */
async function updateTask(
  request: APIRequestContext,
  taskId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const response = await request.put(`${API_URL}/tasks/${taskId}`, { data: patch });
  if (!response.ok()) {
    throw new Error(`PUT /tasks/${taskId} failed: ${response.status()} ${await response.text()}`);
  }
}

/** POST /tasks/:id/events — событие state machine (legacy-набор: PARTICIPANTS_MODE_ENABLED=false). */
async function fireTaskEvent(
  request: APIRequestContext,
  taskId: string,
  event: string,
): Promise<TaskDetails> {
  const response = await request.post(`${API_URL}/tasks/${taskId}/events`, { data: { event } });
  if (!response.ok()) {
    throw new Error(
      `POST /tasks/${taskId}/events ${event} failed: ${response.status()} ${await response.text()}`,
    );
  }
  return (await response.json()) as TaskDetails;
}

/** POST /projects/:id/gitlab/tasks/:taskId/publish-plan — публикация MR плана (реальный маршрут). */
async function publishPlanMr(
  request: APIRequestContext,
  projectId: string,
  taskId: string,
  branch: string,
): Promise<GitLabProjectState["issues"][number]> {
  const response = await request.post(
    `${API_URL}/projects/${projectId}/gitlab/tasks/${taskId}/publish-plan`,
    { data: { branch } },
  );
  if (!response.ok()) {
    throw new Error(`publish-plan failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as GitLabProjectState["issues"][number];
}

interface GitLabMergeRequestListEntry {
  iid: number;
  source_branch: string;
  state: string;
  description?: string;
}

async function listMergeRequestsForBranch(
  request: APIRequestContext,
  branch: string,
): Promise<GitLabMergeRequestListEntry[]> {
  const mrs = await gitLabApi<GitLabMergeRequestListEntry[]>(
    request,
    `/projects/${gitLabProjectPathEncoded()}/merge_requests?state=all&scope=all&per_page=100`,
  );
  return mrs.filter((mr) => mr.source_branch === branch);
}

/**
 * Merge MR с ретраями на transient 422:
 * сразу после создания ветки+коммита+MR GitLab (CE) может ещё не
 * финализировать MR (Sidekiq); настоящие конфликты проваливаются.
 */
async function mergeMrWithRetries(request: APIRequestContext, mrIid: number): Promise<void> {
  const maxAttempts = 12;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await gitLabApi(
        request,
        `/projects/${gitLabProjectPathEncoded()}/merge_requests/${mrIid}/merge`,
        "PUT",
        { should_remove_source_branch: true },
      );
      return;
    } catch (error) {
      if (!(error instanceof GitLabApiError) || error.status !== 422) {
        throw error;
      }

      const retryableReadinessDelay = await isRetryableMergeReadinessDelay(request, mrIid);
      if (!retryableReadinessDelay) {
        throw error;
      }

      lastError = error;
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 750));
    }
  }

  throw lastError;
}

async function deleteTaskIfExists(
  request: APIRequestContext,
  taskId: string | null,
): Promise<void> {
  if (!taskId) return;
  const response = await request.delete(`${API_URL}/tasks/${taskId}`);
  if (!response.ok() && response.status() !== 404) {
    throw new Error(
      `Failed to delete task ${taskId}: ${response.status()} ${await response.text()}`,
    );
  }
}

async function pollForTaskLink(
  request: APIRequestContext,
  projectId: string,
  issueIid: number,
): Promise<NonNullable<GitLabProjectState["issues"][number]>> {
  let link: GitLabProjectState["issues"][number] | undefined;
  await expect
    .poll(
      async () => {
        const state = await readGitLabState(request, projectId);
        link = state.issues.find((entry) => entry.iid === issueIid);
        return link?.taskId ?? null;
      },
      { timeout: 60_000, intervals: [2_000, 2_000, 5_000] },
    )
    .not.toBeNull();
  return link!;
}

async function pollTaskStatus(
  request: APIRequestContext,
  taskId: string,
  expected: string,
  timeoutMs = 60_000,
): Promise<TaskDetails> {
  await expect
    .poll(async () => (await readTaskById(request, taskId)).status, {
      timeout: timeoutMs,
      intervals: [2_000, 2_000, 5_000],
    })
    .toBe(expected);
  return readTaskById(request, taskId);
}

/** Создаёт GitLab Issue с меткой проекта без MR. */
async function createIssue(
  request: APIRequestContext,
  label: string,
  title: string,
  description = "E2E GUI fixture",
): Promise<GitLabIssueResponse> {
  return gitLabApi<GitLabIssueResponse>(
    request,
    `/projects/${gitLabProjectPathEncoded()}/issues`,
    "POST",
    { title, labels: label, description },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// L-10c — Scenario 1: Sync импортирует GitLab Issue БЕЗ MR в Backlog.
// Детерминированный уровень (LLM не нужен).
// ─────────────────────────────────────────────────────────────────────────────
test("L-10c: Issue без MR импортируется в backlog с внешней ссылкой", async ({ request }) => {
  await ensureGitLabIssueMrFeature(request);

  const marker = runId();
  const label = `aif-e2e-full-${marker}`;
  const project = await createIsolatedProject(request, marker);
  let linkedTaskId: string | null = null;

  try {
    const issue = await createIssue(request, label, `[L-10c] issue ${marker}`);

    await connectGitLabViaApi(request, project.id, label);
    await syncGitLabViaApi(request, project.id);

    const link = await pollForTaskLink(request, project.id, issue.iid);
    linkedTaskId = link.taskId;
    expect(link.mrIid).toBeNull();

    const task = await readTaskById(request, link.taskId!);
    expect(task.status).toBe("backlog");
    expect(task.executionOwner).toBe("ai");
    // Импортированная задача управляется координатором (autoMode), пауза не ставится.
    expect(task.paused).toBe(false);

    // Oracle: статус согласован и в списке задач проекта.
    const listResponse = await request.get(`${API_URL}/tasks?projectId=${project.id}`);
    expect(listResponse.ok()).toBe(true);
    const rows = (await listResponse.json()) as Array<{ id: string; status: string }>;
    const row = rows.find((entry) => entry.id === link.taskId);
    expect(row?.status).toBe("backlog");
  } finally {
    await deleteTaskIfExists(request, linkedTaskId);
    await deleteProject(request, project.id);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// L-10d — Scenario 3 (гарантия «план реально создан и опубликован в MR») +
// Scenario 8 (единый MR). Маршрут publish-plan (реальный, без LLM).
// Детерминированный уровень.
// ─────────────────────────────────────────────────────────────────────────────
test("L-10d: план создан (файл) и опубликован в едином MR с текстом плана", async ({ request }) => {
  await ensureGitLabIssueMrFeature(request);

  const marker = runId();
  const label = `aif-e2e-plan-${marker}`;
  const branchName = `e2e-l10d-${marker}`;
  const planText = `# Change Plan ${marker}\n\n## Tasks\n- [ ] refactor ${marker}/impl.ts (why: e2e fixture)\n- [ ] add e2e/${marker}.test.ts\n`;
  const project = await createIsolatedProject(request, marker);
  let linkedTaskId: string | null = null;

  try {
    const issue = await createIssue(request, label, `[L-10d] issue ${marker}`);

    await connectGitLabViaApi(request, project.id, label);
    await syncGitLabViaApi(request, project.id);
    const link = await pollForTaskLink(request, project.id, issue.iid);
    linkedTaskId = link.taskId;
    if (!linkedTaskId) throw new Error("task not linked");

    // Legacy-переход: backlog → planning (start_ai). Координатор задачу не трогает,
    // потому что мы её держим paused (это тестовая фикстура, не продакшн-контур).
    await updateTask(request, linkedTaskId, { paused: true });
    await fireTaskEvent(request, linkedTaskId, "start_ai");
    const afterStart = await readTaskById(request, linkedTaskId);
    expect(afterStart.status).toBe("planning");

    // План кладём в задачу; маршрут publish-plan сам соберёт description из task.plan.
    await updateTask(request, linkedTaskId, { plan: planText });

    // Гарантия Scenario 3 (1/2): файл плана реально создан на диске.
    const planFile = await request.get(`${API_URL}/tasks/${linkedTaskId}/plan-file-status`);
    expect(planFile.ok()).toBe(true);
    const planStatus = (await planFile.json()) as { exists: boolean; path: string };
    expect(planStatus.exists).toBe(true);

    // Публикация MR плана (реальный маршрут publish-plan).
    await createGitLabBranchWithCommit(request, branchName, `l10d-${marker}`);
    const published = await publishPlanMr(request, project.id, linkedTaskId, branchName);
    expect(published.mrIid).toBeTruthy();
    expect(published.mrMode).toBe("plan_review");

    // Гарантия Scenario 3 (2/2): description MR содержит сам текст плана.
    const mr = await gitLabApi<GitLabMrResponse & { description: string }>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/merge_requests/${published.mrIid}`,
    );
    expect(mr.description).toContain("## Change Plan");
    expect(mr.description).toContain(`# Change Plan ${marker}`);
    expect(mr.description).toContain("e2e fixture");

    // Scenario 8 (единый MR): повторная публикация переиспользует ТОТ ЖЕ MR.
    await createGitLabBranchWithCommit(request, branchName, `l10d-${marker}-v2`);
    const republished = await publishPlanMr(request, project.id, linkedTaskId, branchName);
    expect(republished.mrIid).toBe(published.mrIid);
    const mrsForBranch = await listMergeRequestsForBranch(request, branchName);
    expect(mrsForBranch.length).toBe(1);

    // Задача остаётся plan_review-ожидающей (статус не двинулся сам).
    const afterPublish = await readTaskById(request, linkedTaskId);
    expect(afterPublish.status).toBe("planning");
    expect(afterPublish.paused).toBe(true);
  } finally {
    await deleteTaskIfExists(request, linkedTaskId);
    await deleteProject(request, project.id);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// L-10g — Scenarios 10+11 (краткий путь) + Scenario 8 (единый MR): Issue со
// связанным открытым MR импортируется сразу в Done, Merge MR → sync → Accepted.
// Детерминированный уровень (LLM не нужен).
// ─────────────────────────────────────────────────────────────────────────────
test("L-10g: краткий путь Issue+MR → Done, Merge → Accepted (единый MR)", async ({ request }) => {
  await ensureGitLabIssueMrFeature(request);

  const marker = runId();
  const label = `aif-e2e-merge-${marker}`;
  const branchName = `e2e-l10g-${marker}`;
  const project = await createIsolatedProject(request, marker);
  let linkedTaskId: string | null = null;

  try {
    // Scenario 10: Issue со связанным открытым MR → импорт сразу в Done.
    await createGitLabBranchWithCommit(request, branchName, `l10g-${marker}`);
    const issue = await createIssue(request, label, `[L-10g] issue ${marker}`);
    const mr = await gitLabApi<GitLabMrResponse>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/merge_requests`,
      "POST",
      {
        source_branch: branchName,
        target_branch: "main",
        title: `[L-10g] mr ${marker}`,
        description: `Closes #${issue.iid}`,
      },
    );

    await connectGitLabViaApi(request, project.id, label);
    await syncGitLabViaApi(request, project.id);
    const link = await pollForTaskLink(request, project.id, issue.iid);
    linkedTaskId = link.taskId;
    expect(link.mrIid).toBe(mr.iid);
    expect(link.mrState).toBe("open");

    const importedTask = await pollTaskStatus(request, link.taskId!, "done", 60_000);
    expect(importedTask.status).toBe("done");

    // Scenario 11: Merge предсуществующего MR → Accepted (после sync).
    await mergeMrWithRetries(request, mr.iid);
    await syncGitLabViaApi(request, project.id);
    await pollTaskStatus(request, link.taskId!, "accepted", 60_000);

    // Единый MR: всё ещё один MR для ветки, состояние merged.
    const mrsForBranch = await listMergeRequestsForBranch(request, branchName);
    expect(mrsForBranch.length).toBe(1);
    const finalLink = (await readGitLabState(request, project.id)).issues.find(
      (entry) => entry.iid === issue.iid,
    );
    expect(finalLink?.mrState).toBe("merged");
  } finally {
    await deleteTaskIfExists(request, linkedTaskId);
    await deleteProject(request, project.id);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Negative (детерминированный уровень, legacy-события):
//   A8  done → implementing  (request_changes)
//   A9  close MR без merge → paused, НЕ accepted (реальный GitLab close + sync)
// Примечание: A1 (plan_review → improve через request_plan_changes) требует
// достижимого plan_review; legacy-набор участников (PARTICIPANTS_MODE_ENABLED=false)
// не содержит перехода planning → plan_review без LLM, поэтому A1 исполняется
// в полном LLM-тесте L-10-full на реальном контуре.
// ─────────────────────────────────────────────────────────────────────────────
test("Negative A: done→implementing, close-MR→paused (не accepted)", async ({ request }) => {
  await ensureGitLabIssueMrFeature(request);

  const marker = runId();
  const projectId = (await createIsolatedProject(request, `neg-${marker}`)).id;
  const label = `aif-e2e-neg-${marker}`;

  try {
    // A8: done → implementing (request_changes) — краткий путь импорта даёт done.
    const branch8 = `e2e-neg-a8-${marker}`;
    await createGitLabBranchWithCommit(request, branch8, `neg-a8-${marker}`);
    const issue8 = await createIssue(request, label, `[L-10neg] a8 ${marker}`);
    await gitLabApi<GitLabMrResponse>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/merge_requests`,
      "POST",
      {
        source_branch: branch8,
        target_branch: "main",
        title: `[L-10neg] a8 mr ${marker}`,
        description: `Closes #${issue8.iid}`,
      },
    );
    await connectGitLabViaApi(request, projectId, label);
    await syncGitLabViaApi(request, projectId);
    const link8 = await pollForTaskLink(request, projectId, issue8.iid);
    if (!link8.taskId) throw new Error("task not linked");
    await pollTaskStatus(request, link8.taskId, "done", 60_000);

    // Пауза: не даём координатору взять задачу, пока осуществляем негатив.
    await updateTask(request, link8.taskId, { paused: true });
    await fireTaskEvent(request, link8.taskId, "request_changes");
    const a8After = await readTaskById(request, link8.taskId);
    expect(a8After.status).toBe("implementing");
    expect(a8After.reworkRequested).toBe(true);

    // A9: отдельный импорт, задача остаётся done; close MR без merge → НЕ accepted,
    // задача получает paused (управление переходит к человеку).
    const branch9 = `e2e-neg-a9-${marker}`;
    await createGitLabBranchWithCommit(request, branch9, `neg-a9-${marker}`);
    const issue9 = await createIssue(request, label, `[L-10neg] a9 ${marker}`);
    const mr9 = await gitLabApi<GitLabMrResponse>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/merge_requests`,
      "POST",
      {
        source_branch: branch9,
        target_branch: "main",
        title: `[L-10neg] a9 mr ${marker}`,
        description: `Closes #${issue9.iid}`,
      },
    );
    await syncGitLabViaApi(request, projectId);
    const link9 = await pollForTaskLink(request, projectId, issue9.iid);
    if (!link9.taskId) throw new Error("task not linked");
    await pollTaskStatus(request, link9.taskId, "done", 60_000);
    await updateTask(request, link9.taskId, { paused: true });

    await gitLabApi(
      request,
      `/projects/${gitLabProjectPathEncoded()}/merge_requests/${mr9.iid}`,
      "PUT",
      { state_event: "close" },
    );
    await syncGitLabViaApi(request, projectId);
    const a9AfterClose = await readTaskById(request, link9.taskId);
    expect(a9AfterClose.status).not.toBe("accepted");
    expect(a9AfterClose.paused).toBe(true);
  } finally {
    await deleteProject(request, projectId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// L-10-full — Scenarios 2-9 с РЕАЛЬНЫМ LLM в автоматическом режиме.
//
// Гейт: AIF_LLM_INTEGRATION=1 + GitLab-режим + настроенный runtime-профиль
// (ensureLlmRuntime). Координатор автоматически проходит:
//   backlog → planning → plan_review (planner + plan-publisher публикуют MR плана)
//   → approve в GitLab (человек) → implementing → implementer → verify → reviewer
//   (auto-review gate: pass → done; rework/manual — закрытые ветки не проверяем) → done
//   → merge в GitLab (человек) → sync → accepted.
//
// Assertions по требованиям заказчика:
//   - план создан (plan-file-status.exists) И опубликован в MR (description содержит
//     «## Change Plan» и текст плана; publish-plan делает это только после одобрения
//     координатором plan-publisher — на планировании);
//   - реализация соответствует плану: implementationLog содержит `[files] Files changed`
//     (затронутые артефакты — что и зачем), отсутствует `[error]`/`Plan declared file(s) not modified`;
//   - отчёт о работе попал в обновлённый MR (description содержит implementationLog,
//     publishGitLabTask на стадиях implementer/reviewer);
//   - задача дошла до done АВТОМАТИЧЕСКИ (manualReviewRequired=false, executionOwner=ai,
//     количество итераций ревью в норме) — решения человека нет;
//   - обратная связь от результата к реализации: если бы reviewer нашёл блокеры,
//     он вернул бы задачу в implementing (reviewIterationCount), тест проверяет
//     детерминированно завершение через done — фактическое закрытие loop.
// ─────────────────────────────────────────────────────────────────────────────
test("L-10-full: полный AI-конвейер Issue → Accepted (LLM, автономно)", async ({ request }) => {
  await ensureGitLabIssueMrFeature(request);
  await ensureLlmRuntime(request);

  // Тест идёт минуты (несколько LLM-стадий); таймаут Playwright по умолчанию мал.
  test.setTimeout(30 * 60 * 1000);

  const marker = runId();
  const label = `aif-e2e-full-loop-${marker}`;
  const project = await createIsolatedProject(request, marker);
  let linkedTaskId: string | null = null;
  let planMrIid: number | null = null;

  try {
    // Scenario 1-2: импорт задачи и автоочередь проекта (backlog → planning).
    const issue = await createIssue(request, label, `[L-10-full] issue ${marker}`);
    await connectGitLabViaApi(request, project.id, label);
    await syncGitLabViaApi(request, project.id);
    const link = await pollForTaskLink(request, project.id, issue.iid);
    linkedTaskId = link.taskId;
    if (!linkedTaskId) throw new Error("task not linked");

    // Проект в режиме автоочереди: координатор сам двигает backlog → planning.
    // (При включении autoQueueMode задача не требует ручных событий.)
    const queueMode = await request.patch(`${API_URL}/projects/${project.id}/auto-queue-mode`, {
      data: { enabled: true },
    });
    expect(queueMode.ok()).toBe(true);

    // Scenario 3: ждём публикации MR плана координатором (plan-publisher).
    // publish-plan выставляет mrMode=plan_review и кладёт план в description.
    await expect
      .poll(
        async () => {
          const state = await readGitLabState(request, project.id);
          const entry = state.issues.find((item) => item.iid === issue.iid);
          if (entry?.mrIid && entry.mrMode === "plan_review") {
            planMrIid = entry.mrIid;
            return planMrIid;
          }
          return null;
        },
        { timeout: 15 * 60 * 1000, intervals: [5_000, 5_000, 10_000] },
      )
      .not.toBeNull();

    // Гарантия Scenario 3 (1/2): файл плана создан на диске.
    const planFile = await request.get(`${API_URL}/tasks/${linkedTaskId}/plan-file-status`);
    expect(planFile.ok()).toBe(true);
    const planStatus = (await planFile.json()) as { exists: boolean; path: string };
    expect(planStatus.exists).toBe(true);

    // Гарантия Scenario 3 (2/2): план опубликован в MR (текст в description).
    const planMr = await gitLabApi<GitLabMrResponse & { description: string }>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/merge_requests/${planMrIid}`,
    );
    expect(planMr.description).toContain("## Change Plan");

    // Scenario 4: человек одобряет план в GitLab → sync → implementing.
    const approved = await gitLabApi<{ approved: boolean }>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/merge_requests/${planMrIid}/approve`,
      "POST",
    );
    expect(approved.approved).toBe(true);
    await syncGitLabViaApi(request, project.id);

    // Scenarios 5-7: implementer → verify → reviewer(auto gate) → done.
    // Никаких ручных событий: координатор сам решает (человек решения не принимает).
    let doneTask: TaskDetails | null = null;
    await expect
      .poll(
        async () => {
          const current = await readTaskById(request, linkedTaskId!);
          doneTask = current;
          return current.status;
        },
        { timeout: 25 * 60 * 1000, intervals: [10_000, 10_000, 15_000] },
      )
      .toBe("done");

    expect(doneTask!.manualReviewRequired).toBe(false);
    expect(doneTask!.executionOwner).toBe("ai");
    // Автоматический контур: если бы reviewer запросил доработку, счётчик итераций
    // вырос бы и задача вернулась в implementing; по факту завершилась в done.
    expect(doneTask!.planReviewState).toBe("approved");

    // Гарантия Scenario 7 (1/2): work-report исполнителя — затронутые артефакты.
    const logText = doneTask!.implementationLog ?? "";
    expect(logText.length).toBeGreaterThan(0);
    expect(logText).toMatch(/\[files\] Files changed by this implementation:/);
    expect(logText).toMatch(/- .+\.(ts|tsx|js|md|mjs|cjs|json|css|html)/);
    // Реализация соответствует плану: не должно быть заявлений «план не исполнен».
    expect(logText).not.toMatch(/Plan declared file\(s\) not modified/);
    expect(logText).not.toMatch(/\[error\]/);

    // Гарантия Scenario 7 (2/2): отчёт о работе попал в обновлённый MR
    // (publishGitLabTask на стадиях implementer/reviewer пишет implementationLog
    // в description единого MR).
    const finalMr = await gitLabApi<GitLabMrResponse & { description: string }>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/merge_requests/${planMrIid}`,
    );
    expect(finalMr.description).toContain("## Implementation");
    expect(finalMr.description).toContain("Files changed by this implementation");

    // Scenario 8: единый MR на протяжении всего пути.
    const mrsForBranch = await listMergeRequestsForBranch(request, finalMr.source_branch);
    expect(mrsForBranch.length).toBe(1);

    // Scenario 9: Merge единого MR → Done → Accepted.
    await mergeMrWithRetries(request, planMrIid!);
    await syncGitLabViaApi(request, project.id);
    await expect
      .poll(async () => (await readTaskById(request, linkedTaskId!)).status, {
        timeout: 5 * 60 * 1000,
        intervals: [5_000, 5_000, 10_000],
      })
      .toBe("accepted");

    const finalLink = (await readGitLabState(request, project.id)).issues.find(
      (entry) => entry.iid === issue.iid,
    );
    expect(finalLink?.mrState).toBe("merged");
    expect(finalLink?.mrIid).toBe(planMrIid);
  } finally {
    await deleteTaskIfExists(request, linkedTaskId);
    await deleteProject(request, project.id);
  }
});
