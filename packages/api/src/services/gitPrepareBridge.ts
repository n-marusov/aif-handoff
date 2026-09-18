/**
 * Мост из API-слоя в git-prepare эндпоинт агента.
 *
 * Зачем отдельный файл: сам git-prepare живет в агенте (у него есть доступ к файловой
 * системе проекта и git-кредам), но инициирует его именно API — пользователь нажимает
 * "Connect" или "Sync now" в веб-интерфейсе. Поэтому здесь нет бизнес-логики, только
 * один HTTP-вызов и нормализация ответа в плоский результат.
 *
 * Инварианты, которые нельзя терять:
 * - Функции никогда не бросают исключение. Ошибка транспорта или ненулевой статус
 *   превращаются в `{ ok: false, errorCode }`, и вызывающий код сам решает, блокировать
 *   задачу (strict) или показать предупреждение и продолжить.
 * - `strict` НЕ передается в агент: агент всегда выполняет prepare одинаково, а решение
 *   о том, ронять ли операцию на неудаче, принимает вызывающая сторона уже после
 *   получения результата. Это позволяет переиспользовать один эндпоинт в двух сценариях.
 * - Оба вызова идут с ограничением по времени: prepare делает реальный git
 *   (clone/fetch/checkout/commit) и без таймаута подвесил бы HTTP-запрос навсегда.
 *
 * Ловушка: `AGENT_INTERNAL_URL` может прийти с завершающим слешем. Он срезается перед
 * склейкой пути, иначе получился бы двойной слеш, который часть прокси-слоев
 * нормализует, а часть нет.
 */
import { getEnv, logger } from "@aif/shared";

const log = logger("git-prepare-bridge");

export type GitPrepareProvider = "github" | "gitlab";

export interface GitPrepareBridgeResult {
  ok: boolean;
  gitPreparedAt?: string;
  /** Присутствует, когда агент сообщил о структурированном сбое prepare. */
  errorCode?: string;
  error?: string;
}

// Токен внутреннего API необязателен: в локальной разработке агент и API живут в одной
// сети, и эндпоинт открыт. Когда токен задан, он отправляется в двух формах —
// Authorization (стандартный заголовок) и X-Internal-Broadcast-Token (исторический
// контракт внутренней рассылки), чтобы не ломать уже подключенных клиентов.
function internalApiHeaders(): Record<string, string> {
  const token = getEnv().INTERNAL_BROADCAST_TOKEN?.trim() ?? "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-Internal-Broadcast-Token"] = token;
  }
  return headers;
}

/**
 * Просит агента автоматически подготовить локальный git-репозиторий под VCS-
 * подключение (origin, креды, ветка по умолчанию, каркас AI Factory). Синхронно.
 *
 * GitHub и GitLab разделяют один контракт эндпоинта (`POST /<provider>/prepare`);
 * отличается только неймспейс провайдера.
 *
 * - `strict = true` (Синхронизация сейчас / первая синхронизация): сбои
 *   показываются вызывающему, чтобы задачу можно было заблокировать сразу.
 * - `strict = false` (Подключение): сбои логируются и возвращаются как
 *   предупреждение; подключение всё равно сохраняется — следующая Синхронизация
 *   повторит prepare.
 */
