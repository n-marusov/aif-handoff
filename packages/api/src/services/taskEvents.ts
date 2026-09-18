/**
 * Обработка событий задачи на уровне API: входящее событие превращается в мутацию
 * состояния и в payload для broadcast, либо в структурированную ошибку.
 *
 * Почему файл устроен именно так:
 *  - прямых обращений к БД здесь нет, только через @aif/data: инварианты статусов
 *    и авторизации живут в одном слое, а этот модуль остаётся тонким адаптером;
 *  - перед любой мутацией сначала восстанавливается persisted-ветка задачи: неверная
 *    ветка означает запись плана не туда, поэтому это 409, а не тихое продолжение;
 *  - все ветки возвращают discriminated union EventHandlerResult, чтобы роут не ловил
 *    исключения и не угадывал HTTP-код по тексту ошибки;
 *  - fast_fix вынесен в отдельный async-путь: он ходит в runtime, может падать по
 *    таймауту и требует двух попыток с валидацией полноты плана.
 */
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertCurrentBranch,
  isBranchIsolationError,
  looksLikeFullPlanUpdate,
  getProjectConfig,
  resolveTaskAction,
  restorePersistedBranch,
  type AuditActor,
  type ParticipantRole,
  type TaskEvent,
} from "@aif/shared";
import {
  applyTaskAction,
  findProjectById,
  findTaskById,
  getLatestHumanComment,
  persistTaskPlanForTask,
  setTaskFields,
  type TaskRow,
} from "@aif/data";
import { AiHandoffRequiredError, runFastFixQuery, withTimeout } from "./fastFix.js";

/**
 * Вход обработчика: событие плюс actor/role-контекст. Поля участников опциональны,
 * потому что обработчик используется и при выключенном participants mode.
 */
interface EventHandlerInput {
  taskId: string;
  event: TaskEvent;
  deletePlanFile?: boolean;
  participantsModeEnabled?: boolean;
  actor?: AuditActor;
  participantRole?: ParticipantRole | null;
  participantActive?: boolean;
}

/**
 * Результат обработчика: либо ошибка с уже готовым HTTP-статусом, либо задача для
 * broadcast. Тип broadcast зашит здесь, а не в роуте, чтобы клиент не пересчитывал
 * его сам и не расходился с тем, что реально произошло.
 */
export type EventHandlerResult =
  | { ok: false; status: number; error: string; code?: string }
  | { ok: true; task: TaskRow; broadcastType: "task:moved" | "task:updated" };

/**
 * Вернуть рабочее дерево на persisted-ветку задачи перед записью. null означает
 * "проверка не нужна или прошла"; при сбое возвращается готовый 409-результат.
 */
function restoreTaskBranchForMutation(
  task: TaskRow,
  projectRoot: string,
): EventHandlerResult | null {
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
    return { ok: false, status: 409, error };
  }
}

/**
 * Проверка дрейфа ПОСЛЕ дочернего прогона: runtime мог сам переключить ветку,
 * поэтому совпадение проверяется повторно, а не только на входе.
 */
function assertTaskBranchPostRun(task: TaskRow, projectRoot: string): EventHandlerResult | null {
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
    return { ok: false, status: 409, error };
  }
}

/**
 * Fast fix - правка уже существующего плана по последнему человеческому комментарию.
 * Путь намеренно длинный: он пишет в файловую систему через runtime, поэтому вокруг
 * прогона стоят проверки ветки, а результат валидируется на полноту плана.
 */
