/**
 * Персистентность интеграции с GitHub: связь проекта с репозиторием, состояние
 * синхронизации, снимки issue и публикация pull request.
 *
 * Все структурированные поля (фильтр отбора issue, снимок, состояние ревью) хранятся в
 * базе как JSON-текст и разбираются при чтении с безопасными значениями по умолчанию:
 * содержимое могло быть записано другой версией приложения или изменено вручную.
 *
 * Модуль зеркалит gitlab.ts: наборы функций и их поведение совпадают, различия касаются
 * только терминологии провайдера (issue/pull request против issue/merge request).
 */
import { and, desc, eq, max } from "drizzle-orm";
import {
  auditEvents,
  generatePlanPath,
  getProjectConfig,
  githubIssues,
  githubRepositories,
  logger,
  projects,
  taskExecutorHistory,
  tasks,
  type GitHubEligibility,
  type GitHubIssueLink,
  type GitHubIssueRow,
  type GitHubIssueSnapshot,
  type GitHubRepositoryConnection,
  type PullRequestMode,
} from "@aif/shared";
import { getDb } from "./db.js";
import { createAuditEventValues } from "./audit.js";

// Репозиторный слой интеграции с GitHub: привязка репозитория к проекту,
// состояние синхронизации, импорт issue в задачу и учет состояния PR.
// Прямой доступ к drizzle разрешен только пакету @aif/data, поэтому api, agent
// и runtime работают с таблицами исключительно через функции этого модуля.

const log = logger("data:github");
// Единственный экземпляр значения по умолчанию на весь модуль: он возвращается
// и когда фильтр не настроен, и когда строка в БД повреждена, поэтому
// вызывающий код не проверяет null и не создает новый объект на каждый разбор.
const DEFAULT_ELIGIBILITY: GitHubEligibility = { labels: [], assignee: null, milestone: null };

// Разбор фильтра отбора issue из колонки eligibilityJson. Содержимое колонки
// могло быть записано другой версией приложения или поправлено вручную,
// поэтому строка считается недоверенной: сбой разбора означает "фильтр не
// задан", а не ошибку чтения подключения.
function parseEligibility(raw: string): GitHubEligibility {
  try {
    const value: unknown = JSON.parse(raw);
    // JSON.parse умеет вернуть примитив, null и массив, поэтому перед чтением
    // полей убеждаемся, что перед нами именно объект.
    if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_ELIGIBILITY;
    const record = value as Record<string, unknown>;
    return {
      // Нестроковые элементы отбрасываются: метка используется как ключ в UI,
      // поэтому набор значений должен быть однородным.
      labels: Array.isArray(record.labels)
        ? record.labels.filter((label): label is string => typeof label === "string")
        : [],
      assignee: typeof record.assignee === "string" ? record.assignee : null,
      milestone: typeof record.milestone === "string" ? record.milestone : null,
    };
  } catch {
    return DEFAULT_ELIGIBILITY;
  }
}

// Разбор снимка issue, сохраненного в metadataJson. В отличие от фильтра здесь
// нет безопасного частичного значения: все поля снимка обязательны, поэтому
// при некорректном корне снимок считается потерянным и возвращается пустым.
// throw внутри try используется как переход в catch с общим дефолтом.
function parseIssueSnapshot(raw: string): GitHubIssueSnapshot {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    return {
      // Отсутствие поля во внешнем API — обычная ситуация, а не сбой, поэтому
      // каждое значение приводится к безопасному дефолту своего типа.
      title: typeof record.title === "string" ? record.title : "",
      body: typeof record.body === "string" ? record.body : "",
      author: typeof record.author === "string" ? record.author : "unknown",
      labels: Array.isArray(record.labels)
        ? record.labels.filter((item): item is string => typeof item === "string")
        : [],
      assignees: Array.isArray(record.assignees)
        ? record.assignees.filter((item): item is string => typeof item === "string")
        : [],
      milestone: typeof record.milestone === "string" ? record.milestone : null,
      // Комментарии приходят из внешнего источника, поэтому каждый элемент
      // проверяется структурно, а недоверенные отбрасываются. Иначе рендер
      // описания упал бы на первом же объекте неожиданной формы.
      comments: Array.isArray(record.comments)
        ? record.comments.filter(
            (item): item is GitHubIssueSnapshot["comments"][number] =>
              Boolean(item) &&
              typeof item === "object" &&
              !Array.isArray(item) &&
              typeof (item as Record<string, unknown>).id === "number" &&
              typeof (item as Record<string, unknown>).author === "string" &&
              typeof (item as Record<string, unknown>).body === "string" &&
              typeof (item as Record<string, unknown>).htmlUrl === "string" &&
              typeof (item as Record<string, unknown>).createdAt === "string" &&
              typeof (item as Record<string, unknown>).updatedAt === "string",
          )
        : [],
    };
  } catch {
    return { title: "", body: "", author: "unknown", labels: [], assignees: [], milestone: null, comments: [] };
  }
}

