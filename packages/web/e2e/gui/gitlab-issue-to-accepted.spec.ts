import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
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
import { API_URL, runId } from "./common";
import { logTraceStep, testIdFor } from "../shared/trace.js";

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
    webUrl: string;
    tokenConfigured: boolean;
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
  paused?: boolean;
  reworkRequested?: boolean;
  executionOwner?: string;
  manualReviewRequired?: boolean;
  planReviewState?: string | null;
  implementationLog?: string | null;
  agentActivityLog?: string | null;
  branchName?: string | null;
  /** Причина блокировки (заполняется при status === "blocked_external"). */
  blockedReason?: string | null;
  /** Стадия, из которой задача ушла в blocked_external. */
  blockedFromStatus?: string | null;
}

interface CreatedProject {
  id: string;
  name: string;
  rootPath: string;
  plannerMaxBudgetUsd?: number | null;
  planCheckerMaxBudgetUsd?: number | null;
  implementerMaxBudgetUsd?: number | null;
  reviewSidecarMaxBudgetUsd?: number | null;
  pinnedAt?: string | null;
  groupName?: string | null;
  parallelEnabled?: boolean;
  autoQueueMode?: boolean;
  defaultTaskRuntimeProfileId?: string | null;
  defaultPlanRuntimeProfileId?: string | null;
  defaultReviewRuntimeProfileId?: string | null;
  defaultChatRuntimeProfileId?: string | null;
}

interface RuntimeProfileSummary {
  id: string;
  name: string;
  runtimeId: string;
  providerId: string;
  transport: string | null;
  apiKeyEnvVar: string | null;
  enabled: boolean;
}

interface GitLabIssueResponse {
  iid: number;
}

interface GitLabMrResponse {
  iid: number;
}

interface GitLabMrDetails extends GitLabMrResponse {
  description: string;
  source_branch: string;
}

interface GitLabMergeRequestListEntry {
  iid: number;
  source_branch: string;
  state: string;
}

const LLM_INTEGRATION_ENABLED = process.env.AIF_LLM_INTEGRATION === "1";

async function ensureGitLabIssueMrFeature(request: APIRequestContext): Promise<void> {
  const response = await request.get(`${API_URL}/settings`);
  expect(response.ok()).toBe(true);
  const settings = (await response.json()) as ApiSettings;
  test.skip(
    settings.gitProvider !== "gitlab" || !settings.gitlabIssueMrEnabled,
    "L-10 requires GIT_PROVIDER=gitlab and AIF_GITLAB_ISSUE_MR_ENABLED=true",
  );
  test.skip(!GITLAB_WEB_URL || !GITLAB_TOKEN, "L-10 requires GITLAB_WEB_URL and GITLAB_TOKEN");
}

