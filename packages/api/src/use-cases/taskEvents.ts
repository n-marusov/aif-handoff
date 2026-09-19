/**
 * Use case: применение события к задаче (applyTaskEvent).
 *
 * Перенесено из packages/api/src/services/taskEvents.ts при clean-architecture
 * рефакторинге: оркестрация события (авторизация → ветка → мутация → post-check)
 * теперь живёт в application-слое и не знает про HTTP. Транспортный маппинг
 * (код отказа → HTTP-статус) остался в тонком адаптере services/taskEvents.ts.
 *
 * Ключевые инварианты (без изменений относительно исходника):
 *  - прямых обращений к БД нет, только через @aif/data;
 *  - перед любой мутацией восстанавливается persisted-ветка задачи;
 *  - все ветки возвращают discriminated union ApplyTaskEventResult, чтобы маршрут
 *    не ловил исключения и не угадывал ответ по тексту ошибки;
 *  - fast_fix ходит в runtime отдельным async-путём с двумя попытками.
 */
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertCurrentBranch,
  getProjectConfig,
  isBranchIsolationError,
  looksLikeFullPlanUpdate,
  resolveTaskAction,
  restorePersistedBranch,
  taskExecutionRoot,
} from "@aif/shared";
import {
  applyTaskAction,
  findProjectById,
  findTaskById,
  getLatestHumanComment,
  persistTaskPlanForTask,
  setTaskFields,
} from "@aif/data";
import { AiHandoffRequiredError, runFastFixQuery, withTimeout } from "../services/fastFix.js";
import { logger } from "@aif/shared";
import type { ApplyTaskEventInput, ApplyTaskEventResult } from "./types.js";

const log = logger("use-case:task-events");

// Локальный псевдоним задачи-строки: выводится из findTaskById, потому что
// row-типы задач не входят в публичный контракт @aif/data.
type PersistedTask = NonNullable<ReturnType<typeof findTaskById>>;

/** Семантический код отказа, понятный маршруту без разбора текста. */
type DenialCode =
  | "not_found"
  | "ai_handoff_required"
  | "fast_fix_status"
  | "fast_fix_auto_mode"
  | "fast_fix_no_comment"
  | "fast_fix_no_plan"
  | "fast_fix_incomplete"
  | "branch_isolation"
  | string;

function denied(code: DenialCode, error: string): ApplyTaskEventResult {
  return {
    ok: false,
    code,
    error,
  };
}

/**
 * Вернуть рабочее дерево на persisted-ветку задачи перед записью. null означает
 * "проверка не нужна или прошла"; при сбое возвращается готовый отказ.
 */
function restoreTaskBranchForMutation(
  task: PersistedTask,
  projectRoot: string,
): ApplyTaskEventResult | null {
  // У fix-задач ветка не создаётся (они работают в текущем дереве), а отсутствие
  // branchName значит, что изоляция не применялась вообще - проверять нечего.
  if (!task.branchName || task.isFix) return null;
  try {
    // task.branchName — контракт источника истины: каждый путь мутации
    // (fast-fix, обычный переход) должен попасть на
    // сохранённую ветку или громогласно упасть. Используем `restorePersistedBranch` вместо
    // `ensureFeatureBranch({switchOnly:true})`, чтобы расхождение конфига
    // (`git.enabled` / `create_branches`, выключенные после планировщика) не
    // могло отпустить нас на текущий HEAD.
    restorePersistedBranch({
      projectRoot,
      taskId: task.id,
      persistedBranchName: task.branchName,
    });
    return null;
  } catch (err) {
    const error = isBranchIsolationError(err)
      ? `Branch isolation failure (${err.kind}): ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
    return denied("branch_isolation", error);
  }
}

/**
 * Проверка дрейфа ПОСЛЕ дочернего прогона: runtime мог сам переключить ветку,
 * поэтому совпадение проверяется повторно, а не только на входе.
 */
function assertTaskBranchPostRun(
  task: PersistedTask,
  projectRoot: string,
): ApplyTaskEventResult | null {
  if (!task.branchName || task.isFix) return null;
  try {
    assertCurrentBranch(projectRoot, task.branchName);
    return null;
  } catch (err) {
    const error = isBranchIsolationError(err)
      ? `Branch isolation failure (${err.kind}): ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
    return denied("branch_isolation", error);
  }
}

