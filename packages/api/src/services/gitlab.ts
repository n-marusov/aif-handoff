/**
 * GitLab REST-клиент слоя API.
 *
 * Зачем отдельный сервис: у агента нет ни одного провайдерского токена,
 * поэтому все сетевые обращения к GitLab выполняются здесь, на стороне API,
 * где токен проекта доступен из хранилища. Агент лишь дергает эти эндпоинты.
 *
 * Инварианты, которые держит файл:
 * - отказ HTTP всегда несёт структурированный контекст (`httpStatus`,
 *   `adapterCode`); ветвление по тексту message запрещено, поэтому
 *   коды вычисляет classifyHttpError;
 * - проект адресуется URL-encoded путем `namespace%2Fname`, а не числовым id:
 *   так sync/publish не делают лишний запрос разрешения после connect;
 * - ответы GitLab нетипизированы и частично nullable, поэтому поля сужаются
 *   проверками, а не приведением через `as T`.
 */
import { createHash } from "node:crypto";
import { logger, type GitLabEligibility, type GitLabIssueSnapshot } from "@aif/shared";

const log = logger("gitlab-api");

/**
 * Единая ошибка GitLab-клиента. Структурные поля вынесены наружу намеренно:
 * выше по стеку решения принимаются по `httpStatus` и `adapterCode`, а
 * `message` служит только для логов и диагностики. `retryAt` заполняется
 * исключительно при rate limit и хранит абсолютное время в ISO.
 */
export class GitLabApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly adapterCode:
      | "authentication"
      | "forbidden"
      | "not_found"
      | "rate_limited"
      | "validation"
      | "upstream",
    readonly retryAt: string | null = null,
  ) {
    super(message);
    this.name = "GitLabApiError";
  }
}

/**
 * Ответ GET /projects/:id. Берем минимум полей: connect-валидации нужны
 * только признак существования проекта, его web-адрес и ветка по умолчанию.
 */
interface GitLabProjectResponse {
  id: number;
  path_with_namespace: string;
  web_url: string;
  default_branch: string;
}

/**
 * Задача в том виде, в котором ее отдает REST API. `description`, `author` и
 * `milestone` допускают null, поэтому потребители подставляют значения по
 * умолчанию, а не считают поля всегда заполненными. Метки приходят либо
 * строками, либо объектами - нормализация выполняется на стороне вызова.
 */
interface GitLabIssueResponse {
  id: number;
  iid: number;
  web_url: string;
  state: "opened" | "closed";
  title: string;
  description: string | null;
  author: { username: string } | null;
  labels: Array<{ name?: string } | string>;
  assignees: Array<{ username: string }>;
  milestone: { title: string } | null;
  updated_at: string;
}

/**
 * Заметка к задаче или MR. `system: true` означает событие, созданное самим
 * GitLab (смена статуса, действие ревью), а не сообщение человека.
 */
export interface GitLabNoteResponse {
  id: number;
  body: string | null;
  author: { username: string } | null;
  created_at: string;
  updated_at: string;
  /** Маркер системной записи (смена состояния, действие ревью и т.п.). */
  system?: boolean;
  type?: string | null;
}

/**
 * MR в терминах REST: `iid` - номер внутри проекта, `sha` - вершина
 * head-ветки. `merged_at` заполняется только у смерженных MR.
 */
export interface GitLabMergeRequestResponse {
  iid: number;
  web_url: string;
  state: "opened" | "closed" | "merged" | "locked";
  merged_at: string | null;
  source_branch: string;
  sha: string;
  description: string | null;
}

/**
 * Ответ approvals API. Важно: `approved` приходит выставленным даже когда
 * реальных аппрувов нет - см. latestReviewState ниже.
 */
interface GitLabApprovalResponse {
  approved?: boolean;
  approved_by?: Array<{ user: { username: string } }>;
}

/**
 * Один статус коммита, то есть результат одной job-ы pipeline. `allow_failure`
 * помечает job, провал которой не должен ронять pipeline.
 */
