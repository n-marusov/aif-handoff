/**
 * Владение задачей (ownership) и его передача.
 *
 * Здесь сосредоточены операции, меняющие принадлежность задачи: атомарный
 * handoff между участником-человеком и AI-исполнителем, назначение
 * исполнителей и ведение истории исполнителей.
 *
 * Пакет @aif/data - единственный разрешённый слой доступа к SQLite для
 * пакетов api/agent/runtime: прямой импорт drizzle из других пакетов
 * запрещён правилами ESLint, поэтому вся работа с БД инкапсулирована здесь.
 *
 * Инварианты, которые защищает модуль:
 * - перед изменением вызывающая сторона подтверждает ожидаемую ревизию
 *   владения (оптимистичная проверка вместо блокировки строки);
 * - чужую задачу изменить нельзя, а каждая передача владения оставляет
 *   снимок состояния в журнале истории исполнителей и в аудите;
 * - все мутации идут в одной транзакции, поэтому частично применённое
 *   владение невозможно.
 */
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  auditEvents,
  logger,
  participants,
  taskAssignments,
  taskExecutorHistory,
  tasks,
  type AuditActor,
  type ExecutionOwner,
  type TaskAssigneeSummary,
  type TaskExecutorHistoryEntry,
  type TaskOwnership,
  type TaskEvent,
  type TaskStatus,
} from "@aif/shared";
import { getDb } from "./db.js";
import { createAuditEventValues } from "./audit.js";

const log = logger("data:task-ownership");

// Фильтры выборки задач по признакам владения. Применяются при построении
// SQL-условий в buildTaskOwnershipConditions; все поля необязательны, поэтому
// фильтрация комбинируется по принципу "учитывать только заданное".
export interface TaskOwnershipFilters {
  executionOwner?: ExecutionOwner;
  assigneeId?: string;
  currentParticipantId?: string;
  unassigned?: boolean;
}

// Входные данные для передачи владения. Поля с префиксом expected - это
// условие оптимистичной блокировки: вызывающая сторона фиксирует состояние,
// которое она видела при чтении, и handoff выполняется только если оно не
// изменилось. Так два параллельных запроса не могут молча перезаписать друг
// друга. Поля resumeAction и allowLockedBy нужны для возобновления работы:
// первое разрешает выход из plan_review/blocked_external по конкретному
// действию, второе позволяет владельцу текущей блокировки продолжить работу.
// now подставляется в тестах для детерминированной метки времени.
export interface HandoffTaskExecutionInput {
  taskId: string;
  executionOwner: ExecutionOwner;
  assigneeIds?: string[];
  expectedOwnershipRevision: number;
  expectedExecutionOwner?: ExecutionOwner;
  expectedStatus?: TaskStatus;
  actor: AuditActor;
  reason?: string | null;
  resumeAction?: TaskEvent;
  allowLockedBy?: string;
  now?: Date;
}

// Структурный набор причин отказа. Вызывающая сторона ветвится по коду, а не
// по тексту сообщения: сообщения предназначены только для логов и
// диагностики.
export type HandoffTaskExecutionConflictCode =
  | "not_found"
  | "locked"
  | "revision_conflict"
  | "inactive_assignee"
  | "invalid_transition";

// Результат без исключений: конфликты здесь ожидаемы, поэтому возвращаются
// как ok: false вместе с текущим снимком владения, чтобы UI или агент мог
// показать актуальное состояние и предложить повторить операцию.
export type HandoffTaskExecutionResult =
  | {
      ok: true;
      ownership: TaskOwnership;
      history: TaskExecutorHistoryEntry;
    }
  | {
      ok: false;
      code: HandoffTaskExecutionConflictCode;
      ownership?: TaskOwnership;
    };

// Карта taskId -> список назначенных участников: позволяет гидратировать
// назначения для списка задач одним запросом вместо N+1 обращений к БД.
type AssigneeMap = Map<string, TaskAssigneeSummary[]>;

// Разбор JSON-снимка исполнителей из истории. Данные приходят из БД и
// считаются недоверенными: повреждённый или устаревший JSON не должен ломать
// выдачу истории, поэтому ошибка разбора приводит к пустому списку, а каждый
// элемент дополнительно валидируется по структуре.
function parseHistoryAssignees(raw: string): TaskAssigneeSummary[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is TaskAssigneeSummary => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const candidate = value as Partial<TaskAssigneeSummary>;
      return (
        typeof candidate.participantId === "string" &&
        typeof candidate.displayName === "string" &&
        (candidate.role === "admin" || candidate.role === "member") &&
        typeof candidate.active === "boolean"
      );
    });
  } catch {
    return [];
  }
}

