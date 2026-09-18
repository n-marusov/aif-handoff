/**
 * Чтение квот и использования для Z.AI (GLM Coding Plan).
 *
 * Z.AI предоставляет Anthropic-совместимое API, но привычные каналы квот Claude здесь
 * не работают: SDK-поток не несет осмысленных rate_limit_event, а реальные цифры
 * публикует только мониторинговый HTTP API провайдера (/api/monitor/usage/*). Модуль
 * опрашивает три эндпоинта параллельно и сводит ответы к единому RuntimeLimitSnapshot;
 * сводки по моделям и инструментам уезжают в providerMeta как есть.
 *
 * JSON провайдера - недоверенные данные: каждое поле читается через помощники
 * asRecord/readString/readFiniteNumber, которые возвращают null вместо исключения.
 * Это реализация Nullable Cast Rule проекта: тип помощника явно содержит | null,
 * и вызывающий код обязан проверить значение перед разыменованием, а не глушить
 * nullable кастом `as T`.
 *
 * Канал квот целиком fail-soft: любая неудача - это null-снимок, а не ошибка запуска.
 * «Сколько осталось» - диагностика, а не часть выполнения: недоступный мониторинг
 * не должен срывать уже успешную работу агента.
 */

import {
  RuntimeLimitPrecision,
  RuntimeLimitScope,
  RuntimeLimitSource,
  RuntimeLimitStatus,
  type RuntimeLimitSnapshot,
  type RuntimeLimitWindow,
} from "../../types.js";
// Типы лимитов приходят из контрактов рантайма: модуль не изобретает свою форму для
// квот, а нормализует данные провайдера в единый снимок, понятный api и UI.
import type { ClaudeProviderIdentity } from "./providerIdentity.js";

// Структурное подмножество pino-логгера: методы опциональны, потому что логирование не
// входит в контракт - тесты и скрипты без логгера получают работоспособный вызов,
// а места обращения пишутся коротко, через опциональные цепочки logger?.debug?.(...).
interface ZaiQuotaLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

// Вход для построения снимка квот. authToken передается отдельно и никогда не
// попадает в providerMeta или возвращаемые структуры: идентичность и снимок
// сериализуются в БД, и секрет не должен уехать туда вместе с ними.
interface FetchZaiClaudeQuotaSnapshotInput {
  // Тройка идентификаторов, под которыми снимок ляжет в историю: рантайм, провайдер и
  // профиль. Нужны, чтобы позже ответить «чья это была квота», даже если настройки
  // успели поменяться.
  runtimeId: string;
  providerId: string;
  // Профиль может отсутствовать: запуск без профиля (фолбэк на переменные окружения) -
  // законный сценарий, и null здесь означает именно это, а не забытое поле.
  profileId?: string | null;
  // Идентичность из ./providerIdentity.ts: по полю providerFamily функция решает,
  // опрашивать ли провайдера вообще, а по baseOrigin строит URL запросов.
  identity: ClaudeProviderIdentity;
  // Токен для заголовка Authorization. Секрет не пишется ни в снимок, ни в providerMeta:
  // снимок живёт в БД дольше запуска.
  authToken: string;
  // Момент снятия показаний задаётся вызывающим, а не берётся внутри: все три запроса
  // должны получить одно время, и оно же должно совпасть с тем, что запишет потребитель.
  checkedAt?: string;
  // Логгер необязателен: модуль должен работать и в тестах, где логирование не нужно.
  logger?: ZaiQuotaLogger;
}

// Порог «остатка» в процентах, ниже которого снимок считается WARNING. 10% - компромисс:
// предупреждение заметно заранее, но не вспыхивает на каждом промежуточном значении.
const WARNING_THRESHOLD = 10;
// Граница допустимого диапазона Date в ECMAScript (±8.64e15 мс от эпохи). За ней
// new Date() даёт Invalid Date, а toISOString() - исключение, поэтому значения
// за границей отбраковываются на входе в нормализатор.
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;
// Жёсткий потолок на один HTTP-запрос к мониторингу. Ответы эндпоинта быстрые, а
// опрос квот не должен задерживать выдачу результата: лучше потерять снимок,
// чем притормозить диагностический канал на неопределённое время.
const ZAI_QUOTA_REQUEST_TIMEOUT_MS = 1_500;
// Окно статистики использования, которое запрашивается у провайдера и сохраняется
// в сводках (windowHours), чтобы UI честно показывал, за какой период цифры.
const ZAI_USAGE_WINDOW_HOURS = 24;

// Род запроса определяет уровень лога при неудаче и прикрепление окна времени к URL.
// Литеральное объединение читается лучше булева флага: на месте вызова видно значение,
// а не безымянное «true».
type ZaiMonitorFetchKind = "quota" | "model_usage" | "tool_usage";