interface GitLabCommitStatusResponse {
  status: "pending" | "running" | "success" | "failed" | "canceled" | "skipped";
  allow_failure: boolean;
}

/** Свернутое состояние проверок; null означает "статусов у коммита нет вовсе". */
type GitLabCheckState = "pending" | "success" | "failure" | null;

/**
 * Статусы, которые не должны блокировать MR. Без этой поблажки проект с
 * необязательными job-ами навсегда застрял бы в pending.
 */
const SUCCESSFUL_STATUSES = new Set(["success", "canceled", "skipped"]);

/**
 * Достает время сброса лимита из заголовков ответа. GitLab отдает либо
 * относительный `retry-after` в секундах, либо абсолютный `ratelimit-reset`;
 * возвращаем ISO-строку, чтобы значение переживало запись в БД и ответ API.
 */
function retryAtFromHeaders(headers: Headers): string | null {
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return new Date(Date.now() + retryAfter * 1000).toISOString();
  }
  const rateLimitReset = headers.get("ratelimit-reset");
  const resetSeconds = Number(rateLimitReset);
  return Number.isFinite(resetSeconds) && resetSeconds > 0
    ? new Date(resetSeconds * 1000).toISOString()
    : null;
}

/**
 * Единственное место, где HTTP-код превращается в категорию для ветвления.
 * Текст сообщения здесь не участвует: он ненадежен и локализуется провайдером.
 */
function classifyHttpError(status: number): GitLabApiError["adapterCode"] {
  if (status === 401) return "authentication";
  if (status === 404) return "not_found";
  if (status === 422) return "validation";
  if (status === 429) return "rate_limited";
  if (status === 403) return "forbidden";
  return "upstream";
}

/**
 * Запросы к проекту GitLab принимают либо числовой project id, либо
 * URL-кодированный путь `namespace%2Fname`. Здесь используется путь, чтобы
 * sync/publish не делали дополнительный resolve-запрос после connect-проверки.
 */
function projectPath(namespace: string, name: string): string {
  return encodeURIComponent(`${namespace}/${name}`);
}

/**
 * Клиент одного токена. Создается на запрос и не кэширует ответы: кэш живет
 * уровнем выше, а здесь важна предсказуемость прав доступа.
 */
