/**
 * Иерархия ошибок рантайма и классификаторы - нерв правила
 * «никакого ветвления по тексту сообщений».
 *
 * Каждая ошибка несёт структурные признаки: machine-читаемый code,
 * семантический category (enum-литералы), httpStatus, adapterCode и
 * метаданные лимитов. Потребители (координатор, review-гейт, UI) принимают
 * решения по этим полям; message остаётся человекочитаемой диагностикой,
 * формат которой не обещан стабильным и потому непригоден для if/switch.
 *
 * Архитектура классификации - конвейер с убывающей надёжностью сигналов:
 * HTTP-статус (точен) -> структурированные поля SDK -> общий список
 * строковых паттернов (последний шанс, только для CLI-транспортов).
 * Поэтому все classifyBy* живут в одном файле: иначе адаптеры начали бы
 * конкурировать собственными списками, и одна ошибка получала бы разные
 * категории в разных местах системы.
 *
 * Снапшот лимитов вложен прямо в ошибку исполнения: 429 без информации
 * «когда возвращаться» заставила бы потребителя парсить заголовки повторно,
 * и данные разъехались бы по двум объектам.
 */

// Единственный импорт нужен ради вложенного типа: limitSnapshot хранит
// разобранные headers, и ошибка исполнения - их естественный transporter.
import type { RuntimeLimitSnapshot } from "./types.js";

// Корень иерархии. Расширение Error - стандартный путь: try/catch, stack
// trace и pino-сериализация работают с ним бесплатно.
//
// Поле name выставляется в каждом подклассе вручную: в современных таргетах
// (ES2022) прототипная цепь class extends работает корректно, но name по
// умолчанию берётся из конструктора, а в логах и JSON нужна стабильная
// строка, независимая от минификации.
export class RuntimeError extends Error {
  // code - машинный идентификатор ("RUNTIME_ERROR"): его читают API-
  // ответы и UI-переводилки. В отличие от category, он отражает КЛАСС
  // ошибки, а не её причину: причины - удел подклассов исполнения.
  public readonly code: string;

  constructor(message: string, code = "RUNTIME_ERROR", cause?: unknown) {
    // ES2022-конструкция Error(message, { cause }): сохраняет первоисточник
    // для глубокой диагностики, не замусоривая сообщение. Условный объект:
    // до Node 16 лишний второй аргумент игнорировался, а undefined cause
    // хуже отсутствия cause - различаем «нет причины» и «причина = undefined».
    super(message, cause ? { cause } : undefined);
    this.name = "RuntimeError";
    this.code = code;
  }
}

// Важное свойство этой иерархии, зависящее от таргета сборки: проект
// компилируется в ES2022, где class extends Error - нативный класс, и
// instanceof работает корректно «из коробки». При понижающей транскомпиляции
// в ES5 instanceof для наследников Error ломается (ES5-конструктор возвращает
// новый объект), и библиотекам приходится чинить прототип вручную через
// Object.setPrototypeOf - старая боль экосистемы, о которой здесь просто
// не нужно помнить зря.

// Ниже - «скелетные» подклассы: они ничего не добавляют к полям, а лишь
// фиксируют пару (code, name). Это не бойлерплейт, а словарь доменных
// сущностей: каждая стадия жизни рантайма - регистрация модуля, резолв
// профиля, валидация, проверка capabilities - имеет собственный тип
// провала, и ловить их можно точечно: catch по RuntimeRegistrationError
// не проглотит ошибку валидации.
// Каждая подклассовая строка `this.name = "..."` важна дважды: имя
// попадает в сериализацию pino (стандартный сериализатор ошибок берёт
// name + message + stack) и в текст stack trace. Без явного присвоения
// все ошибки выглядели бы как «RuntimeError» в логах, и разбор
// инцидентов превращался бы в гадание.
export class RuntimeRegistrationError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_REGISTRATION_ERROR", cause);
    this.name = "RuntimeRegistrationError";
  }
}

// Сбой выбора профиля/рантайма: конфигурация противоречива или профиль
// не найден. Отличается от Registration тем, что адаптер в реестре есть,
// но запрос к нему невозможно разрешить в конкретный экземпляр.
export class RuntimeResolutionError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_RESOLUTION_ERROR", cause);
    this.name = "RuntimeResolutionError";
  }
}

// Внешний адаптер загружен, но не прошёл структурную проверку контракта
// (не тот экспорт, не те методы). Встречается на пути module.ts.
export class RuntimeModuleValidationError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_MODULE_VALIDATION_ERROR", cause);
    this.name = "RuntimeModuleValidationError";
  }
}