// ---------------------------------------------------------------------------------
// Слой чтения недоверенного JSON. Все помощники возвращают null вместо исключений -
// вызывающий код обязан проверить значение перед использованием (Nullable Cast Rule).
// ---------------------------------------------------------------------------------

// Сужение недоверенного значения до записи без исключений. Одного typeof === "object"
// мало: массив тоже проходит по typeof, но поля по имени в нём бессмысленны. Возврат
// null вместо броска обязывает вызывающего проверять результат перед доступом - так
// живой код не разыменовывает неожиданную null-ветку (Nullable Cast Rule).
function asRecord(value: unknown): Record<string, unknown> | null {
  // !Array.isArray - не придирка: JSON-массив тоже проходит typeof "object", но его
  // поля-индексы не то же самое, что поля объекта, и принимать его за запись значило бы
  // гнать мусор в парсер лимитов.
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Строка, состоящая только из пробелов, приравнивается к отсутствующей: нормализация
// обоих случаев в null устраняет состояние «задано, но пусто» и снимает со всех
// потребителей обязанность делать вторую проверку.
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Пропускает только конечные числа. Значения вроде NaN или Infinity не описаны в JSON,
// но могут протечь через промежуточные слои обработки; арифметика с ними превращается
// в мусор, поэтому фильтр стоит на входе, а не во всех потребителях.
function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Фильтр с type predicate (`item is Record<...>`): после map тип массива -
// (Record<string, unknown> | null)[], и предикат «съедает» null из типа элементов
// законным способом. Альтернатива - каст, который запрещён проектными правилами.
function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        // Внутри массива тоже мусор: map прогоняет каждый элемент через asRecord,
        // превращая не-объекты в null, а второй проход убирает эти null предикатом -
        // на выходе всегда чистый массив записей, а не смесь типов.
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item != null)
    : [];
}

// Нормализация «сырого» времени в ISO-строку. Провайдер то и дело меняет разрядность
// меток (секунды/миллисекунды), поэтому разряд определяется эвристикой по величине:
// современная дата в секундах - это ~1.75e9, в миллисекундах - ~1.75e12; порога 1e12
// эвристику не ломает, потому что между представлениями целый порядок величины.
function normalizeTimestamp(value: unknown): string | null {
  const raw = readFiniteNumber(value);
  if (raw == null) return null;

  // Приведение к миллисекундам: если значение уже в ms - оставляем, иначе умножаем на
  // 1000. Проверка границ обязательна: Date за пределами диапазона даёт Invalid Date,
  // а toISOString() на нем бросает исключение - этого вызывающий код не ожидает.
  const targetMs = raw >= 1_000_000_000_000 ? raw : raw * 1000;
  if (!Number.isFinite(targetMs) || Math.abs(targetMs) > MAX_VALID_DATE_MS) {
    return null;
  }

  const date = new Date(targetMs);
  // Защитная перепроверка: в допустимом диапазоне Invalid Date не встречается, но
  // проверка ничего не стоит и страхует от будущих изменений в арифметике выше.
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

// Обёртка над readString с семантическим именем: подписи бакетов гистограммы - это
// тоже строки, но при смене формата подписок правка нужна будет только здесь, а не
// во всех читателях строк модуля.
function normalizeUsageBucketLabel(value: unknown): string | null {
  return readString(value);
}

// Форматирование даты для query-параметров мониторинга. Z.AI принимает datetime в виде
// локального «YYYY-MM-DD HH:MM:SS», а не ISO 8601 с таймзоной - особенность API
// провайдера, поэтому свой форматтер вместо готового toISOString(). padStart приводит
// разряды к двум знакам, иначе «2026-9-5» не парсится сервером.
// padStart добивает разряды нулём слева: без него месяц или день с однозначным числом
// («2026-9-5») не распознаётся принимающей стороной как ожидаемая маска даты.
function formatUsageWindowDateTime(date: Date): string {
  const pad = (target: number): string => String(target).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Скользящие сутки: с «вчера в этот же час» до «сегодня в конце этого часа».
// Границы выравниваются на час, потому что провайдер агрегирует использование
// почасовыми бакетами, и произвольные границы дали бы рваную сумму.
function buildUsageWindowSearchParams(now: Date = new Date()): URLSearchParams {
  // Начало окна - тот же час предыдущих суток, минуты и секунды обнулены: граница
  // совпадает с началом часа, в котором начался сбор статистики.
  const startDate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
    now.getHours(),
    0,
    0,
    0,
  );
  const endDate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    // Последняя миллисекунда текущего часа: граница включительная, иначе свежие
    // данные терялись бы ровно на стыке часа.
    59,
    59,
    999,
  );

  // URLSearchParams сам кодирует пробелы и двоеточия в date-time: ручная склейка строки
  // сломалась бы на первом же спецсимволе, а здесь кодирование - часть типа.
  return new URLSearchParams({
    startTime: formatUsageWindowDateTime(startDate),
    endTime: formatUsageWindowDateTime(endDate),
  });
}