export class GitLabClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl: string,
  ) {}

  /**
   * Коды сетевых сбоев, для которых имеет смысл повтор.
   * undici оборачивает DNS/connect/timeout ошибки в TypeError с `cause.code`.
   * В Docker Desktop встроенный DNS иногда кратковременно отдаёт EAI_AGAIN,
   * и один повтор обычно срабатывает после восстановления резолвера.
   */
  private static readonly RETRYABLE_NETWORK_CODES = new Set([
    "EAI_AGAIN",
    "ENOTFOUND",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_NODATA",
    "EAI_NONAME",
  ]);

  /** Две повторные попытки поверх первой; дальше выигрыш не оправдывает задержку. */
  private static readonly MAX_NETWORK_RETRIES = 2;

  /**
   * Отличает сетевой сбой от логической ошибки. undici прячет причину в
   * `cause.code`, поэтому проверяется именно код, а не текст исключения.
   */
  private isRetryableNetworkError(error: unknown): boolean {
    if (!(error instanceof TypeError)) return false;
    const cause = (error as { cause?: { code?: string } }).cause;
    const code = cause?.code;
    if (code && GitLabClient.RETRYABLE_NETWORK_CODES.has(code)) return true;
    // Таймаут от AbortSignal.timeout(30_000) проявляется как DOMException
    // с именем "TimeoutError" (undici помещает его в cause TypeError fetch).
    return code === "TimeoutError" || error.name === "TimeoutError";
  }

  /**
   * Единая точка HTTP-вызова: транспортные ретраи, заголовки авторизации,
   * таймаут и превращение не-2xx в GitLabApiError. Все публичные методы ходят
   * только через него, поэтому политика повторов и классификация не
   * расходятся между эндпоинтами.
   */
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? "GET";
    log.debug({ method, path, baseUrl: this.baseUrl }, "GitLab API request started");

    // Замыкание пересобирает запрос на каждую попытку: init тот же, но сигнал
    // таймаута свежий, иначе повтор унаследовал бы уже истекший дедлайн.
    const attempt = async (): Promise<Response> => {
      return fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(30_000),
        headers: {
          "PRIVATE-TOKEN": this.token,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init.headers,
        },
      });
    };

    let response: Response;
    // Последняя сетевая ошибка держится для диагностики исчерпания попыток.
    let lastNetworkError: unknown;
    for (let attemptIndex = 0; ; attemptIndex += 1) {
      try {
        response = await attempt();
        break;
      } catch (error) {
        lastNetworkError = error;
        // Предел попыток проверяется до классификации: на последней попытке
        // исходная ошибка уходит наружу без лишней задержки.
        if (attemptIndex >= GitLabClient.MAX_NETWORK_RETRIES) throw error;
        if (!this.isRetryableNetworkError(error)) throw error;
        const delayMs = 500 * (attemptIndex + 1);
        log.warn(
          {
            method,
            path,
            retry: attemptIndex + 1,
            delayMs,
            networkCode: (error as { cause?: { code?: string } }).cause?.code ?? null,
          },
          "GitLab API network error, retrying",
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    // Не-2xx превращаем в структурированную ошибку: статус и код категории
    // едут наверх отдельными полями, разбирать текст сообщения нельзя.
    if (!response.ok) {
      // Тело ошибки не гарантировано (прокси может вернуть HTML), поэтому
      // парсинг защищен и допускает null.
      const payload = (await response.json().catch(() => null)) as {
        message?: unknown;
        error?: unknown;
        error_description?: unknown;
      } | null;
      const code = classifyHttpError(response.status);
      const message =
        (typeof payload?.message === "string" && payload.message) ||
        (typeof payload?.message === "object" && payload.message !== null
          ? JSON.stringify(payload.message)
          : // Ошибки GitLab часто содержат `error` + `error_description`
            // (например, запрет по scope fine-grained PAT). Возвращаем их,
            // а не общий statusText, чтобы причина была операционно полезной.
            payload?.error_description
            ? `${String(payload.error)}: ${String(payload.error_description)}`
            : (typeof payload?.error === "string" && payload.error) || response.statusText);
      log.warn(
        { method, path, status: response.status, adapterCode: code },
        "GitLab API request failed",
      );
      // retryAt заполняем только для rate limit: для остальных категорий
      // повтор бессмысленен до вмешательства человека.
      throw new GitLabApiError(
        `GitLab API ${response.status}: ${message}`,
        response.status,
        code,
        code === "rate_limited" ? retryAtFromHeaders(response.headers) : null,
      );
    }
    // Переменная нужна только для диагностики пути ретраев; явное обращение
    // снимает предупреждение линтера о неиспользуемом значении.
    void lastNetworkError;
    log.debug({ method, path, status: response.status }, "GitLab API request completed");
    return (await response.json()) as T;
  }

  /**
   * Постраничный обход списочных эндпоинтов. GitLab не сообщает общее число
   * записей, поэтому признак конца - неполная страница.
   */
  private async list<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page += 1) {
      // Разделитель зависит от наличия query: иначе сломаем уже заданные фильтры.
      const separator = path.includes("?") ? "&" : "?";
      const pageItems = await this.request<T[]>(`${path}${separator}per_page=100&page=${page}`);
      items.push(...pageItems);
      if (pageItems.length < 100) return items;
    }
  }

  /** Проверяет путь namespace/name при connect и возвращает удалённый проект. */
  getRepository(path: string): Promise<GitLabProjectResponse> {
    return this.request(`/projects/${encodeURIComponent(path)}`);
  }

  /**
   * Задачи проекта, включая закрытые. `scope=all` обязателен: без него GitLab
   * вернет только задачи, созданные владельцем токена.
   *
   * state=all (а не state=opened) намерен: слияние MR, чьё описание содержит
   * "Closes #<iid>", автоматически закрывает связанный issue. Если синхронизация
   * видит только открытые задачи, закрытый issue выпадает из цикла, его
   * mrState не обновляется на "merged", и ни роут (`merged → accepted`),
   * ни done-checker (читает mrState из БД) не завершают задачу. GitHub-клиент
   * использует state=all по той же причине; issueIsEligible отсекает закрытые
   * задачи от импорта, а связанные закрытые проходят только MR-reconcile.
   */
  listIssues(namespace: string, name: string): Promise<GitLabIssueResponse[]> {
    const project = projectPath(namespace, name);
    return this.list<GitLabIssueResponse>(
      `/projects/${project}/issues?scope=all&state=all&order_by=updated_at`,
    );
  }

  /** Полная лента заметок задачи - источник человеческих комментариев для планировщика. */
  listIssueNotes(namespace: string, name: string, iid: number): Promise<GitLabNoteResponse[]> {
    const project = projectPath(namespace, name);
    return this.list(`/projects/${project}/issues/${iid}/notes`);
  }

  /** Заметки MR: и системные события ревью, и человеческая обратная связь. */
  listMergeRequestNotes(
    namespace: string,
    name: string,
    mrIid: number,
  ): Promise<GitLabNoteResponse[]> {
    const project = projectPath(namespace, name);
    return this.list(`/projects/${project}/merge_requests/${mrIid}/notes`);
  }

  /** Все MR проекта, включая закрытые: нужны для поиска закрывающей ссылки. */
  listMergeRequests(namespace: string, name: string): Promise<GitLabMergeRequestResponse[]> {
    const project = projectPath(namespace, name);
    return this.list(`/projects/${project}/merge_requests?state=all`);
  }

  /** Один MR по внутреннему номеру проекта (`iid`). */
  getMergeRequest(
    namespace: string,
    name: string,
    mrIid: number,
  ): Promise<GitLabMergeRequestResponse> {
    const project = projectPath(namespace, name);
    return this.request(`/projects/${project}/merge_requests/${mrIid}`);
  }

  /**
   * Ищет MR по ветке-источнику. Фильтр отдан GitLab: так весь список MR не
   * выгружается ради одной записи.
   */
  findMergeRequest(
    namespace: string,
    name: string,
    branch: string,
  ): Promise<GitLabMergeRequestResponse | null> {
    const project = projectPath(namespace, name);
    const rows = this.list<GitLabMergeRequestResponse>(
      `/projects/${project}/merge_requests?state=all&source_branch=${encodeURIComponent(branch)}`,
    );
    return rows.then((items) => items[0] ?? null);
  }

  /**
   * Создает MR. `remove_source_branch: false` выбран осознанно: ветку удаляет
   * агент после подтверждения, иначе повторный прогон потерял бы ссылку.
   */
  createMergeRequest(input: {
    namespace: string;
    name: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
  }): Promise<GitLabMergeRequestResponse> {
    const project = projectPath(input.namespace, input.name);
    return this.request(`/projects/${project}/merge_requests`, {
      method: "POST",
      body: JSON.stringify({
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
        description: input.description,
        remove_source_branch: false,
      }),
    });
  }

  /** Правка заголовка и описания MR - используется при публикации плана. */
  updateMergeRequest(input: {
    namespace: string;
    name: string;
    mrIid: number;
    title: string;
    description: string;
  }): Promise<GitLabMergeRequestResponse> {
    const project = projectPath(input.namespace, input.name);
    return this.request(`/projects/${project}/merge_requests/${input.mrIid}`, {
      method: "PUT",
      body: JSON.stringify({ title: input.title, description: input.description }),
    });
  }

  /** Аппрувы MR, свернутые в `pending` / `approved` (см. latestReviewState). */
  async getMergeRequestApprovals(
    namespace: string,
    name: string,
    mrIid: number,
  ): Promise<{ reviewState: "pending" | "approved" }> {
    const project = projectPath(namespace, name);
    const approvals = await this.request<GitLabApprovalResponse>(
      `/projects/${project}/merge_requests/${mrIid}/approvals`,
    );
    return { reviewState: latestReviewState(approvals).state };
  }

  /**
   * Сворачивает статусы коммита в одно состояние для гейта. Приоритет задается
   * порядком проверок в конце: failure важнее pending, а pending важнее
   * success, чтобы гейт не пропустил MR до завершения pipeline.
   */
  async getCommitChecks(namespace: string, name: string, sha: string): Promise<GitLabCheckState> {
    const project = projectPath(namespace, name);
    const statuses = await this.list<GitLabCommitStatusResponse>(
      `/projects/${project}/repository/commits/${encodeURIComponent(sha)}/statuses`,
    );
    const blockingStates: Exclude<GitLabCheckState, null>[] = [];
    for (const status of statuses) {
      // allow_failure означает, что провал job-ы не блокирует pipeline,
      // поэтому в гейт такая job проходит как успех.
      if (status.status === "failed") {
        blockingStates.push(status.allow_failure ? "success" : "failure");
      } else if (SUCCESSFUL_STATUSES.has(status.status)) {
        blockingStates.push("success");
      } else {
        blockingStates.push("pending");
      }
    }
    const result: GitLabCheckState = blockingStates.includes("failure")
      ? "failure"
      : blockingStates.includes("pending")
        ? "pending"
        : blockingStates.includes("success")
          ? "success"
          : null;
    log.debug(
      { namespace, name, sha, statusCount: statuses.length, result },
      "Folded GitLab commit statuses",
    );
    return result;
  }

  /**
   * Идемпотентная запись заметки с маркером: если заметка с тем же маркером уже
   * есть, она обновляется, а не дублируется. Благодаря этому статус можно
   * публиковать многократно, не засоряя ленту MR.
   */
  async upsertMarkerNote(input: {
    namespace: string;
    name: string;
    mrIid: number;
    marker: string;
    body: string;
  }): Promise<void> {
    // Ищем по маркеру в теле, а не по id: id заметки меняется между
    // прогонами, а маркер - стабильный ключ авторства бота.
    const notes = await this.listMergeRequestNotes(input.namespace, input.name, input.mrIid);
    const existing = notes.find((note) => note.body?.includes(input.marker));
    const body = `${input.marker}\n${input.body}`;
    if (existing) {
      await this.request(
        `/projects/${projectPath(input.namespace, input.name)}/merge_requests/${input.mrIid}/notes/${existing.id}`,
        { method: "PUT", body: JSON.stringify({ body }) },
      );
      return;
    }
    await this.request(
      `/projects/${projectPath(input.namespace, input.name)}/merge_requests/${input.mrIid}/notes`,
      {
        method: "POST",
        body: JSON.stringify({ body }),
      },
    );
  }
}

