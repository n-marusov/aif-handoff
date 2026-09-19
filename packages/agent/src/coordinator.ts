/**
 * Координатор конвейера задач.
 *
 * На каждом цикле опроса переводит задачу по статусам:
 * Backlog -> Planning -> Improve -> Plan Review -> Implementing -> Verify -> Review -> Done -> Accepted.
 *
 * Почему один polling-цикл, а не отдельный воркер на задачу:
 * - состояние конвейера хранится в БД, цикл безопасно переживает перезапуск;
 * - несколько координаторов синхронизируются через CAS-захваты, а не через память процесса;
 * - задачи, работающие в общем checkout, исполняются монопольно и не конфликтуют по файлам.
 *
 * Инвариант: порядок стадий в PIPELINE обязателен. Он не допускает обхода доменных гейтов
 * (например, перехода из plan_review в implementing без решения Plan Review Gate).
 *
 * Потенциальное улучшение: выделить policy-слой с явными правилами переходов/гейтов,
 * чтобы убрать дублирование условий между координатором и стадиями.
 */

import {
  clearTaskActiveRuntimeSelection,
  clearTaskRuntimeLimitSnapshot,
  blockTaskForRuntimeGateIfEligible,
  evaluateRuntimeLimitGate,
  findCoordinatorTaskCandidatesForProject,
  listCoordinatorActionableProjectIds,
  findTaskById,
  findProjectById,
  handoffTaskExecution,
  hasActiveLockedTaskForProject,
  claimCoordinatorTaskIfEligible,
  releaseTaskClaim,
  releaseStaleTaskClaims,
  updateTaskStatus as updateTaskStatusRow,
  listDueScheduledTasks,
  appendTaskActivityLog,
  listAutoQueueProjects,
  nextBacklogTaskByPosition,
  countActivePipelineTasksForProject,
  hasActiveBranchBoundTasksForProject,
  hasBlockingAutoQueueCommitForProject,
  claimBacklogTaskForAdvance,
  persistTaskRuntimeLimitSnapshot,
  resolveEffectiveRuntimeProfile,
  setTaskFields,
  type TaskFieldsPatch,
} from "@aif/data";

// Локальные псевдонимы строк: выводится из data-функций, потому что row-типы
// не входят в публичный контракт @aif/data. База — TaskRow (listDueScheduledTasks
// возвращает именно её); гидратированные строки findTaskById в неё присваиваются
// (у них больше полей).
type PersistedTask = ReturnType<typeof listDueScheduledTasks>[number];
type PersistedProject = NonNullable<ReturnType<typeof findProjectById>>;
import { initProject } from "@aif/runtime";
import {
  logger,
  getEnv,
  CLEAN_STATE_RESET,
  getHeadCommitSha,
  getProjectConfig,
  withTimeout,
  TASK_STAGE_LIFECYCLE,
  COORDINATOR_STAGE_ORDER,
  type CoordinatorStage,
  type TaskStatus,
} from "@aif/shared";
import { runPlanner } from "./subagents/planner.js";
import { runImprover } from "./subagents/improver.js";
import { runPlanChecker } from "./subagents/planChecker.js";
import { runImplementer, hasImplementationNoOp } from "./subagents/implementer.js";
import { runReviewer } from "./subagents/reviewer.js";
import { runVerifier } from "./subagents/verifier.js";
import { runDoneChecker } from "./subagents/doneChecker.js";
import { reconcileAllProjectWorktrees } from "./worktreeReconcile.js";
import { runPlanReviewPublisher, taskRequiresPlanReview } from "./planReviewPublisher.js";
import {
  describeDirtyWorkingTree,
  isGitRepo,
  projectSupportsTaskWorktrees,
  projectUsesSharedBranchIsolation,
} from "./gitBranch.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { flushActivityQueue, logActivity } from "./hooks.js";
import {
  notifyTaskBroadcast,
  notifyProjectBroadcast,
  type TaskNotificationInfo,
} from "./notifier.js";
import { handleAutoReviewGate } from "./autoReviewHandler.js";
import { classifyStageError } from "./stageErrorHandler.js";
import { setActiveStageAbortController } from "./stageAbort.js";
import { setCoordinatorId } from "./subagentQuery.js";
import { ensureAutoQueueTaskCommit } from "./autoQueueCommit.js";
import { publishGitHubTask, synchronizeGitHubProjects } from "./githubWorkflow.js";
import { publishGitLabTask, synchronizeGitLabProjects } from "./gitlabWorkflow.js";
import {
  getRandomBackoffMinutes,
  releaseDueBlockedTasks,
  recoverStaleInProgressTasks,
} from "./taskWatchdog.js";

// Конфигурация цикла координатора фиксируется при старте процесса.
// Это исключает дрейф правил в пределах одного uptime-периода.
const log = logger("coordinator");
const env = getEnv();
const AUTO_QUEUE_COMMIT_GATE_ENABLED = env.AIF_AGENT_AUTO_QUEUE_COMMIT_GATE_ENABLED;
// Минимум 60s защищает от некорректного нулевого таймаута стадии.
// Иначе задача зациклится на одном статусе конвейера.
const STAGE_RUN_TIMEOUT_MS = Math.max(env.AGENT_STAGE_RUN_TIMEOUT_MS, 60_000);
// Блокировка живёт дольше таймаута стадии, чтобы второй координатор не перехватил задачу
// во время пост-обработки (логи/фиксация состояния).
const CLAIM_LOCK_DURATION_MS = STAGE_RUN_TIMEOUT_MS + 5 * 60 * 1000; // таймаут стадии + 5 минут запаса
// Идентификатор владельца блокировки создаётся на каждый процесс.
// Это ключ для корректного сравнения владельца в БД.
export const COORDINATOR_ID = crypto.randomUUID();

// RuntimeRegistry внедряется извне (композиционным корнем агента).
// Холдер вынесен в runtimeRegistry.ts, чтобы subagentQuery мог читать тот же
// реестр без циклической зависимости на coordinator.
export { setRuntimeRegistry, getRuntimeRegistrySync } from "./runtimeRegistry.js";
import { getRuntimeRegistrySync } from "./runtimeRegistry.js";
setCoordinatorId(COORDINATOR_ID);

// In-memory метрики координатора за life-cycle процесса.
// В проде не сбрасываются, чтобы не терять динамику инцидентов.
const runtimeCounters = {
  fastRetryStreamInterruptions: 0,
};

// Контракт стадии конвейера: входные статусы, рабочий статус, целевой статус и runner.
// Пока runner выполняется, задача удерживается в inProgress-колонке Kanban.
// from/inProgress/onSuccess берутся из единого графа жизненного цикла
// (@aif/shared TASK_STAGE_LIFECYCLE); runner'ы — поведение стадии здесь.
interface StatusTransition {
  from: readonly TaskStatus[];
  inProgress: TaskStatus;
  onSuccess: TaskStatus;
  runner: (taskId: string, projectRoot: string) => Promise<void>;
  label: CoordinatorStage;
}

// Runner'ы стадий: поведенческая часть, привязанная к топологии из lifecycle-map.
const STAGE_RUNNERS: Record<
  CoordinatorStage,
  (taskId: string, projectRoot: string) => Promise<void>
> = {
  planner: runPlanner,
  improver: runImprover,
  "plan-checker": runPlanChecker,
  "plan-publisher": runPlanReviewPublisher,
  implementer: runImplementer,
  verifier: runVerifier,
  reviewer: runReviewer,
  "done-checker": runDoneChecker,
};

// Порядок PIPELINE определяет доменный маршрут в пределах тика и выводится из
// единого графа жизненного цикла — второго источника статусного графа больше нет.
const PIPELINE: StatusTransition[] = COORDINATOR_STAGE_ORDER.map((stage) => {
  const spec = TASK_STAGE_LIFECYCLE[stage];
  const runner = STAGE_RUNNERS[stage];
  if (!runner) {
    // Недостижимо: map покрывает все стадии; страж на случай будущего дрейфа.
    throw new Error(`Missing stage runner: ${stage}`);
  }
  return {
    from: spec.from,
    inProgress: spec.inProgress,
    onSuccess: spec.onSuccess,
    runner,
    label: stage,
  };
});

// ── Семафор стадий ───────────────────────────────────────────

// Ограничитель параллелизма сразу по двум осям: на проект со стадией (keyMax) и глобально
// (globalMax). Нужен, чтобы упор в лимит рантайма или в диск на одной стадии не утянул
// за собой обработку остальных проектов.
class StageSemaphore {
  private counts = new Map<string, number>();
  private activeCount = 0;
  private waiters: Array<{
    key: string;
    keyMax: number;
    globalMax: number;
    resolve: () => void;
  }> = [];