// Перевод «процента использованного» в «процент остатка» для отображения. Ограничение
// [0, 100] осознанно: провайдер иногда возвращает >100% при перерасходе лимита, и
// отрицательный остаток сломал бы обещанный UI диапазон. Сам факт перерасхода при
// этом не теряется - для него служит статус BLOCKED, а не число.
function toPercentRemaining(percentUsed: number | null): number | null {
  if (percentUsed == null) return null;
  return Math.max(0, Math.min(100, 100 - percentUsed));
}

// ---------------------------------------------------------------------------------
// Слой лимитов: отображение ответов провайдера в окна рантайма и агрегация статуса.
// ---------------------------------------------------------------------------------

// Отображение одного лимита провайдера в окно рантайма. Возвращаемый тип
// RuntimeLimitWindow | null - не «ошибка», а механизм: неизвестный `type` означает,
// что провайдер ввёл новый вид лимита, и старый парсер должен его проигнорировать,
// а не упасть. Это forward-совместимость без релиза адаптера на каждую правку API.
// Числовые поля читаются помощниками и могут быть null, поэтому вместо исключений
// используется guard-проверка «есть ли хоть одно осмысленное значение».
function buildWindowFromLimit(limit: Record<string, unknown>): RuntimeLimitWindow | null {
  // Тип лимита приходит в верхнем регистре (TOKENS_LIMIT/TIME_LIMIT) - это словарь
  // провайдера, а не наш: незнакомое значение должно дать null, а не исключение.
  const limitType = readString(limit.type);
  const percentUsed = readFiniteNumber(limit.percentage);
  const percentRemaining = toPercentRemaining(percentUsed);
  const resetAt = normalizeTimestamp(limit.nextResetTime);
  const remaining = readFiniteNumber(limit.remaining);
  const used = readFiniteNumber(limit.currentValue);
  const total = readFiniteNumber(limit.usage);

  if (limitType === "TOKENS_LIMIT") {
    // Если ни процент, ни время сброса не распарсились - окно пустое, показывать нечего.
    // Сравнение с null, а не truthiness: 0 - валидное значение (исчерпано), и его
    // нельзя путать с отсутствием данных.
    if (percentUsed == null && percentRemaining == null && resetAt == null) {
      return null;
    }

    // «5h»: токен-лимит coding-плана Z.AI сбрасывается каждые 5 часов - устойчивый
    // факт провайдера, который сам ответ не сообщает, поэтому имя задано здесь.

    return {
      scope: RuntimeLimitScope.TOKENS,
      // Имя окна фиксировано как «5h»: провайдер не присылает название периода, а UI
      // должен показать пользователю хотя бы семантику сброса.
      name: "5h",
      // Оба процента передаются наружу: used нужен для аналитики, remaining - для
      // отображения; перевод одного в другое терял бы исходное число провайдера.
      percentUsed,
      percentRemaining,
      resetAt,
      warningThreshold: WARNING_THRESHOLD,
    };
  }

  if (limitType === "TIME_LIMIT") {
    // Для этого типа ценны и абсолютные счётчики (used/remaining/limit), поэтому
    // порог «есть ли данные» шире, чем у TOKENS_LIMIT.
    if (
      percentUsed == null &&
      percentRemaining == null &&
      remaining == null &&
      used == null &&
      total == null &&
      resetAt == null
    ) {
      return null;
    }

    // TIME_LIMIT - это квота на количество вызовов MCP-инструментов, отсюда scope
    // TOOL_USAGE и имя «MCP»: метрика относится к инструментам, а не к токенам.
    return {
      scope: RuntimeLimitScope.TOOL_USAGE,
      name: "MCP",
      used,
      remaining,
      limit: total,
      percentUsed,
      percentRemaining,
      resetAt,
      warningThreshold: WARNING_THRESHOLD,
    };
  }

  return null;
}

// Сводный статус снимка - худший из всех окон: сначала полный исход (BLOCKED), затем
// порог предупреждения (WARNING), затем OK. Пороговая логика дублируется здесь и в
// selectPrimaryQuotaWindow осознанно: статус отвечает на вопрос «как показать весь
// снимок», а primary-окно - на вопрос «какое окно показать как причину».
// Все проверки идут через typeof === "number": remaining может быть законным 0,
// и это ровно BLOCKED, поэтому truthiness-проверка ('window.remaining <= 0' без
// typeof) не отличила бы ноль от отсутствия значения.
// .some с ранним выходом: достаточно одного исчерпанного окна, чтобы статус стал
// BLOCKED - статус описывает худший случай, а не среднее по списку.
function resolveSnapshotStatus(windows: RuntimeLimitWindow[]): RuntimeLimitStatus {
  if (
    windows.some(
      (window) =>
        (typeof window.percentRemaining === "number" && window.percentRemaining <= 0) ||
        (typeof window.remaining === "number" && window.remaining <= 0),
    )
  ) {
    return RuntimeLimitStatus.BLOCKED;
  }

  if (
    windows.some(
      (window) =>
        (typeof window.percentRemaining === "number" &&
          window.percentRemaining <= WARNING_THRESHOLD) ||
        (typeof window.remaining === "number" &&
          typeof window.limit === "number" &&
          window.limit > 0 &&
          window.remaining / window.limit <= WARNING_THRESHOLD / 100),
    )
  ) {
    return RuntimeLimitStatus.WARNING;
  }

  if (windows.length > 0) {
    return RuntimeLimitStatus.OK;
  }

  return RuntimeLimitStatus.UNKNOWN;
}