/**
 * Fast fix - правка уже существующего плана по последнему человеческому комментарию.
 * Путь намеренно длинный: он пишет в файловую систему через runtime, поэтому вокруг
 * прогона стоят проверки ветки, а результат валидируется на полноту плана.
 */
async function handleFastFix(input: ApplyTaskEventInput): Promise<ApplyTaskEventResult> {
  const task = findTaskById(input.taskId);
  if (!task) {
    return denied("not_found", "Task not found");
  }
  // Задача у человека - автоматический прогон запрещён: сначала нужен явный handoff,
  // иначе агент перепишет план, который человек в этот момент правит вручную.
  if (task.executionOwner !== "ai") {
    return denied("ai_handoff_required", "The task must be handed to AI before fast fix can run");
  }
  // Только plan_review: fast fix имеет смысл для комментария к плану, а не к реализации.
  if (task.status !== "plan_review") {
    return denied("fast_fix_status", "fast_fix is only allowed from plan_review");
  }
  // В autoMode координатор сам применяет правки, ручной fast fix создал бы гонку за план.
  if (task.autoMode) {
    return denied("fast_fix_auto_mode", "fast_fix is not needed when autoMode=true");
  }

  // Источник требования - именно комментарий человека; комментарии агентов не годятся,
  // иначе фикс запускался бы по собственной формулировке агента.
  const latestComment = getLatestHumanComment(task.id);
  if (!latestComment) {
    return denied("fast_fix_no_comment", "fast_fix requires a human comment with requested fix");
  }

  // Корень нужен до ветки: у задачи может не быть worktree, тогда всё считается
  // относительно корня проекта.
  const project = findProjectById(task.projectId);
  if (!project) {
    return denied("not_found", "Project not found for task");
  }
  const executionRoot = taskExecutionRoot({
    worktreePath: task.worktreePath,
    rootPath: project.rootPath,
  });

  const branchError = restoreTaskBranchForMutation(task, executionRoot);
  if (branchError) return branchError;

  // Предыдущий план передаётся в модель как база: правка должна быть дельтой,
  // а пустой план означает, что исправлять нечего.
  const previousPlan = task.plan?.trim() ?? "";
  if (!previousPlan) {
    return denied("fast_fix_no_plan", "fast_fix requires an existing plan on the task");
  }
  // Путь плана зависит от типа задачи: fix-задачи всегда живут в FIX_PLAN.md,
  // обычные - в planPath задачи, а при его отсутствии берётся путь из конфига.
  const cfg = getProjectConfig(executionRoot);
  const effectivePlanPath = task.isFix ? cfg.paths.fix_plan : task.planPath || cfg.paths.plan;

  // Первая попытка идёт с инструментами и правом перезаписать файл плана. Любой сбой
  // (таймаут, ошибка runtime) не прерывает flow: ниже будет вторая попытка в режиме
  // без инструментов, где модель обязана вернуть весь план текстом.
  let firstAttempt = "";
  try {
    firstAttempt = await withTimeout(
      runFastFixQuery({
        taskId: task.id,
        taskTitle: task.title,
        taskDescription: task.description,
        latestComment,
        projectRoot: executionRoot,
        planPath: effectivePlanPath,
        previousPlan,
        shouldTryFileUpdate: true,
      }),
      90_000,
      "Fast fix query timed out",
    );
  } catch {
    // Ниже — откат к режиму без инструментов
  }

  // Валидация перед принятием: модель иногда возвращает только фрагмент. Тогда
  // запускается повторный прогон без инструментов, чтобы получить план целиком.
  const updatedPlan = looksLikeFullPlanUpdate(previousPlan, firstAttempt)
    ? firstAttempt
    : await withTimeout(
        runFastFixQuery({
          taskId: task.id,
          taskTitle: task.title,
          taskDescription: task.description,
          latestComment,
          projectRoot: executionRoot,
          planPath: effectivePlanPath,
          previousPlan,
          priorAttempt: firstAttempt || undefined,
          shouldTryFileUpdate: false,
        }),
        90_000,
        "Fast fix query timed out",
      );

  // Обе попытки дали фрагмент - план не трогаем и сообщаем об ошибке: частичная
  // запись уничтожила бы содержимое, которого нет в ответе модели.
  if (!looksLikeFullPlanUpdate(previousPlan, updatedPlan)) {
    return denied(
      "fast_fix_incomplete",
      "Fast fix result omitted existing plan content. Plan was left unchanged.",
    );
  }

  // Пост-проверка расхождения: `runFastFixQuery` запускает runtime, который может писать
  // на диск (инъекция `@${planPath}` просит перезаписать файл). Незваный скилл
  // мог сделать `git checkout` посреди процесса и записать план/состояние не в ту ветку.
  const driftError = assertTaskBranchPostRun(task, executionRoot);
  if (driftError) return driftError;

  // Единая метка времени: план на диске и поле задачи должны совпадать, иначе
  // клиент увидит расхождение и перечитает данные лишний раз.
  const nowIso = new Date().toISOString();
  // Запись идёт и в файл, и в БД: файл читает runtime/агент, поле plan - UI.
  persistTaskPlanForTask({
    taskId: task.id,
    projectRoot: executionRoot,
    isFix: task.isFix,
    planPath: task.planPath ?? undefined,
    planText: updatedPlan,
    updatedAt: nowIso,
  });

  // Флаг доработки снимается только после успешной записи плана - если бы он
  // сбрасывался раньше, при сбое записи правка потерялась бы бесследно.
  setTaskFields(task.id, {
    reworkRequested: false,
    updatedAt: nowIso,
  });

  const updated = findTaskById(task.id);
  if (!updated) {
    return denied("not_found", "Task not found");
  }

  return { ok: true, task: updated, broadcastType: "task:updated" };
}