  // Проверка без побочных эффектов: используется и при захвате, и при разборе очереди,
  // поэтому не должна менять счётчики.
  private canAcquire(key: string, keyMax: number, globalMax: number): boolean {
    const current = this.counts.get(key) ?? 0;
    return current < keyMax && this.activeCount < globalMax;
  }

  // Неблокирующий вариант: нужен тестам и диагностике, где ждать разрешения нельзя.
  tryAcquire(key: string, keyMax: number, globalMax: number): boolean {
    if (!this.canAcquire(key, keyMax, globalMax)) return false;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.activeCount += 1;
    return true;
  }

  // Ожидание отдаётся промисом, а не блокирующим циклом: координатор ждёт разрешения
  // асинхронно и не занимает поток, пока другие стадии продолжают работу.
  acquire(key: string, keyMax: number, globalMax: number): Promise<void> {
    if (this.tryAcquire(key, keyMax, globalMax)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.waiters.push({ key, keyMax, globalMax, resolve });
    });
  }

  // Защита от двойного освобождения: release без предшествующего acquire молча
  // игнорируется, иначе activeCount ушёл бы в минус и семафор разрешил лишний параллелизм.
  release(key: string): void {
    const current = this.counts.get(key) ?? 0;
    if (current <= 0) return;

    if (current === 1) {
      this.counts.delete(key);
    } else {
      this.counts.set(key, current - 1);
    }
    this.activeCount -= 1;
    this.drainWaiters();
  }

  totalActive(): number {
    return this.activeCount;
  }

  trackedKeyCount(): number {
    return this.counts.size;
  }

  waitingCount(): number {
    return this.waiters.length;
  }

  // Сброс только для тестов: при непустой очереди он потерял бы ожидающие промисы,
  // поэтому здесь лучше упасть громко, чем оставить задачу в вечном ожидании.
  reset(): void {
    if (this.waiters.length > 0) {
      throw new Error("Cannot reset stage semaphore while acquisitions are queued");
    }
    this.counts.clear();
    this.activeCount = 0;
  }

  // Перебор очереди с начала, а не только первого ожидающего: если голова очереди не
  // проходит по лимиту своей стадии, следующий waiter из другой стадии должен получить
  // разрешение сейчас, иначе семафор начнёт голодать.
  private drainWaiters(): void {
    let granted = true;
    while (granted) {
      granted = false;
      const waiterIndex = this.waiters.findIndex((waiter) =>
        this.canAcquire(waiter.key, waiter.keyMax, waiter.globalMax),
      );
      if (waiterIndex < 0) return;

      const [waiter] = this.waiters.splice(waiterIndex, 1);
      if (!waiter) return;

      this.counts.set(waiter.key, (this.counts.get(waiter.key) ?? 0) + 1);
      this.activeCount += 1;
      waiter.resolve();
      granted = true;
    }
  }
}

const stageSemaphore = new StageSemaphore();

// ── Публичный API ────────────────────────────────────────────

// Возвращаем копию, а не ссылку: иначе вызывающий код мог бы менять счётчики в обход API
// и ломать сопоставимость метрик между снятыми снапшотами.
export function getCoordinatorRuntimeCounters(): Readonly<typeof runtimeCounters> {
  return { ...runtimeCounters };
}

export function resetCoordinatorRuntimeCountersForTests(): void {
  runtimeCounters.fastRetryStreamInterruptions = 0;
}

export function getStageSemaphore(): StageSemaphore {
  return stageSemaphore;
}

// ── Исполнение стадий ────────────────────────────────────────

// Внешний таймаут вокруг стадии. AbortController нужен не самому таймауту, а затем, чтобы
// после срабатывания можно было погасить дочерний процесс субагента и не оставить его
// висеть после того, как координатор уже посчитал стадию проваленной.
async function runStageWithTimeout(
  runner: (taskId: string, projectRoot: string) => Promise<void>,
  taskId: string,
  projectRoot: string,
  stageLabel: string,
): Promise<void> {
  // Контроллер регистрируется в общем реестре до запуска, а не хранится локально: погасить
  // субагента можно и извне (отмена человеком, снятие владения), поэтому ссылка нужна снаружи.
  const abort = new AbortController();
  setActiveStageAbortController(taskId, abort);

  try {
    await withTimeout(
      runner(taskId, projectRoot),
      STAGE_RUN_TIMEOUT_MS,
      `Stage ${stageLabel} timed out after ${STAGE_RUN_TIMEOUT_MS}ms`,
    );
  } catch (err) {
    // abort идемпотентен, но предупреждение имеет смысл только для настоящего обрыва: если
    // сигнал уже взведён таймаутом, повторный лог лишь запутал бы разбор инцидента.
    if (!abort.signal.aborted) {
      abort.abort();
      log.warn({ taskId, stage: stageLabel }, "Aborted subagent process after stage timeout");
    }
    throw err;
  } finally {
    setActiveStageAbortController(taskId, null);
  }
}

/** Обновляет статус задачи и отправляет согласованное WS-уведомление. */
function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  extra: Omit<TaskFieldsPatch, "status" | "lastHeartbeatAt" | "updatedAt"> = {},
  info: TaskNotificationInfo = {},
): void {
  updateTaskStatusRow(taskId, status, extra, {
    kind: "agent",
    id: "coordinator",
    displayNameSnapshot: "Coordinator",
  });
  // Если статус не изменился, отправляем task:updated.
  // Если изменился — task:moved для перемещения карточки между колонками.
  const broadcastType =
    info.fromStatus && info.fromStatus === status ? "task:updated" : "task:moved";
  void notifyTaskBroadcast(taskId, broadcastType, { ...info, toStatus: status });
}

// Auto-queue commit gate перед терминальным статусом.
// Ошибка пробрасывается вверх: задача не должна закрыться с грязным worktree.
async function ensureCommitBeforeTerminalStatus(
  task: PersistedTask,
  projectRoot: string,
): Promise<void> {
  if (!AUTO_QUEUE_COMMIT_GATE_ENABLED) {
    return;
  }
  try {
    // Flush activity обязателен даже при ошибке, чтобы причина блокировки попала
    // в историю задачи до следующего тика.
    await ensureAutoQueueTaskCommit({ taskId: task.id, projectRoot });
  } finally {
    flushActivityQueue(task.id);
  }
}

// Базовый SHA фиксируется до стадии, чтобы позже верифицировать факт нового коммита.
function resolveAutoQueueCommitPreparation(
  projectRoot: string,
): { status: "pending"; baseSha: string | null } | { status: "not_applicable"; baseSha: null } {
  return isGitRepo(projectRoot)
    ? { status: "pending", baseSha: getHeadCommitSha(projectRoot) }
    : { status: "not_applicable", baseSha: null };
}

// Проект требует serial execution, если задачи делят один физический checkout.
// Это защищает ветки и файлы от конкурентных мутаций.
function projectRequiresSerialExecution(project: PersistedProject): boolean {
  const hasSharedBranchTask = hasActiveBranchBoundTasksForProject(project.id);
  const taskWorktreesUnavailable =
    !env.AIF_TASK_WORKTREES_ENABLED || !projectSupportsTaskWorktrees(project.rootPath);
  const usesSharedBranchIsolation =
    projectUsesSharedBranchIsolation(project.rootPath) && taskWorktreesUnavailable;
  const usesAutoQueueSharedGitWorktree =
    AUTO_QUEUE_COMMIT_GATE_ENABLED &&
    project.autoQueueMode &&
    isGitRepo(project.rootPath) &&
    taskWorktreesUnavailable;

  return hasSharedBranchTask || usesSharedBranchIsolation || usesAutoQueueSharedGitWorktree;
}

/**
 * Branchless fix-задача работает в общем checkout проекта.
 * Её запуск всегда эксклюзивный в пределах проекта.
 */
function branchlessFixTaskRequiresExclusiveRun(task: PersistedTask): boolean {
  return task.isFix === true && (!task.branchName || !task.worktreePath);
}

/** Экспорт для unit-тестов guard-правила параллелизма. */
export const __testBranchlessFixTaskRequiresExclusiveRun = branchlessFixTaskRequiresExclusiveRun;

// Scheduled advance не стартует на грязном worktree.
// Иначе следующая ветка задачи создастся из несогласованного состояния.
function scheduledTaskHasDirtyAutoQueueWorktree(
  task: PersistedTask,
  project: PersistedProject | null | undefined,
): boolean {
  if (!AUTO_QUEUE_COMMIT_GATE_ENABLED || !project?.autoQueueMode) {
    return false;
  }

  const projectRoot = task.worktreePath ?? project.rootPath;
  const dirtyPreview = isGitRepo(projectRoot) ? describeDirtyWorkingTree(projectRoot) : null;
  if (!dirtyPreview) {
    return false;
  }

  log.warn(
    { taskId: task.id, projectId: task.projectId, projectRoot, dirtyPreview },
    "Scheduled auto-queue task deferred because its Git worktree is dirty",
  );
  return true;
}