// Выбор «основного» окна - того, которое UI подсветит как ограничитель задачи.
// Стратегия: из окон, совпадающих со статусом снимка, берется ближайшее по resetAt
// (окно без даты сброса получает -Infinity и проигрывает любому датированному);
// при равенстве дат побеждает окно с меньшим остатком - более срочное.
// Возвращаемый null - только для пустого списка: снимок без окон не строится выше.
function selectPrimaryQuotaWindow(
  windows: RuntimeLimitWindow[],
  status: RuntimeLimitStatus,
): RuntimeLimitWindow | null {
  // Быстрый выход для пустого списка: выбирать не из чего, и reduce с нулевым
  // аккумулятором всё равно вернул бы null - явная проверка делает намерение читаемым.
  if (windows.length === 0) return null;

  // Скор окна - это его время сброса, распарсенное защитно: строковый тип resetAt не
  // гарантирует валидную дату (значение пришло из чужого JSON), а Date.parse на мусоре
  // возвращает NaN, который не должен участвовать в сравнениях.
  const score = (window: RuntimeLimitWindow): number => {
    if (typeof window.resetAt === "string") {
      const parsed = Date.parse(window.resetAt);
      if (Number.isFinite(parsed)) return parsed;
    }
    return Number.NEGATIVE_INFINITY;
  };

  // Предикаты повторяют resolveSnapshotStatus: основное окно должно нести ровно ту
  // «проблему» (исчерпание либо дефицит), которая подняла статус всего снимка. Иначе
  // UI показал бы OK-окно рядом с красным статусом BLOCKED.
  const matching = windows.filter((window) => {
    if (status === RuntimeLimitStatus.BLOCKED) {
      return (
        (typeof window.percentRemaining === "number" && window.percentRemaining <= 0) ||
        (typeof window.remaining === "number" && window.remaining <= 0)
      );
    }

    if (status === RuntimeLimitStatus.WARNING) {
      return (
        (typeof window.percentRemaining === "number" &&
          window.percentRemaining <= WARNING_THRESHOLD) ||
        (typeof window.remaining === "number" &&
          typeof window.limit === "number" &&
          window.limit > 0 &&
          window.remaining / window.limit <= WARNING_THRESHOLD / 100)
      );
    }

    return true;
  });

  // Страховка на случай, когда ни одно окно не совпало со статусом (например, из-за
  // расхождения порогов): тогда рассматриваем все окна - выбор деградирует, но
  // возвращаемый снимок остается непротиворечивым.
  const candidates = matching.length > 0 ? matching : windows;
  // reduce с типизированным начальным значением `null as RuntimeLimitWindow | null`: это
  // приведение типа аккумулятора, а не снятие nullable с чужих данных. «Лучшего пока
  // нет» - отдельное состояние, которого нет в типе окна, поэтому union с null здесь
  // неизбежен и честен.
  return candidates.reduce(
    (best, candidate) => {
      if (!best) return candidate;
      const bestScore = score(best);
      const candidateScore = score(candidate);
      if (candidateScore > bestScore) return candidate;
      if (candidateScore < bestScore) return best;

      // tie-breaker: чем меньше остатка, тем срочнее окно; отсутствие percentRemaining
      // трактуется как «не ограничено» (+Infinity), то есть проигрывает любому числу.
      const bestRemaining =
        typeof best.percentRemaining === "number"
          ? best.percentRemaining
          : Number.POSITIVE_INFINITY;
      const candidateRemaining =
        typeof candidate.percentRemaining === "number"
          ? candidate.percentRemaining
          : Number.POSITIVE_INFINITY;
      return candidateRemaining < bestRemaining ? candidate : best;
    },
    null as RuntimeLimitWindow | null,
  );
}

// ---------------------------------------------------------------------------------
// Сетевой слой: заголовки авторизации, таймауты и запросы монитора.
// ---------------------------------------------------------------------------------