export async function callAgentGitPrepare(
  projectId: string,
  options: { provider: GitPrepareProvider; strict?: boolean; timeoutMs?: number },
): Promise<GitPrepareBridgeResult> {
  // Слеш срезается до склейки пути: при настроенном значении с завершающим слэшем
  // двойной слеш в URL переживает не каждый промежуточный прокси.
  const env = getEnv();
  const baseUrl = env.AGENT_INTERNAL_URL.replace(/\/$/, "");
  // Один контракт на два провайдера: отличается только первый сегмент пути, а тело
  // запроса и поля ответа совпадают, поэтому вызывающий код общий для GitHub и GitLab.
  const url = `${baseUrl}/${options.provider}/prepare`;
  // Prepare выполняет настоящий git (clone/fetch/checkout/commit каркаса
  // AI Factory) и при первом подключении может идти заметно дольше 30с — разрешаем до 2 минут.
  const timeoutMs = options.timeoutMs ?? 120_000;

  log.info(
    { projectId, provider: options.provider, agentUrl: baseUrl, strict: options.strict ?? false },
    "Requesting agent git-prepare",
  );
  // Ответ объявляется заранее, чтобы обрабатывать его после try/catch: сетевой сбой
  // (агент не поднят, таймаут, разрыв) — это не исключение для вызывающего, а
  // структурированный результат, как и HTTP-ошибка ниже.
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: internalApiHeaders(),
      body: JSON.stringify({ projectId }),
      // Таймаут обязателен: prepare делает реальный git и без ограничения подвесил бы
      // HTTP-запрос пользователя на неопределенное время.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Сбой транспорта не пробрасывается: выше по стеку по errorCode и strict решают,
    // отклонить операцию целиком или показать предупреждение и сохранить подключение.
    const message = error instanceof Error ? error.message : String(error);
    const result: GitPrepareBridgeResult = {
      ok: false,
      errorCode: `${options.provider}_prepare_unavailable`,
      error: `Agent internal API unavailable: ${message}`,
    };
    log.warn(
      { projectId, provider: options.provider, err: error },
      "git-prepare agent call failed (unreachable)",
    );
    return result;
  }

  if (!response.ok) {
    // Тело ошибки может оказаться не-JSON (ответ прокси, оборванное соединение),
    // поэтому парсинг обернут в catch, а результат проверяется на null ниже через ?.
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
      projectId?: string;
    } | null;
    const result: GitPrepareBridgeResult = {
      ok: false,
      errorCode: payload?.code ?? `${options.provider}_prepare_failed`,
      error: payload?.error ?? `Agent git-prepare failed with status ${response.status}`,
    };
    log.warn(
      { projectId, provider: options.provider, status: response.status, code: result.errorCode },
      "git-prepare failed",
    );
    return result;
  }

  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    gitPreparedAt?: string;
  } | null;
  // Отсутствие поля ok считается успехом: агент отвечает телом без него в части
  // версий, и обратная совместимость здесь важнее строгости проверки.
  const result: GitPrepareBridgeResult = {
    ok: payload?.ok !== false,
    gitPreparedAt: payload?.gitPreparedAt,
  };
  log.info(
    { projectId, provider: options.provider, gitPreparedAt: result.gitPreparedAt },
    "git-prepare completed",
  );
  return result;
}

// Синхронизация сабмодулей вынесена в отдельный вызов и отдельный тип результата:
// она best-effort и не должна влиять на итог prepare, поэтому поле ok здесь означает
// только "сабмодули синхронизированы", а не "проект подготовлен".
export interface SubmoduleSyncBridgeResult {
  ok: boolean;
  submodulesInitialized?: boolean;
  error?: string;
}

/**
 * Просит агента синхронизировать подмодули уже подготовленного проекта
 * (best-effort, неблокирующе). Вызывается при каждой Синхронизации сейчас, а не
 * только при первом prepare, чтобы проекты, подключённые до выката инициализации
 * подмодулей, тоже получили заполненные подмодули.
 *
 * Сбой логируется, но мост всегда возвращает результат — вызывающий в любом
 * случае должен продолжать процесс импорта.
 */
export async function callAgentSubmoduleSync(
  projectId: string,
  options: { timeoutMs?: number } = {},
): Promise<SubmoduleSyncBridgeResult> {
  const env = getEnv();
  const baseUrl = env.AGENT_INTERNAL_URL.replace(/\/$/, "");
  const url = `${baseUrl}/submodules/sync`;
  // Лимит меньше, чем у prepare: сабмодули обычно уже инициализированы первым вызовом,
  // здесь выполняется повторная проверка состояния, а не полная подготовка репозитория.
  const timeoutMs = options.timeoutMs ?? 60_000;

  log.debug({ projectId }, "Requesting agent submodule sync");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: internalApiHeaders(),
      body: JSON.stringify({ projectId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      log.warn(
        { projectId, status: response.status, error: payload?.error ?? "unknown" },
        "Submodule sync agent call failed",
      );
      return { ok: false, submodulesInitialized: false, error: payload?.error };
    }
    const payload = (await response.json().catch(() => null)) as SubmoduleSyncBridgeResult | null;
    return {
      ok: payload?.ok !== false,
      submodulesInitialized: payload?.submodulesInitialized ?? false,
      error: payload?.error,
    };
  } catch (error) {
    // Здесь некому блокироваться: импорт проекта продолжается независимо от результата,
    // поэтому сбой только логируется и возвращается вызывающему в поле error.
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ projectId, err: message }, "Submodule sync agent call unavailable (non-blocking)");
    return { ok: false, submodulesInitialized: false, error: message };
  }
}