// Соответствие стадии конвейера профилю runtime: plan/review/task.
// Это позволяет разделять стоимость и качество работ по этапам.
function runtimeProfileModeForStage(stage: CoordinatorStage): "task" | "plan" | "review" {
  if (stage === "planner" || stage === "improver" || stage === "plan-checker") {
    return "plan";
  }
  if (stage === "reviewer" || stage === "verifier") {
    return "review";
  }
  return "task";
}

// Improve включается только для skills-mode сценария.
// Improve включается только для skills-mode.
function shouldRunSkillsModeImprove(task: PersistedTask): boolean {
  return task.runPlanImprove && !task.useSubagents;
}

// Verify включается только для skills-mode при явном флаге runPostVerify.
function shouldRunSkillsModeVerify(task: PersistedTask): boolean {
  return task.runPostVerify && !task.useSubagents;
}

// Переопределение success-переходов по флагам пайплайна.
function getStageSuccessStatus(task: PersistedTask, stage: StatusTransition): TaskStatus {
  if (stage.label === "planner" && shouldRunSkillsModeImprove(task)) {
    return "improve";
  }

  if (stage.label === "implementer") {
    if (shouldRunSkillsModeVerify(task)) {
      return "verify";
    }
    if (task.skipReview) {
      return "done";
    }
    return "review";
  }

  if (stage.label === "verifier") {
    return task.skipReview ? "done" : "review";
  }

  return stage.onSuccess;
}

// Рассчитывает retryAfter для blocked_external.
// Приоритет: подсказка провайдера (resetAt/retryAfterSeconds) -> локальная задержка повтора.
function resolveRuntimeGateRetryAfter(gateDecision: ReturnType<typeof evaluateRuntimeLimitGate>): {
  retryAfter: string;
  source: "resetAt" | "retryAfterSeconds" | "random_backoff";
} {
  // resetAt учитывается только если это будущий момент.
  if (gateDecision.futureHint.resetAt && gateDecision.futureHint.isFuture) {
    return {
      retryAfter: gateDecision.futureHint.resetAt,
      source: gateDecision.futureHint.source.includes("retry_after")
        ? "retryAfterSeconds"
        : "resetAt",
    };
  }

  if (
    typeof gateDecision.futureHint.retryAfterSeconds === "number" &&
    Number.isFinite(gateDecision.futureHint.retryAfterSeconds) &&
    gateDecision.futureHint.retryAfterSeconds >= 0
  ) {
    return {
      retryAfter: new Date(
        Date.now() + gateDecision.futureHint.retryAfterSeconds * 1000,
      ).toISOString(),
      source: "retryAfterSeconds",
    };
  }

  return {
    retryAfter: new Date(Date.now() + getRandomBackoffMinutes() * 60_000).toISOString(),
    source: "random_backoff",
  };
}

// Текст причины формируется из структурированных полей gate-решения.
// Логика не зависит от message-matching.
function buildRuntimeGateBlockedReason(
  gateDecision: ReturnType<typeof evaluateRuntimeLimitGate>,
): string {
  const snapshot = gateDecision.snapshot;
  const hintSource = gateDecision.futureHint.source;
  const scope = gateDecision.violatedWindow?.scope ?? snapshot?.primaryScope ?? "runtime";
  if (gateDecision.reason === "exact_threshold") {
    const thresholdWindow = gateDecision.violatedWindow;
    if (thresholdWindow) {
      const thresholdValue = thresholdWindow.warningThreshold ?? snapshot?.warningThreshold;
      const percentRemaining = thresholdWindow.percentRemaining;
      if (typeof percentRemaining === "number" && typeof thresholdValue === "number") {
        return `Coordinator pre-start runtime gate: ${scope} threshold reached (${percentRemaining}% <= ${thresholdValue}%; hint=${hintSource})`;
      }
    }
    return `Coordinator pre-start runtime gate: ${scope} threshold reached (hint=${hintSource})`;
  }

  return `Coordinator pre-start runtime gate: ${scope} limit still blocked (hint=${hintSource})`;
}

// Pre-start runtime gate: переводит задачу в blocked_external до вызова рантайма.
// CAS-обновление гарантирует, что блокируется именно актуальный кандидат.
function proactivelyBlockTaskForRuntimeGate(
  task: PersistedTask,
  stage: CoordinatorStage,
  selection: ReturnType<typeof resolveEffectiveRuntimeProfile>,
  gateDecision: ReturnType<typeof evaluateRuntimeLimitGate>,
): void {
  const snapshot = gateDecision.snapshot;
  const { retryAfter, source } = resolveRuntimeGateRetryAfter(gateDecision);
  const blockedReason = buildRuntimeGateBlockedReason(gateDecision);
  // Лимит-гейт увеличивает retryCount как полноценную неудачную попытку.
  const retryCount = (task.retryCount ?? 0) + 1;
  const persistedAt = new Date().toISOString();
  const applied = blockTaskForRuntimeGateIfEligible({
    taskId: task.id,
    expectedProjectId: task.projectId,
    expectedStatus: task.status,
    expectedAutoMode: task.status === "plan_review" ? task.autoMode === true : undefined,
    blockedFromStatus: task.status,
    blockedReason,
    retryAfter,
    retryCount,
    snapshot,
    persistedAt,
  });

  if (!applied) {
    log.debug(
      {
        taskId: task.id,
        stage,
        runtimeProfileId: selection.profile?.id ?? null,
      },
      "Skipped proactive runtime gate block because candidate changed before CAS update",
    );
    return;
  }

  appendTaskActivityLog(
    task.id,
    `[${persistedAt}] Coordinator runtime gate blocked task before ${stage}: profile=${selection.profile?.id ?? "none"} source=${selection.source} retryAfter=${retryAfter} retryAfterSource=${source}`,
  );
  void notifyTaskBroadcast(task.id, "task:moved", {
    title: task.title,
    fromStatus: task.status,
    toStatus: "blocked_external",
  });

  log.info(
    {
      taskId: task.id,
      stage,
      projectId: task.projectId,
      runtimeProfileId: selection.profile?.id ?? null,
      runtimeSelectionSource: selection.source,
      providerId: snapshot?.providerId ?? selection.profile?.providerId ?? null,
      runtimeId: snapshot?.runtimeId ?? selection.profile?.runtimeId ?? null,
      limitStatus: snapshot?.status ?? null,
      limitPrecision: snapshot?.precision ?? null,
      retryAfter,
      retryAfterSource: source,
      applied,
    },
    "Blocked task before claim due to runtime limit gate",
  );
}

// Guard совместимости legacy и plan-review потоков.
// Не допускает запуск implementer до approved плана для VCS-связанных задач.
function planReviewStageIneligible(stageLabel: CoordinatorStage, task: PersistedTask): boolean {
  // Plan Publisher обрабатывает только задачи с активным Plan Review Gate.
  // Implementer отклоняется, пока planReviewState != approved.
  if (stageLabel === "plan-publisher") {
    return !taskRequiresPlanReview(task.id);
  }
  if (stageLabel === "implementer") {
    if (task.status === "plan_review" || task.status === "implementing") {
      return taskRequiresPlanReview(task.id) && task.planReviewState !== "approved";
    }
  }
  return false;
}

// Единая pre-start проверка runtime-лимитов.
// Может вызываться повторно после ожидания семафора, т.к. snapshot уже мог измениться.
function blockCandidateIfRuntimeLimited(task: PersistedTask, stage: StatusTransition): boolean {
  // Plan Publisher не потребляет runtime-токены, поэтому usage-limit gate
  // к нему не применяется.
  if (stage.label === "plan-publisher") {
    return false;
  }
  const runtimeSelection = resolveEffectiveRuntimeProfile({
    taskId: task.id,
    projectId: task.projectId,
    mode: runtimeProfileModeForStage(stage.label),
  });
  const gateDecision = evaluateRuntimeLimitGate(runtimeSelection.profile);
  if (!gateDecision.blocked) return false;

  log.debug(
    {
      taskId: task.id,
      stage: stage.label,
      projectId: task.projectId,
      runtimeProfileId: gateDecision.runtimeProfileId,
      runtimeSelectionSource: runtimeSelection.source,
      gateReason: gateDecision.reason,
      limitPrecision: gateDecision.snapshot?.precision ?? null,
    },
    "Task candidate blocked by proactive runtime gate",
  );
  proactivelyBlockTaskForRuntimeGate(task, stage.label, runtimeSelection, gateDecision);
  return true;
}