// Заголовок авторизации для монитор-эндпоинтов. Z.AI принимает токен как есть,
// без префикса «Bearer » - в этой форме его использует веб-дашборд провайдера.
function buildMonitorHeaders(authToken: string): Record<string, string> {
  return {
    Authorization: authToken,
    // Локаль фиксируется явно: ответы приходят в стабильной английской схеме полей
    // независимо от locale хоста, который запустил агента.
    "Accept-Language": "en-US,en",
    "Content-Type": "application/json",
  };
}

// Запрос одного монитор-эндпоинта. Тип возврата Promise<Record<string, unknown> | null>
// кодирует философию модуля: любая неудача (нет base, timeout, не-2xx, мусор в теле) -
// это null и лог-запись, но никогда не исключение. Канал квот не имеет права срывать
// выполнение: async-функция возвращает промис, и await на нем не бросает - вызывающий
// код обязан лишь проверить результат на null перед доступом к полям.
async function fetchZaiMonitorPayload(
  input: FetchZaiClaudeQuotaSnapshotInput,
  path: string,
  kind: ZaiMonitorFetchKind,
  options?: { includeUsageWindow?: boolean },
): Promise<Record<string, unknown> | null> {
  // Разрешение относительного пути требует абсолютного base: без origin fetch бросил бы
  // синхронную TypeError, поэтому ранний выход с null - это guard, а не паранойя.
  if (!input.identity.baseOrigin) {
    return null;
  }

  // Эндпоинты использования работают с явным окном времени, а лимитам окно не нужно -
  // отсюда опциональный флаг вместо двух отдельных фетчеров.
  const url = new URL(path, input.identity.baseOrigin);
  if (options?.includeUsageWindow) {
    // Присваивание целой строки в url.search перезаписывает любые прежние параметры:
    // окно задаётся целиком нами, а не достраивается к чему-то из baseUrl.
    url.search = buildUsageWindowSearchParams().toString();
  }

  // AbortController + setTimeout - канонический способ ограничить fetch: у API нет
  // встроенного timeoutMs. Таймер снимается в finally, чтобы не оставаться в event loop
  // после получения ответа (см. также shared/withTimeout.ts).
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), ZAI_QUOTA_REQUEST_TIMEOUT_MS);
  // let без инициализатора: значение присваивается внутри try, а используется после
  // finally. TypeScript такое чтение допускает, потому что catch завершается return -
  // то есть до строк ниже управление доходит только с присвоенным response.
  let response: Response;
  try {
    response = await fetch(url, {
      // Заголовки собираются отдельной функцией: формат авторизации - знание о Z.AI,
      // и оно живёт в одном месте, а не размазано по вызовам.
      headers: buildMonitorHeaders(input.authToken),
      // Сигнал аборта привязывает таймер выше к этому конкретному запросу: отмена
      // прервёт fetch, а не только проигнорирует ответ.
      signal: abortController.signal,
    });
  } catch (error) {
    // Отказ основного quota-эндпоинта пишется в warn (он влияет на картину пользователя),
    // а отказ факультативной сводки - в debug. Метод логгера выбирается вычисляемым
    // ключом, поэтому один вызов вместо двух веток; опциональные цепочки (?.) нужны
    // потому, что логгер и его методы необязательны. `error instanceof Error ?
    // error.message : String(error)` - безопасное извлечение текста из throw-чего-угодно:
    // бросают не только Error.
    input.logger?.[kind === "quota" ? "warn" : "debug"]?.(
      {
        runtimeId: input.runtimeId,
        providerId: input.providerId,
        profileId: input.profileId ?? null,
        baseOrigin: input.identity.baseOrigin,
        endpoint: url.pathname,
        timeoutMs: ZAI_QUOTA_REQUEST_TIMEOUT_MS,
        error: error instanceof Error ? error.message : String(error),
      },
      kind === "quota"
        ? "Unable to refresh Z.AI coding quota snapshot from provider monitor endpoint"
        : "Unable to refresh optional Z.AI usage summary from provider monitor endpoint",
    );
    return null;
  } finally {
    // Таймер снимается в finally: без этого он оставался бы в event loop после
    // успешного ответа и мог бы сработать уже во время следующего запроса.
    clearTimeout(timeout);
  }

  // Статус проверяется до чтения тела: ответ с не-2xx кодом часто содержит HTML
  // ошибки, и response.json() на нем бросил бы исключение с невразумительным текстом.
  // Ветка не парсит тело вообще - классификация отказа идет по структурированному
  // response.status, а не по строке сообщения (Project rule про error control-flow).
  if (!response.ok) {
    input.logger?.[kind === "quota" ? "warn" : "debug"]?.(
      {
        runtimeId: input.runtimeId,
        providerId: input.providerId,
        profileId: input.profileId ?? null,
        baseOrigin: input.identity.baseOrigin,
        endpoint: url.pathname,
        status: response.status,
      },
      kind === "quota"
        ? "Unable to refresh Z.AI coding quota snapshot from provider monitor endpoint"
        : "Unable to refresh optional Z.AI usage summary from provider monitor endpoint",
    );
    return null;
  }

  // Форма конверта различается между эндпоинтами: { data: {...} } либо payload напрямую.
  // Опциональная цепочка payload?.data не случайна: asRecord реально возвращает null,
  // и выражение сохраняет union с null до самого ??-фолбэка - ни одного каста,
  // снимающего nullable (Nullable Cast Rule).
  const payload = asRecord(await response.json());
  return asRecord(payload?.data) ?? payload;
}