// Сам dynamic-import упал: нет файла, сломан синтаксис, нет прав.
// Парочка с Validation: Load - про «не достали», Validation - про «достали
// не то»; разделять их важно, потому что лечатся они по-разному.
export class RuntimeModuleLoadError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_MODULE_LOAD_ERROR", cause);
    this.name = "RuntimeModuleLoadError";
  }
}

// Ошибка проверки входных данных/соединения сервисного уровня
// (используется и в modelDiscovery). Не путать с Execution: здесь ещё
// ничего не выполнялось.
export class RuntimeValidationError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_VALIDATION_ERROR", cause);
    this.name = "RuntimeValidationError";
  }
}

// Запрошенное свойство workflow не поддерживается данным адаптером:
// assert из capabilities.ts. Это ошибка конфигурации, а не провайдера,
// поэтому ретрайт её бессмысленны.
export class RuntimeCapabilityError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_CAPABILITY_ERROR", cause);
    this.name = "RuntimeCapabilityError";
  }
}

/** Семантические категории ошибок — адаптеры выставляют их, чтобы consumers не разбирали тексты сообщений. */
// Union строковых литералов вместо enum: значения переходят в JSON, БД и
// API без маппинга, а компилятор всё равно ловит опечатки. Смысл каждого:
//
// - rate_limit: провайдер исчерпал квоту - ждать, не чинить;
// - auth: ключ/сессия протухли - нужен человек;
// - timeout: локальные сроки вышли - возможен ретрай;
// - permission: песочница или политика прав не позволила действие - конфигурация;
// - stream: обрыв посередине ответа - частично полезные данные потеряны;
// - transport: сеть/прокси лежит - транзитная неполадка;
// - model_not_found: модели в каталоге провайдера нет - опечатка в профиле;
// - context_length: запрос не влезает в окно - менять промпт/сессию;
// - content_filter: отказ фильтра контента - ретрай не поможет;
// - unknown: сигнал не распознан - вести себя консервативно.
export type RuntimeErrorCategory =
  | "rate_limit"
  | "auth"
  | "timeout"
  | "permission"
  | "stream"
  | "transport"
  | "model_not_found"
  | "context_length"
  | "content_filter"
  | "unknown";

// Метаданные ошибки исполнения: всё опционально, потому что разные
// транспорты знают разное. HTTP-клиент сдаст httpStatus и лимиты, CLI -
// только adapterCode или вовсе ничего. Задача класса - не наказать за
// пробелы, а сохранить то, что известно.
export interface RuntimeExecutionErrorMetadata {
  // Код провайдера/SDK ("overloaded_error", "insufficient_quota"): сырая
  // монета поставщика, сохраняемая как есть. category - наша классификация,
  // adapterCode - оригинальная, и при разборе инцидентов нужна именно она.
  adapterCode?: string;
  // Числовой HTTP-статус: структурный след, по которому можно перепроверить
  // классификацию, не доверяя одному category.
  httpStatus?: number;
  // Две единицы одного и того же ожидания - не расточительность, а разделение
  // ролей: retryAfterMs точна для локальных setTimeout, а retryAfterSeconds -
  // канон для снапшотов и UI. Класс ниже выводит секунды из миллисекунд,
  // поэтому провайдеру достаточно заполнить любую из двух.
  resetAt?: string | null;
  retryAfterMs?: number | null;
  retryAfterSeconds?: number | null;
  // Разобранные лимитные заголовки, приехавшие вместе с ошибкой: потребитель
  // получает и «почему встало», и «когда встанет» в одном объекте.
  limitSnapshot?: RuntimeLimitSnapshot | null;
  // Поле-люк: всё, что не влезло в контракт (кастомные коды провайдера,
  // отладочные id запросов). Никто в ядре по нему не ветвится - иначе он
  // перестал бы быть люком и стал бы скрытым контрактом.
  providerMeta?: Record<string, unknown> | null;
}

// Рабочая лошадка всей системы исполнения: любая ошибка обращения к
// рантайму приводится к этому классу. Собрал в себе и диагноз (category),
// и протокольные следы (httpStatus/adapterCode), и план лечения
// (retryAfter*, limitSnapshot) - чтобы потребителю не требовался никто,
// кроме catch-а этой ошибки.
// Ограничитель readonly в типе поля не мешает конструктору присвоить
// значение, но запрещает мутацию всем внешним: ошибка уже «решена»,
// и перекатегоризация её по пути в лог/БД создала бы ложную историю.
export class RuntimeExecutionError extends RuntimeError {
  // Публичные readonly-поля: ошибка путешествует между модулями (agent,
  // api, ws), и мутация категории по пути разрушила бы диагностику.
  public readonly category: RuntimeErrorCategory;
  public readonly adapterCode?: string;
  public readonly httpStatus?: number;
  public readonly resetAt: string | null;
  public readonly retryAfterMs: number | null;
  public readonly retryAfterSeconds: number | null;
  public readonly limitSnapshot: RuntimeLimitSnapshot | null;
  public readonly providerMeta: Record<string, unknown> | null;

