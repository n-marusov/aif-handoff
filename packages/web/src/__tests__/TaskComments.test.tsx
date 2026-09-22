import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

const useTaskCommentsMock = vi.fn();
const mutateCreateCommentMock = vi.fn();
const useCreateTaskCommentMock = vi.fn();

vi.mock("@/hooks/useTasks", () => ({
  useTaskComments: (...args: unknown[]) => useTaskCommentsMock(...args),
  useCreateTaskComment: (...args: unknown[]) => useCreateTaskCommentMock(...args),
}));

const { TaskComments } = await import("@/components/task/TaskComments");

describe("TaskComments", () => {
  beforeEach(() => {
    mutateCreateCommentMock.mockReset();
    useCreateTaskCommentMock.mockReset();
    useCreateTaskCommentMock.mockReturnValue({
      mutate: mutateCreateCommentMock,
      isPending: false,
    });
  });

  it("shows loading state", () => {
    useTaskCommentsMock.mockReturnValue({ data: undefined, isLoading: true });
    render(<TaskComments taskId="t-1" />);
    expect(screen.getByText("Loading comments...")).toBeDefined();
  });

  it("shows empty state", () => {
    useTaskCommentsMock.mockReturnValue({ data: [], isLoading: false });
    render(<TaskComments taskId="t-1" />);
    expect(screen.getByText("No comments yet")).toBeDefined();
  });

  // BR: BR-fact.audit.observability
  // FR: REQ-FR-dashboard.detail.display-task-details
  // NFR: REQ-NFR-api.compliance.request-validation
  // KI: KI-01
  it("submits a new comment and clears the draft on success", () => {
    useTaskCommentsMock.mockReturnValue({ data: [], isLoading: false });

    render(<TaskComments taskId="t-1" />);
    const textarea = screen.getByLabelText("Comment message");
    const sendButton = screen.getByRole("button", { name: "Send" });

    expect(sendButton).toHaveProperty("disabled", true);

    fireEvent.change(textarea, { target: { value: "  Hello from UI  " } });
    expect(sendButton).toHaveProperty("disabled", false);

    fireEvent.click(sendButton);

    expect(mutateCreateCommentMock).toHaveBeenCalledTimes(1);
    const [payload, options] = mutateCreateCommentMock.mock.calls[0] as [
      { id: string; input: { message: string; attachments: unknown[] } },
      { onSuccess?: () => void },
    ];

    expect(payload).toEqual({
      id: "t-1",
      input: { message: "Hello from UI", attachments: [] },
    });

    act(() => {
      options.onSuccess?.();
    });

    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  // BR: BR-fact.audit.observability
  // FR: REQ-FR-dashboard.detail.display-task-details
  // NFR: REQ-NFR-api.compliance.request-validation
  // KI: KI-01
  it("shows error state when comment submit fails", async () => {
    useTaskCommentsMock.mockReturnValue({ data: [], isLoading: false });

    render(<TaskComments taskId="t-1" />);
    const textarea = screen.getByLabelText("Comment message");

    fireEvent.change(textarea, { target: { value: "Will fail" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const [, options] = mutateCreateCommentMock.mock.calls[0] as [
      unknown,
      { onError?: (error: unknown) => void },
    ];
    act(() => {
      options.onError?.(new Error("Request failed"));
    });

    await waitFor(() => {
      expect(screen.getByText("Request failed")).toBeDefined();
    });
  });

  it("renders comments with attachments", () => {
    useTaskCommentsMock.mockReturnValue({
      isLoading: false,
      data: [
        {
          id: "c-1",
          taskId: "t-1",
          author: "human",
          participantId: "participant-1",
          participant: {
            id: "participant-1",
            displayName: "Alice",
            role: "member",
            active: false,
          },
          message: "Please adjust the architecture section.",
          createdAt: "2026-01-01T10:00:00.000Z",
          attachments: [
            {
              name: "notes.md",
              mimeType: "text/markdown",
              size: 120,
              content: "# note",
            },
          ],
        },
      ],
    });

    render(<TaskComments taskId="t-1" />);
    expect(screen.getByText("Please adjust the architecture section.")).toBeDefined();
    expect(screen.getByText("Alice (inactive)")).toBeDefined();
    expect(screen.getByText("Attachments")).toBeDefined();
    expect(screen.getByText(/notes\.md/)).toBeDefined();
  });
});
