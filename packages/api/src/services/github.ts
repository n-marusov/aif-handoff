/**
 * GitHub REST-клиент слоя API.
 *
 * Симметричен gitlab.ts: тот же набор операций (задачи, PR/MR, комментарии,
 * ревью, проверки коммита) и та же причина существования - агент не держит
 * провайдерских токенов, поэтому весь сетевой доступ к GitHub идет отсюда.
 *
 * Отличия, продиктованные самим GitHub:
 * - задачи и PR живут в одном эндпоинте `/issues`, поэтому listIssues
 *   отфильтровывает записи с признаком `pull_request`;
 * - проверки коммита приходят из двух источников (combined status и
 *   check-runs), и оба считаются best-effort, а не гейтом доступа;
 * - ревью - отдельные сущности, поэтому latestReviewState читает их список
 *   напрямую, без эвристик по системным заметкам (как в GitLab).
 *
 * Инвариант тот же, что и у GitLab-клиента: отказ HTTP сохраняет
 * структурированный контекст (`httpStatus`, `adapterCode`), и выше по стеку
 * ветвление идет по полям, а не по тексту сообщения.
 */
import { createHash } from "node:crypto";
import { logger, type GitHubEligibility, type GitHubIssueSnapshot } from "@aif/shared";

const log = logger("github-api");
const API_BASE = "https://api.github.com";

/**
 * Единая ошибка GitHub-клиента. Структурные поля вынесены наружу намеренно:
 * решения наверху принимаются по `httpStatus` и `adapterCode`, а `message`
 * служит только для логов и диагностики. `retryAt` заполняется исключительно
 * при rate limit и хранит абсолютное время в ISO.
 */
export class GitHubApiError extends Error {
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
    this.name = "GitHubApiError";
  }
}

/** Ответ GET /repos/:owner/:repo - минимум полей для connect-валидации. */
interface GitHubRepositoryResponse {
  name: string;
  full_name: string;
  html_url: string;
  default_branch: string;
  owner: { login: string };
}

/**
 * Запись из /issues. GitHub отдает в этом же эндпоинте и PR, поэтому признак
 * `pull_request` обязателен к проверке (см. listIssues). `body`, `user` и
 * `milestone` могут быть null, а `comments` - это счетчик, не список.
 */
interface GitHubIssueResponse {
  number: number;
  node_id: string;
  html_url: string;
  state: "open" | "closed";
  title: string;
  body: string | null;
  user: { login: string } | null;
  labels: Array<{ name?: string } | string>;
  assignees: Array<{ login: string }>;
  milestone: { title: string } | null;
  comments: number;
  updated_at: string;
  pull_request?: unknown;
}

/** Комментарий к задаче или PR; `id` стабилен в пределах репозитория. */
interface GitHubCommentResponse {
  id: number;
  body: string | null;
  html_url: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

/**
 * PR: `number` - номер в репозитории, `head.sha` - вершина исходной ветки.
 * `merged_at` заполняется только у смерженных PR.
 */
export interface GitHubPullResponse {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  body: string | null;
  head: { sha: string };
}

/**
 * Ревью целиком, а не событие: GitHub хранит состояние отзыва в самой записи,
 * поэтому сортировка по времени отправки дает актуальное решение.
 */
interface GitHubReviewResponse {
  id: number;
  state: string;
  body: string | null;
  submitted_at: string | null;
}

/** Свернутое состояние проверок; null означает, что проверок нет вовсе. */
type GitHubCheckState = "pending" | "success" | "failure" | null;

/** Старый combined status API; `total_count` может отсутствовать в ответе. */
interface GitHubCombinedStatusResponse {
  state: "pending" | "success" | "failure" | "error";
  total_count?: number;
  statuses?: unknown[];
}

/** Отдельный check run: пока `status` не completed, итог проверки не ясен. */
interface GitHubCheckRunResponse {
  status: string;
  conclusion: string | null;
}

/** Постраничная выдача check-runs с общим числом, нужным для остановки обхода. */
interface GitHubCheckRunsResponse {
  total_count: number;
  check_runs: GitHubCheckRunResponse[];
}

/**
 * Нейтральные и пропущенные проверки не должны блокировать PR; иначе проект
 * с необязательными job-ами навсегда остался бы красным.
 */
const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Достает время сброса лимита из заголовков. GitHub отдает либо
 * относительный `retry-after` в секундах, либо абсолютный
 * `x-ratelimit-reset`; возвращаем ISO-строку, чтобы значение переживало
 * запись в БД и ответ API. Логика намеренно совпадает с gitlab.ts -
 * контракт retryAt одинаков для обоих провайдеров.
 */
function retryAtFromHeaders(headers: Headers): string | null {
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return new Date(Date.now() + retryAfter * 1000).toISOString();
  }
  const resetSeconds = Number(headers.get("x-ratelimit-reset"));
  return Number.isFinite(resetSeconds) && resetSeconds > 0
    ? new Date(resetSeconds * 1000).toISOString()
    : null;
}