  constructor(
    message: string,
    cause?: unknown,
    // Значение по умолчанию "unknown" честное: конструктор не угадывает.
    // Заставлять каждый вызов указывать категорию было бы хуже - он
    // приписывал бы ложную уверенность там, где её нет.
    category: RuntimeErrorCategory = "unknown",
    metadata: RuntimeExecutionErrorMetadata = {},
  ) {
    // Порядок аргументов super() отличается от базового класса: код
    // фиксированный, а cause третьим параметром. Компромисс ради
    // совместимости со старыми вызовами - наследование полей не ломается.
    super(message, "RUNTIME_EXECUTION_ERROR", cause);
    this.name = "RuntimeExecutionError";
    this.category = category;
    this.adapterCode = metadata.adapterCode;
    this.httpStatus = metadata.httpStatus;
    // Нормализация ?? null: поля объявлены как `T | null`, а не опциональны.
    // Для сериализации в БД/JSON это принципиально: null попадает в колонку,
    // а отсутствующее поле - нет, и история ошибок становится однородной.
    this.resetAt = metadata.resetAt ?? null;
    this.retryAfterMs = metadata.retryAfterMs ?? null;
    // Единственная в классе вычисляемая величина: если дали миллисекунды,
    // секунды выводятся сами. Формула (ceil с клампом) одна на всю систему -
    // все, кто считает часы ожидания, считают их одинаково.
    this.retryAfterSeconds =
      metadata.retryAfterSeconds ??
      (typeof metadata.retryAfterMs === "number"
        ? Math.max(0, Math.ceil(metadata.retryAfterMs / 1000))
        : null);
    this.limitSnapshot = metadata.limitSnapshot ?? null;
    this.providerMeta = metadata.providerMeta ?? null;
  }
}

/** Проверяет, является ли ошибка RuntimeExecutionError с указанной Категорией ошибки. */
// Утилита принимает unknown: прилетевший из catch объект нельзя сужать без
// instanceof. Возвращает plain boolean, а не type predicate: сужение здесь
// не нужно, разбираться будет err.category на месте.
// Это предпочтительный способ проверки категории снаружи: прямой доступ
// к err.category требует сначала instanceof, а хелпер делает оба шага.
export function isRuntimeErrorCategory(err: unknown, category: RuntimeErrorCategory): boolean {
  return err instanceof RuntimeExecutionError && err.category === category;
}

// ---------------------------------------------------------------------------
// Отображение HTTP status → категория (единый источник истины для API-транспортов)
// ---------------------------------------------------------------------------

// Таблица статус -> категория. Выбор структуры данных не случаен:
// Map даёт O(1) поиск, итерацию и ясные has()/get() вместо цепочки if;
// а обёртка ReadonlyMap запрещает типовому потребителю set()/delete() -
// таблица живёт в модуле и должна быть неизменяемой после загрузки.
//
// Данные, а не ветвление if/else: список читается целиком, дополняется
// одной строкой, и все API-транспорты гарантированно трактуют коды
// одинаково (единственный источник правды).
//
// Выбор категорий за кулисами строк:
// - 401 и 403 оба идут в auth: в HTTP-мире 403 чаще означает негодный
//   ключ/план, чем права конкретной задачи, а различать их лечением всё
//   равно нечем - и там, и там нужен человек;
// - 429 - rate_limit даже без заголовков Retry-After: сам факт отказа по
//   квоте уже категория;
// - 408/504 оба timeouts, хотя природа разная (клиент ждёт слишком
//   долго/шлюз ждёт от бэкенда) - лечение идентично: ретрай с паузой;
// - 413 - контекст, 451 (Unavailable For Legal Reasons) - часть шлюзов
//   отдаёт им контентные блокировки, потому категория content_filter.
const HTTP_STATUS_CATEGORY_MAP: ReadonlyMap<number, RuntimeErrorCategory> = new Map([
  [401, "auth"],
  [403, "auth"],
  [429, "rate_limit"],
  [408, "timeout"],
  [504, "timeout"],
  // 404 намеренно пропущен — слишком широкий смысл для общей таблицы. 404 на
  // /models означает «модель не найдена», а на /chat/completions — неверный
  // baseUrl / конфигурация маршрута. Адаптеры должны классифицировать 404 по эндпоинтам.
  // Тот же урок в обратную сторону: полезна только однозначная таблица.
  // Единственный спорный код оставлен в табличном комментарии-предупреждении,
  // чтобы никто не «дописал» его молча.
  [413, "context_length"],
  [451, "content_filter"],
]);

