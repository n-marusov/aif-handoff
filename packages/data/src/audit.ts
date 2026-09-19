/**
 * Журнал аудита: append-only хранилище событий.
 *
 * Одна запись фиксирует актора, действие и снимки состояния задачи (заголовок,
 * исполнитель, статус, участники). Снимки денормализованы намеренно: сущности
 * могут быть переименованы или удалены позже, а история должна читаться без JOIN
 * с живыми таблицами.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import {
  auditEvents,
  logger,
  type AuditActor,
  type AuditEvent,
  type ExecutionOwner,
  type NewAuditEventRow,
  type TaskAssigneeSummary,
  type TaskStatus,
} from "@aif/shared";
import { getDb } from "./db.js";

// Именованное пространство логов "data:audit" позволяет отфильтровать события
// аудита при разборе инцидентов, не поднимая уровень логирования всего пакета.
const log = logger("data:audit");

// Входные данные для добавления события. Обязательны только action, entityType
// и actor - аудит должен уметь фиксировать и частично известные события
// (например, отклонённую попытку доступа без участника и задачи). Поэтому
// undefined и null здесь равнозначны и ниже нормализуются через ?? null.
export interface AppendAuditEventInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  taskId?: string | null;
  taskTitleSnapshot?: string | null;
  participantId?: string | null;
  participantDisplayNameSnapshot?: string | null;
  executionOwnerSnapshot?: ExecutionOwner | null;
  assigneesSnapshot?: TaskAssigneeSummary[] | null;
  statusSnapshot?: TaskStatus | null;
  actor: AuditActor;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}

// SQLite хранит JSON обычным текстом, поэтому при чтении его нужно разбирать и
// валидировать. Функция намеренно мягкая: повреждённая или неожиданная запись
// не должна ломать выдачу истории, поэтому вместо исключения возвращается null.
function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Принимаем только обычные объекты: массив или примитив означают, что
    // запись повреждена либо сделана несовместимой версией кода.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Снимок участников - массив JSON-объектов. В отличие от parseJsonRecord здесь
// проверяется форма каждого элемента: данные могли быть записаны другой версией
// кода, а неподходящие элементы отбрасываются, а не портят выдачу целиком.
function parseAssignees(raw: string | null): TaskAssigneeSummary[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // Предикат типа: всё, что не похоже на запись участника, отбраковывается,
    // а не приводится к нужному типу "на веру".
    return parsed.filter((value): value is TaskAssigneeSummary => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      // Проверяем каждое обязательное поле и допустимые значения роли (union-тип
      // роли сужен до литералов): битый снимок лучше отбросить, чем отдать в UI
      // объект с несуществующей ролью.
      const candidate = value as Partial<TaskAssigneeSummary>;
      return (
        typeof candidate.participantId === "string" &&
        typeof candidate.displayName === "string" &&
        (candidate.role === "admin" || candidate.role === "member") &&
        typeof candidate.active === "boolean"
      );
    });
  } catch {
    return null;
  }
}

// Преобразование строки БД в доменный объект: JSON-колонки разбираются, плоские
// колонки актора собираются обратно во вложенный объект. Маппинг выполняется
// вручную, потому что имена полей хранения и домена намеренно различаются
// (например, metadataJson против metadata).
function toAuditEvent(row: typeof auditEvents.$inferSelect): AuditEvent {
  return {
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    taskId: row.taskId,
    taskTitleSnapshot: row.taskTitleSnapshot,
    participantId: row.participantId,
    participantDisplayNameSnapshot: row.participantDisplayNameSnapshot,
    executionOwnerSnapshot: row.executionOwnerSnapshot,
    assigneesSnapshot: parseAssignees(row.assigneesSnapshotJson),
    statusSnapshot: row.statusSnapshot,
    // В БД актор лежит тремя плоскими колонками, а в домене - одним объектом.
    actor: {
      kind: row.actorKind,
      id: row.actorId,
      displayNameSnapshot: row.actorDisplayNameSnapshot,
    },
    reason: row.reason,
    // Свободные метаданные события: произвольный JSON, поэтому разбираются
    // мягким парсером, который не бросает исключение на неизвестной форме.
    metadata: parseJsonRecord(row.metadataJson),
    createdAt: row.createdAt,
  };
}

// FR: REQ-FR-audit.logging.record-state-transition (criteria 1, 3, 4) — журнал действий
// системы существует ради иммутабельной фиксации каждого изменения состояния, поэтому
// запись собирается в одном месте и никогда не правится задним числом.
// BR: BR-constraint.audit.state-snapshot — денормализованный снимок (заголовок, владелец,
// назначения) фиксируется на момент действия и не зависит от последующих переименований.
// Материализация входных данных в строку для вставки. Идентификатор и момент
// создания генерируются здесь, если не переданы снаружи: это позволяет тестам и
// сценариям восстановления задавать детерминированные значения. JSON заранее
// сериализуется в текст, потому что драйвер принимает только примитивы.
export function createAuditEventValues(input: AppendAuditEventInput): NewAuditEventRow {
  return {
    id: crypto.randomUUID(),
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    taskId: input.taskId ?? null,
    taskTitleSnapshot: input.taskTitleSnapshot ?? null,
    participantId: input.participantId ?? null,
    participantDisplayNameSnapshot: input.participantDisplayNameSnapshot ?? null,
    executionOwnerSnapshot: input.executionOwnerSnapshot ?? null,
    // undefined и null трактуем одинаково: явное "нет данных" не должно
    // превращаться в строку "null" внутри JSON-колонки.
    assigneesSnapshotJson:
      input.assigneesSnapshot === undefined || input.assigneesSnapshot === null
        ? null
        : JSON.stringify(input.assigneesSnapshot),
    statusSnapshot: input.statusSnapshot ?? null,
    actorKind: input.actor.kind,
    // BR: BR-fact.audit.actor-identity — рядом с id актора хранится снимок отображаемого
    // имени: переименование участника не должно переписывать уже случившуюся историю.
    actorId: input.actor.id,
    actorDisplayNameSnapshot: input.actor.displayNameSnapshot,
    reason: input.reason ?? null,
    metadataJson:
      input.metadata === undefined || input.metadata === null
        ? null
        : JSON.stringify(input.metadata),
    createdAt: input.createdAt,
  };
}

// Основная точка записи. Строка вставляется одним запросом с returning(): это
// BR: BR-constraint.audit.immutable-trail — журнал только пополняется (INSERT без UPDATE и
// DELETE), поэтому сбой записи не подавляется: сломанный аудит должен быть заметен сразу.
// FR: REQ-FR-audit.logging.record-state-transition (criterion 5) — запись аудита создаётся в
// той же транзакции, что и само изменение состояния, иначе история разъедется с фактами.
// атомарная операция, поэтому возвращённые значения гарантированно соответствуют
// сохранённой строке. Исключение наружу не подавляется: аудит - критичный
// побочный эффект, и вызывающий код обязан узнать о сбое.
export function appendAuditEvent(input: AppendAuditEventInput): AuditEvent {
  log.debug(
    {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      taskId: input.taskId ?? null,
      participantId: input.participantId ?? null,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
    },
    "Appending audit event",
  );
  const values = createAuditEventValues(input);

  try {
    // returning() возвращает фактически записанную строку, включая значения по
    // умолчанию и любые преобразования на стороне базы данных.
    const created = getDb().insert(auditEvents).values(values).returning().get();
    log.info(
      {
        auditEventId: created.id,
        action: created.action,
        entityType: created.entityType,
        entityId: created.entityId,
      },
      "Audit event appended",
    );
    return toAuditEvent(created);
  } catch (error) {
    log.error(
      {
        error,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
      },
      "Failed to append audit event",
    );
    // Пробрасываем ошибку дальше: вызывающая транзакция должна откатиться
    // целиком, а не продолжиться с частично применёнными изменениями.
    throw error;
  }
}

// Выборка с необязательными фильтрами. Предикаты собираются в массив и
// отбрасываются, если фильтр не задан: один и тот же код обслуживает и полный
// список, и выборки по задаче или участнику, без дублирования условий.
// Сортировка по createdAt с добором по rowid даёт стабильный порядок даже тогда,
// когда события записаны в одну миллисекунду или имеют одинаковую строковую
// метку времени: rowid уникален и монотонен в пределах таблицы.
export function listAuditEvents(input: {
  taskId?: string;
  participantId?: string;
}): AuditEvent[] {
  const predicates = [
    input.taskId ? eq(auditEvents.taskId, input.taskId) : undefined,
    input.participantId ? eq(auditEvents.participantId, input.participantId) : undefined,
  ].filter((predicate) => predicate !== undefined);
  // Ветка без фильтров существует потому, что and() с пустым списком аргументов
  // сгенерировал бы некорректное условие WHERE.
  const rows =
    predicates.length === 0
      ? getDb()
          .select()
          .from(auditEvents)
          .orderBy(asc(auditEvents.createdAt), sql`rowid`)
          .all()
      : getDb()
          .select()
          .from(auditEvents)
          .where(and(...predicates))
          .orderBy(asc(auditEvents.createdAt), sql`rowid`)
          .all();

  log.debug(
    {
      taskId: input.taskId ?? null,
      participantId: input.participantId ?? null,
      count: rows.length,
    },
    "Listed audit events",
  );
  // Преобразуем все строки разом на границе модуля, чтобы наружу не утекали
  // сырые структуры хранилища.
  return rows.map(toAuditEvent);
}