/**
 * Обычный переход статуса (approve_done, start_ai и прочие) без обращения к runtime.
 * Синхронный по той же причине: здесь только БД и файловые операции удаления плана.
 */
function handleRegularTransition(input: ApplyTaskEventInput): ApplyTaskEventResult {
  const task = findTaskById(input.taskId);
  if (!task) {
    return denied("not_found", "Task not found");
  }
  // План удаляется только на терминальных/стартовых переходах и только по явному
  // флагу роута: сам обработчик не решает, нужна ли ещё плановая информация.
  if ((input.event === "approve_done" || input.event === "start_ai") && input.deletePlanFile) {
    const project = findProjectById(task.projectId);
    if (!project) {
      return denied("not_found", "Project not found for task");
    }
    const executionRoot = taskExecutionRoot({
      worktreePath: task.worktreePath,
      rootPath: project.rootPath,
    });

    const branchError = restoreTaskBranchForMutation(task, executionRoot);
    if (branchError) return branchError;

    // Для fix-задач всегда удаляем канонический FIX_PLAN.md.
    // Для обычных задач используем настроенный planPath (дефолты из config.yaml).
    const cfg = getProjectConfig(executionRoot);
    // Путь разворачивается в абсолютный и берётся из конфига проекта, чтобы
    // удалялся ровно тот файл, который читал runtime.
    const planFilePath = task.isFix
      ? resolve(executionRoot, cfg.paths.fix_plan)
      : resolve(executionRoot, task.planPath || cfg.paths.plan);

    // Отсутствие файла не ошибка: задача могла быть переведена после ручного удаления.
    if (existsSync(planFilePath)) {
      unlinkSync(planFilePath);
    }
  }

  // expectedStatus передаётся как optimistic-lock: статус мог измениться между
  // чтением задачи выше и этой записью, и переход должен упасть, а не перезаписать его.
  const transition = applyTaskAction({
    taskId: task.id,
    event: input.event,
    participantsModeEnabled: input.participantsModeEnabled ?? false,
    actor: input.actor ?? {
      kind: "anonymous",
      id: null,
      displayNameSnapshot: null,
    },
    participantRole: input.participantRole,
    participantActive: input.participantActive,
    expectedStatus: task.status,
  });
  // Отказ авторизации отделён от конфликта статуса: маршрут различает
  // "нет прав" (403) и "сейчас так нельзя" (409) по коду в адаптере.
  if (!transition.ok) {
    return {
      ok: false,
      code: transition.code,
      error: transition.message,
    };
  }

  const updated = findTaskById(task.id);
  if (!updated) {
    return denied("not_found", "Task not found");
  }

  return { ok: true, task: updated, broadcastType: "task:moved" };
}

