import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API_URL, runId } from "./common";

interface ApiSettings {
  gitProvider?: "github" | "gitlab";
  gitlabIssueMrEnabled?: boolean;
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
  }>;
}

interface TaskDetails {
  id: string;
  status: string;
}

interface CreatedProject {
  id: string;
  name: string;
  rootPath: string;
}

interface GitLabIssueResponse {
  iid: number;
}

interface GitLabMrResponse {
  iid: number;
}

const GITLAB_WEB_URL = process.env.GITLAB_WEB_URL;
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_REPOSITORY_PATH = "root/e2e-target";

function gitLabApiBaseUrl(): string {
  if (!GITLAB_WEB_URL) {
    throw new Error("GITLAB_WEB_URL is required");
  }
  return `${GITLAB_WEB_URL.replace(/\/$/, "")}/api/v4`;
}

function gitLabProjectPathEncoded(): string {
  return encodeURIComponent(GITLAB_REPOSITORY_PATH);
}

async function gitLabApi<T>(
  request: APIRequestContext,
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  data?: unknown,
): Promise<T> {
  if (!GITLAB_TOKEN) {
    throw new Error("GITLAB_TOKEN is required");
  }
  const response = await request.fetch(`${gitLabApiBaseUrl()}${path}`, {
    method,
    headers: {
      "PRIVATE-TOKEN": GITLAB_TOKEN,
      "Content-Type": "application/json",
    },
    data,
  });
  if (!response.ok()) {
    throw new Error(
      `GitLab API ${method} ${path} failed: ${response.status()} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

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

async function createGitLabBranchWithCommit(
  request: APIRequestContext,
  branchName: string,
  marker: string,
): Promise<void> {
  await gitLabApi(request, `/projects/${gitLabProjectPathEncoded()}/repository/branches`, "POST", {
    branch: branchName,
    ref: "main",
  });

  await gitLabApi(
    request,
    `/projects/${gitLabProjectPathEncoded()}/repository/files/${encodeURIComponent(`e2e/${marker}.md`)}`,
    "POST",
    {
      branch: branchName,
      content: `# ${marker}\n`,
      commit_message: `test(e2e): add ${marker}`,
    },
  );
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

// UC-integration.issues.bootstrap-project-sync-and-create-task: администратор подключает GitLab и синхронизирует issue в задачу (основной источник).
// UC-integration.pr-mr.publish-github-pr: GitLab-вариант MR sync/merge доводит задачу до accepted (контекст).
// HF11.1/HF11.2/HF1.6: sync issue + publish/review/merge MR + auto-accept (контекст).
// contract-aif-rest-api: POST /projects, GET/PUT/POST /projects/:id/gitlab, GET /tasks/:id — внешний oracle (контекст).
// contract-aif-gitlab: Issues/MRs API используется как внешний источник истинного merge-состояния (контекст).
test("L-10: GitLab Issue → MR merge → task accepted через UI sync", async ({ page, request }) => {
  await ensureGitLabIssueMrFeature(request);

  const marker = runId();
  const label = `aif-e2e-l10-${marker}`;
  const issueTitle = `[L-10] issue ${marker}`;
  const branchName = `e2e-l10-${marker}`;

  // Изолированный проект: у VNC (c1de80b3) на диске уже есть git-remote на
  // gitlab.com/atol-cross-platform/vnc, и prepareRepository оставил бы его —
  // sync упал бы на fetch к чужому хосту. Свежий rootPath гарантирует чистый git init.
  const project = await createIsolatedProject(request, marker);

  try {
    await createGitLabBranchWithCommit(request, branchName, `l10-${marker}`);

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

      const importedTask = await readTaskById(request, linkedTaskId!);
      expect(["done", "review", "implementing", "planning", "backlog"]).toContain(
        importedTask.status,
      );

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
    } finally {
      await deleteTaskIfExists(request, linkedTaskId);
    }
  } finally {
    await deleteProject(request, project.id);
  }
});

// UC-integration.issues.bootstrap-project-sync-and-create-task: ошибки подключения GitLab диагностируются в UI (negative).
// HF11.1: интеграция с issue-sync не должна silently fail при невалидном репозитории (контекст).
// contract-aif-rest-api: PUT /projects/:id/gitlab отклоняет невалидный repository и не создаёт connection (контекст).
test("L-10b: connect GitLab с невалидным URL отклоняется и не создаёт connection (negative)", async ({
  page,
  request,
}) => {
  await ensureGitLabIssueMrFeature(request);

  const marker = runId();
  const project = await createIsolatedProject(request, marker);

  try {
    const before = await readGitLabState(request, project.id);

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