// ── Обработка одной задачи ───────────────────────────

/**
 * Возвращает true, если текущая стадия закрыта в рамках этого тика.
 * true означает "перебирать дальше не нужно", а не только "бизнес-успех".
 */
async function processOneTask(task: PersistedTask, stage: StatusTransition): Promise<boolean> {
  // Контракт владения: AI-координатор не меняет human-owned задачу.
  if (task.executionOwner !== "ai") {
    log.warn(
      { taskId: task.id, stage: stage.label, executionOwner: task.executionOwner },
      "Skipped runtime execution because task is not AI-owned",
    );
    return false;
  }
  const project = findProjectById(task.projectId);

  if (!project) {
    log.error(
      { taskId: task.id, projectId: task.projectId },
      "Project not found for task, skipping",
    );
    return false;
  }

  // Инициализация .ai-factory перед запуском субагента.
  // Без RuntimeRegistry шаг пропускается (например, в unit-тестах).
  const injectedRegistry = getRuntimeRegistrySync();
  if (injectedRegistry) {
    const initResult = initProject({
      projectRoot: task.worktreePath ?? project.rootPath,
      registry: injectedRegistry,
    });
    if (!initResult.ok) {
      log.error(
        { taskId: task.id, projectId: task.projectId, error: initResult.error },
        "Project .ai-factory/ scaffold missing and init failed, skipping task",
      );
      return false;
    }
  }

  log.info(
    {
      taskId: task.id,
      title: task.title,
      stage: stage.label,
      projectRoot: project.rootPath,
      worktreePath: task.worktreePath ?? null,
    },
    "Picked up task for processing",
  );
  const sourceStatus = task.status;
  const taskTitle = task.title;

  // При переходе между статусами очищаем active runtime selection.
  // Новый этап должен заново разрешить effective runtime profile.
  if (sourceStatus !== stage.inProgress) {
    clearTaskActiveRuntimeSelection(task.id);
  }
  updateTaskStatus(task.id, stage.inProgress, {}, { title: taskTitle, fromStatus: sourceStatus });

  log.debug(
    { taskId: task.id, from: sourceStatus, to: stage.inProgress },
    "Status transition (start)",
  );

  try {
    const executionRoot = task.worktreePath ?? project.rootPath;
    // Перечитываем задачу перед запуском: между выбором кандидата и этим моментом владелец
    // мог смениться на человека, и тогда запускать субагента нельзя.
    const executionBoundaryTask = findTaskById(task.id);
    if (!executionBoundaryTask || executionBoundaryTask.executionOwner !== "ai") {
      log.warn(
        {
          taskId: task.id,
          stage: stage.label,
          executionOwner: executionBoundaryTask?.executionOwner ?? null,
        },
        "Aborted runtime execution at ownership boundary",
      );
      return false;
    }
    await runStageWithTimeout(stage.runner, task.id, executionRoot, stage.label);

    flushActivityQueue(task.id);

    // Гейт валидации плана (BR-constraint.automation.plan-validation-gate)
    // применяется только там, где файл плана — критичный артефакт потока:
    // VCS-связанный plan-review публикует план для человеческого ревью.
    // Для локальных задач план пишется и валидируется самим runner'ом
    // (persistTaskPlan), поэтому дублирующая проверка диска координатором
    // не блокирует диспатч конвейера.
    const planGateApplies = taskRequiresPlanReview(task.id);

    if (stage.label === "planner") {
      // После генерации плана проверяем, что файл плана действительно
      // создан с содержимым. Ошибка потока или пустой ответ модели
      // могут дать коммит без валидного плана. Остаёмся в planning,
      // чтобы следующий цикл опроса повторил planner.
      if (planGateApplies) {
        const plannedTask = findTaskById(task.id);
        let planValid = false;
        if (plannedTask) {
          try {
            const cfg = getProjectConfig(executionRoot);
            const planRelPath = task.isFix
              ? cfg.paths.fix_plan
              : plannedTask.planPath || cfg.paths.plan;
            const planAbsPath = resolve(executionRoot, planRelPath);
            if (existsSync(planAbsPath)) {
              const content = readFileSync(planAbsPath, "utf8").trim();
              planValid = content.length > 0;
            }
          } catch {
            planValid = false;
          }
        }
        if (!planValid) {
          log.warn(
            { taskId: task.id, reason: "plan_file_missing_or_empty" },
            "Plan file is empty or missing after planner, staying in planning for retry",
          );
          clearTaskActiveRuntimeSelection(task.id);
          clearTaskRuntimeLimitSnapshot(task.id);
          updateTaskStatus(task.id, "planning", CLEAN_STATE_RESET, {
            title: taskTitle,
            fromStatus: stage.inProgress,
          });
          logActivity(task.id, "Agent", "planner: empty plan, staying in planning for retry");
          return true;
        }
      }
    }

    if (stage.label === "improver") {
      // После завершения improve проверяем наличие валидного плана.
      // Если план всё ещё пуст (например, сбой вышестоящего потока или
      // потеря содержимого), возвращаемся в planning, чтобы planner
      // перегенерировал его — не оставляем задачу циклиться в improve.
      if (planGateApplies) {
        const improvedTask = findTaskById(task.id);
        let planValid = false;
        if (improvedTask) {
          try {
            const cfg = getProjectConfig(executionRoot);
            const planRelPath = task.isFix
              ? cfg.paths.fix_plan
              : improvedTask.planPath || cfg.paths.plan;
            const planAbsPath = resolve(executionRoot, planRelPath);
            if (existsSync(planAbsPath)) {
              const content = readFileSync(planAbsPath, "utf8").trim();
              planValid = content.length > 0;
            }
          } catch {
            planValid = false;
          }
        }
        if (!planValid) {
          log.warn(
            { taskId: task.id, reason: "plan_file_missing_or_empty" },
            "Plan not found or empty after improve, returning to planning",
          );
          clearTaskActiveRuntimeSelection(task.id);
          clearTaskRuntimeLimitSnapshot(task.id);
          updateTaskStatus(task.id, "planning", CLEAN_STATE_RESET, {
            title: taskTitle,
            fromStatus: stage.inProgress,
          });
          logActivity(task.id, "Agent", "improve returned to planning: plan is empty or missing");
          return true;
        }
      }
    }

    if (stage.label === "plan-publisher") {
      // Издатель делает self-loop по plan_review. Раннер проставляет
      // planReviewState=published через markTaskPlanPublished (self-loop,
      // остаёмся на plan_review). Когда публикация отложена (нет
      // ветки или файла плана) задача остаётся на plan_review, и следующий
      // опрос повторит попытку — статус никогда не меняется без успешной
      // публикации.
      const current = findTaskById(task.id);
      const published =
        current?.planReviewState === "published" && current.status === "plan_review";
      clearTaskActiveRuntimeSelection(task.id);
      clearTaskRuntimeLimitSnapshot(task.id);
      if (published) {
        void notifyTaskBroadcast(task.id, "task:moved", {
          title: taskTitle,
          fromStatus: stage.inProgress,
          toStatus: "plan_review",
        });
        log.info(
          { taskId: task.id, from: stage.inProgress, to: "plan_review" },
          "Change plan published; task waiting for approval",
        );
      } else {
        log.info(
          {
            taskId: task.id,
            status: current?.status ?? task.status,
            planReviewState: current?.planReviewState ?? null,
          },
          "Plan review publish deferred; task remains at plan_review",
        );
      }
      return true;
    }

    if (stage.label === "done-checker") {
      // Done Checker — self-loop стадия: переход в accepted выполняет только
      // сам раннер (при merge/approve PR/MR), поэтому координатор не должен
      // принудительно применять onSuccess=accepted после возврата раннера.
      // Без этого блока generic-путь успеха переводил бы задачу из done в
      // accepted на каждом цикле, минуя сигналы одобрения.
      const doneTask = findTaskById(task.id);
      clearTaskActiveRuntimeSelection(task.id);
      clearTaskRuntimeLimitSnapshot(task.id);
      log.debug(
        {
          taskId: task.id,
          status: doneTask?.status ?? task.status,
          planReviewFeedback: doneTask?.planReviewFeedback ?? null,
        },
        "Done-checker stage complete; task stays at its status unless the runner transitioned it",
      );
      return true;
    }

    // Реализатор, не изменивший ни одного файла, не считается успехом: сбрасываем состояние
    // коммит-гейта и оставляем задачу в implementing, чтобы повторный запуск был вынужден
    // либо написать код, либо явно упасть.
    if (stage.label === "implementer") {
      const implementationTask = findTaskById(task.id);
      if (hasImplementationNoOp(implementationTask?.implementationLog)) {
        const retryAt = new Date().toISOString();
        setTaskFields(task.id, {
          reworkRequested: true,
          autoQueueCommitStatus: "pending",
          autoQueueCommitBaseSha: null,
          commitSha: null,
          autoQueueCommitError: null,
          autoQueueCommitCompletedAt: null,
          lastHeartbeatAt: retryAt,
          updatedAt: retryAt,
        });
        logActivity(
          task.id,
          "Agent",
          "[FIX] Approved plan was not implemented; scheduling another implementation attempt",
        );
        log.warn(
          { taskId: task.id },
          "[FIX] Implementation produced no files after corrective retry; keeping task in implementing for automatic retry",
        );
        flushActivityQueue(task.id);
        return true;
      }

      await publishGitHubTask(task.id, project.rootPath);
      await publishGitLabTask(task.id, project.rootPath);
      flushActivityQueue(task.id);
    }

    // skipReview - явное желание автора проскочить ревью, но не обязательную
    // skills-mode верификацию: при runPostVerify задача сначала проходит
    // verifier и только потом завершается в done. Пути назад нет, поэтому
    // единственное, что здесь обязательно, - коммит-гейт перед статусом done.
    if (stage.label === "implementer" && task.skipReview && !shouldRunSkillsModeVerify(task)) {
      clearTaskActiveRuntimeSelection(task.id);
      clearTaskRuntimeLimitSnapshot(task.id);
      const doneStatus = "done";
      if (doneStatus === "done") {
        await ensureCommitBeforeTerminalStatus(task, project.rootPath);
      }
      updateTaskStatus(task.id, doneStatus, CLEAN_STATE_RESET, {
        title: taskTitle,
        fromStatus: stage.inProgress,
      });
      log.info(
        { taskId: task.id, from: stage.inProgress, to: doneStatus },
        "Skip review and verify bypassed — moving to done",
      );
      return true;
    }

    // Ревьюер - единственная стадия с автоматическим шлюзом: он сам решает, принять работу,
    // отправить на доработку или передать человеку, и объявляет это исходом, который ниже
    // разбирается по статусу.
    if (stage.label === "reviewer") {
      const outcome = await handleAutoReviewGate({
        taskId: task.id,
        projectRoot: task.worktreePath ?? project.rootPath,
      });
      await publishGitHubTask(task.id, project.rootPath);
      await publishGitLabTask(task.id, project.rootPath);
      flushActivityQueue(task.id);

      // Передача человеку делается через handoffTaskExecution, а не простой записью полей:
      // только этот путь меняет ревизию владения, которую видит UI, и гарантирует, что
      // координатор больше не возьмёт задачу себе.
      if (outcome?.status === "manual_review_required") {
        clearTaskActiveRuntimeSelection(task.id);
        clearTaskRuntimeLimitSnapshot(task.id);
        const currentTask = findTaskById(task.id);
        if (!currentTask) return false;
        const handoff = handoffTaskExecution({
          taskId: task.id,
          executionOwner: "human",
          expectedOwnershipRevision: currentTask.ownershipRevision,
          expectedExecutionOwner: "ai",
          expectedStatus: currentTask.status,
          actor: {
            kind: "system",
            id: "auto-review-gate",
            displayNameSnapshot: "Auto Review Gate",
          },
          reason: outcome.handoffReason,
          allowLockedBy: COORDINATOR_ID,
        });
        if (!handoff.ok) {
          log.error(
            { taskId: task.id, code: handoff.code, handoffReason: outcome.handoffReason },
            "Auto review manual handoff failed",
          );
          return false;
        }
        setTaskFields(task.id, {
          blockedReason: null,
          blockedFromStatus: null,
          retryAfter: null,
          retryCount: 0,
          reworkRequested: false,
          reviewIterationCount: outcome.currentIteration,
          manualReviewRequired: true,
          autoReviewState: outcome.autoReviewState,
        });
        void notifyTaskBroadcast(task.id, "task:updated", {
          title: taskTitle,
          fromStatus: stage.inProgress,
          toStatus: stage.inProgress,
        });
        log.info(
          {
            taskId: task.id,
            from: stage.inProgress,
            to: stage.inProgress,
            executionOwner: "human",
            reviewIteration: outcome.currentIteration,
            handoffReason: outcome.handoffReason,
          },
          "Auto review gate stopped at manual review handoff",
        );
        return true;
      }

      if (outcome?.status === "rework_requested") {
        clearTaskActiveRuntimeSelection(task.id);
        clearTaskRuntimeLimitSnapshot(task.id);
        updateTaskStatus(
          task.id,
          "implementing",
          {
            blockedReason: null,
            blockedFromStatus: null,
            retryAfter: null,
            retryCount: 0,
            reworkRequested: true,
            reviewIterationCount: outcome.currentIteration,
            manualReviewRequired: false,
            autoReviewState: outcome.autoReviewState,
            autoQueueCommitStatus: "pending",
            // Прежний commitSha становится базой новой попытки, а сам commitSha обнуляется:
            // так гейт поймёт, что старый коммит уже учтён и не примет его за результат
            // доработки.
            autoQueueCommitBaseSha: findTaskById(task.id)?.commitSha ?? null,
            commitSha: null,
            autoQueueCommitError: null,
            autoQueueCommitCompletedAt: null,
          },
          { title: taskTitle, fromStatus: stage.inProgress },
        );
        log.info(
          {
            taskId: task.id,
            from: stage.inProgress,
            to: "implementing",
            reviewIteration: outcome.currentIteration,
          },
          "Auto review gate requested changes, restarting implementing stage",
        );
        return true;
      }

      // Принятие шлюзом - это подтверждённое завершение, но коммит всё равно проверяется:
      // ревью могло одобрить дерево с несохранёнными изменениями.
      if (outcome?.status === "accepted") {
        await ensureCommitBeforeTerminalStatus(task, project.rootPath);
        clearTaskActiveRuntimeSelection(task.id);
        clearTaskRuntimeLimitSnapshot(task.id);
        updateTaskStatus(task.id, "done", CLEAN_STATE_RESET, {
          title: taskTitle,
          fromStatus: stage.inProgress,
        });
        log.info(
          { taskId: task.id, from: stage.inProgress, to: "done" },
          "Auto review gate accepted review, moving to done",
        );
        return true;
      }
    }

    // Общий успешный выход стадии. Итерации ревью сохраняются только у реализатора: для
    // остальных стадий счётчик сбрасывается, иначе он накапливался бы между независимыми
    // циклами доработки.
    const successStatus = getStageSuccessStatus(task, stage);
    if (successStatus === "done" || successStatus === "accepted") {
      await ensureCommitBeforeTerminalStatus(task, project.rootPath);
    }
    clearTaskActiveRuntimeSelection(task.id);
    clearTaskRuntimeLimitSnapshot(task.id);
    updateTaskStatus(
      task.id,
      successStatus,
      {
        ...CLEAN_STATE_RESET,
        reviewIterationCount: stage.label === "implementer" ? (task.reviewIterationCount ?? 0) : 0,
      },
      { title: taskTitle, fromStatus: stage.inProgress },
    );

    log.info(
      { taskId: task.id, from: stage.inProgress, to: successStatus },
      "Status transition (success)",
    );
    return true;
  } catch (err) {
    // Классификация ошибки - отдельный слой: координатор не разбирает текст сообщения, а
    // получает готовое решение (быстрый повтор, внешняя блокировка или откат статуса),
    // поэтому новые типы сбоев добавляются в классификатор, а не сюда.
    const recovery = classifyStageError({
      taskId: task.id,
      stageLabel: stage.label,
      sourceStatus,
      retryCount: task.retryCount ?? 0,
      err,
    });

    switch (recovery.kind) {
      case "fast_retry":
        // Обрыв потока - не ошибка задачи, а сбой транспорта: статус не меняется, счётчик
        // растёт, и следующий тик просто повторит стадию.
        runtimeCounters.fastRetryStreamInterruptions += 1;
        log.warn(
          {
            taskId: task.id,
            stage: stage.label,
            metric: "coordinator.fast_retry_stream_interruptions",
            fastRetryStreamInterruptions: runtimeCounters.fastRetryStreamInterruptions,
          },
          "Fast retry scheduled after transient stream interruption",
        );
        clearTaskRuntimeLimitSnapshot(task.id);
        updateTaskStatus(
          task.id,
          stage.inProgress,
          {
            blockedReason: null,
            blockedFromStatus: null,
            retryAfter: null,
          },
          { title: taskTitle, fromStatus: stage.inProgress },
        );
        break;

      case "blocked_external":
        // Снимок лимита сохраняется при наличии: по нему следующий тик поймёт, что задача
        // ждёт не ресурса задачи, а внешнего окна провайдера.
        if (recovery.limitSnapshot) {
          persistTaskRuntimeLimitSnapshot(task.id, recovery.limitSnapshot);
        } else {
          clearTaskRuntimeLimitSnapshot(task.id);
        }
        updateTaskStatus(
          task.id,
          "blocked_external",
          {
            blockedReason: recovery.blockedReason,
            blockedFromStatus: stage.inProgress,
            retryAfter: recovery.retryAfter,
            retryCount: recovery.retryCount,
          },
          { title: taskTitle, fromStatus: stage.inProgress },
        );
        break;

      case "revert":
        // Откат оставляет задачу в статусе стадии: она не блокируется и не переносится,
        // а ждёт нового запуска после устранения причины.
        clearTaskRuntimeLimitSnapshot(task.id);
        updateTaskStatus(
          task.id,
          stage.inProgress,
          {},
          { title: taskTitle, fromStatus: stage.inProgress },
        );
        break;
    }

    flushActivityQueue(task.id);
    return false;
  }
}