async function ensureLlmRuntime(request: APIRequestContext): Promise<void> {
  const response = await request.get(`${API_URL}/settings`);
  expect(response.ok()).toBe(true);
  const settings = (await response.json()) as ApiSettings;

  // Capability-условие оформлено как условная применимость, а не жёсткий assert:
  // в core-контуре (e2e:core) LLM-сценарии пропускаются с явной причиной, а не падают;
  // в llm-контуре (e2e:llm) fail-fast preflight уже проверил флаг и профиль.
  test.skip(
    !LLM_INTEGRATION_ENABLED,
    "full-LLM pipeline requires AIF_LLM_INTEGRATION=1 (real runtime profile + coordinator) — run the llm lane (e2e:llm)",
  );
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
      name: `E2E GitLab ${marker}`,
      // Уникальный каталог внутри контейнера: prepareRepository сделает git init с
      // нуля и добавит origin на e2e-GitLab — не будет старого remote на gitlab.com.
      rootPath: `/home/www/e2e-gitlab-${marker}`,
    },
  });
  if (!response.ok()) {
    throw new Error(`createProject failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as CreatedProject;
}

async function listRuntimeProfiles(request: APIRequestContext): Promise<RuntimeProfileSummary[]> {
  const response = await request.get(
    `${API_URL}/runtime-profiles?includeGlobal=true&enabledOnly=true`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as RuntimeProfileSummary[];
}

async function createRuntimeProfile(
  request: APIRequestContext,
  payload: {
    name: string;
    runtimeId: string;
    providerId: string;
    transport?: string | null;
    apiKeyEnvVar?: string | null;
    defaultModel?: string | null;
  },
): Promise<RuntimeProfileSummary> {
  const response = await request.post(`${API_URL}/runtime-profiles`, {
    data: {
      name: payload.name,
      runtimeId: payload.runtimeId,
      providerId: payload.providerId,
      transport: payload.transport ?? null,
      apiKeyEnvVar: payload.apiKeyEnvVar ?? null,
      defaultModel: payload.defaultModel ?? null,
    },
  });
  if (!response.ok()) {
    throw new Error(`createRuntimeProfile failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as RuntimeProfileSummary;
}

async function ensureEffectiveLlmRuntimeProfile(request: APIRequestContext): Promise<string> {
  const profiles = await listRuntimeProfiles(request);

  // Для реального L-10-full в e2e-стенде приоритетно используем OpenRouter API-профиль:
  // Codex CLI в Docker может быть неаутентифицирован (blocked_external на planner).
  const openRouter = profiles.find((p) => p.enabled && p.runtimeId === "openrouter");
  if (openRouter) return openRouter.id;

  const created = await createRuntimeProfile(request, {
    name: `E2E OpenRouter ${runId()}`,
    runtimeId: "openrouter",
    providerId: "openrouter",
    transport: "api",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-sonnet-4",
  });
  return created.id;
}

async function setProjectRuntimeDefaults(
  request: APIRequestContext,
  project: CreatedProject,
  runtimeProfileId: string,
): Promise<void> {
  const response = await request.put(`${API_URL}/projects/${project.id}`, {
    data: {
      name: project.name,
      rootPath: project.rootPath,
      plannerMaxBudgetUsd: project.plannerMaxBudgetUsd ?? 1,
      planCheckerMaxBudgetUsd: project.planCheckerMaxBudgetUsd ?? 1,
      implementerMaxBudgetUsd: project.implementerMaxBudgetUsd ?? 1,
      reviewSidecarMaxBudgetUsd: project.reviewSidecarMaxBudgetUsd ?? 1,
      pinnedAt: project.pinnedAt ?? null,
      groupName: project.groupName ?? null,
      parallelEnabled: project.parallelEnabled ?? false,
      autoQueueMode: project.autoQueueMode ?? false,
      defaultTaskRuntimeProfileId: runtimeProfileId,
      defaultPlanRuntimeProfileId: runtimeProfileId,
      defaultReviewRuntimeProfileId: runtimeProfileId,
      defaultChatRuntimeProfileId: runtimeProfileId,
    },
  });
  if (!response.ok()) {
    throw new Error(
      `setProjectRuntimeDefaults failed: ${response.status()} ${await response.text()}`,
    );
  }
}

async function deleteProject(request: APIRequestContext, projectId: string): Promise<void> {
  const response = await request.delete(`${API_URL}/projects/${projectId}`);
  if (!response.ok() && response.status() !== 404) {
    throw new Error(`Failed to delete project ${projectId}: ${response.status()}`);
  }
}

async function openBoardForProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/project/${projectId}`);
  await page.getByTestId("kanban-board").waitFor({ state: "visible" });
}

async function openProjectEditor(page: Page, projectName: string): Promise<void> {
  await page.getByRole("button", { name: projectName, exact: true }).click();
  const row = page.locator("div.group", { hasText: projectName }).first();
  await row.getByTitle("Edit").click();
  await expect(page.getByRole("heading", { name: "Edit Project", exact: true })).toBeVisible();
}

async function connectGitLabViaUi(page: Page, repositoryUrl: string, label: string): Promise<void> {
  await page.getByLabel("Full GitLab project URL").fill(repositoryUrl);
  await page.getByLabel("GitLab issue labels").fill(label);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  // Надёжный сигнал успешного подключения — появление кнопки «Sync now»
  // (рендерится только при установленном connection) вместо хрупкого toast.
  await page.getByRole("button", { name: "Sync now", exact: true }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
}

async function syncGitLabViaUi(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  // Ждём завершения маунтации: кнопка снова активна (маунтация идёт асинхронно).
  // Фактический результат проверяется оракулом ниже.
  await page.getByRole("button", { name: "Sync now", exact: true }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
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

async function updateTask(
  request: APIRequestContext,
  taskId: string,
  patch: Partial<Pick<TaskDetails, "paused">>,
): Promise<void> {
  const response = await request.put(`${API_URL}/tasks/${taskId}`, { data: patch });
  if (!response.ok()) {
    throw new Error(`PUT /tasks/${taskId} failed: ${response.status()} ${await response.text()}`);
  }
}

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

async function syncGitLabViaApi(request: APIRequestContext, projectId: string): Promise<void> {
  const response = await request.post(`${API_URL}/projects/${projectId}/gitlab/sync`, {
    data: {},
  });
  if (!response.ok()) {
    throw new Error(`gitlab sync failed: ${response.status()} ${await response.text()}`);
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

// Polling с fail-fast на blocked_external: пока ждём появления нужного значения,
// каждая итерация читает статус задачи и при уходе в blocked_external бросает
// информативную ошибку (blockedReason/blockedFromStatus) сразу, а не ждёт
// длинного таймаута ожидания. probe возвращает null, пока условие не выполнено;
// тип значения, на которое ждём, — generic, чтобы переиспользовать и для статуса
// задачи, и для состояния GitLab-линка.
async function pollWithBlockedFailFast<T>(
  request: APIRequestContext,
  taskId: string | null,
  description: string,
  probe: () => Promise<T | null>,
  opts: { timeout: number; intervals: number[] },
): Promise<T> {
  const deadline = Date.now() + opts.timeout;
  let iteration = 0;
  let lastValue: T | null = null;
  while (Date.now() < deadline) {
    if (taskId) {
      const task = await readTaskById(request, taskId);
      if (task.status === "blocked_external") {
        throw new Error(
          [
            `fail-fast: task ${taskId} moved to blocked_external while waiting for ${description}`,
            `blockedReason: ${task.blockedReason ?? "(not provided)"}`,
            `blockedFromStatus: ${task.blockedFromStatus ?? "(not provided)"}`,
          ].join("\n"),
        );
      }
    }
    lastValue = await probe();
    if (lastValue != null) return lastValue;
    const delay = opts.intervals[Math.min(iteration, opts.intervals.length - 1)];
    iteration += 1;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, delay));
  }
  throw new Error(
    `timed out after ${opts.timeout}ms waiting for ${description}; last probe result: ${JSON.stringify(lastValue)}`,
  );
}

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

// US-integration.pr-mr.gitlab-pipeline-run — полный AI-контур Scenario 1..9 (STRICT).
// Trace: UC-integration.issues.bootstrap-project-sync-and-create-task,
// UC-pipeline.stage.auto-advance-task, UC-pipeline.plan.generate-change-plan,
// UC-integration.pr-mr.resolve-review-decision,
// UC-pipeline.implementation.execute-change-in-isolation,
// UC-pipeline.verification.verify-change-result,
// UC-pipeline.completion.auto-complete-pipeline,
// UC-vcs-auto.mr.publish-atomic-merge-request.
// HF: HF11.1/HF11.2/HF1.1/HF1.2/HF1.4/HF1.5/HF1.6/HF4.3/HF4.4/HF5.1/HF5.3/HF5.4.
// Oracle: contract-aif-rest-api + contract-aif-gitlab (mandatory external oracle).
// Primary e2e layer: API (state machine/ownership); GUI = smoke (UI connect/sync triggers).
// Capability: @requires-llm — runs only in e2e:llm lane.
test("L-10-full @requires-llm: full AI pipeline Issue → Accepted (single MR, real LLM)", async ({
  page,
  request,
}) => {
  await ensureGitLabIssueMrFeature(request);
  await ensureLlmRuntime(request);

  test.setTimeout(30 * 60 * 1000);

  const marker = runId();
  const label = `aif-e2e-full-loop-${marker}`;
  const project = await createIsolatedProject(request, marker);
  const traceId = testIdFor("L-10-full");
  logTraceStep(traceId, "project created", { projectId: project.id, marker, label });

  // Background (US): для planning/implementing/verify/review должен быть
  // настроен effective runtime profile на уровне проекта.
  const runtimeProfileId = await ensureEffectiveLlmRuntimeProfile(request);
  await setProjectRuntimeDefaults(request, project, runtimeProfileId);
  logTraceStep(traceId, "runtime defaults set", { runtimeProfileId });

  // Автоочередь включаем ДО первого sync: контракт владения (P0.2) назначает
  // владельца импортированной задачи по проекту НА МОМЕНТ импорта. Без auto-queue
  // задача импортируется human-владельцем и не подхватывается координатором.
  const queueMode = await request.patch(`${API_URL}/projects/${project.id}/auto-queue-mode`, {
    data: { enabled: true },
  });
  expect(queueMode.ok()).toBe(true);

  let linkedTaskId: string | null = null;
  let planMrIid: number | null = null;
  const observedStatuses = new Set<string>();

  try {
    // Scenario 1: Issue без MR импортируется в backlog.
    // Описание фикстуры намеренно конкретное и ограниченное: расплывчатое описание
    // толкает планировщик генерировать объёмный план (14+ задач), а реализатор
    // в 20-шаговом лимите цикла workspace-инструментов не успевает его выполнить
    // и упирается в «Workspace tool loop exceeded 20 steps». Конкретная задача на
    // один файл + запрет git-операций оставляет план малым и детерминированным,
    // при этом не ослабляет проверки контура (plan/MR/done/auto-review).
    const issue = await gitLabApi<GitLabIssueResponse>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/issues`,
      "POST",
      {
        title: `[L-10-full] issue ${marker}`,
        labels: label,
        description: [
          `Create file \`e2e/l10-${marker}.md\` with exact title \`# l10-${marker}\``,
          `and the single section \`## Purpose\` containing the text \`E2E GUI full-loop fixture\` on its own line.`,
          `Do not modify any other file. Do not create extra files or directories.`,
          `Do not run git push, git fetch, git remote, git merge, git rebase, or any destructive shell command.`,
          `Verify with \`test -s e2e/l10-${marker}.md\`.`,
        ].join("\n"),
      },
    );
    logTraceStep(traceId, "issue created", { iid: issue.iid, taskId: linkedTaskId });

    // Подключение через UI (как требует GUI-контур), затем sync.
    await openBoardForProject(page, project.id);
    await openProjectEditor(page, project.name);
    await connectGitLabViaUi(page, `${GITLAB_WEB_URL}/${GITLAB_REPOSITORY_PATH}`, label);
    await syncGitLabViaUi(page);

    const firstLink = await pollForTaskLink(request, project.id, issue.iid);
    linkedTaskId = firstLink.taskId;
    if (!linkedTaskId) throw new Error("task not linked");
    expect(firstLink.mrIid).toBeNull();

    await expect
      .poll(async () => (await readTaskById(request, linkedTaskId!)).status)
      .toBe("backlog");
    observedStatuses.add("backlog");

    // Scenario 2: auto-queue backlog → planning (auto-queue уже включён до sync).
    await pollWithBlockedFailFast(
      request,
      linkedTaskId,
      "auto-queue: backlog → planning (или далее по контуру)",
      async () => {
        const row = await readTaskById(request, linkedTaskId!);
        observedStatuses.add(row.status);
        return ["planning", "plan_review", "implementing", "verify", "review", "done"].includes(
          row.status,
        )
          ? row.status
          : null;
      },
      { timeout: 10 * 60 * 1000, intervals: [5_000, 5_000, 10_000] },
    );
    expect(observedStatuses.has("planning")).toBe(true);

    // Scenario 3: planner создаёт план и единый MR в режиме plan_review.
    planMrIid = await pollWithBlockedFailFast(
      request,
      linkedTaskId,
      "plan_review MR publication (единый MR, mode=plan_review)",
      async () => {
        const state = await readGitLabState(request, project.id);
        const entry = state.issues.find((item) => item.iid === issue.iid);
        if (entry?.mrIid && entry.mrMode === "plan_review") {
          return entry.mrIid;
        }
        return null;
      },
      { timeout: 15 * 60 * 1000, intervals: [5_000, 5_000, 10_000] },
    );

    expect(planMrIid).not.toBeNull();

    // Задача обязана остановиться в plan_review (MR ещё не одобрен человеком).
    // Ожидаем именно этот статус, а не читаем один раз: синхронизация линка и
    // статуса идёт асинхронно, и однократное чтение ловило бы гонку.
    await pollWithBlockedFailFast(
      request,
      linkedTaskId,
      "статус plan_review (MR опубликован, approve ещё не было)",
      async () => {
        const row = await readTaskById(request, linkedTaskId!);
        observedStatuses.add(row.status);
        return row.status === "plan_review" ? row.status : null;
      },
      { timeout: 2 * 60 * 1000, intervals: [2_000, 2_000, 5_000] },
    );

    const planFile = await request.get(`${API_URL}/tasks/${linkedTaskId}/plan-file-status`);
    expect(planFile.ok()).toBe(true);
    const planStatus = (await planFile.json()) as { exists: boolean; path: string };
    expect(planStatus.exists).toBe(true);

    const planMr = await gitLabApi<GitLabMrDetails>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/merge_requests/${planMrIid}`,
    );
    expect(planMr.description).toContain("## Change Plan");

    // Scenario 4: approve в GitLab -> после sync задача уходит в implementing.
    const approved = await gitLabApi<{ approved: boolean }>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/merge_requests/${planMrIid}/approve`,
      "POST",
    );
    expect(approved.approved).toBe(true);
    await syncGitLabViaApi(request, project.id);

    // Scenario 5: после sync задача стартует implementing (и далее по авто-контуру).
    await pollWithBlockedFailFast(
      request,
      linkedTaskId,
      "approve → implementing (implementing/verify/review/done)",
      async () => {
        const status = (await readTaskById(request, linkedTaskId!)).status;
        observedStatuses.add(status);
        return ["implementing", "verify", "review", "done"].includes(status) ? status : null;
      },
      { timeout: 10 * 60 * 1000, intervals: [5_000, 5_000, 10_000] },
    );

    // Scenario 5/6/7: implementing -> verify -> review -> done (автоконтур).
    const doneTask = await pollWithBlockedFailFast(
      request,
      linkedTaskId,
      "автоконтур implementing → verify → review → done",
      async () => {
        const current = await readTaskById(request, linkedTaskId!);
        observedStatuses.add(current.status);
        return current.status === "done" ? current : null;
      },
      { timeout: 25 * 60 * 1000, intervals: [10_000, 10_000, 15_000] },
    );

    expect(doneTask.manualReviewRequired).toBe(false);
    expect(doneTask.executionOwner).toBe("ai");
    expect(doneTask.planReviewState).toBe("approved");

    const logText = doneTask.implementationLog ?? "";
    expect(logText.length).toBeGreaterThan(0);
    expect(logText).toMatch(/\[files\] Files changed by this implementation:/);
    expect(logText).not.toMatch(/Plan declared file\(s\) not modified/);
    expect(logText).not.toMatch(/\[error\]/);

    // Scenario 8: на всём пути используется тот же единственный MR.
    expect(observedStatuses.has("plan_review")).toBe(true);
    expect(observedStatuses.has("implementing")).toBe(true);
    expect(observedStatuses.has("verify")).toBe(true);
    expect(observedStatuses.has("review")).toBe(true);

    const finalMr = await gitLabApi<GitLabMrDetails>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/merge_requests/${planMrIid}`,
    );
    expect(finalMr.description).toContain("## Implementation");
    expect(finalMr.description).toContain("Files changed by this implementation");
    const mrsForBranch = await listMergeRequestsForBranch(request, finalMr.source_branch);
    expect(mrsForBranch.length).toBe(1);

    // Scenario 9: merge единого MR -> sync -> accepted.
    await mergeMrWithRetries(request, planMrIid!);
    await syncGitLabViaApi(request, project.id);
    await pollWithBlockedFailFast(
      request,
      linkedTaskId,
      "merge → accepted",
      async () => {
        const row = await readTaskById(request, linkedTaskId!);
        return row.status === "accepted" ? row.status : null;
      },
      { timeout: 5 * 60 * 1000, intervals: [5_000, 5_000, 10_000] },
    );

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

// US-integration.pr-mr.gitlab-issue-shortcut-accept — Scenario 10 + 11 (краткий контур):
//   Issue с уже существующим MR → импорт сразу в done → merge/sync → accepted.
// UC-integration.issues.bootstrap-project-sync-and-create-task + UC-integration.pr-mr.resolve-review-decision.
// HF11.1/HF11.2/HF1.6; BR-fact.git.vcs-workflow + BR-trigger.automation.done-to-accepted-approval.
// Oracle: contract-aif-rest-api (GET /tasks/:id, GET /projects/:id/gitlab) + contract-aif-gitlab (MR state).
// Primary e2e layer: GUI (UI connect/sync flow + user-visible shortcut acceptance).
// Secondary smoke/trace: API L-10g covers the same transition deterministically (state semantics).
test("L-10: shortcut path Issue+MR → Done, Merge → Accepted (single MR, UI sync)", async ({
  page,
  request,
}) => {
  await ensureGitLabIssueMrFeature(request);

  const marker = runId();
  const label = `aif-e2e-l10-${marker}`;
  const issueTitle = `[L-10] issue ${marker}`;
  let branchName = `e2e-l10-${marker}`;

  // Изолированный проект: у VNC (c1de80b3) на диске уже есть git-remote на
  // gitlab.com/atol-cross-platform/vnc, и prepareRepository оставил бы его —
  // sync упал бы на fetch к чужому хосту. Свежий rootPath гарантирует чистый git init.
  const project = await createIsolatedProject(request, marker);

  try {
    const createdBranch = await createGitLabBranchWithCommit(request, branchName, `l10-${marker}`);
    branchName = createdBranch;

    const issue = await gitLabApi<GitLabIssueResponse>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/issues`,
      "POST",
      {
        title: issueTitle,
        labels: label,
        description: "E2E GUI L-10 fixture",
      },
    );

    const mr = await gitLabApi<GitLabMrResponse>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/merge_requests`,
      "POST",
      {
        source_branch: branchName,
        target_branch: "main",
        title: `[L-10] mr ${marker}`,
        description: `Closes #${issue.iid}`,
      },
    );

    let linkedTaskId: string | null = null;

    try {
      await openBoardForProject(page, project.id);
      await openProjectEditor(page, project.name);
      await connectGitLabViaUi(page, `${GITLAB_WEB_URL}/${GITLAB_REPOSITORY_PATH}`, label);
      await syncGitLabViaUi(page);

      await expect
        .poll(async () => {
          const state = await readGitLabState(request, project.id);
          const link = state.issues.find((entry) => entry.iid === issue.iid);
          if (!link?.taskId) return null;
          return { taskId: link.taskId, mrIid: link.mrIid, mrState: link.mrState };
        })
        .toEqual({ taskId: expect.any(String), mrIid: mr.iid, mrState: "open" });

      const stateAfterFirstSync = await readGitLabState(request, project.id);
      const link = stateAfterFirstSync.issues.find((entry) => entry.iid === issue.iid);
      expect(link).toBeDefined();
      linkedTaskId = link!.taskId;
      expect(linkedTaskId).toBeTruthy();

      // Scenario 10: краткий интеграционный путь должен импортировать задачу сразу в done
      // без прохождения AI-этапов planning/improve/plan_review/implementing/verify/review.
      const importedTask = await readTaskById(request, linkedTaskId!);
      expect(importedTask.status).toBe("done");
      expect(importedTask.planReviewState ?? null).toBeNull();
      expect(importedTask.executionOwner).toBe("human");

      const shortcutActivity = importedTask.agentActivityLog ?? "";
      expect(shortcutActivity).not.toMatch(/aif-plan started/i);
      expect(shortcutActivity).not.toMatch(/aif-implement started/i);
      expect(shortcutActivity).not.toMatch(/aif-verify started/i);
      expect(shortcutActivity).not.toMatch(/aif-review started/i);

      // Single-MR policy: до merge для исходной ветки существует ровно один MR.
      const mrsForBranchBeforeMerge = await listMergeRequestsForBranch(request, branchName);
      expect(mrsForBranchBeforeMerge.length).toBe(1);

      await gitLabApi(
        request,
        `/projects/${gitLabProjectPathEncoded()}/merge_requests/${mr.iid}/merge`,
        "PUT",
        { merge_when_pipeline_succeeds: false, should_remove_source_branch: true },
      );

      await syncGitLabViaUi(page);

      await expect
        .poll(async () => {
          const row = await readTaskById(request, linkedTaskId!);
          return row.status;
        })
        .toBe("accepted");

      const finalState = await readGitLabState(request, project.id);
      const finalLink = finalState.issues.find((entry) => entry.iid === issue.iid);
      expect(finalLink?.mrState).toBe("merged");
      expect(finalLink?.mrIid).toBe(mr.iid);

      // После merge новый completion MR не появляется — всё в том же едином MR.
      const mrsForBranchAfterMerge = await listMergeRequestsForBranch(request, branchName);
      expect(mrsForBranchAfterMerge.length).toBe(1);
    } finally {
      await deleteTaskIfExists(request, linkedTaskId);
    }
  } finally {
    await deleteProject(request, project.id);
  }
});