/**
 * Проверка, что задача подходит под фильтры проекта (метки, исполнитель,
 * веха). Незаданный фильтр означает "не ограничивать": отсутствие требования
 * не должно отсекать задачу.
 */
export function issueIsEligible(
  issue: GitLabIssueResponse,
  eligibility: GitLabEligibility,
): boolean {
  // Метки приходят строками или объектами; нормализуем к строкам и отбрасываем
  // безымянные, иначе проверка includes всегда давала бы false.
  const labels = (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((label): label is string => Boolean(label));
  const hasLabels = eligibility.labels.every((required) => labels.includes(required));
  const hasAssignee = eligibility.assignee
    ? (issue.assignees ?? []).some((assignee) => assignee.username === eligibility.assignee)
    : true;
  const hasMilestone = eligibility.milestone
    ? issue.milestone?.title === eligibility.milestone
    : true;
  return issue.state === "opened" && hasLabels && hasAssignee && hasMilestone;
}

/**
 * Ищет MR, закрывающий задачу, по ключевому слову в описании. Регулярка
 * повторяет синтаксис GitLab (close/fix/resolve) и запрещает совпадение по
 * префиксу номера: ссылка `#12` не должна матчить `#123`.
 */
export function findMergeRequestClosingIssue(
  mergeRequests: GitLabMergeRequestResponse[],
  iid: number,
): GitLabMergeRequestResponse | null {
  const closingReference = new RegExp(
    `\\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\\s+#${iid}(?!\\d)`,
    "i",
  );
  return (
    mergeRequests.find((mr) => mr.description && closingReference.test(mr.description)) ?? null
  );
}

/**
 * Собирает снапшот задачи для планировщика. Комментарии берутся хвостом
 * (последние 100): обсуждение может быть длинным, а бюджет контекста - нет.
 */
export async function toIssueSnapshot(
  client: GitLabClient,
  namespace: string,
  name: string,
  issue: GitLabIssueResponse,
): Promise<GitLabIssueSnapshot> {
  const notes = await client.listIssueNotes(namespace, name, issue.iid);
  return {
    title: issue.title,
    body: issue.description ?? "",
    author: issue.author?.username ?? "unknown",
    labels: (issue.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label.name))
      .filter((label): label is string => Boolean(label)),
    assignees: (issue.assignees ?? []).map((assignee) => assignee.username),
    milestone: issue.milestone?.title ?? null,
    comments: notes.slice(-100).map((note) => ({
      id: note.id,
      author: note.author?.username ?? "unknown",
      body: note.body ?? "",
      webUrl: issue.web_url,
      createdAt: note.created_at,
      updatedAt: note.updated_at,
    })),
  };
}

