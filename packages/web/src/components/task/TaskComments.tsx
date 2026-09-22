import { useMemo, useState, type FormEvent } from "react";
import { Download, Send } from "lucide-react";
import { useTaskComments, useCreateTaskComment } from "@/hooks/useTasks";
import { Markdown } from "@/components/ui/markdown";
import { EmptyState } from "@/components/ui/empty-state";
import { AuthorBadge } from "@/components/ui/author-badge";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { AlertBox } from "@/components/ui/alert-box";

interface TaskCommentsProps {
  taskId: string;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function TaskComments({ taskId }: TaskCommentsProps) {
  const { data: comments, isLoading } = useTaskComments(taskId);
  const createCommentMutation = useCreateTaskComment();
  const [draft, setDraft] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const reversedComments = useMemo(() => (comments ? [...comments].reverse() : []), [comments]);

  const isSubmitting = createCommentMutation.isPending;
  const isSubmitDisabled = isSubmitting || draft.trim().length === 0;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message) return;

    setSubmitError(null);
    createCommentMutation.mutate(
      {
        id: taskId,
        input: {
          message,
          attachments: [],
        },
      },
      {
        onSuccess: () => {
          setDraft("");
        },
        onError: (error) => {
          setSubmitError(error instanceof Error ? error.message : "Failed to send comment");
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      <form onSubmit={handleSubmit} className="space-y-2 border border-border bg-background/55 p-3">
        <p className="text-2xs uppercase tracking-wide text-muted-foreground">Add comment</p>
        <Textarea
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (submitError) setSubmitError(null);
          }}
          placeholder="Write a comment"
          rows={4}
          disabled={isSubmitting}
          aria-label="Comment message"
        />
        {submitError && (
          <AlertBox variant="error" className="text-xs">
            {submitError}
          </AlertBox>
        )}
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={isSubmitDisabled}>
            <Send className="mr-1 h-3.5 w-3.5" />
            {isSubmitting ? "Sending..." : "Send"}
          </Button>
        </div>
      </form>

      {isLoading ? (
        <EmptyState message="Loading comments..." />
      ) : !comments || comments.length === 0 ? (
        <EmptyState message="No comments yet" />
      ) : (
        reversedComments.map((comment) => (
          <div
            key={comment.id}
            className={`border p-3 ${
              comment.author === "human"
                ? "border-blue-500/30 bg-blue-500/5"
                : "border-violet-500/30 bg-violet-500/5"
            }`}
          >
            <div className="mb-2 flex items-center justify-between text-2xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <AuthorBadge author={comment.author} />
                {comment.author === "human" && comment.participant && (
                  <span>
                    {comment.participant.displayName}
                    {comment.participant.active ? "" : " (inactive)"}
                  </span>
                )}
              </div>
              <span>{formatWhen(comment.createdAt)}</span>
            </div>
            <Markdown content={comment.message} className="text-sm text-foreground/90" />
            {comment.attachments.length > 0 && (
              <div className="mt-3 border-t border-border pt-2">
                <p className="mb-1 text-2xs uppercase tracking-wide text-muted-foreground">
                  Attachments
                </p>
                <ul className="space-y-1 text-xs text-foreground/80">
                  {comment.attachments.map((file, index) => (
                    <li
                      key={`${comment.id}-${file.name}-${index}`}
                      className="flex items-center gap-2"
                    >
                      <span className="truncate">
                        {file.name} ({file.mimeType || "unknown"}, {file.size} bytes)
                        {file.content == null && !file.path && (
                          <span className="ml-1 text-3xs text-muted-foreground">
                            (metadata only)
                          </span>
                        )}
                      </span>
                      {file.path && (
                        <a
                          href={`/tasks/${taskId}/comments/${comment.id}/attachments/${encodeURIComponent(file.name)}`}
                          download={file.name}
                          className="inline-flex shrink-0 items-center text-muted-foreground transition-colors hover:text-foreground"
                          title="Download"
                        >
                          <Download className="h-3 w-3" />
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