/**
 * Классифицировать ошибку по HTTP status коду. API-транспорты должны использовать
 * это как первичный сигнал классификации — без сопоставления строк.
 *
 * Возвращает `null`, если статус не отображается на известную категорию
 * (вызывающему следует падать на резервную классификацию по сообщению).
 */
export function classifyByHttpStatus(status: number): RuntimeErrorCategory | null {
  const exact = HTTP_STATUS_CATEGORY_MAP.get(status);
  if (exact) return exact;
  // Единственное диапазоновое правило: любой 5xx - поломка канала связи.
  // Точный код 5xx не добавляет лечения: и 500, и 502, и 503 = «сервер
  // страдает, ретрай с backoff».
  if (status >= 500 && status < 600) return "transport";
  // null != unknown-категория: это «сигнал не распознан», и вызывающий
  // обязан продолжить конвейер классификации, а не ставить unknown заранее.
  return null;
}

// ---------------------------------------------------------------------------
// Общие резервные паттерны (единый сводный список, только как последняя мера)
// ---------------------------------------------------------------------------

/**
 * Сводные строковые паттерны для классификации ошибок по сообщению.
 * Используются ТОЛЬКО как мера последней надежды, когда нет ни HTTP status,
 * ни структурированного сигнала SDK (например, CLI-транспорты, plain Error(string)).
 *
 * Это ЕДИНЫЙ источник истины — адаптерам нельзя вести собственные массивы
 * паттернов. См. правило CHECKLIST.md "No string-based error classification".
 */
// Два неочевидных инварианта этого массива, которые нельзя увидеть в типах:
//
// 1) Все паттерны хранятся в нижнем регистре, потому что классификатор
//    приводит сообщение к lowerCase перед сравнением. Паттерн "Rate Limit"
//    с заглавными - это мёртвая строка: она не совпадёт никогда, и никто
//    не получит ошибку - просто молча не сработает ветвление.
// 2) Порядок записей = приоритет: возвращается категория первого совпадения.
//    Поэтому "timeout" стоит раньше "transport": сообщение fetch
//    «network request was aborted» содержит и network, и aborted - и
//    перестановка записей молча переключит его в другую категорию.
// readonly-обёртки в типе таблицы - не декорация: ReadonlyArray гарантирует,
// что вызывающий код не допишет новые паттерны «на месте», а readonly
// string[] внутри - что не подменит элементы. Иммутабельность справочника здесь
// важнее гибкости: список читают конкурентно все адаптеры сразу.
const SHARED_FALLBACK_PATTERNS: ReadonlyArray<{
  category: RuntimeErrorCategory;
  patterns: readonly string[];
}> = [
  {
    category: "rate_limit",
    patterns: [
      // Список собран эмпирически по реальным ответам провайдеров - от
      // подписочных формулировок Claude ("usage limit", "out of extra
      // usage") до машинных кодов OpenAI ("insufficient_quota").
      // Дубли-подстроки внутри категории ("quota" ⊂ "insufficient_quota")
      // безвредны; опасны только пересечения между категориями (см. инвариант 2).
      "usage limit",
      "out of extra usage",
      "rate limit",
      "rate_limit",
      "too many requests",
      "insufficient_quota",
      "quota",
      "at capacity",
      "model is at capacity",
      "hit your limit",
      "limit reached",
      "limit exceeded",
      "out of credits",
      "credits",
    ],
  },
  {
    // Машинные коды (authentication_error, invalid_api_key) соседствуют с
    // человеческими фразами: SDK-обёртки иногда пробрасывают наружу и то,
    // и другое в зависимости от глубины падения.
    category: "auth",
    patterns: [
      "authentication_error",
      "invalid authentication credentials",
      "failed to authenticate",
      "unauthorized",
      "invalid api key",
      "invalid_api_key",
      "invalid credentials",
      "invalid password",
      "forbidden",
      "not logged in",
    ],
  },
  {
    // etimedout - константа сокета Node, query_start_timeout - маркер SDK
    // Claude: часть «текстовых» паттернов на деле структурные коды, которые
    // иначе из сообщения не вынуть.
    category: "timeout",
    patterns: [
      "timed out",
      "timeout",
      "etimedout",
      "aborted",
      "query_start_timeout",
      "first_activity_timeout",
    ],
  },
  {
    // Отличия от соседних категорий: «здесь прав не давали провайдером, а
    // наша песочница не пустила» - лечится настройкой, не ожиданием.
    category: "permission",
    patterns: ["permission denied", "write permission", "blocked by permissions"],
  },
  {
    // Обрыв потока отличается от transport-ошибки тем, что соединение
    // поднималось успешно: умерла передача, и часть ответа уже потеряна.
    category: "stream",
    patterns: ["stream_error", "stream closed", "stream interrupted"],
  },
  {
    // Широчайшая подстрока "network": любые "network error", "bad network"
    // и т.п. Принятая небрежность - ловит лишнее, но лишь то, что не
    // перешло в более ранние категории (см. инвариант 2).
    category: "transport",
    patterns: ["connection refused", "econnrefused", "econnreset", "network", "fetch failed"],
  },
  {
    // Последние два элемента - строчные написания имён классов исключений
    // SDK (ProviderModelNotFoundError → providermodelnotfounderror): часть
    // библиотек не экслиртирует тип ошибки отдельно, и её имя остаётся
    // единственным структурным следом внутри текста.
    category: "model_not_found",
    patterns: [
      "model not found",
      "no endpoints found",
      "no models provided",
      "model_not_available",
      "no available model",
      "providermodelnotfounderror",
      "modelnotfounderror",
      "provider not found",
    ],
  },
  {
    // Окно контекста превышено: лечится сжатием истории/сессии, повтор
    // дословно того же запроса обречён - потому категория не в externals ниже.
    category: "context_length",
    patterns: ["context_length_exceeded", "maximum context length"],
  },
  {
    // Цензурный отказ провайдера. Как и context_length, детерминирован для
    // того же текста, поэтому для координатора это внутренняя проблема задачи.
    category: "content_filter",
    patterns: ["content_filter", "content_policy"],
  },
];

