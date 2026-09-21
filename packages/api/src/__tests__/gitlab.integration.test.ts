import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GitLabClient } from "../services/gitlab.js";

/**
 * Интеграционный smoke-тест взаимодействия с реальным GitLab-стендом.
 *
 * Стенд поднимается из docker-compose.e2e.yml (см. scripts/e2e-docker.mjs):
 *   - GitLab CE доступен с хоста на http://localhost:8929 (GITLAB_WEB_PORT);
 *   - root PAT провижинится со значением GITLAB_TOKEN (имя aif-e2e);
 *   - тестовый репозиторий root/e2e-target создаётся со README (ветка main).
 *
 * Тест гоняет путь, повторяющий сценарий e2e (`packages/web/e2e/gui/gitlab-issue-to-accepted.spec.ts`)
 * и описание docker-compose.e2e.yml (Issue → MR → Approve → comment → merge):
 *   1. getRepository — валидация подключения (как routes/gitlab.ts connect);
 *   2. создание ветки + коммит файла, создание issue, createMergeRequest;
 *   3. findMergeRequest / getMergeRequestApprovals / getCommitChecks;
 *   4. upsertMarkerNote дважды — проверка идемпотентности (update вместо дубля);
 *   5. approve через REST API → getMergeRequestApprovals → reviewState approved;
 *   6. merge через REST API → getMergeRequest → state merged; issue закрыт
 *      автоматически ("Closes #<iid>" в описании MR).
 *
 * Гейт по флагу: запускается только при AIF_GITLAB_INTEGRATION=1. CI и обычный
 * прогон vitest флаг не ставят, поэтому основной набор остаётся герметичным.
 * Локальный запуск (стенд: `node scripts/e2e-docker.mjs --prepare`):
 *   AIF_GITLAB_INTEGRATION=1 npx vitest run gitlab.integration.test.ts
 */

const GITLAB_HEALTHCHECK_POLL_MS = 1_000;
const GITLAB_HEALTHCHECK_TIMEOUT_MS = 60_000;

// --- Загрузка .env.integration (репозиторий уже умеет так же, как e2e-docker.mjs) ---

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf8");
  const parsed: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && value) parsed[key] = value;
  }
  return parsed;
}

