import { and, desc, eq, max } from "drizzle-orm";
import {
  auditEvents,
  generatePlanPath,
  getProjectConfig,
  gitlabIssues,
  gitlabRepositories,
  logger,
  projects,
  taskExecutorHistory,
  tasks,
  type GitLabEligibility,
  type GitLabIssueLink,
  type GitLabIssueRow,
  type GitLabIssueSnapshot,
  type GitLabRepositoryConnection,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { createAuditEventValues } from "./audit.js";

const log = logger("data:gitlab");
const DEFAULT_ELIGIBILITY: GitLabEligibility = { labels: [], assignee: null, milestone: null };

function parseEligibility(raw: string): GitLabEligibility {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_ELIGIBILITY;
    const record = value as Record<string, unknown>;
    return {
      labels: Array.isArray(record.labels)
        ? record.labels.filter((label): label is string => typeof label === "string")
        : [],
      assignee: typeof record.assignee === "string" ? record.assignee : null,
      milestone: typeof record.milestone === "string" ? record.milestone : null,
    };
  } catch {
    return DEFAULT_ELIGIBILITY;
  }
}

function parseIssueSnapshot(raw: string): GitLabIssueSnapshot {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    return {
      title: typeof record.title === "string" ? record.title : "",
      body: typeof record.body === "string" ? record.body : "",
      author: typeof record.author === "string" ? record.author : "unknown",
      labels: Array.isArray(record.labels)
        ? record.labels.filter((item): item is string => typeof item === "string")
        : [],
      assignees: Array.isArray(record.assignees)
        ? record.assignees.filter((item): item is string => typeof item === "string")
        : [],
      milestone: typeof record.milestone === "string" ? record.milestone : null,
      comments: Array.isArray(record.comments)
        ? record.comments.filter(
            (item): item is GitLabIssueSnapshot["comments"][number] =>
              Boolean(item) &&
              typeof item === "object" &&
              !Array.isArray(item) &&
              typeof (item as Record<string, unknown>).id === "number" &&
              typeof (item as Record<string, unknown>).author === "string" &&
              typeof (item as Record<string, unknown>).body === "string" &&
              typeof (item as Record<string, unknown>).webUrl === "string" &&
              typeof (item as Record<string, unknown>).createdAt === "string" &&
              typeof (item as Record<string, unknown>).updatedAt === "string",
          )
        : [],
    };
  } catch {
    return { title: "", body: "", author: "unknown", labels: [], assignees: [], milestone: null, comments: [] };
  }
}