/** Отпечаток текста ревью: позволяет заметить изменения, не храня все тело. */
export function reviewFingerprint(reviewComments: string): string {
  return createHash("sha256").update(reviewComments).digest("hex");
}

/**
 * Сворачивает ответ approvals API MR в состояние ревью.
 *
 * В GitLab EE (включая проекты gitlab.com без настроенных approval rules)
 * поле `approved: true` может быть формальным: правило считается выполненным
 * даже при нуле обязательных аппрувов. Реальное одобрение подтверждает только
 * непустой `approved_by`, поэтому состояние "approved" зависит от списка
 * одобривших во всех редакциях (CE, EE/Free, Premium).
 */
export function latestReviewState(approvals: GitLabApprovalResponse): {
  state: "pending" | "approved";
} {
  // REQ-FR-integration.pr-mr.resolve-review-decision (критерии 1-2):
  // статус approval требует непустого списка одобривших; формальное
  // `approved: true` без approver-ов не считается реальным одобрением.
  const hasRealApproval = (approvals.approved_by?.length ?? 0) > 0;
  return {
    state: approvals.approved === true && hasRealApproval ? "approved" : "pending",
  };
}

/** Системная заметка, фиксирующая действие ревью MR (approved/changes requested). */
export interface GitLabReviewActionNote {
  id: number;
  body: string | null;
  authorUsername: string | null;
  createdAt: string;
}

