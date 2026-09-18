/**
 * Участники: учётные записи, роли и админские инварианты.
 *
 * Здесь собраны операции жизненного цикла участника: создание и обновление,
 * деактивация, смена и сброс пароля. Главный инвариант - в системе всегда остаётся
 * хотя бы один активный администратор; попытка нарушить его отклоняется отдельным
 * структурированным кодом отказа, а не общей ошибкой.
 *
 * Строки участников не удаляются физически: деактивация проставляет признак и время,
 * поэтому история задач и журнал аудита продолжают ссылаться на существующие записи.
 */
import { and, asc, count, eq, isNull, ne, sql } from "drizzle-orm";
import {
  auditEvents,
  logger,
  participantSessions,
  participants,
  taskAssignments,
  taskExecutorHistory,
  tasks,
  type AuditActor,
  type CreateParticipantInput,
  type Participant,
  type TaskAssigneeSummary,
  type UpdateParticipantInput,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { createAuditEventValues } from "./audit.js";
import {
  hashParticipantPassword,
  normalizeParticipantUsername,
  verifyParticipantPasswordOrDummy,
} from "./authSessions.js";

// Логгер с областью видимости пакета: префикс data:participants отделяет
// события репозитория участников от прочих записей слоя данных.
const log = logger("data:participants");
// Системный актор-заглушка для вызовов без явного пользователя (внутренние
// задачи, миграции). id: null означает, что за действием не стоит конкретный
// участник, поэтому аудит ссылается только на отображаемое имя.
const SYSTEM_ACTOR: AuditActor = {
  kind: "system",
  id: null,
  displayNameSnapshot: "System",
};

// Коды ошибок репозитория — часть контракта для вызывающих пакетов: они не
// раскрывают детали SQL и позволяют API отдать понятное сообщение.
// "final_active_admin" защищает инвариант "в системе есть активный админ".
export type ParticipantRepositoryErrorCode =
  | "not_found"
  | "duplicate_username"
  | "final_active_admin"
  | "inactive_participant"
  | "invalid_current_password"
  | "invalid_input";

// Результат мутации — размеченное объединение: ветка ok: true несёт
// актуальное состояние участника, ветка ok: false — только код причины.
// Такая форма заставляет вызывающий код явно обработать отказ вместо
// проверки исключения или истинности возвращённого значения.
export type ParticipantMutationResult =
  | {
      ok: true;
      participant: Participant;
      // Последствия операции: сколько активных сессий было прервано (смена
      // роли, сброс пароля) и с каких задач снят участник при деактивации.
      // Поля опциональны, потому что каждая операция возвращает свой набор.
      revokedSessionCount?: number;
      affectedTaskIds?: string[];
    }
  | { ok: false; code: ParticipantRepositoryErrorCode };

// SQLite сообщает о конфликте уникальности кодом ошибки драйвера. Проверяем
// структурный код, а не текст сообщения: формулировки меняются между
// версиями, а код стабилен и не зависит от локали.
function isSqliteUniqueConstraint(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE";
}

// Явное отображение строки таблицы в доменный тип. Даже при совпадении имён
// полей такой слой не даёт служебным колонкам (например passwordHash) утечь
// в публичный контракт пакета.
function toParticipant(row: typeof participants.$inferSelect): Participant {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    active: row.active,
    deactivatedAt: row.deactivatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Подсчёт активных администраторов. Соединение или транзакция передаётся
// параметром, потому что функция вызывается внутри мутационных транзакций:
// проверку "последнего админа" нужно делать на том же снимке данных, в
// котором выполняется изменение, иначе проверка окажется вне транзакции.
function countActiveAdmins(
  database: ReturnType<typeof getDb>,
): number {
  const result = database
    .select({ value: count() })
    .from(participants)
    .where(and(eq(participants.active, true), eq(participants.role, "admin")))
    .get();
  // Агрегат count() возвращает строку, но драйвер может отдать undefined на
  // пустом результате — приводим к нулю явно.
  return result?.value ?? 0;
}

// Снимок назначенных участников на момент вызова. Он попадает в аудит и в
// историю исполнителей, поэтому состав фиксируется в определённом порядке:
// снимки должны быть сравнимы между запусками и между ревизиями владения.
function listAssignmentSnapshots(
  database: ReturnType<typeof getDb>,
  taskId: string,
): TaskAssigneeSummary[] {
  return database
    .select({
      participantId: participants.id,
      displayName: participants.displayName,
      role: participants.role,
      active: participants.active,
    })
    .from(taskAssignments)
    .innerJoin(participants, eq(taskAssignments.participantId, participants.id))
    .where(eq(taskAssignments.taskId, taskId))
    .orderBy(asc(participants.displayName), asc(participants.id))
    .all();
}

// Общее число участников, включая деактивированных: используется при
// первичной инициализации, когда нужно решить, создавать ли администратора.
export function countParticipants(): number {
  const result = getDb().select({ value: count() }).from(participants).get();
  return result?.value ?? 0;
}

// По умолчанию возвращаются только активные участники, чтобы выпадающие
// списки в интерфейсе не содержали отключённых. includeInactive нужен
// административным экранам и истории, где архивные записи важны.
export function listParticipants(options: { includeInactive?: boolean } = {}): Participant[] {
  const rows = options.includeInactive
    ? getDb().select().from(participants).orderBy(asc(participants.displayName), asc(participants.id)).all()
    : getDb()
        .select()
        .from(participants)
        .where(eq(participants.active, true))
        .orderBy(asc(participants.displayName), asc(participants.id))
        .all();
  log.debug(
    { includeInactive: options.includeInactive ?? false, count: rows.length },
    "Listed participants",
  );
  return rows.map(toParticipant);
}

// Точечный поиск по первичному ключу. null вместо исключения — нормальный
// результат для проверок существования перед мутацией.
export function findParticipantById(participantId: string): Participant | null {
  const row = getDb()
    .select()
    .from(participants)
    .where(eq(participants.id, participantId))
    .get();
  log.debug({ participantId, found: Boolean(row) }, "Looked up participant by ID");
  return row ? toParticipant(row) : null;
}

// Поиск идёт по нормализованному имени: нормализация приводит регистр и
// пробелы к канонической форме, поэтому "Alice" и "alice" указывают на
// одного и того же участника.
export function findParticipantByUsername(username: string): Participant | null {
  const row = getDb()
    .select()
    .from(participants)
    .where(eq(participants.normalizedUsername, normalizeParticipantUsername(username)))
    .get();
  log.debug({ participantId: row?.id ?? null, found: Boolean(row) }, "Looked up participant");
  return row ? toParticipant(row) : null;
}

// Создание участника. Пароль хешируется ДО открытия транзакции: хеширование
// намеренно дорогое (защита от перебора), а держать транзакцию SQLite
// открытой во время CPU-работы нельзя — это блокирует других писателей.
// Роль по умолчанию member: права администратора выдаются осознанно.
export async function createParticipant(
  input: CreateParticipantInput,
  actor: AuditActor = SYSTEM_ACTOR,
): Promise<ParticipantMutationResult> {
  const username = input.username.trim();
  const normalizedUsername = normalizeParticipantUsername(username);
  const displayName = input.displayName.trim();
  const role = input.role ?? "member";
  log.debug({ role, actorKind: actor.kind, actorId: actor.id }, "Creating participant");

  // Валидация до обращения к БД: пустые после trim поля бессмысленны, а
  // отказ на этом уровне дешевле и не оставляет частичных записей.
  if (!username || !normalizedUsername || !displayName || !input.password) {
    log.warn({ role, actorKind: actor.kind }, "Rejected invalid participant creation input");
    return { ok: false, code: "invalid_input" };
  }

  // Предварительная проверка дубликата ради понятного кода ошибки. Она не
  // заменяет уникальный индекс: между проверкой и вставкой параллельный
  // запрос может создать того же пользователя, поэтому гонку ловим ниже.
  const existing = getDb()
    .select({ id: participants.id })
    .from(participants)
    .where(eq(participants.normalizedUsername, normalizedUsername))
    .get();
  if (existing) {
    log.warn({ participantId: existing.id }, "Rejected duplicate participant username");
    return { ok: false, code: "duplicate_username" };
  }

  // Идентификатор и отметка времени вычисляются один раз до транзакции: все
  // строки, созданные в рамках операции (участник и запись аудита), должны
  // иметь одинаковую метку, иначе аудит окажется рассинхронизированным.
  const passwordHash = await hashParticipantPassword(input.password);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  try {
    // Вставка участника и запись аудита — одна атомарная операция. Если не
    // запишется аудит, участник не должен появиться: иначе история изменений
    // перестанет быть достоверной.
    const created = getDb().transaction((tx) => {
      const row = tx
        .insert(participants)
        .values({
          id,
          username,
          normalizedUsername,
          displayName,
          passwordHash,
          role,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      // Аудит пишется в той же транзакции, что и вставка. Отображаемое имя
      // сохраняется снимком: запись останется читаемой, даже если участник
      // позже переименуется или будет деактивирован.
      tx.insert(auditEvents)
        .values(
          createAuditEventValues({
            action: "participant.created",
            entityType: "participant",
            entityId: row.id,
            participantId: row.id,
            participantDisplayNameSnapshot: row.displayName,
            actor,
            metadata: { role: row.role },
            createdAt: now,
          }),
        )
        .run();
      return row;
    });
    log.info({ participantId: created.id, role: created.role }, "Participant created");
    return { ok: true, participant: toParticipant(created) };
  } catch (error) {
    // Гонка на уникальном индексе: параллельный запрос успел создать
    // участника между проверкой выше и вставкой. Превращаем ошибку драйвера
    // в тот же доменный код, что и предварительная проверка.
    if (isSqliteUniqueConstraint(error)) {
      log.warn({ participantId: id }, "Participant creation lost duplicate username race");
      return { ok: false, code: "duplicate_username" };
    }
    log.error({ error, participantId: id, role }, "Participant creation failed");
    throw error;
  }
}

// Обновление профиля и роли участника. Чтение текущего состояния и запись
// идут в одной транзакции: иначе между чтением роли и её изменением
// параллельный запрос мог бы деактивировать последнего администратора.
export function updateParticipant(
  participantId: string,
  input: UpdateParticipantInput,
  actor: AuditActor = SYSTEM_ACTOR,
): ParticipantMutationResult {
  const db = getDb();
  const displayName = input.displayName?.trim();
  // В лог идёт признак наличия поля, а не его значение: отображаемое имя
  // может содержать персональные данные, которым не место в журналах.
  log.debug(
    {
      participantId,
      hasDisplayName: input.displayName !== undefined,
      requestedRole: input.role ?? null,
      actorKind: actor.kind,
      actorId: actor.id,
    },
    "Updating participant",
  );

  // Пустая строка после trim для displayName — это ошибка ввода, а не
  // намерение очистить имя: отображаемое имя обязательно у участника.
  if (input.displayName !== undefined && !displayName) {
    log.warn({ participantId }, "Rejected empty participant display name");
    return { ok: false, code: "invalid_input" };
  }

  try {
    return db.transaction((tx) => {
      const current = tx
        .select()
        .from(participants)
        .where(eq(participants.id, participantId))
        .get();
      if (!current) return { ok: false, code: "not_found" } as const;
      if (!current.active) return { ok: false, code: "inactive_participant" } as const;

      // Проверка "последнего администратора" выполняется на данных внутри
      // транзакции: два параллельных понижения роли не должны вместе оставить
      // систему без активного администратора.
      const isDemotingActiveAdmin =
        current.role === "admin" && input.role === "member";
      if (isDemotingActiveAdmin && countActiveAdmins(tx) <= 1) {
        log.warn({ participantId }, "Rejected final active admin demotion");
        return { ok: false, code: "final_active_admin" } as const;
      }

      const now = new Date().toISOString();
      const roleChanged = input.role !== undefined && input.role !== current.role;
      // Смена роли меняет набор прав, поэтому активные сессии участника
      // отзываются: старый токен не должен сохранять прежние полномочия.
      // Отзыв идёт в той же транзакции, что и обновление роли.
      const revokedSessions = roleChanged
        ? tx
            .update(participantSessions)
            .set({ revokedAt: now })
            .where(
              and(
                eq(participantSessions.participantId, participantId),
                isNull(participantSessions.revokedAt),
              ),
            )
            .run()
        : null;
      // Непереданные поля остаются прежними: применяется частичное
      // обновление, а не перезапись всей строки значениями по умолчанию.
      const updated = tx
        .update(participants)
        .set({
          displayName: displayName ?? current.displayName,
          role: input.role ?? current.role,
          updatedAt: now,
        })
        .where(eq(participants.id, participantId))
        .returning()
        .get();
      // Аудит пишется в той же транзакции, что и обновление профиля: запись
      // об изменении роли не должна переживать откат самого изменения.
      tx.insert(auditEvents)
        .values(
          createAuditEventValues({
            action: "participant.updated",
            entityType: "participant",
            entityId: updated.id,
            participantId: updated.id,
            participantDisplayNameSnapshot: updated.displayName,
            actor,
            // Метаданные фиксируют и прежнюю, и новую роль: по одной записи
            // аудита должно быть понятно, что именно изменилось.
            metadata: {
              previousRole: current.role,
              role: updated.role,
              displayNameChanged: updated.displayName !== current.displayName,
              revokedSessionCount: revokedSessions?.changes ?? 0,
            },
            createdAt: now,
          }),
        )
        .run();
      log.info(
        {
          participantId,
          role: updated.role,
          revokedSessionCount: revokedSessions?.changes ?? 0,
        },
        "Participant updated",
      );
      // Возвращаем количество отозванных сессий, чтобы API могло сообщить
      // пользователю, сколько активных входов было прервано сменой роли.
      return {
        ok: true,
        participant: toParticipant(updated),
        revokedSessionCount: revokedSessions?.changes,
      } as const;
    });
  } catch (error) {
    log.error({ error, participantId }, "Participant update failed");
    throw error;
  }
}

// Деактивация участника. Запись остаётся в БД ради аудита и истории, но вход
// запрещается, сессии отзываются, а назначения на задачи снимаются. Всё это
// одна транзакция: задача не должна остаться с назначением на отключённого
// исполнителя, а версия владения обязана увеличиться согласованно.
export function deactivateParticipant(
  participantId: string,
  actor: AuditActor = SYSTEM_ACTOR,
): ParticipantMutationResult {
  const db = getDb();
  // Отметка времени берётся один раз до транзакции: все записи (участник,
  // сессии, история по каждой задаче, аудит) должны иметь одинаковое время,
  // чтобы историю можно было восстановить в правильном порядке.
  const now = new Date().toISOString();
  log.debug(
    { participantId, actorKind: actor.kind, actorId: actor.id },
    "Deactivating participant",
  );

  try {
    return db.transaction((tx) => {
      const participant = tx
        .select()
        .from(participants)
        .where(eq(participants.id, participantId))
        .get();
      if (!participant) return { ok: false, code: "not_found" } as const;
      if (!participant.active) return { ok: false, code: "inactive_participant" } as const;
      if (participant.role === "admin" && countActiveAdmins(tx) <= 1) {
        log.warn({ participantId }, "Rejected final active admin deactivation");
        return { ok: false, code: "final_active_admin" } as const;
      }

      // Сначала читаем затронутые задачи, и только потом удаляем назначения:
      // после DELETE восстановить список было бы нечем, а он нужен и для
      // истории исполнителей, и для записей аудита по каждой задаче.
      const affectedTasks = tx
        .select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
          executionOwner: tasks.executionOwner,
          ownershipRevision: tasks.ownershipRevision,
        })
        .from(taskAssignments)
        .innerJoin(tasks, eq(taskAssignments.taskId, tasks.id))
        .where(eq(taskAssignments.participantId, participantId))
        .all();
      // Удаление назначений — основное назначение операции: после деактивации
      // участник не должен оставаться исполнителем ни по одной задаче.
      tx.delete(taskAssignments)
        .where(eq(taskAssignments.participantId, participantId))
        .run();

      // Обход затронутых задач: на каждую задачу нужны собственные записи
      // истории и аудита, поэтому цикл идёт внутри той же транзакции.
      for (const task of affectedTasks) {
        // По каждой затронутой задаче увеличивается ownershipRevision. Это
        // сообщает клиентам с устаревшим снимком владения о конфликте версии,
        // чтобы они не перезаписали снятое назначение своей старой копией.
        const revisionRow = tx
          .update(tasks)
          .set({
            ownershipRevision: sql`${tasks.ownershipRevision} + 1`,
            updatedAt: now,
          })
          .where(eq(tasks.id, task.id))
          .returning({ ownershipRevision: tasks.ownershipRevision })
          .get();
        // Снимок берётся ПОСЛЕ удаления назначений, поэтому фиксирует
        // фактическое состояние задачи без выбывшего участника: именно его
        // увидят аудит и история исполнителей.
        const assignees = listAssignmentSnapshots(tx, task.id);
        // Если RETURNING не вернул строку, ревизия всё равно считается
        // увеличенной: важно лишь, что снимок владения стал устаревшим.
        const ownershipRevision = revisionRow?.ownershipRevision ?? task.ownershipRevision + 1;
        // История исполнителей append-only: предыдущие записи не правятся и
        // не удаляются, поэтому накапливается полная хронология владения.
        tx.insert(taskExecutorHistory)
          .values({
            id: crypto.randomUUID(),
            taskId: task.id,
            taskTitleSnapshot: task.title,
            ownershipRevision,
            executionOwner: task.executionOwner,
            assigneesSnapshotJson: JSON.stringify(assignees),
            statusSnapshot: task.status,
            actorKind: actor.kind,
            actorId: actor.id,
            actorDisplayNameSnapshot: actor.displayNameSnapshot,
            reason: "participant_deactivated",
            createdAt: now,
          })
          .run();
        // На каждую затронутую задачу пишется отдельное событие аудита: так
        // снятие назначения видно в истории конкретной задачи, а не только
        // в общей записи о деактивации участника.
        tx.insert(auditEvents)
          .values(
            createAuditEventValues({
              action: "task.assignment_removed",
              entityType: "task",
              entityId: task.id,
              taskId: task.id,
              taskTitleSnapshot: task.title,
              participantId,
              participantDisplayNameSnapshot: participant.displayName,
              executionOwnerSnapshot: task.executionOwner,
              assigneesSnapshot: assignees,
              statusSnapshot: task.status,
              actor,
              reason: "participant_deactivated",
              metadata: { ownershipRevision },
              createdAt: now,
            }),
          )
          .run();
      }

      // Отзыв сессий выполняется до фактической деактивации, но в той же
      // транзакции: к моменту коммита ни один живой токен не сможет
      // действовать от имени участника.
      const revokedSessions = tx
        .update(participantSessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(participantSessions.participantId, participantId),
            isNull(participantSessions.revokedAt),
          ),
        )
        .run();
      // Строка не удаляется, а помечается неактивной: запись нужна для аудита
      // и истории, а deactivatedAt фиксирует момент отключения.
      const deactivated = tx
        .update(participants)
        .set({ active: false, deactivatedAt: now, updatedAt: now })
        .where(eq(participants.id, participantId))
        .returning()
        .get();
      tx.insert(auditEvents)
        .values(
          createAuditEventValues({
            action: "participant.deactivated",
            entityType: "participant",
            entityId: participantId,
            participantId,
            participantDisplayNameSnapshot: participant.displayName,
            actor,
            // Сводка по последствиям деактивации: сколько сессий прервано и
            // с каких задач снят участник. Эти числа нельзя восстановить
            // постфактум, поэтому они попадают в аудит сразу.
            metadata: {
              revokedSessionCount: revokedSessions.changes,
              removedAssignmentCount: affectedTasks.length,
            },
            createdAt: now,
          }),
        )
        .run();

      log.info(
        {
          participantId,
          revokedSessionCount: revokedSessions.changes,
          removedAssignmentCount: affectedTasks.length,
        },
        "Participant deactivated",
      );
      return {
        ok: true,
        participant: toParticipant(deactivated),
        revokedSessionCount: revokedSessions.changes,
        affectedTaskIds: affectedTasks.map((task) => task.id),
      } as const;
    });
  } catch (error) {
    log.error({ error, participantId }, "Participant deactivation failed");
    throw error;
  }
}

// Административный сброс пароля: текущий пароль не запрашивается, поэтому
// операция предназначена для восстановления доступа, а не для плановой смены
// пароля самим пользователем. Хеширование, как и при создании, идёт до
// транзакции, чтобы не держать блокировку во время дорогой криптографии.
export async function resetParticipantPassword(
  participantId: string,
  password: string,
  actor: AuditActor = SYSTEM_ACTOR,
): Promise<ParticipantMutationResult> {
  // Пустой пароль отклоняется до транзакции: сброс на пустое значение был бы
  // фактически отключением защиты учётной записи.
  if (!password) {
    log.warn({ participantId }, "Rejected empty participant password reset");
    return { ok: false, code: "invalid_input" };
  }
  log.debug(
    { participantId, actorKind: actor.kind, actorId: actor.id },
    "Resetting participant password",
  );
  // Хеш готовится до транзакции, а отметка времени фиксируется один раз,
  // чтобы обновление пароля, отзыв сессий и аудит имели общее время события.
  const passwordHash = await hashParticipantPassword(password);
  const now = new Date().toISOString();

  try {
    return getDb().transaction((tx) => {
      const participant = tx
        .select()
        .from(participants)
        .where(eq(participants.id, participantId))
        .get();
      if (!participant) return { ok: false, code: "not_found" } as const;
      if (!participant.active) return { ok: false, code: "inactive_participant" } as const;

      // Обновляется только хеш и время изменения: остальные поля профиля
      // сбросом пароля не затрагиваются.
      const updated = tx
        .update(participants)
        .set({ passwordHash, updatedAt: now })
        .where(eq(participants.id, participantId))
        .returning()
        .get();
      // Сброс пароля отзывает все активные сессии: если доступ был
      // скомпрометирован, смена пароля должна немедленно лишить
      // злоумышленника входа по ранее выданному токену.
      const revokedSessions = tx
        .update(participantSessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(participantSessions.participantId, participantId),
            isNull(participantSessions.revokedAt),
          ),
        )
        .run();
      // Запись аудита создаётся в той же транзакции, что и смена хеша: события
      // "пароль изменён" не должно существовать без самого изменения. Сам хеш
      // в аудит не попадает.
      tx.insert(auditEvents)
        .values(
          createAuditEventValues({
            action: "participant.password_reset",
            entityType: "participant",
            entityId: participantId,
            participantId,
            participantDisplayNameSnapshot: participant.displayName,
            actor,
            metadata: { revokedSessionCount: revokedSessions.changes },
            createdAt: now,
          }),
        )
        .run();
      log.info(
        { participantId, revokedSessionCount: revokedSessions.changes },
        "Participant password reset",
      );
      return {
        ok: true,
        participant: toParticipant(updated),
        revokedSessionCount: revokedSessions.changes,
      } as const;
    });
  } catch (error) {
    log.error({ error, participantId }, "Participant password reset failed");
    throw error;
  }
}