// Преобразование строки БД в доменную запись истории: наружу отдаём только
// публичные поля и распарсенный снимок исполнителей, не раскрывая строение
// таблицы.
function toHistoryEntry(
  row: typeof taskExecutorHistory.$inferSelect,
): TaskExecutorHistoryEntry {
  return {
    id: row.id,
    taskId: row.taskId,
    taskTitleSnapshot: row.taskTitleSnapshot,
    ownershipRevision: row.ownershipRevision,
    executionOwner: row.executionOwner,
    assignees: parseHistoryAssignees(row.assigneesSnapshotJson),
    statusSnapshot: row.statusSnapshot,
    actor: {
      kind: row.actorKind,
      id: row.actorId,
      displayNameSnapshot: row.actorDisplayNameSnapshot,
    },
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

// Сравнение по множеству идентификаторов, а не по порядку: порядок выдачи
// стабилизирован сортировкой в запросах, но бизнес-логика не должна на него
// полагаться, поэтому сравниваются отсортированные наборы.
function sameAssignees(current: TaskAssigneeSummary[], requested: TaskAssigneeSummary[]): boolean {
  if (current.length !== requested.length) return false;
  const currentIds = current.map((assignee) => assignee.participantId).sort();
  const requestedIds = requested.map((assignee) => assignee.participantId).sort();
  return currentIds.every((participantId, index) => participantId === requestedIds[index]);
}

// Блокировка считается активной, если её выставил кто-то другой и срок ещё
// не истёк. Параметр allowLockedBy позволяет владельцу блокировки продолжить
// работу: он передаётся тем же актором, который ранее захватил задачу.
function hasLiveTaskLock(
  task: { lockedBy: string | null; lockedUntil: string | null },
  nowIso: string,
  allowLockedBy?: string,
): boolean {
  return Boolean(
    task.lockedBy &&
    task.lockedBy !== allowLockedBy &&
    (!task.lockedUntil || task.lockedUntil > nowIso),
  );
}

// Сборка условий WHERE для выборок по владению. Заданные условия возвращаются
// в массиве, а отсутствующие отбрасываются, поэтому один построитель
// обслуживает разные комбинации фильтров без дублирования SQL. Участие
// человека проверяется через EXISTS по таблице назначений, так как назначения
// хранятся отдельными строками связи (many-to-many).
export function buildTaskOwnershipConditions(filters: TaskOwnershipFilters) {
  const participantId = filters.currentParticipantId ?? filters.assigneeId;
  return [
    filters.executionOwner
      ? eq(tasks.executionOwner, filters.executionOwner)
      : undefined,
    participantId
      ? sql`exists (
          select 1
          from ${taskAssignments}
          where ${taskAssignments.taskId} = ${tasks.id}
            and ${taskAssignments.participantId} = ${participantId}
        )`
      : undefined,
    filters.unassigned
      ? sql`not exists (
          select 1
          from ${taskAssignments}
          where ${taskAssignments.taskId} = ${tasks.id}
        )`
      : undefined,
  ].filter((condition) => condition !== undefined);
}

// Пакетная гидратация назначений. Все запрошенные задачи заранее попадают в
// результат с пустым массивом, поэтому вызывающей стороне не нужны проверки
// на отсутствие ключа. Порядок сортировки детерминирован (имя, затем id),
// чтобы снимки истории и аудита были воспроизводимы.
export function listTaskAssigneesByTaskIds(taskIds: string[]): AssigneeMap {
  const uniqueTaskIds = [...new Set(taskIds)];
  const result: AssigneeMap = new Map(uniqueTaskIds.map((taskId) => [taskId, []]));
  if (uniqueTaskIds.length === 0) return result;

  const rows = getDb()
    .select({
      taskId: taskAssignments.taskId,
      participantId: participants.id,
      displayName: participants.displayName,
      role: participants.role,
      active: participants.active,
    })
    .from(taskAssignments)
    .innerJoin(participants, eq(taskAssignments.participantId, participants.id))
    .where(inArray(taskAssignments.taskId, uniqueTaskIds))
    .orderBy(
      asc(taskAssignments.taskId),
      asc(participants.displayName),
      asc(participants.id),
    )
    .all();

  for (const row of rows) {
    result.get(row.taskId)?.push({
      participantId: row.participantId,
      displayName: row.displayName,
      role: row.role,
      active: row.active,
    });
  }
  log.debug(
    { taskCount: uniqueTaskIds.length, assignmentCount: rows.length },
    "Hydrated task assignees",
  );
  return result;
}

// Текущее владение задачей: исполнитель, ревизия и список назначенных
// участников. Для несуществующей задачи возвращается null, чтобы вызывающая
// сторона различала "нет задачи" и "нет владельца".
export function getTaskOwnership(taskId: string): TaskOwnership | null {
  const task = getDb()
    .select({
      executionOwner: tasks.executionOwner,
      ownershipRevision: tasks.ownershipRevision,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!task) return null;
  return {
    ...task,
    assignees: listTaskAssigneesByTaskIds([taskId]).get(taskId) ?? [],
  };
}

// История исполнителей читается в порядке роста ревизии: это хронологическая
// лента смены владения, по которой восстанавливается, кто и когда владел
// задачей. Сортировка по createdAt и id даёт устойчивый порядок при
// совпадающих ревизиях.
export function listTaskExecutorHistory(taskId: string): TaskExecutorHistoryEntry[] {
  const rows = getDb()
    .select()
    .from(taskExecutorHistory)
    .where(eq(taskExecutorHistory.taskId, taskId))
    .orderBy(
      asc(taskExecutorHistory.ownershipRevision),
      asc(taskExecutorHistory.createdAt),
      asc(taskExecutorHistory.id),
    )
    .all();
  log.debug({ taskId, count: rows.length }, "Listed task executor history");
  return rows.map(toHistoryEntry);
}

/**
 * Атомарная передача владения задачей (handoff).
 *
 * Вся операция выполняется в одной транзакции SQLite: проверки, обновление
 * задачи, замена назначений, запись истории исполнителей и события аудита
 * фиксируются вместе. Если на любом шаге обнаруживается конфликт, возвращается
 * ok: false и частичных изменений не остаётся.
 *
 * Порядок проверок намеренно идёт от самого дешёвого к самому дорогому:
 * существование задачи, активная блокировка, совпадение ожидаемой ревизии,
 * допустимость перехода, корректность назначаемых участников и, наконец,
 * осмысленность операции. Случай "ничего не меняется" отсекается отдельно,
 * чтобы не плодить лишние ревизии и записи в истории.
 *
 * Конкурентный доступ закрывается на двух уровнях: предварительная сверка
 * ревизии даёт понятный код ошибки, а условие в самом UPDATE гарантирует, что
 * между проверкой и записью никто не успел изменить задачу.
 */
export function handoffTaskExecution(
  input: HandoffTaskExecutionInput,
): HandoffTaskExecutionResult {
  const db = getDb();
  // Единая метка времени на всю транзакцию: задача, назначения, история и аудит
  // должны иметь согласованное время, иначе хронология расходится при
  // сопоставлении снимков.
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  // Дубликаты идентификаторов убираем сразу: повтор одного участника создал бы
  // дублирующие строки назначений и сломал сравнение наборов.
  const requestedAssigneeIds = [...new Set(input.assigneeIds ?? [])];
  // Пишем параметры запроса до транзакции: если handoff упадёт, в логах
  // останется то, что именно пытались передать.
  log.debug(
    {
      taskId: input.taskId,
      executionOwner: input.executionOwner,
      assigneeCount: requestedAssigneeIds.length,
      expectedOwnershipRevision: input.expectedOwnershipRevision,
      expectedExecutionOwner: input.expectedExecutionOwner ?? null,
      expectedStatus: input.expectedStatus ?? null,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
    },
    "Evaluating task execution handoff",
  );

  // Транзакция охватывает и проверки, и мутации: решение принимается по тому
  // же согласованному снимку данных, по которому выполняется запись.
  try {
    return db.transaction((tx) => {
      // Читаем задачу внутри транзакции, а не до неё: внешнее чтение могло бы
      // устареть к моменту записи.
      const task = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
      // Отсутствие задачи - не исключение, а штатный исход: возвращаем код, по
      // которому вызывающая сторона отличит "нет задачи" от конфликта.
      if (!task) {
        log.warn({ taskId: input.taskId, code: "not_found" }, "Task handoff rejected");
        return { ok: false, code: "not_found" } as const;
      }

      // Текущие назначения нужны и для проверок, и для снимка владения в ответе
      // при отказе, чтобы клиент мог показать актуальное состояние.
      const currentAssignees = tx
        .select({
          participantId: participants.id,
          displayName: participants.displayName,
          role: participants.role,
          active: participants.active,
        })
        .from(taskAssignments)
        .innerJoin(participants, eq(taskAssignments.participantId, participants.id))
        .where(eq(taskAssignments.taskId, task.id))
        .orderBy(asc(participants.displayName), asc(participants.id))
        .all();
      const currentOwnership: TaskOwnership = {
        executionOwner: task.executionOwner,
        ownershipRevision: task.ownershipRevision,
        assignees: currentAssignees,
      };
      // Блокировку проверяем раньше всего остального: если задачу уже ведёт
      // другой процесс, остальные проверки смысла не имеют, а сообщение о
      // конфликте должно быть максимально точным.
      const hasLiveLock = hasLiveTaskLock(task, nowIso, input.allowLockedBy);
      if (hasLiveLock) {
        log.warn(
          {
            taskId: task.id,
            code: "locked",
            lockedBy: task.lockedBy,
            lockedUntil: task.lockedUntil,
          },
          "Task handoff rejected",
        );
        return { ok: false, code: "locked", ownership: currentOwnership } as const;
      }

      // Оптимистичная проверка: сверяем состояние, которое вызывающая сторона
      // видела при чтении, с текущим. Несовпадение означает, что параллельный
      // запрос уже изменил задачу, и нашу запись применять нельзя.
      const revisionMismatch =
        task.ownershipRevision !== input.expectedOwnershipRevision;
      const ownerMismatch =
        input.expectedExecutionOwner !== undefined &&
        task.executionOwner !== input.expectedExecutionOwner;
      const statusMismatch =
        input.expectedStatus !== undefined && task.status !== input.expectedStatus;
      if (revisionMismatch || ownerMismatch || statusMismatch) {
        log.warn(
          {
            taskId: task.id,
            code: "revision_conflict",
            expectedOwnershipRevision: input.expectedOwnershipRevision,
            actualOwnershipRevision: task.ownershipRevision,
            expectedExecutionOwner: input.expectedExecutionOwner ?? null,
            actualExecutionOwner: task.executionOwner,
            expectedStatus: input.expectedStatus ?? null,
            actualStatus: task.status,
          },
          "Task handoff rejected",
        );
        return {
          ok: false,
          code: "revision_conflict",
          ownership: currentOwnership,
        } as const;
      }

      // Допустимость перехода. Каждое условие отсекает ситуацию, в которой
      // смена исполнителя противоречит жизненному циклу задачи: завершённую
      // задачу не возвращаем в работу, AI не получает персональных
      // исполнителей, а выход из plan_review и blocked_external требует явного
      // действия возобновления.
      if (
        task.status === "accepted" ||
        (input.executionOwner === "ai" && requestedAssigneeIds.length > 0) ||
        (task.executionOwner === "human" &&
          input.executionOwner === "ai" &&
          task.status === "plan_review" &&
          !task.autoMode &&
          input.resumeAction !== "start_implementation") ||
        (task.executionOwner === "human" &&
          input.executionOwner === "ai" &&
          task.status === "blocked_external" &&
          (input.resumeAction !== "retry_from_blocked" || !task.blockedFromStatus))
      ) {
        log.warn(
          { taskId: task.id, code: "invalid_transition", status: task.status },
          "Task handoff rejected",
        );
        return {
          ok: false,
          code: "invalid_transition",
          ownership: currentOwnership,
        } as const;
      }

      // Назначаемых участников перечитываем из БД, а не доверяем данным
      // клиента: так подтверждается, что все они существуют и активны.
      const requestedAssignees =
        requestedAssigneeIds.length === 0
          ? []
          : tx
              .select({
                participantId: participants.id,
                displayName: participants.displayName,
                role: participants.role,
                active: participants.active,
              })
              .from(participants)
              .where(inArray(participants.id, requestedAssigneeIds))
              .orderBy(asc(participants.displayName), asc(participants.id))
              .all();
      // Расхождение количества отсекает несуществующие id, проверка active -
      // деактивированных участников. Передать задачу неактивному нельзя, иначе
      // она зависнет без исполнителя.
      const hasInactiveOrMissingAssignee =
        requestedAssignees.length !== requestedAssigneeIds.length ||
        requestedAssignees.some((participant) => !participant.active);
      if (hasInactiveOrMissingAssignee) {
        log.warn(
          {
            taskId: task.id,
            code: "inactive_assignee",
            requestedAssigneeCount: requestedAssigneeIds.length,
            activeAssigneeCount: requestedAssignees.filter((assignee) => assignee.active).length,
          },
          "Task handoff rejected",
        );
        return {
          ok: false,
          code: "inactive_assignee",
          ownership: currentOwnership,
        } as const;
      }

      // Операция без фактических изменений отклоняется: иначе ревизия росла бы
      // впустую, а журнал аудита заполнялся бы шумом.
      if (
        task.executionOwner === input.executionOwner &&
        sameAssignees(currentAssignees, requestedAssignees)
      ) {
        log.warn(
          { taskId: task.id, code: "invalid_transition" },
          "Task handoff would not change ownership",
        );
        return {
          ok: false,
          code: "invalid_transition",
          ownership: currentOwnership,
        } as const;
      }

      // Условие блокировки дублируется в самом UPDATE. Это ключевая часть
      // защиты от гонок: даже если проверка выше прошла, запись выполнится
      // только когда блокировка действительно свободна.
      const lockAvailable = input.allowLockedBy
        ? or(
            isNull(tasks.lockedBy),
            lte(tasks.lockedUntil, nowIso),
            eq(tasks.lockedBy, input.allowLockedBy),
          )
        : or(isNull(tasks.lockedBy), lte(tasks.lockedUntil, nowIso));
      const updated = tx
        .update(tasks)
        // Ревизия увеличивается атомарно в SQL, а не вычисляется в приложении: инкремент
        // на стороне базы исключает потерю обновлений при параллельных передачах владения.
        .set({
          executionOwner: input.executionOwner,
          ownershipRevision: sql`${tasks.ownershipRevision} + 1`,
          // Возврат задачи от человека к AI переводит её в рабочее состояние и
          // сбрасывает сопутствующие поля прогресса, чтобы агент начинал с
          // чистого листа, а не с остатков предыдущего прогона.
          ...(task.executionOwner === "human" &&
          input.executionOwner === "ai" &&
          task.status === "backlog"
            ? {
                status: "planning" as const,
                blockedReason: null,
                blockedFromStatus: null,
                retryAfter: null,
                retryCount: 0,
                reworkRequested: false,
                reviewIterationCount: 0,
                manualReviewRequired: false,
                autoReviewStateJson: null,
                scheduledAt: null,
              }
            : {}),
          ...(task.executionOwner === "human" &&
          input.executionOwner === "ai" &&
          task.status === "plan_review" &&
          !task.autoMode &&
          input.resumeAction === "start_implementation"
            ? {
                status: "implementing" as const,
                blockedReason: null,
                blockedFromStatus: null,
                retryAfter: null,
                retryCount: 0,
                reworkRequested: false,
                reviewIterationCount: 0,
                manualReviewRequired: false,
                autoReviewStateJson: null,
                scheduledAt: null,
              }
            : {}),
          ...(task.executionOwner === "human" &&
          input.executionOwner === "ai" &&
          task.status === "blocked_external" &&
          input.resumeAction === "retry_from_blocked" &&
          task.blockedFromStatus
            ? {
                status: task.blockedFromStatus,
                blockedReason: null,
                blockedFromStatus: null,
                retryAfter: null,
                retryCount: 0,
                reworkRequested: false,
                reviewIterationCount: 0,
                manualReviewRequired: false,
                autoReviewStateJson: null,
                scheduledAt: null,
              }
            : {}),
          updatedAt: nowIso,
        })
        .where(
          // Ожидаемые ревизия и статус проверяются прямо в условии UPDATE:
          // оптимистичная проверка и запись становятся одной атомарной
          // операцией, поэтому "потерянное обновление" невозможно.
          and(
            eq(tasks.id, task.id),
            eq(tasks.ownershipRevision, input.expectedOwnershipRevision),
            input.expectedExecutionOwner === undefined
              ? undefined
              : eq(tasks.executionOwner, input.expectedExecutionOwner),
            input.expectedStatus === undefined
              ? undefined
              : eq(tasks.status, input.expectedStatus),
            lockAvailable,
          ),
        )
        .returning({
          executionOwner: tasks.executionOwner,
          ownershipRevision: tasks.ownershipRevision,
          status: tasks.status,
        })
        .get();
      // Пустой результат UPDATE означает, что состояние изменилось между
      // проверкой и записью. Уточняем причину по свежим данным, чтобы вернуть
      // наиболее информативный код конфликта.
      if (!updated) {
        const racedTask = tx
          .select({ lockedBy: tasks.lockedBy, lockedUntil: tasks.lockedUntil })
          .from(tasks)
          .where(eq(tasks.id, task.id))
          .get();
        const code =
          racedTask && hasLiveTaskLock(racedTask, nowIso, input.allowLockedBy)
            ? "locked"
            : "revision_conflict";
        log.warn(
          { taskId: task.id, code, lockedBy: racedTask?.lockedBy ?? null },
          "Task handoff lost atomic update race",
        );
        return {
          ok: false,
          code,
          ownership: currentOwnership,
        } as const;
      }

      // Назначения заменяются целиком: сначала удаляются прежние строки, затем
      // вставляются новые. Поэтому состояние назначений всегда соответствует
      // последнему снимку владения и не накапливает устаревшие связи.
      tx.delete(taskAssignments).where(eq(taskAssignments.taskId, task.id)).run();
      if (input.executionOwner === "human" && requestedAssignees.length > 0) {
        tx.insert(taskAssignments)
          .values(
            requestedAssignees.map((assignee) => ({
              taskId: task.id,
              participantId: assignee.participantId,
              assignedByKind: input.actor.kind,
              assignedById: input.actor.id,
              assignedByDisplayNameSnapshot: input.actor.displayNameSnapshot,
              createdAt: nowIso,
            })),
          )
          .run();
      }

      const ownership: TaskOwnership = {
        executionOwner: updated.executionOwner,
        ownershipRevision: updated.ownershipRevision,
        assignees: input.executionOwner === "human" ? requestedAssignees : [],
      };
      // Снимок в истории исполнителей фиксируется в той же транзакции, что и
      // само изменение, поэтому аудит не может разойтись с фактическим
      // состоянием. Заголовок и статус сохраняются как снимок: история
      // остаётся читаемой даже после переименования задачи или удаления
      // участника.
      const historyRow = tx
        .insert(taskExecutorHistory)
        .values({
          id: crypto.randomUUID(),
          taskId: task.id,
          taskTitleSnapshot: task.title,
          ownershipRevision: ownership.ownershipRevision,
          executionOwner: ownership.executionOwner,
          assigneesSnapshotJson: JSON.stringify(ownership.assignees),
          statusSnapshot: updated.status,
          actorKind: input.actor.kind,
          actorId: input.actor.id,
          actorDisplayNameSnapshot: input.actor.displayNameSnapshot,
          reason: input.reason ?? null,
          createdAt: nowIso,
        })
        .returning()
        .get();
      // Событие аудита хранит и предыдущее, и новое состояние: по нему можно
      // восстановить, из какого статуса и владения задача перешла в текущее.
      tx.insert(auditEvents)
        .values(
          createAuditEventValues({
            action: "task.execution_handoff",
            entityType: "task",
            entityId: task.id,
            taskId: task.id,
            taskTitleSnapshot: task.title,
            executionOwnerSnapshot: ownership.executionOwner,
            assigneesSnapshot: ownership.assignees,
            statusSnapshot: updated.status,
            actor: input.actor,
            reason: input.reason ?? null,
            metadata: {
              previousExecutionOwner: task.executionOwner,
              previousOwnershipRevision: task.ownershipRevision,
              previousStatus: task.status,
              ownershipRevision: ownership.ownershipRevision,
              status: updated.status,
            },
            createdAt: nowIso,
          }),
        )
        .run();
      // Успех логируем после фиксации результата, уже с новой ревизией и
      // составом исполнителей.
      log.info(
        {
          taskId: task.id,
          executionOwner: ownership.executionOwner,
          ownershipRevision: ownership.ownershipRevision,
          assigneeCount: ownership.assignees.length,
          status: updated.status,
        },
        "Task execution handoff completed",
      );
      // ok: true возвращается вместе с записью истории, чтобы вызывающая сторона
      // не делала повторный запрос за тем, что и так известно.
      return {
        ok: true,
        ownership,
        history: toHistoryEntry(historyRow),
      } as const;
    });
    // Ошибки инфраструктуры (например, сбой БД) не превращаем в бизнес-код:
    // транзакция уже откатилась, а исключение должен увидеть вызывающий.
  } catch (error) {
    log.error(
      {
        error,
        taskId: input.taskId,
        expectedOwnershipRevision: input.expectedOwnershipRevision,
      },
      "Task execution handoff transaction failed",
    );
    throw error;
  }
}