function toIssueLink(row: GitLabIssueRow): GitLabIssueLink {
  return {
    projectId: row.projectId,
    iid: row.iid,
    taskId: row.taskId,
    globalId: row.globalId,
    webUrl: row.webUrl,
    state: row.state,
    metadata: parseIssueSnapshot(row.metadataJson),
    sourceUpdatedAt: row.sourceUpdatedAt,
    lastSyncedAt: row.lastSyncedAt,
    syncError: row.syncError,
    mrIid: row.mrIid,
    mrUrl: row.mrUrl,
    mrState: row.mrState,
    mrChecksStatus: row.mrChecksStatus,
    reviewState: row.reviewState,
    lastReviewNoteId: row.lastReviewNoteId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toConnection(row: typeof gitlabRepositories.$inferSelect): GitLabRepositoryConnection {
  return {
    projectId: row.projectId,
    namespace: row.namespace,
    name: row.name,
    webUrl: row.webUrl,
    defaultBranch: row.defaultBranch,
    tokenEnvVar: row.tokenEnvVar,
    eligibility: parseEligibility(row.eligibilityJson),
    enabled: row.enabled,
    tokenConfigured: Boolean(process.env[row.tokenEnvVar]?.trim()),
    lastSyncedAt: row.lastSyncedAt,
    syncError: row.syncError,
    gitPreparedAt: row.gitPreparedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function findGitLabRepository(projectId: string): GitLabRepositoryConnection | undefined {
  const row = getDb()
    .select()
    .from(gitlabRepositories)
    .where(eq(gitlabRepositories.projectId, projectId))
    .get();
  return row ? toConnection(row) : undefined;
}

export function listEnabledGitLabRepositories(): GitLabRepositoryConnection[] {
  return getDb()
    .select()
    .from(gitlabRepositories)
    .where(eq(gitlabRepositories.enabled, true))
    .all()
    .map(toConnection);
}

export function upsertGitLabRepository(input: {
  projectId: string;
  namespace: string;
  name: string;
  webUrl: string;
  defaultBranch: string;
  tokenEnvVar: string;
  eligibility: GitLabEligibility;
  enabled: boolean;
  gitPreparedAt?: string | null;
}): GitLabRepositoryConnection {
  const now = new Date().toISOString();
  getDb()
    .insert(gitlabRepositories)
    .values({
      ...input,
      eligibilityJson: JSON.stringify(input.eligibility),
      syncError: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: gitlabRepositories.projectId,
      set: {
        namespace: input.namespace,
        name: input.name,
        webUrl: input.webUrl,
        defaultBranch: input.defaultBranch,
        tokenEnvVar: input.tokenEnvVar,
        eligibilityJson: JSON.stringify(input.eligibility),
        enabled: input.enabled,
        syncError: null,
        gitPreparedAt: input.gitPreparedAt ?? null,
        updatedAt: now,
      },
    })
    .run();
  log.info(
    { projectId: input.projectId, repository: `${input.namespace}/${input.name}` },
    "GitLab repository connection saved",
  );
  return findGitLabRepository(input.projectId)!;
}

/**
 * Record that the agent auto-prepared the local git repo (origin/credentials/
 * default branch + AI Factory scaffold) for this connection. Returns the
 * updated connection, or undefined when the project has no connection.
 */
export function markGitLabRepositoryPrepared(projectId: string): GitLabRepositoryConnection | undefined {
  const now = new Date().toISOString();
  const existing = findGitLabRepository(projectId);
  if (!existing) return undefined;
  getDb()
    .update(gitlabRepositories)
    .set({ gitPreparedAt: now, updatedAt: now })
    .where(eq(gitlabRepositories.projectId, projectId))
    .run();
  log.debug({ projectId, gitPreparedAt: now }, "GitLab repository marked prepared");
  return findGitLabRepository(projectId);
}

export function deleteGitLabRepository(projectId: string): boolean {
  const result = getDb()
    .delete(gitlabRepositories)
    .where(eq(gitlabRepositories.projectId, projectId))
    .run();
  log.info({ projectId, deleted: result.changes > 0 }, "GitLab repository connection removed");
  return result.changes > 0;
}

export function recordGitLabRepositorySync(projectId: string, error: string | null): void {
  const now = new Date().toISOString();
  getDb()
    .update(gitlabRepositories)
    .set({ lastSyncedAt: now, syncError: error, updatedAt: now })
    .where(eq(gitlabRepositories.projectId, projectId))
    .run();
}

function renderIssueDescription(input: {
  iid: number;
  webUrl: string;
  snapshot: GitLabIssueSnapshot;
}): string {
  const { snapshot } = input;
  const context = [
    `Source: ${input.webUrl}`,
    `Author: @${snapshot.author}`,
    snapshot.labels.length > 0 ? `Labels: ${snapshot.labels.join(", ")}` : null,
    snapshot.assignees.length > 0 ? `Assignees: ${snapshot.assignees.map((name) => `@${name}`).join(", ")}` : null,
    snapshot.milestone ? `Milestone: ${snapshot.milestone}` : null,
  ].filter(Boolean);
  const comments = snapshot.comments.map(
    (comment) => `### @${comment.author} — ${comment.createdAt}\n\n${comment.body}\n\n${comment.webUrl}`,
  );
  return [
    context.join("\n"),
    snapshot.body,
    comments.length > 0 ? `## GitLab comments\n\n${comments.join("\n\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface ImportGitLabIssueInput {
  projectId: string;
  namespace: string;
  repository: string;
  iid: number;
  globalId: string;
  webUrl: string;
  state: "open" | "closed";
  sourceUpdatedAt: string;
  snapshot: GitLabIssueSnapshot;
  mergeRequest?: {
    iid: number;
    url: string;
    state: "open";
  };
}

export function importGitLabIssueTask(input: ImportGitLabIssueInput): {
  issue: GitLabIssueLink;
  taskId: string;
  created: boolean;
} {
  const db = getDb();
  const now = new Date().toISOString();
  const initialStatus = input.mergeRequest ? "done" : "backlog";
  let taskId = "";
  let created = false;

  db.transaction((tx) => {
    tx.insert(gitlabIssues)
      .values({
        projectId: input.projectId,
        iid: input.iid,
        globalId: input.globalId,
        webUrl: input.webUrl,
        state: input.state,
        metadataJson: JSON.stringify(input.snapshot),
        sourceUpdatedAt: input.sourceUpdatedAt,
        lastSyncedAt: now,
        ...(input.mergeRequest
          ? {
              mrIid: input.mergeRequest.iid,
              mrUrl: input.mergeRequest.url,
              mrState: input.mergeRequest.state,
            }
          : {}),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [gitlabIssues.projectId, gitlabIssues.iid],
        set: {
          globalId: input.globalId,
          webUrl: input.webUrl,
          state: input.state,
          metadataJson: JSON.stringify(input.snapshot),
          sourceUpdatedAt: input.sourceUpdatedAt,
          lastSyncedAt: now,
          syncError: null,
          ...(input.mergeRequest
            ? {
                mrIid: input.mergeRequest.iid,
                mrUrl: input.mergeRequest.url,
                mrState: input.mergeRequest.state,
              }
            : {}),
          updatedAt: now,
        },
      })
      .run();

    const linked = tx
      .select()
      .from(gitlabIssues)
      .where(and(eq(gitlabIssues.projectId, input.projectId), eq(gitlabIssues.iid, input.iid)))
      .get();
    if (!linked) throw new Error("GitLab issue upsert did not return a row");

    const title = `#${input.iid} ${input.snapshot.title}`;
    const description = renderIssueDescription(input);
    const tags = [...new Set(["gitlab", ...input.snapshot.labels])].slice(0, 50);
    if (linked.taskId) {
      taskId = linked.taskId;
      const existing = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
      const nextTags = JSON.stringify(tags);
      const nextPaused = input.state === "closed";
      // Only touch the task row when the synced content actually changed.
      // Writing updatedAt on every sync defeats releaseStaleTaskClaims: the
      // dead-process reaper treats fresh updatedAt as "recently active", so a
      // crashed coordinator claim would block the task until the lock TTL
      // expires instead of being recovered within the heartbeat window.
      const changed =
        !existing ||
        existing.title !== title ||
        existing.description !== description ||
        existing.tags !== nextTags ||
        existing.paused !== nextPaused;
      if (changed) {
        tx.update(tasks)
          .set({ title, description, tags: nextTags, paused: nextPaused, updatedAt: now })
          .where(eq(tasks.id, taskId))
          .run();
      } else {
        log.debug(
          { projectId: input.projectId, iid: input.iid, taskId },
          "[FIX] GitLab sync skipped unchanged task row to avoid masking stale-claim recovery",
        );
      }
      return;
    }

    const project = tx.select().from(projects).where(eq(projects.id, input.projectId)).get();
    if (!project) throw new Error(`Project ${input.projectId} not found`);
    taskId = crypto.randomUUID();
    const maxPosition = tx
      .select({ value: max(tasks.position) })
      .from(tasks)
      .where(eq(tasks.projectId, input.projectId))
      .get()?.value;
    const config = getProjectConfig(project.rootPath);
    const planPath = generatePlanPath(`gitlab-issue-${input.iid}`, "full", {
      plansDir: config.paths.plans,
      defaultPlanPath: config.paths.plan,
    });
    tx.insert(tasks)
      .values({
        id: taskId,
        projectId: input.projectId,
        title,
        description,
        autoMode: true,
        executionOwner: "ai",
        plannerMode: "full",
        planPath,
        planDocs: true,
        planTests: true,
        autoQueueCommitStatus: "pending",
        autoQueueCommitBaseSha: null,
        paused: input.state === "closed",
        tags: JSON.stringify(tags),
        status: initialStatus,
        position: Number(maxPosition ?? 1000) + 100,
        lastHeartbeatAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(taskExecutorHistory)
      .values({
        id: crypto.randomUUID(),
        taskId,
        taskTitleSnapshot: title,
        ownershipRevision: 0,
        executionOwner: "ai",
        assigneesSnapshotJson: "[]",
        statusSnapshot: initialStatus,
        actorKind: "system",
        actorId: "gitlab-sync",
        actorDisplayNameSnapshot: "GitLab Sync",
        reason: "gitlab_issue_imported",
        createdAt: now,
      })
      .run();
    tx.insert(auditEvents)
      .values(
        createAuditEventValues({
          action: "gitlab.issue_imported",
          entityType: "task",
          entityId: taskId,
          taskId,
          taskTitleSnapshot: title,
          executionOwnerSnapshot: "ai",
          assigneesSnapshot: [],
          statusSnapshot: initialStatus,
          actor: { kind: "system", id: "gitlab-sync", displayNameSnapshot: "GitLab Sync" },
          metadata: {
            repository: `${input.namespace}/${input.repository}`,
            iid: input.iid,
            ...(input.mergeRequest ? { mrIid: input.mergeRequest.iid } : {}),
          },
          createdAt: now,
        }),
      )
      .run();
    tx.update(gitlabIssues)
      .set({ taskId, updatedAt: now })
      .where(and(eq(gitlabIssues.projectId, input.projectId), eq(gitlabIssues.iid, input.iid)))
      .run();
    created = true;
  });

  const issue = findGitLabIssue(input.projectId, input.iid);
  if (!issue || !taskId) throw new Error("GitLab issue import failed");
  log.info({ projectId: input.projectId, iid: input.iid, taskId, created }, "GitLab issue synchronized");
  return { issue, taskId, created };
}

export function findGitLabIssue(projectId: string, iid: number): GitLabIssueLink | undefined {
  const row = getDb()
    .select()
    .from(gitlabIssues)
    .where(and(eq(gitlabIssues.projectId, projectId), eq(gitlabIssues.iid, iid)))
    .get();
  return row ? toIssueLink(row) : undefined;
}

export function findGitLabIssueByTaskId(taskId: string): GitLabIssueLink | undefined {
  const row = getDb().select().from(gitlabIssues).where(eq(gitlabIssues.taskId, taskId)).get();
  return row ? toIssueLink(row) : undefined;
}

export function listGitLabIssues(projectId: string): GitLabIssueLink[] {
  return getDb()
    .select()
    .from(gitlabIssues)
    .where(eq(gitlabIssues.projectId, projectId))
    .orderBy(desc(gitlabIssues.iid))
    .all()
    .map(toIssueLink);
}

export function markGitLabIssueUnavailable(projectId: string, iid: number, error: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction((tx) => {
    const issue = tx
      .select({ taskId: gitlabIssues.taskId })
      .from(gitlabIssues)
      .where(and(eq(gitlabIssues.projectId, projectId), eq(gitlabIssues.iid, iid)))
      .get();
    tx.update(gitlabIssues)
      .set({ syncError: error, lastSyncedAt: now, updatedAt: now })
      .where(and(eq(gitlabIssues.projectId, projectId), eq(gitlabIssues.iid, iid)))
      .run();
    if (issue?.taskId) {
      tx.update(tasks)
        .set({ paused: true, updatedAt: now })
        .where(eq(tasks.id, issue.taskId))
        .run();
    }
  });
}

export function updateGitLabMergeRequest(input: {
  projectId: string;
  iid: number;
  mrIid: number;
  mrUrl: string;
  mrState: "open" | "closed" | "merged";
  mrChecksStatus?: "pending" | "success" | "failure" | null;
  reviewState?: "pending" | "approved" | null;
  reviewFingerprint?: string | null;
  lastReviewNoteId?: number | null;
}): GitLabIssueLink | undefined {
  const now = new Date().toISOString();
  getDb()
    .update(gitlabIssues)
    .set({
      mrIid: input.mrIid,
      mrUrl: input.mrUrl,
      mrState: input.mrState,
      ...(input.mrChecksStatus !== undefined ? { mrChecksStatus: input.mrChecksStatus } : {}),
      ...(input.reviewState !== undefined ? { reviewState: input.reviewState } : {}),
      ...(input.reviewFingerprint !== undefined ? { reviewFingerprint: input.reviewFingerprint } : {}),
      ...(input.lastReviewNoteId !== undefined
        ? { lastReviewNoteId: input.lastReviewNoteId }
        : {}),
      syncError: null,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .where(and(eq(gitlabIssues.projectId, input.projectId), eq(gitlabIssues.iid, input.iid)))
    .run();
  return findGitLabIssue(input.projectId, input.iid);
}

export function getGitLabIssueReviewFingerprint(projectId: string, iid: number): string | null {
  return (
    getDb()
      .select({ value: gitlabIssues.reviewFingerprint })
      .from(gitlabIssues)
      .where(and(eq(gitlabIssues.projectId, projectId), eq(gitlabIssues.iid, iid)))
      .get()?.value ?? null
  );
}