/**
 * Единственное место, где HTTP-код превращается в категорию для ветвления.
 * GitHub отдает 403 и при нехватке прав, и при исчерпании лимита, поэтому
 * rate_limited отличается по заголовку `x-ratelimit-remaining`, а не по тексту.
 */
function classifyHttpError(status: number, headers: Headers): GitHubApiError["adapterCode"] {
  if (status === 401) return "authentication";
  if (status === 404) return "not_found";
  if (status === 422) return "validation";
  if (status === 429 || (status === 403 && headers.get("x-ratelimit-remaining") === "0")) {
    return "rate_limited";
  }
  if (status === 403) return "forbidden";
  return "upstream";
}

/** Клиент одного токена; создается на запрос и не кэширует ответы. */
export class GitHubClient {
  constructor(private readonly token: string) {}

  /**
   * Единая точка HTTP-вызова: базовый URL, заголовки авторизации и версии API,
   * таймаут и превращение не-2xx в GitHubApiError. Публичные методы ходят
   * только через него, поэтому обработка отказов не расходится по эндпоинтам.
   */
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? "GET";
    log.debug({ method, path }, "GitHub API request started");
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
    });
    // Не-2xx превращаем в структурированную ошибку: статус и код категории
    // уезжают наверх отдельными полями, текст сообщения не разбирается.
    if (!response.ok) {
      // Тело ошибки не гарантировано, поэтому парсинг защищен и допускает null.
      const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;
      const code = classifyHttpError(response.status, response.headers);
      const message = typeof payload?.message === "string" ? payload.message : response.statusText;
      log.warn(
        { method, path, status: response.status, adapterCode: code },
        "GitHub API request failed",
      );
      // retryAt заполняем только для rate limit: для остальных категорий
      // повтор бессмысленен до вмешательства человека.
      throw new GitHubApiError(
        `GitHub API ${response.status}: ${message}`,
        response.status,
        code,
        code === "rate_limited" ? retryAtFromHeaders(response.headers) : null,
      );
    }
    log.debug({ method, path, status: response.status }, "GitHub API request completed");
    return (await response.json()) as T;
  }

  /**
   * Постраничный обход списочных эндпоинтов. GitHub отдает `Link`-заголовки,
   * но проще и надежнее ориентироваться на неполную страницу, как в gitlab.ts,
   * чтобы поведение обоих клиентов оставалось одинаковым.
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

  /**
   * Проверка доступа к репозиторию на этапе connect. Владелец и имя
   * кодируются по отдельности: они уже разбиты и не содержат слэша.
   */
  getRepository(owner: string, repository: string): Promise<GitHubRepositoryResponse> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`);
  }

  /**
   * Задачи репозитория. Эндпоинт /issues отдает и PR тоже, поэтому записи с
   * признаком `pull_request` отфильтровываются: иначе PR попали бы в очередь
   * задач как обычные issues.
   */
  async listIssues(owner: string, repository: string): Promise<GitHubIssueResponse[]> {
    const rows = await this.list<GitHubIssueResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues?state=all&sort=updated&direction=desc`,
    );
    // Записи с полем pull_request - это PR, а не задачи.
    return rows.filter((row) => row.pull_request === undefined);
  }

  /** Комментарии задачи: человеческая обратная связь для планировщика. */
  listIssueComments(
    owner: string,
    repository: string,
    issueNumber: number,
  ): Promise<GitHubCommentResponse[]> {
    return this.list(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issueNumber}/comments`,
    );
  }

  /** Один PR по номеру в репозитории. */
  getPullRequest(owner: string, repository: string, prNumber: number): Promise<GitHubPullResponse> {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${prNumber}`,
    );
  }

  /**
   * Ищет PR по ветке. GitHub требует квалификатор `owner:branch`, иначе фильтр
   * по head не сработает для ветки из форка.
   */
  async findPullRequest(
    owner: string,
    repository: string,
    branch: string,
  ): Promise<GitHubPullResponse | null> {
    const pulls = await this.list<GitHubPullResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    );
    return pulls[0] ?? null;
  }

  /** Открытые PR: нужны для сверки состояния перед публикацией. */
  listOpenPullRequests(owner: string, repository: string): Promise<GitHubPullResponse[]> {
    return this.list(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls?state=open`,
    );
  }

  /**
   * Создает PR. `draft: false` задан явно: гейт ревью ожидает PR, готовый к
   * проверке, а черновик ведет себя иначе с точки зрения событий и статусов.
   */
  createPullRequest(input: {
    owner: string;
    repository: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<GitHubPullResponse> {
    return this.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls`,
      {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
          draft: false,
        }),
      },
    );
  }

  /** Правка заголовка и тела PR - используется при обновлении плана. */
  updatePullRequest(input: {
    owner: string;
    repository: string;
    prNumber: number;
    title: string;
    body: string;
  }): Promise<GitHubPullResponse> {
    return this.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls/${input.prNumber}`,
      { method: "PATCH", body: JSON.stringify({ title: input.title, body: input.body }) },
    );
  }

  /** Все ревью PR; свертку в состояние делает latestReviewState. */
  listReviews(
    owner: string,
    repository: string,
    prNumber: number,
  ): Promise<GitHubReviewResponse[]> {
    return this.list(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${prNumber}/reviews`,
    );
  }

  /**
   * Постраничный обход check-runs. Останавливается либо на неполной странице,
   * либо при достижении total_count: GitHub иногда отдает пустые хвостовые
   * страницы, и без второго условия обход завершался бы лишними запросами.
   */
  private async listCheckRuns(
    owner: string,
    repository: string,
    sha: string,
  ): Promise<GitHubCheckRunResponse[]> {
    const runs: GitHubCheckRunResponse[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.request<GitHubCheckRunsResponse>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(sha)}/check-runs?filter=latest&per_page=100&page=${page}`,
      );
      runs.push(...response.check_runs);
      if (response.check_runs.length < 100 || runs.length >= response.total_count) return runs;
    }
  }

  /**
   * Сворачивает два независимых источника проверок в одно состояние. Оба
   * запроса best-effort и идут параллельно, поэтому недоступность одного не
   * роняет публикацию PR. Приоритет при свертке: failure важнее pending, а
   * pending важнее success, чтобы гейт не пропустил PR до конца проверок.
   */
  async getCommitChecks(owner: string, repository: string, sha: string): Promise<GitHubCheckState> {
    // Проверки коммита — best-effort диагностика. Публикация PR никогда не
    // должна падать из-за недоступности эндпоинта проверок (например, у токена
    // нет права Checks). Скатываемся на тот эндпоинт, который сработал.
    const [statusResult, checksResult] = await Promise.all([
      this.request<GitHubCombinedStatusResponse>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(sha)}/status`,
      ).then(
        (status) => ({ ok: true as const, status }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      this.listCheckRuns(owner, repository, sha).then(
        (checkRuns) => ({ ok: true as const, checkRuns }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]);
    if (!statusResult.ok && !checksResult.ok) {
      // Оба источника молчат - считаем, что данных о проверках нет, и не
      // блокируем публикацию PR: это диагностика, а не гейт доступа.
      log.warn(
        { owner, repository, sha },
        "Both commit status and check-runs endpoints unavailable; returning null checks",
      );
      return null;
    }
    if (!statusResult.ok) {
      log.warn(
        { owner, repository, sha },
        "Commit status endpoint unavailable; falling back to check-runs only",
      );
    }
    if (!checksResult.ok) {
      log.warn(
        { owner, repository, sha },
        "Check-runs endpoint unavailable (token may lack Checks permission); falling back to commit status only",
      );
    }
    const states: Exclude<GitHubCheckState, null>[] = [];
    if (statusResult.ok) {
      const status = statusResult.status;
      const legacyCount = status.total_count ?? status.statuses?.length;
      // Пустой combined status (total_count = 0) не считается проверкой:
      // иначе PR без CI выглядел бы как успешно проверенный.
      if (legacyCount === undefined || legacyCount > 0) {
        states.push(status.state === "error" ? "failure" : status.state);
      }
    }
    if (checksResult.ok) {
      // Незавершенный check run держит гейт в pending, завершенный решается
      // по conclusion: нейтральные и пропущенные считаются успехом.
      for (const run of checksResult.checkRuns) {
        if (run.status !== "completed") {
          states.push("pending");
        } else {
          states.push(
            run.conclusion && SUCCESSFUL_CHECK_CONCLUSIONS.has(run.conclusion)
              ? "success"
              : "failure",
          );
        }
      }
    }
    const result: GitHubCheckState = states.includes("failure")
      ? "failure"
      : states.includes("pending")
        ? "pending"
        : states.includes("success")
          ? "success"
          : null;
    log.debug(
      {
        owner,
        repository,
        sha,
        legacyCount: statusResult.ok ? (statusResult.status.total_count ?? null) : null,
        checkRunCount: checksResult.ok ? checksResult.checkRuns.length : 0,
        result,
      },
      "Combined GitHub commit statuses and check runs",
    );
    return result;
  }

  /**
   * Идемпотентная запись комментария с маркером: существующий обновляется,
   * новый создается. Маркер - стабильный ключ авторства бота, в отличие от id
   * комментария, который меняется между прогонами.
   */
  async upsertMarkerComment(input: {
    owner: string;
    repository: string;
    issueNumber: number;
    marker: string;
    body: string;
  }): Promise<void> {
    const comments = await this.listIssueComments(input.owner, input.repository, input.issueNumber);
    const existing = comments.find((comment) => comment.body?.includes(input.marker));
    const body = `${input.marker}\n${input.body}`;
    if (existing) {
      await this.request(
        `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/issues/comments/${existing.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ body }),
        },
      );
      return;
    }
    await this.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/issues/${input.issueNumber}/comments`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
  }
}

/**
 * Проверка соответствия задачи фильтрам проекта (метки, исполнитель, веха).
 * Незаданный фильтр означает "не ограничивать": отсутствие требования не
 * должно отсекать задачу.
 */
export function issueIsEligible(
  issue: GitHubIssueResponse,
  eligibility: GitHubEligibility,
): boolean {
  // Метки приходят строками или объектами; нормализуем к строкам и отбрасываем
  // безымянные, иначе проверка includes всегда давала бы false.
  const labels = issue.labels
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((label): label is string => Boolean(label));
  const hasLabels = eligibility.labels.every((required) => labels.includes(required));
  const hasAssignee = eligibility.assignee
    ? issue.assignees.some((assignee) => assignee.login === eligibility.assignee)
    : true;
  const hasMilestone = eligibility.milestone
    ? issue.milestone?.title === eligibility.milestone
    : true;
  return issue.state === "open" && hasLabels && hasAssignee && hasMilestone;
}

/**
 * Ищет PR, закрывающий задачу, по ключевому слову в теле. Регулярка повторяет
 * синтаксис GitHub (close/fix/resolve) и запрещает совпадение по префиксу
 * номера: ссылка `#12` не должна матчить `#123`. Логика совпадает с
 * findMergeRequestClosingIssue из gitlab.ts.
 */
export function findPullRequestClosingIssue(
  pulls: GitHubPullResponse[],
  issueNumber: number,
): GitHubPullResponse | null {
  const closingReference = new RegExp(
    `\\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\\s+#${issueNumber}(?!\\d)`,
    "i",
  );
  return pulls.find((pull) => pull.body && closingReference.test(pull.body)) ?? null;
}

/**
 * Собирает снапшот задачи для планировщика. Комментарии запрашиваются только
 * когда счетчик `comments` больше нуля: так лишний запрос не делается, а в
 * снапшот попадает хвост из последних 100 сообщений.
 */
export async function toIssueSnapshot(
  client: GitHubClient,
  owner: string,
  repository: string,
  issue: GitHubIssueResponse,
): Promise<GitHubIssueSnapshot> {
  const comments =
    issue.comments > 0 ? await client.listIssueComments(owner, repository, issue.number) : [];
  return {
    title: issue.title,
    body: issue.body ?? "",
    author: issue.user?.login ?? "unknown",
    labels: issue.labels
      .map((label) => (typeof label === "string" ? label : label.name))
      .filter((label): label is string => Boolean(label)),
    assignees: issue.assignees.map((assignee) => assignee.login),
    milestone: issue.milestone?.title ?? null,
    comments: comments.slice(-100).map((comment) => ({
      id: comment.id,
      author: comment.user?.login ?? "unknown",
      body: comment.body ?? "",
      htmlUrl: comment.html_url,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    })),
  };
}

/** Отпечаток текста ревью: позволяет заметить изменения, не храня все тело. */
export function reviewFingerprint(reviewComments: string): string {
  return createHash("sha256").update(reviewComments).digest("hex");
}

/**
 * Сворачивает список ревью в актуальное решение. Учитываются только APPROVED
 * и CHANGES_REQUESTED: обычные комментарии и устаревшие состояния не должны
 * затирать решение. GitHub хранит состояние в самой записи ревью, поэтому
 * сортировка по времени отправки и выбор первой записи дают последнее слово.
 * Этим функция отличается от gitlab.ts, где состояние собирается из
 * системных заметок таймлайна.
 */
export function latestReviewState(reviews: GitHubReviewResponse[]): {
  id: number | null;
  state: "pending" | "approved" | "changes_requested";
  body: string | null;
} {
  const latest = [...reviews]
    .filter((review) => review.state === "APPROVED" || review.state === "CHANGES_REQUESTED")
    .sort((left, right) => (right.submitted_at ?? "").localeCompare(left.submitted_at ?? ""))[0];
  if (!latest) return { id: null, state: "pending", body: null };
  return {
    id: latest.id,
    state: latest.state === "APPROVED" ? "approved" : "changes_requested",
    body: latest.body,
  };
}