// Преобразование строки таблицы в доменную модель: metadataJson разворачивается
// в объект, а имена полей остаются такими же, как в API, чтобы потребителю не
// приходилось знать про суффикс Json в схеме БД.
function toIssueLink(row: GitHubIssueRow): GitHubIssueLink {
  return {
    projectId: row.projectId,
    issueNumber: row.issueNumber,
    taskId: row.taskId,
    nodeId: row.nodeId,
    htmlUrl: row.htmlUrl,
    state: row.state,
    metadata: parseIssueSnapshot(row.metadataJson),
    sourceUpdatedAt: row.sourceUpdatedAt,
    lastSyncedAt: row.lastSyncedAt,
    syncError: row.syncError,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    prState: row.prState,
    prChecksStatus: row.prChecksStatus,
    prMode: row.prMode,
    reviewState: row.reviewState,
    lastReviewId: row.lastReviewId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// tokenConfigured вычисляется при чтении, а не хранится в БД: сам токен в базу
// не попадает никогда, сохраняется только имя переменной окружения. Поэтому
// дампы и резервные копии не содержат секретов, а флаг всегда актуален.
function toConnection(row: typeof githubRepositories.$inferSelect): GitHubRepositoryConnection {
  return {
    projectId: row.projectId,
    owner: row.owner,
    name: row.name,
    htmlUrl: row.htmlUrl,
    defaultBranch: row.defaultBranch,
    tokenEnvVar: row.tokenEnvVar,
    eligibility: parseEligibility(row.eligibilityJson),
    enabled: row.enabled,
    tokenConfigured: Boolean(process.env[row.tokenEnvVar]?.trim()),
    lastSyncedAt: row.lastSyncedAt,
    syncError: row.syncError,
    gitPreparedAt: row.gitPreparedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// projectId — первичный ключ связи, поэтому запрос возвращает не более одной
// строки, а отсутствие результата является нормальным состоянием проекта без
// настроенной интеграции (это не ошибка).
export function findGitHubRepository(projectId: string): GitHubRepositoryConnection | undefined {
  const row = getDb()
    .select()
    .from(githubRepositories)
    .where(eq(githubRepositories.projectId, projectId))
    .get();
  return row ? toConnection(row) : undefined;
}

// Обход только включенных подключений: выключенная интеграция не должна
// порождать сетевые запросы и накапливать ошибки синхронизации в интерфейсе.
export function listEnabledGitHubRepositories(): GitHubRepositoryConnection[] {
  return getDb()
    .select()
    .from(githubRepositories)
    .where(eq(githubRepositories.enabled, true))
    .all()
    .map(toConnection);
}

// Создание или обновление подключения к репозиторию. Идемпотентность
// обеспечивает onConflictDoUpdate по projectId: повторный вызов с теми же
// данными не создает вторую строку и не переписывает дату создания.
export function upsertGitHubRepository(input: {
  projectId: string;
  owner: string;
  name: string;
  htmlUrl: string;
  defaultBranch: string;
  tokenEnvVar: string;
  eligibility: GitHubEligibility;
  enabled: boolean;
  gitPreparedAt?: string | null;
}): GitHubRepositoryConnection {
  const now = new Date().toISOString();
  getDb()
    .insert(githubRepositories)
    .values({
      ...input,
      // Фильтр хранится строкой, потому что схема таблицы не описывает JSON:
      // сериализация и разбор сосредоточены в этом модуле и в toConnection.
      eligibilityJson: JSON.stringify(input.eligibility),
      // Новая конфигурация считается рабочей: прошлая ошибка синхронизации
      // сбрасывается, иначе UI показывал бы уже неактуальную проблему.
      syncError: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      // Конфликт разрешается по projectId — это инвариант "один репозиторий на
      // проект", а не по паре owner/name: тот же репозиторий может быть
      // подключен к нескольким проектам независимо.
      target: githubRepositories.projectId,
      set: {
        owner: input.owner,
        name: input.name,
        htmlUrl: input.htmlUrl,
        defaultBranch: input.defaultBranch,
        tokenEnvVar: input.tokenEnvVar,
        eligibilityJson: JSON.stringify(input.eligibility),
        enabled: input.enabled,
        syncError: null,
        // Метка подготовки локального git сбрасывается явным null, если не
        // передана: после смены репозитория старое "репозиторий подготовлен"
        // уже не соответствует содержимому рабочей копии.
        gitPreparedAt: input.gitPreparedAt ?? null,
        updatedAt: now,
        // createdAt намеренно отсутствует в set: дата создания сохраняется от
        // первой вставки и не переписывается при каждом сохранении формы.
      },
    })
    .run();
  log.info({ projectId: input.projectId, repository: `${input.owner}/${input.name}` }, "GitHub repository connection saved");
  // Строка гарантированно существует сразу после upsert, поэтому утверждение о
  // не-null здесь корректно; повторное чтение возвращает нормализованное
  // значение вместе с вычисленным tokenConfigured.
  return findGitHubRepository(input.projectId)!;
}

/**
 * Отметка о том, что агент подготовил локальный git-репозиторий для этого подключения
 * (origin, учётные данные, базовая ветка и каркас ai-factory).
 *
 * Возвращается обновлённая связь либо undefined, если подключения у проекта нет.
 */
export function markGitHubRepositoryPrepared(
  projectId: string,
): GitHubRepositoryConnection | undefined {
  // Идемпотентная отметка о том, что агент подготовил локальный git (origin,
  // учетные данные, ветка по умолчанию, каркас AI Factory) для этого подключения.
  // Повторный вызов безопасен: он только перезаписывает метку времени, не создавая
  // и не удаляя строку. Явная проверка существования нужна потому, что UPDATE по
  // отсутствующей строке завершается успешно, и без нее вызывающий получил бы
  // ложное подтверждение подготовки для проекта без подключения.
  const now = new Date().toISOString();
  const existing = findGitHubRepository(projectId);
  if (!existing) return undefined;
  getDb()
    .update(githubRepositories)
    .set({ gitPreparedAt: now, updatedAt: now })
    .where(eq(githubRepositories.projectId, projectId))
    .run();
  log.debug({ projectId, gitPreparedAt: now }, "GitHub repository marked prepared");
  return findGitHubRepository(projectId);
}

// Удаление не бросает исключение при отсутствии строки: changes показывает,
// была ли реально удалена запись, а решение о том, считать ли это ошибкой,
// остается за вызывающим.
export function deleteGitHubRepository(projectId: string): boolean {
  const result = getDb()
    .delete(githubRepositories)
    .where(eq(githubRepositories.projectId, projectId))
    .run();
  log.info({ projectId, deleted: result.changes > 0 }, "GitHub repository connection removed");
  return result.changes > 0;
}

// Единая точка фиксации результата синхронизации: успех передается как null и
// тем самым очищает предыдущую ошибку, неудача — текстом для отображения в UI.
export function recordGitHubRepositorySync(projectId: string, error: string | null): void {
  const now = new Date().toISOString();
  getDb()
    .update(githubRepositories)
    .set({ lastSyncedAt: now, syncError: error, updatedAt: now })
    .where(eq(githubRepositories.projectId, projectId))
    .run();
}

// Сборка тела задачи из снимка issue: сначала контекст (ссылка, автор, метки,
// исполнители, веха), затем исходное описание и, при наличии, комментарии.
// Пустые элементы отфильтрованы, чтобы в markdown не появлялись лишние пустые
// строки, когда у issue нет меток или вехи.
function renderIssueDescription(input: {
  issueNumber: number;
  htmlUrl: string;
  snapshot: GitHubIssueSnapshot;
}): string {
  const { snapshot } = input;
  const context = [
    `Source: ${input.htmlUrl}`,
    `Author: @${snapshot.author}`,
    snapshot.labels.length > 0 ? `Labels: ${snapshot.labels.join(", ")}` : null,
    snapshot.assignees.length > 0 ? `Assignees: ${snapshot.assignees.map((name) => `@${name}`).join(", ")}` : null,
    snapshot.milestone ? `Milestone: ${snapshot.milestone}` : null,
  ].filter(Boolean);
  // Комментарии разворачиваются в готовый markdown: заголовок третьего уровня
  // вложен в раздел второго уровня, а ссылка сохраняется для перехода к
  // исходному обсуждению.
  const comments = snapshot.comments.map(
    (comment) => `### @${comment.author} — ${comment.createdAt}\n\n${comment.body}\n\n${comment.htmlUrl}`,
  );
  return [context.join("\n"), snapshot.body, comments.length > 0 ? `## GitHub comments\n\n${comments.join("\n\n")}` : null]
    .filter(Boolean)
    .join("\n\n");
}

// Вход импорта: данные issue, уже полученные от GitHub API, плюс необязательный
// PR. Необязательность PR важна: именно его наличие определяет стартовый статус
// задачи и поля синхронизации (см. importGitHubIssueTask).
export interface ImportGitHubIssueInput {
  projectId: string;
  owner: string;
  repository: string;
  issueNumber: number;
  nodeId: string;
  htmlUrl: string;
  state: "open" | "closed";
  sourceUpdatedAt: string;
  snapshot: GitHubIssueSnapshot;
  pullRequest?: {
    number: number;
    url: string;
    state: "open";
  };
}

// Импорт issue в задачу. Результат идемпотентен по паре (projectId, issueNumber):
// повторный вызов для того же issue обновляет уже связанную задачу и не
// создает дубликат, а признак created сообщает вызывающему, появилась ли задача
// впервые (от этого зависит, например, запуск планирования).
export function importGitHubIssueTask(input: ImportGitHubIssueInput): {
  issue: GitHubIssueLink;
  taskId: string;
  created: boolean;
} {
  const db = getDb();
  const now = new Date().toISOString();
  // Если по issue уже открыт PR, работа агента не требуется: задача создается
  // сразу в done. Иначе она попадает в backlog и обрабатывается как ручная.
  const initialStatus = input.pullRequest ? "done" : "backlog";
  let taskId = "";
  let created = false;

  // Все записи выполняются в одной транзакции: связь issue с задачей, сама
  // задача, история владения и аудит должны появиться вместе. Частично
  // примененный импорт оставил бы issue без задачи или задачу без истории.
  db.transaction((tx) => {
    tx.insert(githubIssues)
      .values({
        projectId: input.projectId,
        issueNumber: input.issueNumber,
        nodeId: input.nodeId,
        htmlUrl: input.htmlUrl,
        state: input.state,
        metadataJson: JSON.stringify(input.snapshot),
        sourceUpdatedAt: input.sourceUpdatedAt,
        lastSyncedAt: now,
        // Поля PR добавляются только при наличии pullRequest: при обновлении
        // существующей строки отсутствующий PR не должен затирать уже
        // сохраненные значения (они не входят в блок set ниже).
        ...(input.pullRequest
          ? {
              prNumber: input.pullRequest.number,
              prUrl: input.pullRequest.url,
              prState: input.pullRequest.state,
            }
          : {}),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        // Составной ключ (projectId, issueNumber): один и тот же номер issue
        // может существовать в разных репозиториях и проектах, поэтому одного
        // issueNumber как ключа конфликта недостаточно.
        target: [githubIssues.projectId, githubIssues.issueNumber],
        set: {
          nodeId: input.nodeId,
          htmlUrl: input.htmlUrl,
          state: input.state,
          metadataJson: JSON.stringify(input.snapshot),
          sourceUpdatedAt: input.sourceUpdatedAt,
          lastSyncedAt: now,
          // Успешный разбор внешних данных снимает прошлую ошибку синхронизации,
          // иначе она осталась бы в списке issue навсегда.
          syncError: null,
          ...(input.pullRequest
            ? {
                prNumber: input.pullRequest.number,
                prUrl: input.pullRequest.url,
                prState: input.pullRequest.state,
              }
            : {}),
          updatedAt: now,
        },
      })
      .run();

    // Drizzle на SQLite не возвращает строку из upsert, поэтому читаем ее явно.
    // Заодно получаем ранее сохраненный taskId: именно он определяет, нужно ли
    // создавать задачу или только обновить уже связанную.
    const linked = tx
      .select()
      .from(githubIssues)
      .where(and(eq(githubIssues.projectId, input.projectId), eq(githubIssues.issueNumber, input.issueNumber)))
      .get();
    if (!linked) throw new Error("GitHub issue upsert did not return a row");

    const title = `#${input.issueNumber} ${input.snapshot.title}`;
    const description = renderIssueDescription(input);
    // Метка github добавляется всегда, дубликаты убираются, длина ограничена:
    // список меток показывается в карточке и не должен разрастаться бесконечно
    // при каждом изменении issue на стороне GitHub.
    const tags = [...new Set(["github", ...input.snapshot.labels])].slice(0, 50);
    if (linked.taskId) {
      // Ветка повторной синхронизации: задача уже существует, поэтому обновляются
      // только те поля, которые действительно изменились.
      taskId = linked.taskId;
      const existing = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
      const nextTags = JSON.stringify(tags);
      const nextPaused = input.state === "closed";
      // Строка задачи обновляется только при реальном изменении синхронизированного
      // содержимого. Обновление updatedAt на каждой синхронизации ломает
      // releaseStaleTaskClaims: сборщик мёртвых процессов считает свежий updatedAt
      // признаком активности, и захват упавшего координатора висел бы до истечения TTL
      // вместо восстановления по пульсу.
      const changed =
        !existing ||
        existing.title !== title ||
        existing.description !== description ||
        existing.tags !== nextTags ||
        existing.paused !== nextPaused;
      if (changed) {
        tx.update(tasks)
          .set({ title, description, tags: nextTags, paused: nextPaused, updatedAt: now })
          .where(eq(tasks.id, taskId))
          .run();
      } else {
        log.debug(
          { projectId: input.projectId, issueNumber: input.issueNumber, taskId },
          "GitHub sync skipped unchanged task row to avoid masking stale-claim recovery",
        );
      }
      return;
    }

    const project = tx.select().from(projects).where(eq(projects.id, input.projectId)).get();
    // Без проекта создавать задачу нельзя: внешний ключ и путь к каркасу плана
    // вычисляются от его корневого каталога.
    if (!project) throw new Error(`Project ${input.projectId} not found`);
    taskId = crypto.randomUUID();
    // Разреженная нумерация с шагом 100: между соседними задачами остается место
    // для вставки, а запасное 1000 задает порядок в пустом проекте.
    const maxPosition = tx
      .select({ value: max(tasks.position) })
      .from(tasks)
      .where(eq(tasks.projectId, input.projectId))
      .get()?.value;
    const config = getProjectConfig(project.rootPath);
    const planPath = generatePlanPath(`github-issue-${input.issueNumber}`, "full", {
      plansDir: config.paths.plans,
      defaultPlanPath: config.paths.plan,
    });
    // Импортированная задача сразу настроена на автоматический режим полного
    // планирования: человек не должен донастраивать ее вручную после импорта.
    tx.insert(tasks)
      .values({
        id: taskId,
        projectId: input.projectId,
        title,
        description,
        autoMode: true,
        executionOwner: "ai",
        plannerMode: "full",
        planPath,
        planDocs: true,
        planTests: true,
        autoQueueCommitStatus: "pending",
        // Базовый SHA появится только после первого коммита; до тех пор null —
        // значение означает "точка отсчета еще не зафиксирована".
        autoQueueCommitBaseSha: null,
        paused: input.state === "closed",
        tags: JSON.stringify(tags),
        status: initialStatus,
        position: Number(maxPosition ?? 1000) + 100,
        // Отметка активности проставляется сразу, чтобы сборщик зависших claim-ов
        // не считал только что созданную задачу брошенной.
        lastHeartbeatAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // Запись в историю владения создается вместе с задачей, иначе таймлайн
    // исполнителей в UI начинался бы с пустоты и не отражал актора импорта.
    tx.insert(taskExecutorHistory)
      .values({
        id: crypto.randomUUID(),
        taskId,
        taskTitleSnapshot: title,
        ownershipRevision: 0,
        executionOwner: "ai",
        assigneesSnapshotJson: "[]",
        statusSnapshot: initialStatus,
        actorKind: "system",
        actorId: "github-sync",
        actorDisplayNameSnapshot: "GitHub Sync",
        reason: "github_issue_imported",
        createdAt: now,
      })
      .run();
    // Аудит неизменяем: событие фиксирует, что задача появилась из issue, и
    // сохраняет снимок подписи на момент импорта, а не текущее состояние.
    tx.insert(auditEvents)
      .values(
        createAuditEventValues({
          action: "github.issue_imported",
          entityType: "task",
          entityId: taskId,
          taskId,
          taskTitleSnapshot: title,
          executionOwnerSnapshot: "ai",
          assigneesSnapshot: [],
          statusSnapshot: initialStatus,
          actor: { kind: "system", id: "github-sync", displayNameSnapshot: "GitHub Sync" },
          metadata: {
            repository: `${input.owner}/${input.repository}`,
            issueNumber: input.issueNumber,
            ...(input.pullRequest ? { prNumber: input.pullRequest.number } : {}),
          },
          createdAt: now,
        }),
      )
      .run();
    // Обратная ссылка проставляется последней, когда задача уже существует:
    // так в базе не бывает issue, ссылающегося на несуществующую задачу.
    tx.update(githubIssues)
      .set({ taskId, updatedAt: now })
      .where(and(eq(githubIssues.projectId, input.projectId), eq(githubIssues.issueNumber, input.issueNumber)))
      .run();
    // Признак created выставляется только в ветке создания новой задачи.
    created = true;
  });

  // Читаем результат через публичный ридер, чтобы вернуть уже нормализованную
  // доменную модель, а не собранный вручную объект.
  const issue = findGitHubIssue(input.projectId, input.issueNumber);
  if (!issue || !taskId) throw new Error("GitHub issue import failed");
  log.info({ projectId: input.projectId, issueNumber: input.issueNumber, taskId, created }, "GitHub issue synchronized");
  return { issue, taskId, created };
}

// Составной ключ выборки повторяет уникальный индекс таблицы, поэтому результат
// либо одна строка, либо отсутствие строки.
export function findGitHubIssue(projectId: string, issueNumber: number): GitHubIssueLink | undefined {
  const row = getDb()
    .select()
    .from(githubIssues)
    .where(and(eq(githubIssues.projectId, projectId), eq(githubIssues.issueNumber, issueNumber)))
    .get();
  return row ? toIssueLink(row) : undefined;
}

// Обратный поиск: по задаче находим связанную issue. Используется, когда
// воркфлоу работает с задачей и ему нужно понять, из какого issue она пришла.
export function findGitHubIssueByTaskId(taskId: string): GitHubIssueLink | undefined {
  const row = getDb().select().from(githubIssues).where(eq(githubIssues.taskId, taskId)).get();
  return row ? toIssueLink(row) : undefined;
}

// Сортировка по убыванию номера: в интерфейсе свежие issue должны быть сверху,
// а порядок не должен зависеть от порядка вставки строк в БД.
export function listGitHubIssues(projectId: string): GitHubIssueLink[] {
  return getDb()
    .select()
    .from(githubIssues)
    .where(eq(githubIssues.projectId, projectId))
    .orderBy(desc(githubIssues.issueNumber))
    .all()
    .map(toIssueLink);
}

// Пометка issue как недоступной (удалена на стороне GitHub, отозвана
// авторизация и т.п.). Обе записи объединены транзакцией, чтобы сообщение об
// ошибке и пауза задачи применялись согласованно и не расходились при сбое.
export function markGitHubIssueUnavailable(
  projectId: string,
  issueNumber: number,
  error: string,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction((tx) => {
    // Связь с задачей читается заранее, потому что после обновления строки
    // решения по taskId уже не примет ни один из последующих шагов.
    const issue = tx
      .select({ taskId: githubIssues.taskId })
      .from(githubIssues)
      .where(
        and(eq(githubIssues.projectId, projectId), eq(githubIssues.issueNumber, issueNumber)),
      )
      .get();
    // Время последней синхронизации двигается и при неудаче: UI различает
    // "давно не синхронизировалось" и "синхронизация завершилась с ошибкой".
    tx.update(githubIssues)
      .set({ syncError: error, lastSyncedAt: now, updatedAt: now })
      .where(
        and(eq(githubIssues.projectId, projectId), eq(githubIssues.issueNumber, issueNumber)),
      )
      .run();
    // issue может быть еще не связана с задачей (предыдущий импорт не дошел до
    // конца), поэтому обновление задачи выполняется условно. Пауза не дает
    // агенту продолжать работу над источником, которого больше нет.
    if (issue?.taskId) {
      tx.update(tasks)
        .set({ paused: true, updatedAt: now })
        .where(eq(tasks.id, issue.taskId))
        .run();
    }
  });
}

// Обновление состояния PR у связанной issue. Необязательные поля добавляются
// через условный spread: undefined означает "значение не изменилось", а явный
// null — "очистить поле". Смешивать эти случаи нельзя, иначе частичное
// обновление затирало бы уже известные статусы проверок и ревью.
export function updateGitHubPullRequest(input: {
  projectId: string;
  issueNumber: number;
  prNumber: number;
  prUrl: string;
  prState: "open" | "closed" | "merged";
  prChecksStatus?: "pending" | "success" | "failure" | null;
  reviewState?: "pending" | "approved" | "changes_requested" | null;
  lastReviewId?: number | null;
  reviewFingerprint?: string | null;
}): GitHubIssueLink | undefined {
  const now = new Date().toISOString();
  getDb()
    .update(githubIssues)
    .set({
      prNumber: input.prNumber,
      prUrl: input.prUrl,
      prState: input.prState,
      ...(input.prChecksStatus !== undefined ? { prChecksStatus: input.prChecksStatus } : {}),
      ...(input.reviewState !== undefined ? { reviewState: input.reviewState } : {}),
      ...(input.lastReviewId !== undefined ? { lastReviewId: input.lastReviewId } : {}),
      ...(input.reviewFingerprint !== undefined ? { reviewFingerprint: input.reviewFingerprint } : {}),
      // Успешное обновление снимает прошлую ошибку: карточка issue должна
      // показывать актуальное состояние, а не историческую проблему.
      syncError: null,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .where(and(eq(githubIssues.projectId, input.projectId), eq(githubIssues.issueNumber, input.issueNumber)))
    .run();
  return findGitHubIssue(input.projectId, input.issueNumber);
}

/**
 * Переключение опубликованного PR по связанной issue между режимом ревью плана и режимом
 * финальной реализации. PR остаётся в той же ветке issue, меняется только смысл тела ревью.
 */
export function updateGitHubPullRequestMode(
  projectId: string,
  issueNumber: number,
  mode: PullRequestMode,
): GitHubIssueLink | undefined {
  const now = new Date().toISOString();
  // Обновляется только поле режима: PR остается в той же ветке issue, меняется
  // лишь смысл описания, поэтому повторный вызов безопасен.
  log.info({ projectId, issueNumber, prMode: mode }, "GitHub pull request mode updated");
  getDb()
    .update(githubIssues)
    .set({ prMode: mode, updatedAt: now })
    .where(and(eq(githubIssues.projectId, projectId), eq(githubIssues.issueNumber, issueNumber)))
    .run();
  return findGitHubIssue(projectId, issueNumber);
}

// Возвращает null и когда строки нет, и когда поле пустое: для вызывающего это
// один и тот же случай "сравнивать не с чем", поэтому различать их не нужно.
export function getGitHubIssueReviewFingerprint(projectId: string, issueNumber: number): string | null {
  return getDb()
    .select({ value: githubIssues.reviewFingerprint })
    .from(githubIssues)
    .where(and(eq(githubIssues.projectId, projectId), eq(githubIssues.issueNumber, issueNumber)))
    .get()?.value ?? null;
}

/**
 * Обновление только поля lastReviewId у issue после успешно обработанного события ревью
 * плана (одобрение или запрос изменений).
 *
 * Это намеренно отдельная запись одного поля: идентификатор ревью не сохраняется, пока
 * переход состояния не завершился успешно. Иначе временный конфликт CAS внутри
 * markTaskPlanApproved или markTaskPlanChangesRequested приводил бы к безвозвратному
 * пропуску события при повторной попытке.
 */
export function updateGitHubPullRequestLastReviewId(input: {
  projectId: string;
  issueNumber: number;
  lastReviewId: number | null;
}): GitHubIssueLink | undefined {
  const now = new Date().toISOString();
  // Обновляется ровно одно поле по составному ключу issue: lastSyncedAt
  // двигается вместе с ним, чтобы успешно обработанное ревью не выглядело
  // как пропущенная синхронизация.
  getDb()
    .update(githubIssues)
    .set({ lastReviewId: input.lastReviewId, lastSyncedAt: now, updatedAt: now })
    .where(and(eq(githubIssues.projectId, input.projectId), eq(githubIssues.issueNumber, input.issueNumber)))
    .run();
  log.debug(
    { projectId: input.projectId, issueNumber: input.issueNumber, lastReviewId: input.lastReviewId },
    "GitHub pull request lastReviewId updated",
  );
  return findGitHubIssue(input.projectId, input.issueNumber);
}