// ── Триггер запланированных задач ───────────────────

/**
 * Запускает запланированные задачи с наступившим сроком в стадию planning.
 *
 * Backlog-задачи с `scheduledAt <= now` переходят в `planning` (тот же путь,
 * что и событие `start_ai` от человека). Атомарно очищает `scheduledAt`, пишет
 * запись в activity-журнал и рассылает `task:scheduled_fired`.
 */
// Планировщик обрабатывает только задачи с наступившим scheduledAt. Проверка на грязное
// дерево стоит до захвата специально: иначе задача сменила бы статус, но фактически не
// стартовала, и в канбане остался бы ложный след.
export function processDueScheduledTasks(): number {
  const nowIso = new Date().toISOString();
  const due = listDueScheduledTasks(nowIso);
  if (due.length === 0) {
    log.debug({ nowIso }, "No due scheduled tasks");
    return 0;
  }

  log.info({ dueCount: due.length, nowIso }, "Firing due scheduled tasks");

  let fired = 0;
  for (const task of due) {
    try {
      const project = findProjectById(task.projectId);
      if (scheduledTaskHasDirtyAutoQueueWorktree(task, project)) {
        continue;
      }
      const autoQueueCommit =
        AUTO_QUEUE_COMMIT_GATE_ENABLED && project?.autoQueueMode === true
          ? resolveAutoQueueCommitPreparation(task.worktreePath ?? project.rootPath)
          : undefined;
      // CAS-захват: продолжаем, только если строка всё ещё backlog+не приостановлена
      // на момент записи. Защищает от гонки с auto-queue или с
      // параллельным экземпляром координатора.
      if (!claimBacklogTaskForAdvance(task.id, autoQueueCommit)) {
        log.debug({ taskId: task.id }, "Scheduler: task no longer backlog/unpaused, skipped");
        continue;
      }
      appendTaskActivityLog(
        task.id,
        `[${nowIso}] [scheduler] Fired scheduled task (was due at ${task.scheduledAt})`,
      );
      void notifyTaskBroadcast(task.id, "task:scheduled_fired", {
        title: task.title,
        fromStatus: task.status,
        toStatus: "planning",
      });
      // Дублирует стандартный broadcast статуса, который отправил бы
      // updateTaskStatus, чтобы колонки канбана перерисовались существующим
      // путём кода task:moved (и Telegram сработал на переход).
      void notifyTaskBroadcast(task.id, "task:moved", {
        title: task.title,
        fromStatus: task.status,
        toStatus: "planning",
      });
      fired += 1;
      log.info(
        { taskId: task.id, title: task.title, scheduledAt: task.scheduledAt },
        "Scheduled task fired",
      );
    } catch (err) {
      log.error({ taskId: task.id, err }, "Failed to fire scheduled task");
    }
  }

  log.info({ fired, attempted: due.length }, "Scheduled-task trigger pass complete");
  return fired;
}