// US-integration.issues.bootstrap-project-sync-and-create-task — negative (валидность подключения):
// не входит в numbered-сценарии, но обязателен как guardrail окружения.
// UC-integration.issues.bootstrap-project-sync-and-create-task; HF11.1.
// Oracle: contract-aif-rest-api (PUT /projects/:id/gitlab не должен создавать connection на invalid repo).
// Primary e2e layer: GUI (form + error rendering). API duplicates the negative validation logic.
test("L-10b: connect GitLab с невалидным URL отклоняется и не создаёт connection (negative)", async ({
  page,
  request,
}) => {
  await ensureGitLabIssueMrFeature(request);

  const marker = runId();
  const project = await createIsolatedProject(request, marker);

  try {
    await openBoardForProject(page, project.id);
    await openProjectEditor(page, project.name);

    await page
      .getByLabel("Full GitLab project URL")
      .fill(`${GITLAB_WEB_URL}/root/non-existent-${marker}`);
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    // UI обязан показать диагностируемую ошибку, а не «молчать».
    await expect(
      page.getByText(/Failed to connect GitLab repository|Not Found|404/i),
    ).toBeVisible();

    const after = await readGitLabState(request, project.id);
    expect(after.connection).toBeNull();
  } finally {
    await deleteProject(request, project.id);
  }
});

