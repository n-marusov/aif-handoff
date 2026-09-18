import { useEffect, useState } from "react";
import {
  withTimeout,
  type TaskCommentAttachment,
  type TaskEvent,
  type Task,
} from "@aif/shared/browser";
import { api, PLAN_FAST_FIX_TIMEOUT_MS } from "@/lib/api";
import { encodeBase64 } from "@/lib/formatters";
import {
  useUpdateTask,
  useDeleteTask,
  useTaskEvent,
  useCreateTaskComment,
  useSyncTaskPlan,
} from "@/hooks/useTasks";

export type PlanChangeMode = "replanning" | "fast_fix" | "request_changes";

const TEXT_FILE_MAX_SIZE = 200_000;
const IMAGE_FILE_MAX_SIZE = 1_000_000;
const BASE64_CONTENT_MAX_SIZE = 2_000_000;
export const MAX_TASK_ATTACHMENTS = 100;
export const TASK_ATTACHMENT_WARN_AT = 50;
// Повторяет taskAttachmentSchema.size.max() из packages/api/src/schemas.ts.
export const ATTACHMENT_SIZE_HARD_LIMIT = 100_000_000;
const COMMENT_TIMEOUT_MS = 30_000;

export function partitionBySize(files: File[]): { accepted: File[]; rejected: File[] } {
  const accepted: File[] = [];
  const rejected: File[] = [];
  for (const f of files) {
    if (f.size > ATTACHMENT_SIZE_HARD_LIMIT) rejected.push(f);
    else accepted.push(f);
  }
  return { accepted, rejected };
}

export async function toAttachmentPayload(file: File): Promise<TaskCommentAttachment> {
  const isTextLike =
    file.type.startsWith("text/") ||
    /\.(md|markdown|txt|json|ya?ml|toml|ini|env|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|php|css|scss|html|xml|csv|sql|sh)$/i.test(
      file.name,
    );
  const isImage = file.type.startsWith("image/");
  const canReadContent = isTextLike && file.size <= TEXT_FILE_MAX_SIZE;
  const rawContent = canReadContent ? await file.text() : null;
  let content: string | null = rawContent ? rawContent.slice(0, TEXT_FILE_MAX_SIZE) : null;

  if (!content && isImage && file.size <= IMAGE_FILE_MAX_SIZE) {
    const base64 = encodeBase64(new Uint8Array(await file.arrayBuffer()));
    content = `data:${file.type || "application/octet-stream"};base64,${base64}`.slice(
      0,
      BASE64_CONTENT_MAX_SIZE,
    );
  }

  return {
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    content,
  };
}