/**
 * Классификация ошибки по сопоставлению строки сообщения. Это МЕРА ПОСЛЕДНЕЙ
 * НАДЕЖДЫ — вызывающий обязан предпочесть `classifyByHttpStatus` или
 * структурированные сигналы SDK до обращения к этой функции.
 */
// Классификатор последнего шанса. Вызывать его можно только когда
// исчерпаны структурные сигналы: HTTP-статус, поля SDK, adapterCode.
// Результат - одна из категорий либо honest "unknown".
export function classifyByMessageFallback(message: string): RuntimeErrorCategory {
  // Приведение к нижнему регистру делает сравнение регистронезависимым и
  // требует инварианта «паттерны тоже в нижнем регистре» (см. комментарий
  // к таблице выше).
  const lowered = message.toLowerCase();
  for (const entry of SHARED_FALLBACK_PATTERNS) {
    // some() короткозамкнут: нашли подстроку - идём дальше не смотрим.
    if (entry.patterns.some((p) => lowered.includes(p))) {
      return entry.category;
    }
  }
  // "unknown" - не провал, а защита: молча угадать категорию по несходному
  // тексту хуже, чем признать незнание и повести себя консервативно.
  return "unknown";
}

// ---------------------------------------------------------------------------
// Проверка категории внешнего сбоя (для координатора агента)
// ---------------------------------------------------------------------------

/** Категории, указывающие на проблему провайдера/внешний сбой (не баг задачи). */
// Set вместо includes по массиву: O(1) и смысл «справочник membership»
// читается из типа. Состав списка - решение, а не очевидность: сюда вошли
// только категории, где повтор запроса может дать другой результат.
const EXTERNAL_FAILURE_CATEGORIES: ReadonlySet<RuntimeErrorCategory> = new Set([
  "rate_limit",
  "auth",
  "timeout",
  "permission",
  "stream",
  "transport",
]);

/**
 * True, если категория указывает на внешний сбой/проблему провайдера,
 * а не на баг в самой задаче. Координатор агента решает по ней между
 * "blocked_external" (backoff + повтор) и "revert".
 */
// Развилка координатора: внешняя проблема - задача встаёт в blocked_external
// и ждёт восстановления провайдера; внутренняя (model_not_found,
// context_length, content_filter) - детерминирована, тот же запрос даст ту
// же ошибку, поэтому изменения откатываются и задача возвращается человеку.
// Категория permission тут намеренно: песочница - часть инфраструктуры,
// а не дефект задачи.
export function isExternalFailureCategory(category: RuntimeErrorCategory): boolean {
  return EXTERNAL_FAILURE_CATEGORIES.has(category);
}