log.debug({ useCase: "applyTaskEvent", init: true }, "Task event use case initialized");

/**
 * Единственная публичная точка входа use case. Порядок шагов значим: сначала
 * авторизация (когда включён participants mode), только потом мутация - иначе
 * неавторизованный вызов мог бы успеть удалить план или запустить runtime.
 */
export async function applyTaskEvent(input: ApplyTaskEventInput): Promise<ApplyTaskEventResult> {
  log.debug({ useCase: "applyTaskEvent", taskId: input.taskId }, "use case entry");
  try {
    // Режим участников выключен - проверка пропускается целиком, включая чтение
    // задачи: в однопользовательском режиме лишний запрос к БД не нужен.
    if (input.participantsModeEnabled) {
      const task = findTaskById(input.taskId);
      if (!task) {
        return denied("not_found", "Task not found");
      }
      // В снапшот попадают только поля, влияющие на решение о переходе. Читать всю
      // задачу нельзя: правило доступа не должно зависеть от содержимого описания.
      const authorization = resolveTaskAction(
        {
          id: task.id,
          status: task.status,
          autoMode: task.autoMode,
          executionOwner: task.executionOwner,
          assignees: task.assignees,
          blockedFromStatus: task.blockedFromStatus,
          skipReview: task.skipReview,
          runPostVerify: task.runPostVerify,
        },
        input.event,
        {
          participantsModeEnabled: true,
          actor: input.actor ?? {
            kind: "anonymous",
            id: null,
            displayNameSnapshot: null,
          },
          participantRole: input.participantRole,
          participantActive: input.participantActive,
        },
      );
      if (!authorization.ok) {
        return {
          ok: false,
          code: authorization.code,
          error: authorization.error,
        };
      }
    }
    // fast_fix обрабатывается отдельно и асинхронно (он ходит в runtime),
    // все остальные события - синхронный переход статуса.
    const result =
      input.event === "fast_fix" ? await handleFastFix(input) : handleRegularTransition(input);
    log.debug(
      { useCase: "applyTaskEvent", taskId: input.taskId, outcome: result.ok ? "ok" : "denied" },
      "use case exit",
    );
    return result;
    // Наружу пропускаются только известные ошибки: AiHandoffRequiredError имеет свой
    // код для клиента, всё остальное перебрасывается, чтобы не подменять причину сбоя.
  } catch (error) {
    if (error instanceof AiHandoffRequiredError) {
      log.debug(
        { useCase: "applyTaskEvent", taskId: input.taskId, outcome: "denied", code: error.code },
        "use case exit",
      );
      return {
        ok: false,
        code: error.code,
        error: error.message,
      };
    }
    throw error;
  }
}