// Смена пароля по инициативе самого участника: требуется знание текущего
// пароля и идентификатор текущей сессии. Совпадение старого и нового пароля
// отклоняется как ошибка ввода — это чаще опечатка, чем осознанная смена.
export async function changeParticipantPassword(
  participantId: string,
  currentPassword: string,
  newPassword: string,
  currentSessionId: string,
  actor: AuditActor = SYSTEM_ACTOR,
): Promise<ParticipantMutationResult> {
  // currentSessionId обязателен: по нему текущий вход остаётся действительным
  // после смены пароля, а все прочие сессии отзываются.
  if (!currentPassword || !newPassword || currentPassword === newPassword || !currentSessionId) {
    log.warn({ participantId }, "Rejected invalid participant password change input");
    return { ok: false, code: "invalid_input" };
  }

  const participant = getDb()
    .select()
    .from(participants)
    .where(eq(participants.id, participantId))
    .get();
  // Проверка идёт через вариант с "пустым" хешем: при отсутствии участника
  // время ответа остаётся таким же, как при неверном пароле. Это не даёт
  // отличить существующее имя от несуществующего по задержке ответа.
  const verified = await verifyParticipantPasswordOrDummy(
    currentPassword,
    participant?.passwordHash ?? null,
  );
  if (!participant) return { ok: false, code: "not_found" };
  if (!participant.active) return { ok: false, code: "inactive_participant" };
  if (!verified) {
    log.warn({ participantId }, "Rejected invalid current participant password");
    return { ok: false, code: "invalid_current_password" };
  }

  // Новый хеш считается до открытия транзакции: транзакция остаётся короткой
  // и содержит только проверки состояния и записи.
  const passwordHash = await hashParticipantPassword(newPassword);
  const now = new Date().toISOString();
  return getDb().transaction((tx) => {
    // Оптимистичная проверка: строка обновляется, только если пароль в БД всё
    // ещё тот же, что был прочитан при проверке. Параллельная смена пароля в
    // другой сессии даст пустой результат, и более свежее значение не будет
    // перезаписано устаревшим.
    const updated = tx
      .update(participants)
      .set({ passwordHash, updatedAt: now })
      .where(
        and(
          eq(participants.id, participantId),
          eq(participants.active, true),
          eq(participants.passwordHash, participant.passwordHash),
        ),
      )
      .returning()
      .get();
    if (!updated) {
      // Обновление не прошло: причину выясняем по актуальному состоянию
      // строки, чтобы вернуть вызывающему точный код, а не общий конфликт.
      const current = tx
        .select({ active: participants.active })
        .from(participants)
        .where(eq(participants.id, participantId))
        .get();
      if (!current) return { ok: false, code: "not_found" } as const;
      if (!current.active) return { ok: false, code: "inactive_participant" } as const;
      return { ok: false, code: "invalid_current_password" } as const;
    }

    // Текущая сессия сохраняется: пользователь только что подтвердил владение
    // паролем и не должен быть разлогинен собственной сменой. Остальные сессии
    // отзываются, так как старый пароль больше недействителен.
    const revokedSessions = tx
      .update(participantSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(participantSessions.participantId, participantId),
          ne(participantSessions.id, currentSessionId),
          isNull(participantSessions.revokedAt),
        ),
      )
      .run();
    // Аудит и отзыв сессий — часть той же транзакции, что и запись нового
    // хеша, поэтому частичного состояния (пароль сменён, старые сессии живы)
    // не возникает даже при сбое.
    tx.insert(auditEvents)
      .values(
        createAuditEventValues({
          action: "participant.password_changed",
          entityType: "participant",
          entityId: participantId,
          participantId,
          participantDisplayNameSnapshot: participant.displayName,
          actor,
          metadata: { revokedSessionCount: revokedSessions.changes },
          createdAt: now,
        }),
      )
      .run();
    log.info(
      { participantId, revokedSessionCount: revokedSessions.changes },
      "Participant password changed",
    );
    return {
      ok: true,
      participant: toParticipant(updated),
      revokedSessionCount: revokedSessions.changes,
    } as const;
  });
}