// ---------------------------------------------------------------------------------
// Слой сводок использования: дополнительные наблюдения, которые уезжают в providerMeta
// и не влияют на статус снимка.
// ---------------------------------------------------------------------------------

// Превращение ответа model-usage в компактную сводку. Итоговый тип -
// Record<string, unknown> | null намеренно: сводка уезжает в providerMeta и не входит
// в типизированный контракт рантайма (UI читает поля оптимистично), а null отделяет
// «данных нет» от «данные нулевые».
function normalizeZaiModelUsageSummary(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) {
    return null;
  }

  const totalUsage = asRecord(payload.totalUsage);
  // Одни и те же списки провайдер то заворачивает в totalUsage, то кладет в корень
  // ответа - цепочка ?? читает оба варианта, не привязываясь к версии API.
  // Запись без modelName исключается (map -> null -> filter с type predicate):
  // счётчик токенов без привязки к модели смысла в сводке не имеет, и выкинуть
  // запись дешевле, чем ронять всю сводку из-за одной мусорной строки.
  const modelSummaryList = readRecordArray(payload.modelSummaryList ?? totalUsage?.modelSummaryList)
    .map((entry) => {
      const modelName = readString(entry.modelName);
      if (!modelName) {
        return null;
      }

      return {
        modelName,
        // Числовые поля могут быть null: модель без счётчика всё равно попадает в список -
        // запись о самом факте использования модели для UI полезна.
        totalTokens: readFiniteNumber(entry.totalTokens),
        sortOrder: readFiniteNumber(entry.sortOrder),
      };
    })
    // Фильтр с предикатом `entry is {...}` убирает null-заготовки, оставленные map, и
    // одновременно сужает тип элементов до полной формы записи - без единого каста.
    .filter(
      (
        entry,
      ): entry is {
        modelName: string;
        totalTokens: number | null;
        sortOrder: number | null;
      } => entry != null,
    );

  // x_time - ось гистограммы с подписями бакетов; последний элемент - самый свежий
  // бакет, то есть фактически время снятия показаний (взятие с конца через .at(-1)).
  const sampledAt =
    normalizeUsageBucketLabel(Array.isArray(payload.x_time) ? payload.x_time.at(-1) : null) ?? null;
  const granularity = readString(payload.granularity);
  const totalModelCallCount = readFiniteNumber(totalUsage?.totalModelCallCount);
  const totalTokensUsage = readFiniteNumber(totalUsage?.totalTokensUsage);

  // Если не распарсилось ни одного поля и список пуст - возвращаем null: потребитель
  // не увидит пустой объект и не примет «нет данных» за «нулевое использование».
  if (
    granularity == null &&
    sampledAt == null &&
    totalModelCallCount == null &&
    totalTokensUsage == null &&
    modelSummaryList.length === 0
  ) {
    return null;
  }

  // Поля отдаются под теми именами, которых ждут потребители: контракт на сводку не
  // формализован (providerMeta), но UI ищет ровно эти ключи, и переименование -
  // ломающее изменение для него.
  return {
    granularity,
    sampledAt,
    totalModelCallCount,
    totalTokensUsage,
    topModels: modelSummaryList,
    windowHours: ZAI_USAGE_WINDOW_HOURS,
  };
}

// Имена полей у инструментов («что это» и «сколько раз») менялись от ревизии к ревизии
// API, поэтому кандидаты читаются по очереди через ?? - первый непустой выигрывает.
// Отсутствие totalCount при наличии имени - допустимая полудырка: запись сохраняется
// с null, потому что перечень инструментов сам по себе полезен.
function normalizeZaiToolSummaryEntry(
  entry: Record<string, unknown>,
): { toolName: string; totalCount: number | null } | null {
  const toolName =
    readString(entry.toolName) ??
    readString(entry.name) ??
    readString(entry.toolCode) ??
    readString(entry.modelCode);
  if (!toolName) {
    return null;
  }

  const totalCount =
    // Цепочка `??` останавливается на первом непустом значении и не считает нулём:
    // 0 вызовов инструмента - это данные, и они не должны проваливаться к следующему
    // кандидату только потому, что 0 ложноподобен.
    readFiniteNumber(entry.totalCount) ??
    readFiniteNumber(entry.totalUsage) ??
    readFiniteNumber(entry.count) ??
    readFiniteNumber(entry.usage);

  return { toolName, totalCount };
}