/**
 * GitLab пишет системную заметку "approved this merge request" на каждое
 * действие Approve. Якорь `(?:^|\s)` не даёт совпасть строке
 * "unapproved this merge request". Одобрение определяется по этой заметке,
 * потому что это единственный канал событий, доступный на всех тарифах.
 */
const APPROVAL_NOTE_PATTERN = /(?:^|\s)approved this merge request/i;
/** Системная заметка о запросе изменений; формулировку задает сам GitLab. */
const REQUEST_CHANGES_NOTE_PATTERN = /requested changes/i;

/** Приводит REST-заметку к минимальной форме, нужной вызывающему коду. */
function toReviewActionNote(note: GitLabNoteResponse): GitLabReviewActionNote {
  return {
    id: note.id,
    body: note.body,
    authorUsername: note.author?.username ?? null,
    createdAt: note.created_at,
  };
}

/**
 * Находит самую свежую системную заметку GitLab с действием
 * "requested changes". Поиск реализован в сервисе, чтобы логика маршрутов
 * не размазывала проверки шаблонов по payload заметок.
 * Возвращает null, если такой заметки нет.
 */
export function findLatestRequestChangesNote(
  notes: GitLabNoteResponse[],
): GitLabReviewActionNote | null {
  const latest = notes
    .filter((note) => note.system && REQUEST_CHANGES_NOTE_PATTERN.test((note.body ?? "").trim()))
    .sort((a, b) => b.id - a.id)[0];
  return latest ? toReviewActionNote(latest) : null;
}