// US-integration.pr-mr.gitlab-issue-shortcut-accept — негативные ветки MR:
//   A8 done → implementing (request_changes),
//   A9 close MR без merge/approve: не accepted + paused.
// UC-integration.pr-mr.resolve-review-decision; HF11.2/HF5.3; BR-inference.git.review-decision-precedence.
// Oracle: contract-aif-rest-api (POST /tasks/:id/events, GET /tasks/:id), contract-aif-gitlab (MR state=closed).
// Primary e2e layer: API (state semantics — API L-10j/L-10c/Negative A run the same assertions).
// Secondary smoke/trace: GUI keeps UI sync triggers; deep state assertions stay in API lane.
test("L-10c: negative MR decisions (A8/A9) keep flow safe", async ({ page, request }) => {
  await ensureGitLabIssueMrFeature(request);

  const marker = runId();
  const label = `aif-e2e-neg-${marker}`;
  const project = await createIsolatedProject(request, `neg-${marker}`);

  try {
    await openBoardForProject(page, project.id);
    await openProjectEditor(page, project.name);
    await connectGitLabViaUi(page, `${GITLAB_WEB_URL}/${GITLAB_REPOSITORY_PATH}`, label);

    // A8: краткий путь (Issue+MR) импортирует в done; request_changes возвращает в implementing.
    const branchA8 = `e2e-neg-a8-${marker}`;
    const createdBranchA8 = await createGitLabBranchWithCommit(
      request,
      branchA8,
      `neg-a8-${marker}`,
    );
    const issueA8 = await gitLabApi<GitLabIssueResponse>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/issues`,
      "POST",
      {
        title: `[L-10c] A8 issue ${marker}`,
        labels: label,
        description: "E2E GUI negative A8 fixture",
      },
    );
    await gitLabApi<GitLabMrResponse>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/merge_requests`,
      "POST",
      {
        source_branch: createdBranchA8,
        target_branch: "main",
        title: `[L-10c] A8 mr ${marker}`,
        description: `Closes #${issueA8.iid}`,
      },
    );

    await syncGitLabViaUi(page);

    await expect
      .poll(async () => {
        const state = await readGitLabState(request, project.id);
        return state.issues.find((entry) => entry.iid === issueA8.iid) ?? null;
      })
      .toBeTruthy();

    const stateA8 = await readGitLabState(request, project.id);
    const rowA8 = stateA8.issues.find((entry) => entry.iid === issueA8.iid);
    expect(rowA8?.taskId).toBeTruthy();
    const taskIdA8 = rowA8!.taskId!;

    await expect.poll(async () => (await readTaskById(request, taskIdA8)).status).toBe("done");

    await updateTask(request, taskIdA8, { paused: true });
    const a8AfterEvent = await fireTaskEvent(request, taskIdA8, "request_changes");
    expect(a8AfterEvent.status).toBe("implementing");
    expect(a8AfterEvent.reworkRequested).toBe(true);

    // A9: close MR без merge/approve не должен переводить задачу в accepted.
    const branchA9 = `e2e-neg-a9-${marker}`;
    const createdBranchA9 = await createGitLabBranchWithCommit(
      request,
      branchA9,
      `neg-a9-${marker}`,
    );
    const issueA9 = await gitLabApi<GitLabIssueResponse>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/issues`,
      "POST",
      {
        title: `[L-10c] A9 issue ${marker}`,
        labels: label,
        description: "E2E GUI negative A9 fixture",
      },
    );
    const mrA9 = await gitLabApi<GitLabMrResponse>(
      request,
      `/projects/${gitLabProjectPathEncoded()}/merge_requests`,
      "POST",
      {
        source_branch: createdBranchA9,
        target_branch: "main",
        title: `[L-10c] A9 mr ${marker}`,
        description: `Closes #${issueA9.iid}`,
      },
    );

    await syncGitLabViaUi(page);

    const stateA9 = await readGitLabState(request, project.id);
    const rowA9 = stateA9.issues.find((entry) => entry.iid === issueA9.iid);
    expect(rowA9?.taskId).toBeTruthy();
    const taskIdA9 = rowA9!.taskId!;

    await expect.poll(async () => (await readTaskById(request, taskIdA9)).status).toBe("done");

    await updateTask(request, taskIdA9, { paused: true });
    await gitLabApi(
      request,
      `/projects/${gitLabProjectPathEncoded()}/merge_requests/${mrA9.iid}`,
      "PUT",
      { state_event: "close" },
    );
    await syncGitLabViaUi(page);

    const a9Task = await readTaskById(request, taskIdA9);
    expect(a9Task.status).not.toBe("accepted");
    expect(a9Task.paused).toBe(true);

    const mrsForBranchA9 = await listMergeRequestsForBranch(request, createdBranchA9);
    expect(mrsForBranchA9.length).toBe(1);
    expect(mrsForBranchA9[0]?.state).toBe("closed");

    await deleteTaskIfExists(request, taskIdA8);
    await deleteTaskIfExists(request, taskIdA9);
  } finally {
    await deleteProject(request, project.id);
  }
});