// Та же схема, что у сводки по моделям: многовариантные имена полей, ??-фолбэки
// между корнем ответа и totalUsage, и null на выходе, если не нашлось ничего.
function normalizeZaiToolUsageSummary(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload) {
    return null;
  }

  const totalUsage = asRecord(payload.totalUsage);
  const toolSummaryList = readRecordArray(payload.toolSummaryList ?? totalUsage?.toolSummaryList)
    .map((entry) => normalizeZaiToolSummaryEntry(entry))
    .filter((entry): entry is { toolName: string; totalCount: number | null } => entry != null);

  // sampledAt и granularity читаются так же, как в модельной сводке: x_time - ось
  // гистограммы, ее последний элемент - время снимка показаний.
  const sampledAt =
    normalizeUsageBucketLabel(Array.isArray(payload.x_time) ? payload.x_time.at(-1) : null) ?? null;
  const granularity = readString(payload.granularity);
  const totalNetworkSearchCount =
    // Каждый счётчик ищется в двух местах: свёрнутым в totalUsage и в корне ответа.
    // Это адаптация к разным ревизиям API, а не избыточность.
    readFiniteNumber(totalUsage?.totalNetworkSearchCount) ??
    readFiniteNumber(payload.networkSearchCount);
  const totalWebReadMcpCount =
    readFiniteNumber(totalUsage?.totalWebReadMcpCount) ?? readFiniteNumber(payload.webReadMcpCount);
  const totalZreadMcpCount =
    readFiniteNumber(totalUsage?.totalZreadMcpCount) ?? readFiniteNumber(payload.zreadMcpCount);
  const totalSearchMcpCount = readFiniteNumber(totalUsage?.totalSearchMcpCount);

  if (
    granularity == null &&
    sampledAt == null &&
    totalNetworkSearchCount == null &&
    totalWebReadMcpCount == null &&
    totalZreadMcpCount == null &&
    totalSearchMcpCount == null &&
    toolSummaryList.length === 0
  ) {
    return null;
  }

  // Та же схема именования для сводки инструментов: набор ключей - обещанная форма
  // для UI, а windowHours явно говорит, за какой промежуток посчитаны счётчики.
  return {
    granularity,
    sampledAt,
    totalNetworkSearchCount,
    totalWebReadMcpCount,
    totalZreadMcpCount,
    totalSearchMcpCount,
    tools: toolSummaryList,
    windowHours: ZAI_USAGE_WINDOW_HOURS,
  };
}

