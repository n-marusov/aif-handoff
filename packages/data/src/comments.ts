/**
 * Репозиторий комментариев: операции над task_comments с гидратацией участника.
 */
import { asc, eq } from "drizzle-orm";
import {
  parseAttachments,
  participants,
  taskComments,
  type ParticipantSummary,
  type TaskComment,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";

export type CommentRow = typeof taskComments.$inferSelect;

export type HydratedCommentRow = CommentRow & {
  participant: ParticipantSummary | null;
};

export function toCommentResponse(
  comment: CommentRow & { participant?: ParticipantSummary | null },
): TaskComment {
  return {
    id: comment.id,
    taskId: comment.taskId,
    author: comment.author,
    participantId: comment.participantId,
    participant: comment.participant ?? null,
    message: comment.message,
    attachments: parseAttachments(comment.attachments),
    createdAt: comment.createdAt,
  };
}

function taskCommentSelection() {
  return {
    comment: taskComments,
    participantId: participants.id,
    participantDisplayName: participants.displayName,
    participantRole: participants.role,
    participantActive: participants.active,
  };
}

function hydrateCommentSelection(
  row: {
    comment: CommentRow;
    participantId: string | null;
    participantDisplayName: string | null;
    participantRole: "admin" | "member" | null;
    participantActive: boolean | null;
  },
): HydratedCommentRow {
  if (
    row.participantId === null ||
    row.participantDisplayName === null ||
    row.participantRole === null ||
    row.participantActive === null
  ) {
    return {
      ...row.comment,
      participant: null,
    };
  }
  return {
    ...row.comment,
    participant: {
      id: row.participantId,
      displayName: row.participantDisplayName,
      role: row.participantRole,
      active: row.participantActive,
    },
  };
}

function findHydratedTaskComment(commentId: string): HydratedCommentRow | undefined {
  const row = getDb()
    .select(taskCommentSelection())
    .from(taskComments)
    .leftJoin(participants, eq(taskComments.participantId, participants.id))
    .where(eq(taskComments.id, commentId))
    .get();
  return row ? hydrateCommentSelection(row) : undefined;
}

export function listTaskComments(taskId: string): HydratedCommentRow[] {
  return getDb()
    .select(taskCommentSelection())
    .from(taskComments)
    .leftJoin(participants, eq(taskComments.participantId, participants.id))
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt), asc(taskComments.id))
    .all()
    .map(hydrateCommentSelection);
}

export function createTaskComment(input: {
  taskId: string;
  author: "human" | "agent";
  participantId?: string | null;
  message: string;
  attachments?: unknown[];
  createdAt?: string;
}): HydratedCommentRow | undefined {
  const id = crypto.randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  getDb()
    .insert(taskComments)
    .values({
      id,
      taskId: input.taskId,
      author: input.author,
      participantId: input.participantId ?? null,
      message: input.message,
      attachments: JSON.stringify(input.attachments ?? []),
      createdAt,
    })
    .run();
  return findHydratedTaskComment(id);
}

export function updateTaskComment(
  commentId: string,
  patch: { attachments?: unknown[] },
): HydratedCommentRow | undefined {
  const sets: Record<string, unknown> = {};
  if (patch.attachments !== undefined) {
    sets.attachments = JSON.stringify(patch.attachments);
  }
  if (Object.keys(sets).length === 0) return findHydratedTaskComment(commentId);
  getDb()
    .update(taskComments)
    .set(sets)
    .where(eq(taskComments.id, commentId))
    .run();
  return findHydratedTaskComment(commentId);
}

export function getLatestHumanComment(taskId: string): HydratedCommentRow | undefined {
  return listTaskComments(taskId).filter((comment) => comment.author === "human").at(-1);
}

export function getLatestReworkComment(taskId: string): HydratedCommentRow | undefined {
  return listTaskComments(taskId).at(-1);
}