export function useTaskDetailActions(task: Task | undefined, onClose: () => void) {
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const taskEvent = useTaskEvent();
  const createTaskComment = useCreateTaskComment();
  const syncTaskPlan = useSyncTaskPlan();

  // --- Удаление ---
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleDelete = () => {
    if (!task) return;
    deleteTask.mutate(task.id, {
      onSuccess: () => {
        setShowDeleteConfirm(false);
        onClose();
      },
    });
  };

  // --- Изменение плана (replanning / fast_fix / request_changes) ---
  const [showReplanModal, setShowReplanModal] = useState(false);
  const [planChangeMode, setPlanChangeMode] = useState<PlanChangeMode>("replanning");
  const [isSubmittingPlanChange, setIsSubmittingPlanChange] = useState(false);
  const [planChangeError, setPlanChangeError] = useState<string | null>(null);
  const [planChangeSuccess, setPlanChangeSuccess] = useState<string | null>(null);
  const [replanComment, setReplanComment] = useState("");
  const [replanFiles, setReplanFiles] = useState<File[]>([]);

  const resetReplanModal = () => {
    setShowReplanModal(false);
    setReplanComment("");
    setReplanFiles([]);
    setPlanChangeError(null);
    setIsSubmittingPlanChange(false);
  };

  const openPlanChange = (mode: PlanChangeMode) => {
    setPlanChangeMode(mode);
    setPlanChangeError(null);
    setPlanChangeSuccess(null);
    setShowReplanModal(true);
  };

  const handlePlanChangeRequest = async () => {
    if (!task) return;
    if (!replanComment.trim()) return;
    if (isSubmittingPlanChange) return;

    setIsSubmittingPlanChange(true);
    setPlanChangeError(null);
    try {
      const attachments = await Promise.all(replanFiles.map((file) => toAttachmentPayload(file)));
      await withTimeout(
        createTaskComment.mutateAsync({
          id: task.id,
          input: { message: replanComment.trim(), attachments },
        }),
        COMMENT_TIMEOUT_MS,
        "Comment request timed out",
      );
      await withTimeout(
        taskEvent.mutateAsync({
          id: task.id,
          event:
            planChangeMode === "replanning"
              ? "request_replanning"
              : planChangeMode === "fast_fix"
                ? "fast_fix"
                : "request_changes",
        }),
        planChangeMode === "fast_fix" ? PLAN_FAST_FIX_TIMEOUT_MS : COMMENT_TIMEOUT_MS,
        "Task event request timed out",
      );
      if (planChangeMode === "fast_fix") {
        setPlanChangeSuccess(
          `Fast fix applied. Plan updated in task and sync to ${task.planPath || ".ai-factory/PLAN.md"} attempted.`,
        );
      } else {
        setPlanChangeSuccess(null);
      }
      resetReplanModal();
      if (planChangeMode === "replanning" || planChangeMode === "request_changes") {
        onClose();
      }
    } catch (error) {
      console.error("[task-detail] failed to submit plan change request", error);
      setPlanChangeError(error instanceof Error ? error.message : "Failed to submit request");
    } finally {
      setIsSubmittingPlanChange(false);
    }
  };

  // --- Обслуживание (очистка активности, синхронизация плана) ---
  const [maintenanceSuccess, setMaintenanceSuccess] = useState<string | null>(null);
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);
  const [showClearActivityConfirm, setShowClearActivityConfirm] = useState(false);
  const [showSyncPlanConfirm, setShowSyncPlanConfirm] = useState(false);

  useEffect(() => {
    if (!maintenanceSuccess) return;
    const id = window.setTimeout(() => setMaintenanceSuccess(null), 4000);
    return () => window.clearTimeout(id);
  }, [maintenanceSuccess]);

  useEffect(() => {
    if (!maintenanceError) return;
    const id = window.setTimeout(() => setMaintenanceError(null), 4000);
    return () => window.clearTimeout(id);
  }, [maintenanceError]);

  const handleClearActivityLog = () => {
    if (!task) return;
    setMaintenanceSuccess(null);
    setMaintenanceError(null);
    updateTask.mutate(
      { id: task.id, input: { agentActivityLog: null } },
      {
        onSuccess: () => {
          setShowClearActivityConfirm(false);
          setMaintenanceSuccess("Agent activity log cleared.");
        },
        onError: (error) => {
          setMaintenanceError(
            error instanceof Error ? error.message : "Failed to clear agent activity log",
          );
        },
      },
    );
  };

  const handleSyncPlanFromFile = () => {
    if (!task) return;
    setMaintenanceSuccess(null);
    setMaintenanceError(null);
    syncTaskPlan.mutate(task.id, {
      onSuccess: () => {
        setShowSyncPlanConfirm(false);
        setMaintenanceSuccess("Plan synced from physical file.");
      },
      onError: (error) => {
        setMaintenanceError(
          error instanceof Error ? error.message : "Failed to sync plan from physical file",
        );
      },
    });
  };

  // --- Запуск AI с проверкой файла плана ---
  const [showStartAiConfirm, setShowStartAiConfirm] = useState(false);
  const [startAiPlanPath, setStartAiPlanPath] = useState<string | null>(null);
  const [isCheckingStartAiPlanFile, setIsCheckingStartAiPlanFile] = useState(false);

  const triggerStartAi = (options?: { deletePlanFile?: boolean }) => {
    if (!task) return;
    taskEvent.mutate({ id: task.id, event: "start_ai", deletePlanFile: options?.deletePlanFile });
    onClose();
  };

  const handleStartAiClick = async () => {
    if (!task) return;
    if (isCheckingStartAiPlanFile) return;
    setIsCheckingStartAiPlanFile(true);
    try {
      const status = await api.getTaskPlanFileStatus(task.id);
      if (status.exists) {
        setStartAiPlanPath(status.path);
        setShowStartAiConfirm(true);
        return;
      }
      triggerStartAi();
    } catch (error) {
      console.warn("[task-detail] failed to check plan file status before start_ai", error);
      triggerStartAi();
    } finally {
      setIsCheckingStartAiPlanFile(false);
    }
  };

  // --- Вложения ---
  const handleTaskAttachmentsSelected = async (files: File[] | FileList | null) => {
    if (!task || !files) return;
    const arr = Array.isArray(files) ? files : Array.from(files);
    if (arr.length === 0) return;
    const { accepted, rejected } = partitionBySize(arr);
    if (rejected.length > 0) {
      console.warn(
        "[task-detail] dropping %d files over %d bytes: %s",
        rejected.length,
        ATTACHMENT_SIZE_HARD_LIMIT,
        rejected.map((f) => f.name).join(", "),
      );
    }
    if (accepted.length === 0) return;
    const uploaded = await Promise.all(accepted.map((file) => toAttachmentPayload(file)));
    const taskAttachments = task.attachments ?? [];
    updateTask.mutate({
      id: task.id,
      input: { attachments: [...taskAttachments, ...uploaded].slice(0, MAX_TASK_ATTACHMENTS) },
    });
  };

  const handleRemoveTaskAttachment = (index: number) => {
    if (!task) return;
    const taskAttachments = task.attachments ?? [];
    updateTask.mutate({
      id: task.id,
      input: { attachments: taskAttachments.filter((_, i) => i !== index) },
    });
  };

  // --- Подтверждение approve done ---
  const [showApproveDoneConfirm, setShowApproveDoneConfirm] = useState(false);
  const [deletePlanOnApprove, setDeletePlanOnApprove] = useState(false);
  const [commitOnApprove, setCommitOnApprove] = useState(true);
  // Если пользователь просит коммит при подтверждении, сервер запускает `/aif-commit`
  // как фоновую задачу fire-and-forget и рассылает результат по WS.
  // Держим модалку открытой со спиннером до прихода WS-подтверждения, чтобы
  // пользователь видел, состоялся ли коммит (issue #75).
  const [commitPending, setCommitPending] = useState(false);

  useEffect(() => {
    if (!commitPending || !task) return;
    const matchesTask = (e: Event): boolean => {
      const detail = (e as CustomEvent<{ taskId?: string }>).detail;
      return detail?.taskId === task.id;
    };
    const onDone = (e: Event) => {
      if (!matchesTask(e)) return;
      console.debug("[approve-done] commit done for", task.id);
      setCommitPending(false);
      setShowApproveDoneConfirm(false);
      setDeletePlanOnApprove(false);
      setCommitOnApprove(true);
      onClose();
    };
    const onFailed = (e: Event) => {
      if (!matchesTask(e)) return;
      console.debug("[approve-done] commit failed for", task.id);
      // Держим модалку открытой, чтобы пользователь увидел тост ошибки и мог повторить.
      setCommitPending(false);
    };
    window.addEventListener("task:commit_done", onDone);
    window.addEventListener("task:commit_failed", onFailed);
    return () => {
      window.removeEventListener("task:commit_done", onDone);
      window.removeEventListener("task:commit_failed", onFailed);
    };
  }, [commitPending, task, onClose]);

  const handleApproveDone = () => {
    if (!task) return;
    taskEvent.mutate({
      id: task.id,
      event: "approve_done",
      deletePlanFile: deletePlanOnApprove,
      commitOnApprove,
    });
    if (commitOnApprove) {
      // Ждём WS-подтверждение — модалку пока НЕ закрываем.
      console.debug("[approve-done] awaiting commit WS ack for", task.id);
      setCommitPending(true);
      return;
    }
    setShowApproveDoneConfirm(false);
    setDeletePlanOnApprove(false);
    setCommitOnApprove(true);
    onClose();
  };

  // --- Обработка нажатий кнопок действий ---
  const handleActionClick = (action: { event?: TaskEvent; actionType?: string }) => {
    if (action.actionType === "open_replanning") {
      openPlanChange("replanning");
      return;
    }
    if (action.actionType === "open_fast_fix") {
      openPlanChange("fast_fix");
      return;
    }
    if (action.actionType === "open_request_changes") {
      openPlanChange("request_changes");
      return;
    }
    if (action.event) {
      if (action.event === "start_ai") {
        void handleStartAiClick();
        return;
      }
      if (action.event === "approve_done") {
        setShowApproveDoneConfirm(true);
        return;
      }
      taskEvent.mutate({ id: task!.id, event: action.event });
      onClose();
    }
  };

  return {
    // удаление
    showDeleteConfirm,
    setShowDeleteConfirm,
    handleDelete,
    // изменение плана
    showReplanModal,
    planChangeMode,
    isSubmittingPlanChange,
    planChangeError,
    planChangeSuccess,
    replanComment,
    setReplanComment,
    replanFiles,
    setReplanFiles,
    resetReplanModal,
    handlePlanChangeRequest,
    // обслуживание
    maintenanceSuccess,
    maintenanceError,
    showClearActivityConfirm,
    setShowClearActivityConfirm,
    handleClearActivityLog,
    showSyncPlanConfirm,
    setShowSyncPlanConfirm,
    handleSyncPlanFromFile,
    syncTaskPlanIsPending: syncTaskPlan.isPending,
    updateTaskIsPending: updateTask.isPending,
    // запуск AI
    showStartAiConfirm,
    setShowStartAiConfirm,
    startAiPlanPath,
    isCheckingStartAiPlanFile,
    triggerStartAi,
    // вложения
    handleTaskAttachmentsSelected,
    handleRemoveTaskAttachment,
    // подтверждение завершения
    showApproveDoneConfirm,
    setShowApproveDoneConfirm,
    deletePlanOnApprove,
    setDeletePlanOnApprove,
    commitOnApprove,
    setCommitOnApprove,
    commitPending,
    handleApproveDone,
    // кнопки действий
    handleActionClick,
    // обновление задачи (для сохранения описания)
    updateTask,
  };
}