// Единственная экспортная функция модуля: собирает снимок квот либо возвращает null,
// когда ничего пригодного не найдено. Идентичность перепроверяется и здесь, хотя
// вызывающие коды (stream/cli) тоже её проверяют: функция вызывается напрямую из двух
// транспортов, и защита от бессмысленных HTTP-запросов к не-Z.AI провайдеру должна
// принадлежать самому модулю, а не полагаться на дисциплину потребителей.
export async function fetchZaiClaudeQuotaSnapshot(
  input: FetchZaiClaudeQuotaSnapshotInput,
): Promise<RuntimeLimitSnapshot | null> {
  // Ранний выход до любых запросов: для чужих семейств провайдеров этот модуль не
  // знает ни эндпоинтов, ни формата ответов.
  if (input.identity.providerFamily !== "zai-glm-coding" || !input.identity.baseOrigin) {
    return null;
  }

  // Три независимых запроса отправляются параллельно через Promise.all: суммарная
  // задержка равна самому медленному запросу, а не сумме трёх; у каждого запроса при
  // этом свой AbortController-таймер. Fail-soft внутри fetchZaiMonitorPayload
  // гарантирует, что Promise.all не реджектится из-за отказа канала квот.
  const [data, modelUsagePayload, toolUsagePayload] = await Promise.all([
    fetchZaiMonitorPayload(input, "/api/monitor/usage/quota/limit", "quota"),
    fetchZaiMonitorPayload(input, "/api/monitor/usage/model-usage", "model_usage", {
      includeUsageWindow: true,
    }),
    fetchZaiMonitorPayload(input, "/api/monitor/usage/tool-usage", "tool_usage", {
      includeUsageWindow: true,
    }),
  ]);

  if (!data) {
    return null;
  }

  // Array.isArray вместо доверия типу: data - произвольный JSON провайдера, поле
  // limits может оказаться чем угодно; не-массив трактуется как пустой список.
  const rawLimits = Array.isArray(data?.limits) ? data.limits : [];
  const windows = rawLimits
    // asRecord(limit) может вернуть null, и ?? {} - это фолбэк на пустую запись, а не
    // каст, снимающий nullable: на пустой записи buildWindowFromLimit сам вернёт null,
    // и окно отфильтруется тип-предикатом следующим шагом.
    .map((limit) => buildWindowFromLimit(asRecord(limit) ?? {}))
    // Второй фильтр с предикатом `window is RuntimeLimitWindow` убирает null-значения,
    // оставленные buildWindowFromLimit, и сужает тип массива: windows дальше имеет
    // тип RuntimeLimitWindow[] без каста.
    .filter((window): window is RuntimeLimitWindow => window != null);

  // Ни одного распознанного окна - показывать нечего: null вместо пустого снимка со
  // статусом OK, чтобы потребитель не перепутал «нет данных» с «всё хорошо».
  if (windows.length === 0) {
    return null;
  }

  // Статус и основное окно считаются по одному входу (windows), поэтому они не могут
  // противоречить друг другу: primary-окно всегда несёт «проблему», поднявшую статус.
  const status = resolveSnapshotStatus(windows);
  const primaryWindow = selectPrimaryQuotaWindow(windows, status);
  // resetAt снимка берется у основного окна: именно это время UI покажет как «когда
  // ограничение отпустит».
  const resetAt = primaryWindow?.resetAt ?? null;
  // Сырые usageDetails берутся из первого лимита, где они есть, и переезжают в
  // providerMeta без нормализации: это материал для отладки и собственных виджетов UI,
  // и поднимать типизацию чужих полей в контракт рантайма смысла нет.
  const usageDetails =
    rawLimits.map((limit) => asRecord(limit)).find((limit) => Array.isArray(limit?.usageDetails))
      ?.usageDetails ?? null;
  // Сводки использования не участвуют в вычислении статуса: это сопутствующие
  // наблюдения, и их отсутствие не делает снимок неполным - в отличие от отсутствия
  // окон, которое снимок отменяет.
  const modelUsageSummary = normalizeZaiModelUsageSummary(modelUsagePayload);
  const toolUsageSummary = normalizeZaiToolUsageSummary(toolUsagePayload);

  const snapshot: RuntimeLimitSnapshot = {
    // Источник - собственный API провайдера, а не заголовки и не эвристики, отсюда
    // precision EXACT: числа взяты напрямую из ответов мониторинга.
    source: RuntimeLimitSource.PROVIDER_API,
    // status уже посчитан по всем окнам (худший исход), checkedAt выбран вызывающим
    // или сгенерирован сейчас - снимок самодостаточен для записи в историю.
    status,
    precision: RuntimeLimitPrecision.EXACT,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    providerId: input.providerId,
    runtimeId: input.runtimeId,
    // profileId сохраняется явным null: снимок переживает удаление профиля, и
    // «профиля не было» должно отличаться от «забыли записать».
    profileId: input.profileId ?? null,
    // Каскад фолбэков для primaryScope: основное окно -> первое из окон -> TOKENS.
    // Поле обязано быть непустым для UI, а primaryWindow мог быть null и windows[0]
    // отфильтрован как невалидное - тогда остается только константный дефолт.
    primaryScope: primaryWindow?.scope ?? windows[0]?.scope ?? RuntimeLimitScope.TOKENS,
    resetAt,
    // retryAfterSeconds здесь null: мониторинг сообщает время сброса (resetAt), но не
    // рекомендацию «повторить через N секунд»; выводить одно из другого было бы
    // подменой данных провайдера придуманными числами.
    retryAfterSeconds: null,
    warningThreshold: WARNING_THRESHOLD,
    // windows остаются как есть (уже отфильтрованные) - UI рисует их списком, а не
    // пересобирает из primaryScope.
    windows,
    // Идентичность кочует в providerMeta целиком: потребители снимка (UI, история
    // лимитов) видят, чей именно аккаунт и каким каналом измерены цифры.
    providerMeta: {
      // Семейство, метка и источник квот - из идентичности: потребитель должен видеть,
      // чем именно измерены цифры, не догадываясь по URL.
      providerFamily: input.identity.providerFamily,
      providerLabel: input.identity.providerLabel,
      quotaSource: input.identity.quotaSource,
      // Отпечаток аккаунта связывает снимок с историей одного аккаунта, не раскрывая
      // сам ключ; accountLabel пока null - человеческого имени у аккаунта нет.
      accountFingerprint: input.identity.accountFingerprint,
      accountLabel: input.identity.accountLabel,
      // Уровень плана приходит в поле level как есть; переименование в planType
      // фиксирует имя, на которое уже подписан UI.
      planType: readString(data?.level),
      usageDetails,
      modelUsageSummary,
      toolUsageSummary,
    },
  };

  // Логируются только безопасные агрегаты (статус, число окон): ни снимок целиком, ни
  // authToken в лог не пишутся - секрет не должен попасть в логи так же ревниво, как
  // он не попадает в providerMeta.
  input.logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      profileId: input.profileId ?? null,
      status: snapshot.status,
      windowCount: snapshot.windows.length,
    },
    "Observed Z.AI coding quota snapshot from provider monitor endpoint",
  );

  return snapshot;
}