// ── Продвижение автоочереди ─────────────────────────

/**
 * Для каждого проекта с `autoQueueMode = true` заполняет конвейер до глубины пула,
 * продвигая в `planning` backlog-задачи (сначала — с наименьшим `position`).
 * Глубина пула: `1` для последовательных проектов и
 * `COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT` для параллельных, поэтому один
 * путь кода покрывает оба случая:
 *   - непараллельный проект: строгая последовательность — следующая задача стартует
 *     только после терминального статуса предыдущей (done/verified)
 *   - параллельный проект: держит число в работе на уровне параллельного предела
 *
 * «В работе» = любой нетерминальный статус конвейера (planning..review и
 * blocked_external). Терминальные = done/verified. Сам backlog — источник
 * пула и не учитывается.
 */
// Автоочередь сама наполняет конвейер из backlog, поэтому человеку не нужно вручную
// запускать каждую следующую задачу. Она работает только поверх существующих статусов и
// не трогает задачи, уже находящиеся в работе.
export function processAutoQueueAdvance(): number {
  const projects = listAutoQueueProjects();
  if (projects.length === 0) {
    log.debug("No projects with auto-queue mode enabled");
    return 0;
  }

  let advanced = 0;
  for (const project of projects) {
    // Предикат сериализации объединяет:
    //   - текущий конфиг (`git.create_branches=true` в настоящем git-репозитории) И
    //   - состояние задач (у любой задачи в работе уже сохранён branchName).
    //
    // Одного конфига мало: оператор может переключить `create_branches=off`
    // посреди конвейера. Legacy задачи, привязанные к ветке без worktreePath,
    // всё равно переключают HEAD в общем корне, поэтому требуют последовательного
    // исполнения. Проекты с рабочими деревьями для задач держат параллельный пул
    // открытым: planner готовит изолированный cwd до правки файлов.
    const requiresSerialExecution = projectRequiresSerialExecution(project);
    if (project.parallelEnabled && requiresSerialExecution) {
      log.warn(
        { projectId: project.id, projectRoot: project.rootPath },
        "Auto-queue parallel pool disabled while tasks share one Git working tree",
      );
    }
    // Глубина пула: последовательный проект держит ровно одну задачу в конвейере,
    // параллельный - до настроенного лимита, но не выше возможностей рабочего дерева.
    const limit =
      project.parallelEnabled && !requiresSerialExecution
        ? env.COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT
        : 1;
    let active = countActivePipelineTasksForProject(project.id);

    if (active >= limit) {
      log.debug(
        { projectId: project.id, active, limit },
        "Auto-queue: project pipeline at capacity, skipping",
      );
      continue;
    }

    // Пока есть задача с незавершённым коммит-состоянием, новые стартовать нельзя: их
    // изменения смешались бы в одном дереве с недокоммиченными.
    if (AUTO_QUEUE_COMMIT_GATE_ENABLED && hasBlockingAutoQueueCommitForProject(project.id)) {
      log.warn(
        { projectId: project.id },
        "Auto-queue paused because a task has blocking commit state",
      );
      continue;
    }

    // Гейт грязного рабочего дерева. Терминальные статусы (done/verified) не
    // гарантируют, что диф предыдущей задачи закоммичен — manual-review
    // ставит конвейер на паузу с чистым статусом, но грязным репозиторием.
    // Продвижение следующей задачи позволило бы её planner создать feature-ветку
    // поверх устаревших изменений (или сорвать checkout совсем). Пауза
    // auto-queue для этого проекта, пока рабочее дерево не очистится.
    if (
      isGitRepo(project.rootPath) &&
      (!env.AIF_TASK_WORKTREES_ENABLED || !projectSupportsTaskWorktrees(project.rootPath))
    ) {
      const dirty = describeDirtyWorkingTree(project.rootPath);
      if (dirty) {
        log.warn(
          { projectId: project.id, projectRoot: project.rootPath, dirtyPreview: dirty },
          "Auto-queue paused: work tree has uncommitted changes from previous task",
        );
        continue;
      }
    }

    // Заполняет пул до предела за один этот тик. Ограничитель цикла держит
    // это дешёвым (лимит мал, по умолчанию 3) и не даёт ждать ещё один полный
    // цикл опроса ради старта второй/третьей задачи.
    // Заполняем пул до предела за один тик, чтобы не ждать следующего опроса ради запуска
    // второй задачи; граница цикла мала (по умолчанию 3), так что это дёшево.
    while (active < limit) {
      const next = nextBacklogTaskByPosition(project.id);
      if (!next) {
        log.debug(
          { projectId: project.id, active, limit },
          "Auto-queue: no more backlog tasks ready to advance",
        );
        break;
      }

      const nowIso = new Date().toISOString();
      try {
        // CAS-захват: продолжаем, только если строка всё ещё backlog+не приостановлена.
        // Если false — другой проход (планировщик / параллельный координатор /
        // клик start_ai человеком) выиграл гонку — перечитать счётчики пула и продолжить.
        const autoQueueCommit = AUTO_QUEUE_COMMIT_GATE_ENABLED
          ? resolveAutoQueueCommitPreparation(next.worktreePath ?? project.rootPath)
          : undefined;
        if (!claimBacklogTaskForAdvance(next.id, autoQueueCommit)) {
          log.debug(
            { taskId: next.id, projectId: project.id },
            "Auto-queue: task no longer backlog/unpaused, skipped",
          );
          active = countActivePipelineTasksForProject(project.id);
          continue;
        }
        // Дублирует broadcast, который дал бы updateTaskStatus для перехода
        // backlog → planning (CAS-запись его пропускает).
        void notifyTaskBroadcast(next.id, "task:moved", {
          title: next.title,
          fromStatus: next.status,
          toStatus: "planning",
        });
        appendTaskActivityLog(
          next.id,
          `[${nowIso}] [auto-queue] Advanced by project auto-queue mode (pool ${active + 1}/${limit})`,
        );
        void notifyProjectBroadcast(project.id, "project:auto_queue_advanced", {
          taskId: next.id,
        });
        advanced += 1;
        active += 1;
        log.info(
          {
            projectId: project.id,
            taskId: next.id,
            title: next.title,
            position: next.position,
            poolDepth: `${active}/${limit}`,
          },
          "Auto-queue advanced next backlog task",
        );
      } catch (err) {
        log.error({ projectId: project.id, taskId: next.id, err }, "Auto-queue advance failed");
        // При ошибке выходим из цикла этого проекта; повторим на следующем тике.
        break;
      }
    }
  }

  if (advanced > 0) {
    log.info({ advanced, projectCount: projects.length }, "Auto-queue advance pass complete");
  }
  return advanced;
}