function loadIntegrationEnvFromFile(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "../../../../.env.integration");
  const fileValues = readEnvFile(envPath);
  for (const [key, value] of Object.entries(fileValues)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

loadIntegrationEnvFromFile();

const ENABLED = process.env.AIF_GITLAB_INTEGRATION === "1";
const GITLAB_BASE_URL = (process.env.AIF_GITLAB_BASE_URL ?? "").trim().replace(/\/+$/, "");
const GITLAB_TOKEN = (process.env.GITLAB_TOKEN ?? "").trim();
const TEST_NAMESPACE = (process.env.GITLAB_TEST_NAMESPACE ?? "root").trim();
const TEST_PROJECT = (process.env.GITLAB_TEST_PROJECT ?? "e2e-target").trim();
const READY = GITLAB_BASE_URL.length > 0 && GITLAB_TOKEN.length > 0;

/**
 * Минимальная REST-обёртка для операций, которых нет в GitLabClient
 * (создание фикстур Issue/ветки/коммита, approve, merge). Токен уходит
 * заголовком PRIVATE-TOKEN, как в scripts/e2e-docker.mjs и e2e-спектрах.
 */
async function gitlabRest<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${GITLAB_BASE_URL}${path}`, {
    method,
    headers: {
      "PRIVATE-TOKEN": GITLAB_TOKEN,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitLab API ${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function waitForGitLab(): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolveWait, reject) => {
    const tryOnce = async (): Promise<void> => {
      if (Date.now() - startedAt >= GITLAB_HEALTHCHECK_TIMEOUT_MS) {
        reject(
          new Error(
            `GitLab ${GITLAB_BASE_URL} not ready within ${GITLAB_HEALTHCHECK_TIMEOUT_MS}ms`,
          ),
        );
        return;
      }
      try {
        const response = await fetch(`${GITLAB_BASE_URL}/version`, {
          headers: { "PRIVATE-TOKEN": GITLAB_TOKEN },
        });
        if (response.ok) {
          resolveWait();
          return;
        }
      } catch {
        // Стенд ещё поднимается.
      }
      await new Promise<void>((r) => setTimeout(r, GITLAB_HEALTHCHECK_POLL_MS));
      void tryOnce();
    };
    void tryOnce();
  });
}

/**
 * Merge MR с ретраями на 422 "Branch cannot be merged": сразу после создания
 * ветки+коммита+MR GitLab (CE) может ещё не финализировать MR (Sidekiq), и
 * merge возвращает 422 transient. Повторяем с паузой; если это настоящая
 * невозможность merge (конфликт, удалённая ветка), ретраи не помогут и тест
 * упадёт с исходной ошибкой (при недостижении лимита).
 */
async function mergeMergeRequestWithRetries(encodedProject: string, mrIid: number): Promise<void> {
  const maxAttempts = 12;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await gitlabRest<unknown>(
        `/projects/${encodedProject}/merge_requests/${mrIid}/merge`,
        "PUT",
        { should_remove_source_branch: true },
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Ретраим только transient 422 "Branch cannot be merged"; остальное -
      // это уже не гонка, а реальная ошибка.
      if (!message.includes("422") || !message.includes("Branch cannot be merged")) {
        throw error;
      }
      lastError = error;
      await new Promise<void>((r) => setTimeout(r, 750));
    }
  }
  throw lastError;
}

interface GitLabIssue {
  iid: number;
  state: string;
  title: string;
}

describe.skipIf(!ENABLED || !READY)("GitLab integration", () => {
  const client = new GitLabClient(GITLAB_TOKEN, GITLAB_BASE_URL);
  const encodedProject = encodeURIComponent(`${TEST_NAMESPACE}/${TEST_PROJECT}`);

  it("connects to the configured test repository and reads it back", async () => {
    await waitForGitLab();
    const repository = await client.getRepository(`${TEST_NAMESPACE}/${TEST_PROJECT}`);

    expect(repository.path_with_namespace).toBe(`${TEST_NAMESPACE}/${TEST_PROJECT}`);
    expect(repository.default_branch).toBeTruthy();
    expect(repository.web_url).toContain(TEST_PROJECT);
  }, 90_000);

  it("runs the Issue → MR → approve → comment → merge lifecycle against real GitLab", async () => {
    await waitForGitLab();

    const marker = `aif-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const branch = `it-${marker}`;
    const issueTitle = `[INT] issue ${marker}`;
    const markerNote = `<!-- aif-gitlab-review -->`;
    let issueIid: number | null = null;
    let mrIid: number | null = null;

    try {
      // 1. Ветка + коммит файла (полный доступ патча к e2e-target).
      await gitlabRest<unknown>(`/projects/${encodedProject}/repository/branches`, "POST", {
        branch,
        ref: "main",
      });
      await gitlabRest<unknown>(
        `/projects/${encodedProject}/repository/files/${encodeURIComponent(`e2e/${marker}.md`)}`,
        "POST",
        {
          branch,
          content: `# ${marker}\n`,
          commit_message: `test(integration): add ${marker}`,
        },
      );

      // 2. Issue.
      const issue = await gitlabRest<GitLabIssue>(`/projects/${encodedProject}/issues`, "POST", {
        title: issueTitle,
        description: "GitLab integration fixture",
      });
      issueIid = issue.iid;
      expect(issue.state).toBe("opened");

      // 3. MR, закрывающий issue.
      const mr = await client.createMergeRequest({
        namespace: TEST_NAMESPACE,
        name: TEST_PROJECT,
        sourceBranch: branch,
        targetBranch: "main",
        title: `[INT] mr ${marker}`,
        description: `Closes #${issueIid}`,
      });
      expect(mr.state).toBe("opened");
      mrIid = mr.iid;

      // 4. findMergeRequest по ветке-источнику (используется publish-роутом).
      const found = await client.findMergeRequest(TEST_NAMESPACE, TEST_PROJECT, branch);
      expect(found).not.toBeNull();
      expect(found?.iid).toBe(mr.iid);

      // 5. До одобрения reviewState = pending.
      expect(
        (await client.getMergeRequestApprovals(TEST_NAMESPACE, TEST_PROJECT, mr.iid)).reviewState,
      ).toBe("pending");

      // 6. getCommitChecks без пайплайна должен дать структурированное значение.
      const checks = await client.getCommitChecks(TEST_NAMESPACE, TEST_PROJECT, mr.sha);
      expect([null, "pending", "success", "failure"]).toContain(checks);

      // 7. upsertMarkerNote идемпотентен: второй вызов обновляет, а не дублирует.
      await client.upsertMarkerNote({
        namespace: TEST_NAMESPACE,
        name: TEST_PROJECT,
        mrIid: mr.iid,
        marker: markerNote,
        body: "review v1",
      });
      await client.upsertMarkerNote({
        namespace: TEST_NAMESPACE,
        name: TEST_PROJECT,
        mrIid: mr.iid,
        marker: markerNote,
        body: "review v2",
      });
      const notes = await client.listMergeRequestNotes(TEST_NAMESPACE, TEST_PROJECT, mr.iid);
      const markerNotes = notes.filter((note) => note.body?.includes(markerNote));
      expect(markerNotes.length).toBe(1);
      expect(markerNotes[0]?.body).toContain("review v2");

      // 8. Approve.
      const approved = await gitlabRest<{ approved: boolean }>(
        `/projects/${encodedProject}/merge_requests/${mr.iid}/approve`,
        "POST",
      );
      expect(approved.approved).toBe(true);
      expect(
        (await client.getMergeRequestApprovals(TEST_NAMESPACE, TEST_PROJECT, mr.iid)).reviewState,
      ).toBe("approved");

      // 9. Merge (с ретраем на transient 422 "Branch cannot be merged").
      await mergeMergeRequestWithRetries(encodedProject, mr.iid);
      const merged = await client.getMergeRequest(TEST_NAMESPACE, TEST_PROJECT, mr.iid);
      expect(merged.state).toBe("merged");
      expect(merged.merged_at).toBeTruthy();

      // 10. "Closes #<iid>" автоматически закрывает issue при merge — асинхронно
      // (Sidekiq). Мгновенная проверка флакает, поэтому поллим до 20с.
      await expect
        .poll(
          async () => {
            const issues = await client.listIssues(TEST_NAMESPACE, TEST_PROJECT);
            const closedIssue = issues.find((entry) => entry.iid === issueIid);
            return closedIssue?.state;
          },
          { timeout: 20_000, interval: 500 },
        )
        .toBe("closed");
    } finally {
      // Бест-эффект клинап: закрыть issue и ветку, если сценарий прервался до merge.
      if (issueIid !== null && mrIid !== null) {
        try {
          const mr = await client.getMergeRequest(TEST_NAMESPACE, TEST_PROJECT, mrIid);
          if (mr.state !== "merged") {
            await gitlabRest<unknown>(`/projects/${encodedProject}/issues/${issueIid}`, "PUT", {
              state_event: "close",
            });
            await gitlabRest<unknown>(
              `/projects/${encodedProject}/repository/branches/${encodeURIComponent(branch)}`,
              "DELETE",
            );
          }
        } catch {
          // Стенд уже мог быть остановлен — клинап бест-эффект.
        }
      }
    }
  }, 180_000);
});
