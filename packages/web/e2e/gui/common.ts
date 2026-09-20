import type { Page, APIRequestContext } from "@playwright/test";

/**
 * E2E GUI shared helpers — real dev stack (API :3009 + web :5180).
 *
 * Contract references:
 * - REST: `docs/contracts/contract-aif-rest-api.md` (`/tasks`, `/tasks/:id/events`,
 *   `/tasks/:id/handoff`, `/tasks/:id/comments`, `/runtime-profiles`)
 * - WS: `docs/contracts/contract-aif-ws.md` (`ws:connected`, `task:moved`, ...)
 *
 * Fixture convention: test tasks are created with `autoMode:false` and
 * `paused:true` so the running coordinator never hijacks them, and deleted in
 * cleanup via REST.
 */

export const WEB_URL = process.env.AIF_WEB_URL ?? "http://localhost:5180";
export const API_URL = process.env.AIF_E2E_API_URL ?? "http://localhost:3009";

export const PROJECT_ID = "c1de80b3-2ba0-48c7-9f04-2d777472d218";

export const STATUS_COLUMN_LABELS = [
  "Backlog",
  "Planning",
  "Improve",
  "Plan Review",
  "Implementing",
  "Verify",
  "Review",
  "Blocked",
  "Done",
  "Accepted",
];

export interface CreateTaskOptions {
  title: string;
  description?: string;
  autoMode?: boolean;
  paused?: boolean;
  executionOwner?: "ai" | "human";
  priority?: number;
  planPath?: string | null;
  skipReview?: boolean;
}

export function makeTaskPayload(options: CreateTaskOptions) {
  return {
    projectId: PROJECT_ID,
    title: options.title,
    description: options.description ?? "E2E GUI fixture",
    autoMode: options.autoMode ?? false,
    executionOwner: options.executionOwner ?? "ai",
    assigneeIds: [],
    isFix: false,
    plannerMode: "fast" as const,
    planPath: options.planPath ?? ".ai-factory/PLAN.md",
    planDocs: false,
    planTests: false,
    skipReview: options.skipReview ?? true,
    useSubagents: false,
    runPlanImprove: false,
    runPostVerify: false,
    autoQa: false,
    maxReviewIterations: 3,
    runtimeProfileId: null,
    modelOverride: null,
    priority: options.priority ?? 0,
    paused: options.paused ?? true,
  };
}

export interface CreatedTask {
  id: string;
  status: string;
  executionOwner: string;
  title: string;
}

/** Creates a disposable task via the REST API (real server oracle). */
export async function createTaskViaApi(
  api: APIRequestContext,
  options: CreateTaskOptions,
): Promise<CreatedTask> {
  const response = await api.post(`${API_URL}/tasks`, { data: makeTaskPayload(options) });
  if (!response.ok()) {
    throw new Error(`createTaskViaApi failed: ${response.status()} ${await response.text()}`);
  }
  const task = (await response.json()) as CreatedTask;
  return task;
}

/** Deletes a disposable task; tolerates 404 (already gone). */
export async function deleteTaskViaApi(api: APIRequestContext, id: string): Promise<void> {
  const response = await api.delete(`${API_URL}/tasks/${id}`);
  if (!response.ok() && response.status() !== 404) {
    throw new Error(`deleteTaskViaApi failed: ${response.status()} ${await response.text()}`);
  }
}

/** Opens the project board and waits until the board is interactive. */
export async function openProjectBoard(page: Page): Promise<void> {
  await page.goto(`/project/${PROJECT_ID}`);
  await page.getByTestId("kanban-board").waitFor({ state: "visible" });
}

/** Column count badge for a given status column (h3 label + sibling count). */
export async function readColumnCount(page: Page, label: string): Promise<number> {
  const heading = page.getByRole("heading", { name: label, exact: true });
  await heading.waitFor({ state: "visible" });
  const container = heading.locator("xpath=..");
  const countText = await container.locator("span").last().innerText();
  return Number.parseInt(countText, 10);
}

/** Unique suffix for disposable fixtures in a single run. */
export function runId(): string {
  return String(Date.now());
}