async function handleFastFix(input: EventHandlerInput): Promise<EventHandlerResult> {
  const task = findTaskById(input.taskId);
  if (!task) {
    return { ok: false, status: 404, error: "Task not found" };
  }
  // Задача у человека - автоматический прогон запрещён: сначала нужен явный handoff,
  // иначе агент перепишет план, который человек в этот момент правит вручную.
  if (task.executionOwner !== "ai") {
    return {
      ok: false,
      status: 409,
      code: "ai_handoff_required",
      error: "The task must be handed to AI before fast fix can run",
    };
  }
  // Только plan_review: fast fix имеет смысл для комментария к плану, а не к реализации.
  if (task.status !== "plan_review") {
    return {
      ok: false,
      status: 409,
      error: "fast_fix is only allowed from plan_review",
    };
  }
  // В autoMode координатор сам применяет правки, ручной fast fix создал бы гонку за план.
  if (task.autoMode) {
    return { ok: false, status: 409, error: "fast_fix is not needed when autoMode=true" };
  }

  // Источник требования - именно комментарий человека; комментарии агентов не годятся,
  // иначе фикс запускался бы по собственной формулировке агента.
  const latestComment = getLatestHumanComment(task.id);
  if (!latestComment) {
    return {
      ok: false,
      status: 409,
      error: "fast_fix requires a human comment with requested fix",
    };
  }

  // Корень нужен до ветки: у задачи может не быть worktree, тогда всё считается
  // относительно корня проекта.
  const project = findProjectById(task.projectId);
  if (!project) {
    return { ok: false, status: 404, error: "Project not found for task" };
  }
  const executionRoot = task.worktreePath ?? project.rootPath;

  const branchError = restoreTaskBranchForMutation(task, executionRoot);
  if (branchError) return branchError;

  // Предыдущий план передаётся в модель как база: правка должна быть дельтой,
  // а пустой план означает, что исправлять нечего.
  const previousPlan = task.plan?.trim() ?? "";
  if (!previousPlan) {
    return { ok: false, status: 409, error: "fast_fix requires an existing plan on the task" };
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
    return {
      ok: false,
      status: 500,
      error: "Fast fix result omitted existing plan content. Plan was left unchanged.",
    };
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
    return { ok: false, status: 404, error: "Task not found" };
  }

  return { ok: true, task: updated, broadcastType: "task:updated" };
}

/**
 * Обычный переход статуса (approve_done, start_ai и прочие) без обращения к runtime.
 * Синхронный по той же причине: здесь только БД и файловые операции удаления плана.
 */
function handleRegularTransition(input: EventHandlerInput): EventHandlerResult {
  const task = findTaskById(input.taskId);
  if (!task) {
    return { ok: false, status: 404, error: "Task not found" };
  }
  // План удаляется только на терминальных/стартовых переходах и только по явному
  // флагу роута: сам обработчик не решает, нужна ли ещё плановая информация.
  if ((input.event === "approve_done" || input.event === "start_ai") && input.deletePlanFile) {
    const project = findProjectById(task.projectId);
    if (!project) {
      return { ok: false, status: 404, error: "Project not found for task" };
    }
    const executionRoot = task.worktreePath ?? project.rootPath;

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
  // Отказ авторизации отделён от конфликта статуса: клиенту важно различать
  // "нет прав" (403) и "сейчас так нельзя" (409), чтобы показать разные подсказки.
  if (!transition.ok) {
    const authorizationDenied =
      transition.code === "actor_not_authorized" || transition.code === "assignment_required";
    return {
      ok: false,
      status: transition.code === "not_found" ? 404 : authorizationDenied ? 403 : 409,
      code: transition.code,
      error: transition.message,
    };
  }

  const updated = findTaskById(task.id);
  if (!updated) {
    return { ok: false, status: 404, error: "Task not found" };
  }

  return { ok: true, task: updated, broadcastType: "task:moved" };
}

/**
 * Единственная публичная точка входа модуля. Порядок шагов значим: сначала
 * авторизация (когда включён participants mode), только потом мутация - иначе
 * неавторизованный вызов мог бы успеть удалить план или запустить runtime.
 */
export async function handleTaskEvent(input: EventHandlerInput): Promise<EventHandlerResult> {
  try {
    // Режим участников выключен - проверка пропускается целиком, включая чтение
    // задачи: в однопользовательском режиме лишний запрос к БД не нужен.
    if (input.participantsModeEnabled) {
      const task = findTaskById(input.taskId);
      if (!task) {
        return { ok: false, status: 404, error: "Task not found", code: "not_found" };
      }
      // В снапшот попадают только поля, влияющие на решение о переходе. Читать всю
      // задачу нельзя: правило доступа не должно зависеть от содержимого описания.
      const authorization = resolveTaskAction(
        {
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
        const authorizationDenied =
          authorization.code === "actor_not_authorized" ||
          authorization.code === "assignment_required";
        return {
          ok: false,
          status: authorizationDenied ? 403 : 409,
          code: authorization.code,
          error: authorization.error,
        };
      }
    }
    // fast_fix обрабатывается отдельно и асинхронно (он ходит в runtime),
    // все остальные события - синхронный переход статуса.
    if (input.event === "fast_fix") {
      return await handleFastFix(input);
    }
    return handleRegularTransition(input);
    // Наружу пропускаются только известные ошибки: AiHandoffRequiredError имеет свой
    // код для клиента, всё остальное перебрасывается, чтобы не подменять причину сбоя.
  } catch (error) {
    if (error instanceof AiHandoffRequiredError) {
      return {
        ok: false,
        status: 409,
        code: error.code,
        error: error.message,
      };
    }
    throw error;
  }
}