/**
 * Находит самую свежую системную заметку GitLab с событием "approved".
 * Возвращает null, если заметки нет; вызывающий код использует её id как
 * маркер края для одобрения плана.
 */
export function findLatestApprovalNote(notes: GitLabNoteResponse[]): GitLabReviewActionNote | null {
  const latest = notes
    .filter((note) => note.system && APPROVAL_NOTE_PATTERN.test((note.body ?? "").trim()))
    .sort((a, b) => b.id - a.id)[0];
  return latest ? toReviewActionNote(latest) : null;
}

/**
 * Системные заметки, отменяющие одобрение, даже если заметка
 * "approved this merge request" ещё есть в ленте MR:
 * явное действие "unapproved this merge request" и автоматический
 * сброс "reset approvals ..." после push нового коммита.
 *
 * В GitHub отдельный помощник не нужен: dismiss review перезаписывает состояние
 * самой ревью-строки, и `latestReviewState` не видит устаревший APPROVED.
 * В GitLab заметки только добавляются, поэтому маршрут сравнивает id
 * заметки одобрения с id последней заметки отмены.
 */
const APPROVAL_RESET_NOTE_PATTERNS = [
  /(?:^|\s)unapproved this merge request/i,
  /(?:^|\s)reset approvals?/i,
];

/**
 * Находит самую свежую системную заметку GitLab, отменяющую одобрение
 * (действие unapprove или reset approvals после push).
 * Возвращает null, если такой заметки нет.
 *
 * REQ-FR-integration.pr-mr.resolve-review-decision (критерий 9):
 * отмена аннулирует более раннее одобрение; маршрут сравнивает id заметок
 * и применяет только неотменённые approvals.
 */
export function findLatestApprovalResetNote(
  notes: GitLabNoteResponse[],
): GitLabReviewActionNote | null {
  const latest = notes
    .filter(
      (note) =>
        note.system &&
        APPROVAL_RESET_NOTE_PATTERNS.some((pattern) => pattern.test((note.body ?? "").trim())),
    )
    .sort((a, b) => b.id - a.id)[0];
  return latest ? toReviewActionNote(latest) : null;
}

/**
 * Собирает тексты человеческих (не системных) заметок MR новее `sinceNoteId`
 * в одну строку обратной связи для планировщика.
 * Заметки с `excludeBodyContaining` (например, префиксом маркера AIF)
 * пропускаются, чтобы бот не кормил в перепланирование собственные комментарии.
 * Возвращает null, если новой обратной связи нет.
 */
export function collectMergeRequestHumanFeedback(
  notes: GitLabNoteResponse[],
  sinceNoteId: number,
  excludeBodyContaining: string,
): string | null {
  const parts: string[] = [];
  for (const note of notes) {
    // Системные заметки - это события GitLab, а не реплики людей.
    if (note.system) continue;
    if (note.id <= sinceNoteId) continue;
    const body = (note.body ?? "").trim();
    if (!body) continue;
    // Отсекаем собственные комментарии бота: иначе он перескажет их себе же.
    if (excludeBodyContaining.length > 0 && body.includes(excludeBodyContaining)) continue;
    // Автор в квадратных скобках и обрезка на 2000 символов удерживают промпт
    // в разумных рамках, даже если человек вставил огромный лог.
    parts.push(`[${note.author?.username ?? "unknown"}] ${body.slice(0, 2000)}`);
  }
  // Жесткий лимит на итоговую обратную связь: планировщик получает выжимку,
  // а не весь тред целиком.
  const feedback = parts.join("\n\n").trim().slice(0, 20_000);
  return feedback.length > 0 ? feedback : null;
}