// ── Цикл опроса ──────────────────────────────────────

let activePollPromise: Promise<void> | null = null;
let followUpPollRequested = false;

// Один тик обслуживания. Порядок шагов не произвольный: сначала снимаются протухшие локи и
// разблокируются задачи с истёкшим retryAfter, затем просыпаются отложенные задачи,
// синхронизируется внешний трекер и только после этого наполняется автоочередь. Если
// поменять местами, задача может стартовать, оставаясь под чужим локом.
async function runPollCycle(): Promise<void> {
  log.debug("Starting poll cycle");

  // Освобожаем протухшие локи ДО watchdog — иначе watchdog переведёт задачу в blocked_external,
  // а лок останется сиротой (очистка heartbeat фильтрует по статусу в работе)
  const released = releaseStaleTaskClaims();
  if (released > 0) {
    log.info({ released }, "Released stale task claims");
  }

  releaseDueBlockedTasks();
  recoverStaleInProgressTasks();
  processDueScheduledTasks();
  await synchronizeGitHubProjects();
  await synchronizeGitLabProjects();
  processAutoQueueAdvance();

  const maxProjectLanes = env.COORDINATOR_MAX_CONCURRENT_PROJECTS;
  const globalMaxTasks = env.COORDINATOR_MAX_CONCURRENT_TASKS;

  // Ошибка на одной стадии не означает, что задачу нельзя взять на следующей: без этого
  // множества упавший planner тут же был бы выбран implementer'ом в том же тике.
  // Учитываем упавшие в этом цикле задачи — не брать их на последующих стадиях
  const failedInCycle = new Set<string>();

  // Кэширует фактические настройки параллельности проекта, чтобы не перечитывать их.
  // Legacy задачи, привязанные к ветке без worktreePath, всё ещё мутируют общий
  // projectRoot, поэтому такие проекты остаются последовательными, пока legacy задача не рассосётся.
  // Кэш на время тика: проект читается из БД один раз, хотя по нему проходит весь конвейер.
  // Между тиками кэш не живёт - настройки проекта могут измениться.
  const projectConcurrencyCache = new Map<string, { parallel: boolean; max: number }>();
  function resolveProjectConcurrency(projectId: string): { parallel: boolean; max: number } {
    let cached = projectConcurrencyCache.get(projectId);
    if (cached === undefined) {
      const project = findProjectById(projectId);
      const configuredParallel = project?.parallelEnabled ?? false;
      // Как в processAutoQueueAdvance: конфиг ИЛИ состояние задач принуждает к последовательности.
      const requiresSerialExecution = project ? projectRequiresSerialExecution(project) : false;
      cached = {
        parallel: configuredParallel && !requiresSerialExecution,
        max:
          configuredParallel && !requiresSerialExecution
            ? env.COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT
            : 1,
      };
      if (configuredParallel && requiresSerialExecution) {
        log.warn(
          { projectId, projectRoot: project?.rootPath },
          "Project parallel execution forced to serial while tasks share one Git working tree",
        );
      }
      projectConcurrencyCache.set(projectId, cached);
    }
    return cached;
  }

  // Число обрабатываемых проектов ограничено сверху: один тик не должен забирать все
  // ресурсы машины, остальные проекты дождутся следующего.
  const projectIds = listCoordinatorActionableProjectIds(maxProjectLanes);
  if (projectIds.length === 0) {
    log.debug("No actionable project lanes");
    return;
  }

  log.debug(
    {
      projectIds,
      maxProjectLanes,
      globalMaxTasks,
      activeTasks: stageSemaphore.totalActive(),
    },
    "Coordinator project lanes selected",
  );

  // Проекты обрабатываются параллельно, а стадии внутри проекта - строго по порядку PIPELINE.
  // Так задача не перескочит через стадию внутри одного тика, но разные проекты не
  // блокируют друг друга.
  async function processProjectLane(projectId: string): Promise<void> {
    // После захвата fix-задачи без ветки остальная часть лана проекта ждёт
    // следующего цикла, чтобы мутации общего дерева не перекрывались.
    let exclusiveRunClaimedThisCycle = false;
    for (const stage of PIPELINE) {
      const concurrency = resolveProjectConcurrency(projectId);
      const parallel = concurrency.parallel;
      const projectMax = concurrency.max;
      const stageKey = `${projectId}:${stage.label}`;

      // Берём с запасом (пятикратный размер пула, но не больше 50): часть кандидатов
      // отсеется проверками вроде плана или лимитов, и без запаса тик остался бы без работы.
      const candidateWindow = Math.min(Math.max(projectMax * 5, projectMax), 50);
      const candidates = findCoordinatorTaskCandidatesForProject(
        projectId,
        stage.label,
        candidateWindow,
      )
        .filter((t) => {
          if (failedInCycle.has(t.id)) {
            log.warn(
              { taskId: t.id, projectId, stage: stage.label, reason: "failed_in_cycle" },
              "Skipped stage candidate",
            );
            return false;
          }
          return true;
        })
        .filter((t) => {
          const ineligible = planReviewStageIneligible(stage.label, t);
          if (ineligible) {
            log.warn(
              {
                taskId: t.id,
                projectId,
                stage: stage.label,
                reason: "plan_review_gate_ineligible",
                planReviewState: t.planReviewState ?? null,
              },
              "Skipped stage candidate",
            );
          }
          return !ineligible;
        });

      if (candidates.length === 0) {
        log.debug({ stage: stage.label, projectId }, "No tasks to process in project lane");
        continue;
      }

      log.debug(
        {
          stage: stage.label,
          projectId,
          candidateCount: candidates.length,
          candidateWindow,
          projectMax,
          globalMaxTasks,
        },
        "Project lane task candidates selected",
      );

      const spawned: Promise<void>[] = [];

      try {
        for (const task of candidates) {
          // Параллельность на проект: непараллельные проекты ограничены 1 задачей за раз
          if (spawned.length >= projectMax) {
            log.debug(
              { taskId: task.id, projectId: task.projectId, projectMax, stage: stage.label },
              "Project at capacity, skipping task",
            );
            log.warn(
              {
                taskId: task.id,
                projectId: task.projectId,
                stage: stage.label,
                reason: "project_capacity",
                projectMax,
              },
              "Skipped stage candidate",
            );
            continue;
          }

          // Fix-задачи без ветки мутируют общий checkout: они никогда не
          // кандидаты в параллель и идут, только когда в работе пусто.
          if (exclusiveRunClaimedThisCycle) {
            log.debug(
              { taskId: task.id, projectId: task.projectId },
              "Exclusive (branchless fix) task already claimed this cycle; deferring candidate",
            );
            log.warn(
              {
                taskId: task.id,
                projectId: task.projectId,
                stage: stage.label,
                reason: "exclusive_run_already_claimed",
              },
              "Skipped stage candidate",
            );
            continue;
          }
          const requiresExclusiveRun = branchlessFixTaskRequiresExclusiveRun(task);
          if (
            requiresExclusiveRun &&
            (spawned.length > 0 || hasActiveLockedTaskForProject(task.projectId))
          ) {
            log.warn(
              {
                taskId: task.id,
                projectId: task.projectId,
                inFlightInLane: spawned.length,
              },
              "Branchless fix task requires exclusive execution; deferring while other project tasks are active",
            );
            log.warn(
              {
                taskId: task.id,
                projectId: task.projectId,
                stage: stage.label,
                reason: "exclusive_run_conflict",
              },
              "Skipped stage candidate",
            );
            continue;
          }

          // Межцикловая защита: для непараллельных проектов проверяет БД на активный лок
          // (другой одновременный цикл опроса мог уже захватить задачу этого проекта)
          if (!parallel && hasActiveLockedTaskForProject(task.projectId)) {
            log.debug(
              { taskId: task.id, projectId: task.projectId },
              "Non-parallel project has active lock from another cycle, skipping",
            );
            log.warn(
              {
                taskId: task.id,
                projectId: task.projectId,
                stage: stage.label,
                reason: "active_project_lock",
              },
              "Skipped stage candidate",
            );
            continue;
          }

          if (blockCandidateIfRuntimeLimited(task, stage)) {
            log.warn(
              {
                taskId: task.id,
                projectId: task.projectId,
                stage: stage.label,
                reason: "runtime_gate_blocked",
              },
              "Skipped stage candidate",
            );
            continue;
          }

          // Ожидание разрешения стоит после всех дешёвых проверок: занимать слот семафора
          // под кандидата, который всё равно не пройдёт фильтр, нельзя.
          await stageSemaphore.acquire(stageKey, projectMax, globalMaxTasks);
          let claimedTask: PersistedTask | undefined;
          let claimOutcomeUncertain = false;
          let cleanupOwnedByTaskPromise = false;

          // Освобождение идёт через одну функцию, потому что вызывается из двух веток:
          // штатно - из finally промиса задачи, и аварийно - если после захвата слота
          // семафора запуск так и не состоялся.
          const releaseOwnedResources = (): void => {
            try {
              // Если захват бросил исключение на середине, неизвестно, записала ли БД лок:
              // снимаем по исходному id, чтобы не оставить вечный замок.
              const taskIdToRelease =
                claimedTask?.id ?? (claimOutcomeUncertain ? task.id : undefined);
              if (taskIdToRelease) {
                releaseTaskClaim(taskIdToRelease, COORDINATOR_ID);
              }
            } catch (err) {
              log.error(
                { taskId: claimedTask?.id ?? task.id, stage: stage.label, err },
                "[FIX:149] Failed to release coordinator task claim",
              );
            } finally {
              stageSemaphore.release(stageKey);
            }
          };

          try {
            log.debug(
              { taskId: task.id, projectId: task.projectId, stage: stage.label },
              "[FIX:149] Revalidating task candidate after coordinator permit",
            );

            // Перепроверка после ожидания: пока задача стояла в очереди семафора, другой
            // координатор мог занять проект, и кандидат уже не актуален.
            if (!parallel && hasActiveLockedTaskForProject(task.projectId)) {
              log.debug(
                { taskId: task.id, projectId: task.projectId },
                "Non-parallel project became active while waiting for permit, skipping",
              );
              log.warn(
                {
                  taskId: task.id,
                  projectId: task.projectId,
                  stage: stage.label,
                  reason: "active_project_lock_after_wait",
                },
                "Skipped stage candidate",
              );
              continue;
            }

            if (blockCandidateIfRuntimeLimited(task, stage)) {
              log.warn(
                {
                  taskId: task.id,
                  projectId: task.projectId,
                  stage: stage.label,
                  reason: "runtime_gate_blocked_after_wait",
                },
                "Skipped stage candidate",
              );
              continue;
            }

            claimOutcomeUncertain = true;
            // Условный захват по ожидаемому статусу и режиму: если состояние строки
            // изменилось, захват вернёт undefined, и тик спокойно пойдёт дальше.
            claimedTask = claimCoordinatorTaskIfEligible({
              taskId: task.id,
              expectedProjectId: task.projectId,
              expectedStatus: task.status,
              expectedAutoMode: task.status === "plan_review" ? task.autoMode : undefined,
              coordinatorId: COORDINATOR_ID,
              lockDurationMs: CLAIM_LOCK_DURATION_MS,
            });
            claimOutcomeUncertain = false;
            if (!claimedTask) {
              log.debug(
                { taskId: task.id, stage: stage.label, expectedStatus: task.status },
                "[FIX:149] Task candidate changed while waiting for permit, skipping",
              );
              continue;
            }
            const executionTask = claimedTask;

            if (branchlessFixTaskRequiresExclusiveRun(executionTask)) {
              exclusiveRunClaimedThisCycle = true;
            }

            log.debug(
              {
                taskId: executionTask.id,
                stage: stage.label,
                runner: stage.runner.name || "anonymous",
                from: executionTask.status,
                onSuccess: getStageSuccessStatus(executionTask, stage),
                parallel,
              },
              "Stage candidate selected for execution",
            );

            // Задача обрабатывается без await: несколько задач одной стадии должны идти
            // параллельно, а ограничивают их семафор и размер пула проекта.
            const taskPromise = processOneTask(executionTask, stage)
              .then((success) => {
                if (!success) failedInCycle.add(executionTask.id);
              })
              .catch((err) => {
                failedInCycle.add(executionTask.id);
                log.error(
                  { taskId: executionTask.id, stage: stage.label, err },
                  "Unexpected error in task processing",
                );
              })
              .finally(releaseOwnedResources);

            spawned.push(taskPromise);
            cleanupOwnedByTaskPromise = true;
          } finally {
            // Успешный запуск передаёт владение ресурсами промису задачи; иначе освобождаем
            // их здесь же, чтобы слот семафора не утёк до конца цикла.
            if (!cleanupOwnedByTaskPromise) {
              releaseOwnedResources();
            }
          }
        }
      } finally {
        // Порядок стадий сохраняется, даже когда настройка позднего кандидата отклонила лан.
        if (spawned.length > 0) {
          log.debug(
            { projectId, stage: stage.label, taskCount: spawned.length },
            "[FIX:149] Draining started stage tasks before lane exit",
          );
          await Promise.allSettled(spawned);
          log.debug(
            { projectId, stage: stage.label, taskCount: spawned.length },
            "[FIX:149] Started stage tasks drained",
          );
        }
      }
    }
  }

  // allSettled, а не all: падение одного проекта не должно отменять уже идущие стадии в
  // других - они всё равно завершатся, и их результат нужно дождаться.
  const laneResults = await Promise.allSettled(
    projectIds.map((projectId) => processProjectLane(projectId)),
  );
  laneResults.forEach((result, index) => {
    if (result.status === "rejected") {
      log.error(
        { projectId: projectIds[index], err: result.reason },
        "Project coordinator lane failed",
      );
    }
  });

  // Пост-цикловая сверка с условием «ни одна стадия не в работе»: рабочее дерево,
  // которое задача только подготавливает, никогда не должно быть принято за сироту.
  // Это страховка, синхронизирующая `git worktree list` с живым набором задач.
  if (stageSemaphore.totalActive() === 0) {
    try {
      await reconcileAllProjectWorktrees("poll_cycle");
    } catch (err) {
      log.error({ err }, "Post-cycle worktree reconciliation failed; poll cycle continues");
    }
  }

  log.debug("Poll cycle complete");
}

// Single-flight: параллельные вызовы (крон и ручной запуск) не создают второй цикл, а
// просят один дополнительный проход после текущего. Флаг, а не счётчик, потому что больше
// одного лишнего прохода не нужно: следующий тик всё равно увидит свежее состояние.
export function pollAndProcess(): Promise<void> {
  if (activePollPromise) {
    followUpPollRequested = true;
    log.debug("Poll cycle already active; queued one follow-up cycle");
    return activePollPromise;
  }

  async function drainPollRequests(): Promise<void> {
    do {
      followUpPollRequested = false;
      await runPollCycle();
    } while (followUpPollRequested);
  }

  activePollPromise = drainPollRequests().finally(() => {
    activePollPromise = null;
  });
  return activePollPromise;
}
