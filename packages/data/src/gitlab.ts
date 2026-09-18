/**
 * Персистентность интеграции с GitLab: связь проекта с репозиторием, состояние
 * синхронизации, снимки issue и публикация merge request.
 *
 * Модуль намеренно повторяет структуру github.ts: одинаковые имена операций, порядок
 * аргументов и семантика возвращаемых значений. При правке парной функции в github.ts
 * нужно внести такую же правку здесь, иначе провайдеры начнут расходиться в поведении.
 *
 * Все структурированные поля хранятся как JSON-текст и разбираются при чтении безопасно:
 * содержимое могло быть записано другой версией приложения или изменено вручную.
 */
import { and, desc, eq, max } from "drizzle-orm";
import {
  auditEvents,
  generatePlanPath,
  getProjectConfig,
  gitlabIssues,
  gitlabRepositories,
  logger,
  projects,
  taskExecutorHistory,
  tasks,
  type GitLabEligibility,
  type GitLabIssueLink,
  type GitLabIssueRow,
  type GitLabIssueSnapshot,
  type GitLabRepositoryConnection,
  type PullRequestMode,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { createAuditEventValues } from "./audit.js";

// Персистентность интеграции с GitLab: привязка репозитория к проекту,
// состояние подготовки локальной копии и синхронизации, публикация merge
// request и фиксация решения ревью по MR.
//
// Пакет @aif/data - единственный слой, которому разрешен прямой доступ к SQLite
// через drizzle-orm; api, agent и runtime обращаются к базе только через эти
// функции. Поэтому здесь сосредоточены SQL-инварианты: выбор ключа конфликта,
// состав обновляемых колонок и границы транзакций.
//
// Файл сознательно зеркалит github.ts - те же операции над теми же сущностями
// для другого провайдера. Это требование чеклиста пакета: репозиторный API
// должен быть согласован между провайдерами, чтобы вызывающий код не различал
// GitHub и GitLab там, где различие несущественно. При правке парной функции
// проверяй вторую.
//
// Общий принцип файла: одна экспортируемая функция выражает одно намерение,
// а ее имя описывает это намерение целиком.

const log = logger("data:gitlab");
// Общий неизменяемый дефолт для отсутствующих или поврежденных критериев
// отбора. Объект отдается по ссылке, поэтому мутировать его у вызывающего кода
// нельзя.
const DEFAULT_ELIGIBILITY: GitLabEligibility = { labels: [], assignee: null, milestone: null };

// Разбор критериев отбора задач из JSON-колонки eligibility_json. Данные могли
// быть записаны более старой версией схемы или повреждены, поэтому функция
// обязана вернуть валидную структуру при любом входе: исключение здесь уронило
// бы весь обход репозиториев при синхронизации.
function parseEligibility(raw: string): GitLabEligibility {
  try {
    const value: unknown = JSON.parse(raw);
    // Все, что не является обычным объектом, считается отсутствием критериев:
    // JSON.parse может вернуть примитив, null или массив.
    if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_ELIGIBILITY;
    // Единственный каст здесь - к словарю с unknown-значениями; конкретные поля
    // проверяются поштучно, потому что правилами проекта запрещено кастовать
    // тип, отбрасывая возможный null.
    const record = value as Record<string, unknown>;
    return {
      // Нестроковые элементы отбрасываются, а не приводятся к строке: пустая
      // или искаженная метка изменила бы фильтр отбора задач.
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

// Разбор сохраненного снимка issue (заголовок, тело, метки, комментарии),
// который нужен для повторного рендера описания задачи. Данные недоверенные:
// снимок пришел из GitLab API и лежит в текстовой колонке, поэтому каждое поле
// проверяется отдельно.
function parseIssueSnapshot(raw: string): GitLabIssueSnapshot {
  try {
    const value: unknown = JSON.parse(raw);
    // В отличие от критериев отбора неверный корень здесь - ошибка формата, а не
    // допустимое "пусто": сигнал уходит в catch ниже, где возвращается пустой
    // снимок без исключения наружу.
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    return {
      // Отсутствующее поле заменяется безопасным дефолтом (пустая строка,
      // "unknown"), а не пробрасывается как undefined: потребители снимка
      // ожидают полностью заполненную структуру.
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
      // Каждый комментарий проверяется по всем обязательным полям сразу:
      // частично заполненная запись сломала бы рендер описания задачи.
      comments: Array.isArray(record.comments)
        ? record.comments.filter(
            (item): item is GitLabIssueSnapshot["comments"][number] =>
              Boolean(item) &&
              typeof item === "object" &&
              !Array.isArray(item) &&
              typeof (item as Record<string, unknown>).id === "number" &&
              typeof (item as Record<string, unknown>).author === "string" &&
              typeof (item as Record<string, unknown>).body === "string" &&
              typeof (item as Record<string, unknown>).webUrl === "string" &&
              typeof (item as Record<string, unknown>).createdAt === "string" &&
              typeof (item as Record<string, unknown>).updatedAt === "string",
          )
        : [],
    };
  } catch {
    // Битый JSON или неверная форма корня: возвращается пустой снимок, чтобы
    // синхронизация продолжилась, а не прервалась на одной записи.
    return { title: "", body: "", author: "unknown", labels: [], assignees: [], milestone: null, comments: [] };
  }
}

// Преобразование строки таблицы в контракт для вызывающего кода. Слой данных не
// отдает строку БД наружу напрямую: так схему можно менять, не ломая
// потребителей, а разбор JSON-колонок остается в одном месте.
function toIssueLink(row: GitLabIssueRow): GitLabIssueLink {
  return {
    projectId: row.projectId,
    iid: row.iid,
    taskId: row.taskId,
    globalId: row.globalId,
    webUrl: row.webUrl,
    state: row.state,
    // metadata лежит в БД как JSON-текст, наружу отдается уже разобранной
    // структурой; поврежденный JSON не бросает исключение.
    metadata: parseIssueSnapshot(row.metadataJson),
    sourceUpdatedAt: row.sourceUpdatedAt,
    lastSyncedAt: row.lastSyncedAt,
    syncError: row.syncError,
    mrIid: row.mrIid,
    mrUrl: row.mrUrl,
    mrState: row.mrState,
    mrChecksStatus: row.mrChecksStatus,
    mrMode: row.mrMode,
    reviewState: row.reviewState,
    lastReviewNoteId: row.lastReviewNoteId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Маппер строки подключения репозитория в контракт: имя переменной окружения с
// токеном хранится в БД, а сам токен - нет, секреты берутся из окружения.
function toConnection(row: typeof gitlabRepositories.$inferSelect): GitLabRepositoryConnection {
  return {
    projectId: row.projectId,
    namespace: row.namespace,
    name: row.name,
    webUrl: row.webUrl,
    defaultBranch: row.defaultBranch,
    tokenEnvVar: row.tokenEnvVar,
    // eligibility хранится строкой JSON и разбирается с безопасным фолбэком,
    // поэтому невалидное значение не сломает чтение настроек.
    eligibility: parseEligibility(row.eligibilityJson),
    enabled: row.enabled,
    // Признак наличия токена вычисляется на чтение, а не хранится: так он не
    // устаревает при смене окружения и не требует повторной записи в БД.
    // Строка из пробелов считается отсутствием токена.
    tokenConfigured: Boolean(process.env[row.tokenEnvVar]?.trim()),
    lastSyncedAt: row.lastSyncedAt,
    syncError: row.syncError,
    gitPreparedAt: row.gitPreparedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Поиск подключения по первичному ключу projectId. Отсутствие строки - это
// нормальное состояние (проект без интеграции), поэтому возвращается undefined,
// а не исключение: решение о дальнейших шагах принимает вызывающий код.
export function findGitLabRepository(projectId: string): GitLabRepositoryConnection | undefined {
  const row = getDb()
    .select()
    .from(gitlabRepositories)
    .where(eq(gitlabRepositories.projectId, projectId))
    .get();
  return row ? toConnection(row) : undefined;
}

// Список только включенных подключений для фонового обхода синхронизации.
// Фильтр по enabled выполняется в SQL, а не в памяти: выключенные репозитории не
// должны попадать в выборку вообще, иначе их пришлось бы отсеивать в нескольких
// местах и легко было бы забыть про одно из них.
export function listEnabledGitLabRepositories(): GitLabRepositoryConnection[] {
  return getDb()
    .select()
    .from(gitlabRepositories)
    .where(eq(gitlabRepositories.enabled, true))
    .all()
    .map(toConnection);
}

// Создание или обновление подключения к репозиторию. Идемпотентность
// обеспечивает onConflictDoUpdate по projectId: повторный вызов с теми же
// данными не создает вторую строку и не переписывает дату создания.
export function upsertGitLabRepository(input: {
  projectId: string;
  namespace: string;
  name: string;
  webUrl: string;
  defaultBranch: string;
  tokenEnvVar: string;
  eligibility: GitLabEligibility;
  enabled: boolean;
  gitPreparedAt?: string | null;
}): GitLabRepositoryConnection {
  const now = new Date().toISOString();
  getDb()
    .insert(gitlabRepositories)
    .values({
      ...input,
      eligibilityJson: JSON.stringify(input.eligibility),
      syncError: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      // Конфликт разрешается по projectId - это инвариант "одно подключение на
      // проект", а не по паре namespace/name: один и тот же репозиторий может
      // быть подключен к разным проектам независимо.
      target: gitlabRepositories.projectId,
      set: {
        // В set перечислена только изменяемая часть: createdAt намеренно
        // отсутствует, чтобы дата создания пережила повторный upsert.
        namespace: input.namespace,
        name: input.name,
        webUrl: input.webUrl,
        defaultBranch: input.defaultBranch,
        tokenEnvVar: input.tokenEnvVar,
        eligibilityJson: JSON.stringify(input.eligibility),
        enabled: input.enabled,
        // Успешное сохранение подключения сбрасывает прошлую ошибку
        // синхронизации: устаревшая диагностика не должна висеть в интерфейсе.
        syncError: null,
        // Явный ?? null нужен, чтобы отсутствие поля во входе означало сброс
        // отметки о подготовке, а не сохранение старого значения.
        gitPreparedAt: input.gitPreparedAt ?? null,
        updatedAt: now,
      },
    })
    .run();
  log.info(
    { projectId: input.projectId, repository: `${input.namespace}/${input.name}` },
    "GitLab repository connection saved",
  );
  // Возвращается строка, перечитанная из БД, а не собранная из входных данных:
  // так наружу уходят значения по умолчанию и нормализация, примененные SQLite.
  return findGitLabRepository(input.projectId)!;
}

/**
 * Отметка о том, что агент подготовил локальный git-репозиторий для этого подключения
 * (origin, учётные данные, базовая ветка и каркас ai-factory).
 *
 * Возвращается обновлённая связь либо undefined, если подключения у проекта нет.
 */
// Идемпотентная отметка о том, что локальная копия репозитория подготовлена.
// Повторный вызов безопасен: он лишь обновляет метку времени и не трогает
// остальные поля, поэтому не может затереть настройки, сохраненные upsert-ом.
export function markGitLabRepositoryPrepared(projectId: string): GitLabRepositoryConnection | undefined {
  const now = new Date().toISOString();
  // Отсутствие подключения намеренно не создает строку: маркер подготовки не
  // имеет смысла без самого подключения, поэтому возвращается undefined.
  const existing = findGitLabRepository(projectId);
  if (!existing) return undefined;
  getDb()
    .update(gitlabRepositories)
    .set({ gitPreparedAt: now, updatedAt: now })
    .where(eq(gitlabRepositories.projectId, projectId))
    .run();
  log.debug({ projectId, gitPreparedAt: now }, "GitLab repository marked prepared");
  // Перечитанная строка гарантирует, что вызывающий увидит актуальные значения
  // всех колонок, а не только что записанную метку.
  return findGitLabRepository(projectId);
}

// Удаление подключения. Идемпотентно: повторный вызов не бросает исключение, а
// возвращает false. Булев результат сообщает вызывающему, была ли строка реально
// удалена, - это позволяет отличать "удалено" от "уже отсутствовало".
export function deleteGitLabRepository(projectId: string): boolean {
  const result = getDb()
    .delete(gitlabRepositories)
    .where(eq(gitlabRepositories.projectId, projectId))
    .run();
  log.info({ projectId, deleted: result.changes > 0 }, "GitLab repository connection removed");
  return result.changes > 0;
}

// Фиксация результата одной попытки синхронизации: время и текст ошибки.
// Успех передается как error = null и тем самым стирает прошлую ошибку.
// Строка не создается (нет upsert): писать статус синхронизации для
// несуществующего подключения не имеет смысла.
export function recordGitLabRepositorySync(projectId: string, error: string | null): void {
  const now = new Date().toISOString();
  getDb()
    .update(gitlabRepositories)
    .set({ lastSyncedAt: now, syncError: error, updatedAt: now })
    .where(eq(gitlabRepositories.projectId, projectId))
    .run();
}

// Сборка человекочитаемого описания задачи из снимка issue. Порядок блоков
// фиксирован, а пустые части отбрасываются через filter(Boolean): результат
// должен быть детерминированным, потому что importGitLabIssueTask сравнивает
// новое описание с текущим и по этому сравнению решает, обновлять ли задачу.
function renderIssueDescription(input: {
  iid: number;
  webUrl: string;
  snapshot: GitLabIssueSnapshot;
}): string {
  const { snapshot } = input;
  // Контекстные строки собираются одним массивом с null для неприменимых полей,
  // чтобы не накапливать условную конкатенацию.
  const context = [
    `Source: ${input.webUrl}`,
    `Author: @${snapshot.author}`,
    snapshot.labels.length > 0 ? `Labels: ${snapshot.labels.join(", ")}` : null,
    snapshot.assignees.length > 0 ? `Assignees: ${snapshot.assignees.map((name) => `@${name}`).join(", ")}` : null,
    snapshot.milestone ? `Milestone: ${snapshot.milestone}` : null,
  ].filter(Boolean);
  // Комментарии GitLab встраиваются в тело описания как markdown-секции;
  // ссылка на комментарий сохраняется, чтобы читатель мог вернуться к
  // исходной дискуссии в трекере.
  const comments = snapshot.comments.map(
    (comment) => `### @${comment.author} — ${comment.createdAt}\n\n${comment.body}\n\n${comment.webUrl}`,
  );
  return [
    context.join("\n"),
    snapshot.body,
    comments.length > 0 ? `## GitLab comments\n\n${comments.join("\n\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Вход импорта задачи из issue GitLab. Отдельный тип, а не список аргументов:
// полей много, а вызывающий код передает их как один снимок из API, и порядок
// аргументов не должен ничего значить.
export interface ImportGitLabIssueInput {
  projectId: string;
  namespace: string;
  repository: string;
  iid: number;
  globalId: string;
  webUrl: string;
  state: "open" | "closed";
  sourceUpdatedAt: string;
  snapshot: GitLabIssueSnapshot;
  // MR опционален: issue может быть импортирован до публикации merge request.
  // Наличие MR переводит новую задачу сразу в done (см. initialStatus ниже).
  mergeRequest?: {
    iid: number;
    url: string;
    state: "open";
  };
}

// Импорт issue в задачу. Возвращает тройку: актуальную связь issue -> задача,
// идентификатор задачи и признак того, что задача была создана именно этим
// вызовом. Функция идемпотентна по паре (projectId, iid): повторный вызов
// обновляет существующую задачу вместо создания дубликата.
export function importGitLabIssueTask(input: ImportGitLabIssueInput): {
  issue: GitLabIssueLink;
  taskId: string;
  created: boolean;
} {
  const db = getDb();
  const now = new Date().toISOString();
  // Если MR уже опубликован, работа по issue считается завершенной и задача не
  // должна попасть в очередь исполнения.
  const initialStatus = input.mergeRequest ? "done" : "backlog";
  let taskId = "";
  // Переменные объявлены до транзакции, потому что колбэк транзакции ничего не
  // возвращает; результат забирается из внешней области видимости после ее
  // завершения.
  let created = false;

  // Вся запись идет одной транзакцией: связь issue -> задача, сама задача, запись
  // истории владельца и событие аудита должны появиться вместе. Частично
  // примененный импорт оставил бы задачу без связи или без аудита.
  db.transaction((tx) => {
    tx.insert(gitlabIssues)
      .values({
        projectId: input.projectId,
        iid: input.iid,
        globalId: input.globalId,
        webUrl: input.webUrl,
        state: input.state,
        metadataJson: JSON.stringify(input.snapshot),
        sourceUpdatedAt: input.sourceUpdatedAt,
        lastSyncedAt: now,
        ...(input.mergeRequest
          ? {
              mrIid: input.mergeRequest.iid,
              mrUrl: input.mergeRequest.url,
              mrState: input.mergeRequest.state,
            }
          : {}),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        // Составной ключ повторяет первичный ключ таблицы: iid уникален только
        // внутри проекта, в разных проектах номера совпадают.
        target: [gitlabIssues.projectId, gitlabIssues.iid],
        set: {
          // Поля MR пишутся только при наличии mergeRequest: в противном случае
          // спред пустой и уже сохраненные значения MR не затираются.
          globalId: input.globalId,
          webUrl: input.webUrl,
          state: input.state,
          metadataJson: JSON.stringify(input.snapshot),
          sourceUpdatedAt: input.sourceUpdatedAt,
          lastSyncedAt: now,
          syncError: null,
          ...(input.mergeRequest
            ? {
                mrIid: input.mergeRequest.iid,
                mrUrl: input.mergeRequest.url,
                mrState: input.mergeRequest.state,
              }
            : {}),
          updatedAt: now,
        },
      })
      .run();

    // Upsert нужен здесь ради одной цели - получить строку связи вместе с уже
    // существующим taskId: вернуть строку из "insert ... on conflict" одним
    // запросом неудобно, поэтому она перечитывается.
    const linked = tx
      .select()
      .from(gitlabIssues)
      .where(and(eq(gitlabIssues.projectId, input.projectId), eq(gitlabIssues.iid, input.iid)))
      .get();
    // Строка обязана существовать сразу после upsert; ее отсутствие означает
    // нарушение инварианта, и продолжать нельзя.
    if (!linked) throw new Error("GitLab issue upsert did not return a row");

    const title = `#${input.iid} ${input.snapshot.title}`;
    const description = renderIssueDescription(input);
    // Метка gitlab добавляется всегда и не дублируется: Set отбрасывает повторы,
    // если такая метка уже пришла из issue. Ограничение в 50 меток защищает
    // карточку доски от визуального переполнения.
    const tags = [...new Set(["gitlab", ...input.snapshot.labels])].slice(0, 50);
    // Ветка обновления: связь уже указывает на задачу, значит задача существует и
    // нужно лишь синхронизировать ее содержимое.
    if (linked.taskId) {
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
          { projectId: input.projectId, iid: input.iid, taskId },
          "[FIX] GitLab sync skipped unchanged task row to avoid masking stale-claim recovery",
        );
      }
      // Ранний выход: существующая задача обновлена, создавать новую не нужно.
      return;
    }

    // Ветка создания: связи с задачей нет. Проект обязателен - без его rootPath
    // нельзя вычислить путь к плану, поэтому отсутствие проекта считается
    // ошибкой данных, а не штатной ситуацией.
    const project = tx.select().from(projects).where(eq(projects.id, input.projectId)).get();
    if (!project) throw new Error(`Project ${input.projectId} not found`);
    taskId = crypto.randomUUID();
    // Новая задача ставится в конец доски: позиция берется как максимум по
    // проекту плюс шаг. maxPosition может быть null (пустая доска), поэтому есть
    // фолбэк 1000.
    const maxPosition = tx
      .select({ value: max(tasks.position) })
      .from(tasks)
      .where(eq(tasks.projectId, input.projectId))
      .get()?.value;
    // Путь к плану детерминированно выводится из номера issue: повторный импорт
    // той же issue всегда указывает на тот же файл плана.
    const config = getProjectConfig(project.rootPath);
    const planPath = generatePlanPath(`gitlab-issue-${input.iid}`, "full", {
      plansDir: config.paths.plans,
      defaultPlanPath: config.paths.plan,
    });
    // Импортированная из трекера задача сразу готова к автономному прогону:
    // autoMode и владелец ai означают, что координатор подхватит ее без ручного
    // вмешательства, а paused выставляется по состоянию issue, чтобы закрытая в
    // GitLab задача не исполнялась.
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
        autoQueueCommitBaseSha: null,
        paused: input.state === "closed",
        tags: JSON.stringify(tags),
        status: initialStatus,
        position: Number(maxPosition ?? 1000) + 100,
        lastHeartbeatAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // Событие истории фиксирует, что владельцем задачи стала система, а не
    // человек; revision 0 - стартовое значение до первой смены владельца.
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
        actorId: "gitlab-sync",
        actorDisplayNameSnapshot: "GitLab Sync",
        reason: "gitlab_issue_imported",
        createdAt: now,
      })
      .run();
    // Аудит пишется тем же helper-ом, что и в остальных путях создания задач:
    // он сам заполняет обязательные поля и не позволяет записать событие без
    // снимков заголовка, владельца и статуса.
    tx.insert(auditEvents)
      .values(
        createAuditEventValues({
          action: "gitlab.issue_imported",
          entityType: "task",
          entityId: taskId,
          taskId,
          taskTitleSnapshot: title,
          executionOwnerSnapshot: "ai",
          assigneesSnapshot: [],
          statusSnapshot: initialStatus,
          actor: { kind: "system", id: "gitlab-sync", displayNameSnapshot: "GitLab Sync" },
          metadata: {
            repository: `${input.namespace}/${input.repository}`,
            iid: input.iid,
            ...(input.mergeRequest ? { mrIid: input.mergeRequest.iid } : {}),
          },
          createdAt: now,
        }),
      )
      .run();
    // Обратная связь: только теперь связь получает taskId. Порядок важен -
    // задача и аудит уже существуют, поэтому значение внешнего ключа валидно.
    tx.update(gitlabIssues)
      .set({ taskId, updatedAt: now })
      .where(and(eq(gitlabIssues.projectId, input.projectId), eq(gitlabIssues.iid, input.iid)))
      .run();
    created = true;
  });

  // Связь перечитывается вне транзакции: наружу должен уйти полный контракт со
  // всеми полями, включая те, что не участвовали в записи.
  const issue = findGitLabIssue(input.projectId, input.iid);
  // Сюда можно попасть только при нарушении инвариантов выше (например, если
  // транзакция откатилась): явная ошибка вместо возврата неполного объекта.
  if (!issue || !taskId) throw new Error("GitLab issue import failed");
  log.info({ projectId: input.projectId, iid: input.iid, taskId, created }, "GitLab issue synchronized");
  return { issue, taskId, created };
}

// Поиск связи по составному ключу (projectId, iid). undefined означает, что issue
// еще не импортирован: это ожидаемое состояние при первом обходе трекера.
export function findGitLabIssue(projectId: string, iid: number): GitLabIssueLink | undefined {
  const row = getDb()
    .select()
    .from(gitlabIssues)
    .where(and(eq(gitlabIssues.projectId, projectId), eq(gitlabIssues.iid, iid)))
    .get();
  return row ? toIssueLink(row) : undefined;
}

// Обратный поиск по taskId. Колонка taskId уникальна, но допускает несколько
// NULL (связь без созданной задачи), поэтому результат либо один, либо его нет.
export function findGitLabIssueByTaskId(taskId: string): GitLabIssueLink | undefined {
  const row = getDb().select().from(gitlabIssues).where(eq(gitlabIssues.taskId, taskId)).get();
  return row ? toIssueLink(row) : undefined;
}

// Список связей проекта для интерфейса. Сортировка по убыванию iid ставит самые
// свежие issue сверху; порядок задается в SQL, чтобы не зависеть от порядка
// строк в таблице.
export function listGitLabIssues(projectId: string): GitLabIssueLink[] {
  return getDb()
    .select()
    .from(gitlabIssues)
    .where(eq(gitlabIssues.projectId, projectId))
    .orderBy(desc(gitlabIssues.iid))
    .all()
    .map(toIssueLink);
}

// Пометка issue как недоступного (например, удален в GitLab или API отдает
// ошибку доступа). Запись ошибки и постановка задачи на паузу выполняются в
// одной транзакции, чтобы не появилось состояние "ошибка записана, а задача
// продолжает исполняться".
export function markGitLabIssueUnavailable(projectId: string, iid: number, error: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction((tx) => {
    const issue = tx
      .select({ taskId: gitlabIssues.taskId })
      .from(gitlabIssues)
      .where(and(eq(gitlabIssues.projectId, projectId), eq(gitlabIssues.iid, iid)))
      .get();
    // Прочие поля связи намеренно не трогаются: недоступность - это диагностика,
    // а не смена состояния импортированной issue.
    tx.update(gitlabIssues)
      .set({ syncError: error, lastSyncedAt: now, updatedAt: now })
      .where(and(eq(gitlabIssues.projectId, projectId), eq(gitlabIssues.iid, iid)))
      .run();
    // Пауза, а не удаление задачи: ручные изменения и история задачи должны
    // пережить временную недоступность issue. Если связи с задачей нет, паузить
    // нечего: этот случай допустим.
    if (issue?.taskId) {
      tx.update(tasks)
        .set({ paused: true, updatedAt: now })
        .where(eq(tasks.id, issue.taskId))
        .run();
    }
  });
}

// Запись состояния merge request по связанной issue. Необязательные поля
// меняются только при явной передаче: проверка на undefined (а не на истинность)
// позволяет осознанно записать null и тем самым очистить значение.
export function updateGitLabMergeRequest(input: {
  projectId: string;
  iid: number;
  mrIid: number;
  mrUrl: string;
  mrState: "open" | "closed" | "merged";
  mrChecksStatus?: "pending" | "success" | "failure" | null;
  reviewState?: "pending" | "approved" | null;
  reviewFingerprint?: string | null;
  lastReviewNoteId?: number | null;
}): GitLabIssueLink | undefined {
  const now = new Date().toISOString();
  getDb()
    .update(gitlabIssues)
    .set({
      mrIid: input.mrIid,
      mrUrl: input.mrUrl,
      mrState: input.mrState,
      // Патч собирается условными спредами: обновляются ровно те колонки,
      // которые присутствуют в объекте, остальные сохраняют прежние значения.
      ...(input.mrChecksStatus !== undefined ? { mrChecksStatus: input.mrChecksStatus } : {}),
      ...(input.reviewState !== undefined ? { reviewState: input.reviewState } : {}),
      ...(input.reviewFingerprint !== undefined ? { reviewFingerprint: input.reviewFingerprint } : {}),
      ...(input.lastReviewNoteId !== undefined
        ? { lastReviewNoteId: input.lastReviewNoteId }
        : {}),
      // Успешная синхронизация MR сбрасывает прошлую ошибку и обновляет время
      // последней синхронизации.
      syncError: null,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .where(and(eq(gitlabIssues.projectId, input.projectId), eq(gitlabIssues.iid, input.iid)))
    .run();
  // Возвращается перечитанная связь: undefined здесь означает, что строка исчезла
  // между update и чтением (например, issue удален параллельно).
  return findGitLabIssue(input.projectId, input.iid);
}

/**
 * Запись маркера обработанной заметки ревью MR после успешно применённого решения
 * (одобрение плана или запрос изменений).
 *
 * Это намеренно отдельная запись одного поля: маркер не сохраняется, пока переход
 * состояния не завершился успешно. Временный конфликт CAS остаётся повторяемым при
 * следующей синхронизации вместо безвозвратной потери события ревью. Повторяет
 * updateGitHubPullRequestLastReviewId; см. инцидент с выжиганием маркера 2026-09-11.
 *
 * REQ-FR-integration.pr-mr.resolve-review-decision, критерии 11-12:
 *   маркер фиксируется только после успешного перехода; при конфликте событие
 *   остаётся необработанным и повторяется на следующей синхронизации.
 * REQ-NFR-integration.compliance.review-event-idempotency:
 *   однократность применения, отсутствие потери, наблюдаемость отказа.
 */
export function updateGitLabMergeRequestLastReviewNoteId(input: {
  projectId: string;
  iid: number;
  lastReviewNoteId: number | null;
}): GitLabIssueLink | undefined {
  const now = new Date().toISOString();
  // Отладочный лог пишется до записи: он фиксирует намерение и позволяет по
  // логам понять, был ли метод вызван при конфликте версий.
  log.debug(
    {
      projectId: input.projectId,
      iid: input.iid,
      lastReviewNoteId: input.lastReviewNoteId,
    },
    "GitLab merge request lastReviewNoteId updated",
  );
  // Одиночный UPDATE без явной транзакции: атомарность обеспечивает сам SQL, а
  // список изменяемых колонок сведен к одной значимой - маркеру обработки ревью.
  // Именно поэтому метод не слит с updateGitLabMergeRequest: тот сбрасывает
  // syncError и пишет состояние MR, чего здесь быть не должно.
  getDb()
    .update(gitlabIssues)
    .set({ lastReviewNoteId: input.lastReviewNoteId, lastSyncedAt: now, updatedAt: now })
    .where(and(eq(gitlabIssues.projectId, input.projectId), eq(gitlabIssues.iid, input.iid)))
    .run();
  return findGitLabIssue(input.projectId, input.iid);
}

/**
 * Переключение опубликованного MR по связанной issue между режимом ревью плана и режимом
 * финальной реализации. MR остаётся в той же ветке issue, меняется только смысл описания.
 */
export function updateGitLabMergeRequestMode(
  projectId: string,
  iid: number,
  mode: PullRequestMode,
): GitLabIssueLink | undefined {
  const now = new Date().toISOString();
  log.info({ projectId, iid, mrMode: mode }, "GitLab merge request mode updated");
  // Обновляются только mrMode и updatedAt. Поля синхронизации (syncError,
  // lastSyncedAt) не трогаются: переключение режима - локальное действие над уже
  // опубликованным MR, а не результат обращения к GitLab API.
  getDb()
    .update(gitlabIssues)
    .set({ mrMode: mode, updatedAt: now })
    .where(and(eq(gitlabIssues.projectId, projectId), eq(gitlabIssues.iid, iid)))
    .run();
  return findGitLabIssue(projectId, iid);
}

// Отпечаток последнего обработанного ревью. Нормализация undefined -> null
// избавляет вызывающий код от двух проверок на отсутствие: null одинаково
// означает "нет данных" и "строки нет".
export function getGitLabIssueReviewFingerprint(projectId: string, iid: number): string | null {
  return (
    getDb()
      .select({ value: gitlabIssues.reviewFingerprint })
      .from(gitlabIssues)
      .where(and(eq(gitlabIssues.projectId, projectId), eq(gitlabIssues.iid, iid)))
      .get()?.value ?? null
  );
}
