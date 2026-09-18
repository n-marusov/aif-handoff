/**
 * Парсинг rate-limit заголовков OpenAI-совместимых API.
 *
 * Модуль превращает HTTP-заголовки ответа (`x-ratelimit-*`, `Retry-After`) в
 * единый RuntimeLimitSnapshot, по которому UI и координатор решают, когда
 * можно слать следующий запрос.
 *
 * Главная практическая сложность - формат заголовков строго не стандартизован.
 * Разные провайдеры кладут в одно и то же поле epoch-секунды, миллисекунды,
 * HTTP-дату или длительность вида "1h30m". Каждый парсер здесь сначала
 * определяет форму значения, затем преобразует её, а при сомнительном
 * результате отбрасывает подсказку вместо выдумывания времени.
 *
 * Такое поведение осознанно: неверное время сброса хуже отсутствия времени
 * сброса. Ложное значение провоцирует преждевременный повтор или незаметно
 * замораживает очередь задач, и причину потом сложно найти.
 */

// `logger` из `@aif/shared` - настроенный pino; модулю задают имя подсистемы,
// чтобы логи разбора лимитов можно было отфильтровать при разборе инцидентов.
import { logger } from "@aif/shared";
// Импорт из "./types.js", а не "./types": пакет работает как ESM, и там
// TypeScript требует указывать реальные имена файлов компиляции - загрузчик
// не знает, что исходник называется .ts. Слово `type` помечает чисто
// типовые импорты: они полностью стираются из собранного JS.
import {
  RuntimeLimitPrecision,
  RuntimeLimitScope,
  RuntimeLimitSource,
  RuntimeLimitStatus,
  type RuntimeLimitSnapshot,
  type RuntimeLimitWindow,
} from "./types.js";

// Порог в процентах: остаток квоты ниже него помечает окно состоянием
// WARNING. 10% - компромисс: запас времени на реакцию (снизить интенсивность
// или сменить профиль) без постоянных ложных тревог.
const DEFAULT_WARNING_THRESHOLD = 10;
// Граница допустимых меток времени в ECMAScript: Date хранит миллисекунды
// только в диапазоне ±8.64e15 (спецификационное значение). Вне его Date
// становится Invalid Date, а toISOString() бросает исключение - отсюда
// явная проверка до всякой конвертации.
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;
// Три границы для различения epoch-значений и длительностей (см.
// parseRateLimitResetMs). Разделители чисел (1_000_000_000) - синтаксис
// ES2021: на значение не влияют, зато разряды читаются глазами.
//
// 1e9 в секундах - это сентябрь 2001 года, 1e12 в миллисекундах - март 2001.
// Современные epoch-секунды (~1.7e9) и epoch-миллисекунды (~1.7e12) попадают
// в непересекающиеся диапазоны ещё несколько столетий.
const EPOCH_SECONDS_MIN = 1_000_000_000;
const EPOCH_MILLISECONDS_MIN = 1_000_000_000_000;
// Верхняя граница «миллисекундного» диапазона: 13 девяток. Всё, что больше,
// на epoch-миллисекунды уже не похоже - такие значения уходят в длительности.
const EPOCH_MILLISECONDS_MAX = 9_999_999_999_999;
const log = logger("openai-rate-limits");

// Контракт входных данных для билдера снапшота.
//
// Необязательные поля кодируют «вызовущий может этого не знать»: profileId
// принимает null («профиль сознательно не выбран») в дополнение к undefined
// («поля нет в контексте») - для аудита это разные ситуации, поэтому оба
// значения сохранены раздельно.
interface BuildOpenAiCompatibleLimitSnapshotInput {
  providerId: string;
  runtimeId: string;
  profileId?: string | null;
  // Момент проверки ISO-строкой, а не Date: снапшот сериализуется в БД и
  // в JSON, и строка - каноническая форма метки времени в проекте.
  checkedAt?: string;
  // Прямое указание статуса: вызывающий знает про 429-ответ больше, чем
  // молчаливые заголовки, и override перебивает вывод из windows.
  statusOverride?: RuntimeLimitStatus;
  // Значение заголовка Retry-After, подменённое извне (например, из тела
  // ошибки), когда транспорт уже вытащил его из нестандартного поля.
  retryAfterHeader?: string | null;
}

// Безопасный разбор числа из HTTP-заголовка: заголовок - не типизированная
// строка, и в нём может быть что угодно.
function readFiniteNumber(value: string | null): number | null {
  // Проверка на falsy отсекает null и пустую строку: Number("") и Number(null)
  // возвращают 0, а не NaN, и «успешный» ноль уехал бы в результат.
  // При этом строка "0" - truthy, так что настоящий ноль до парсинга доходит.
  if (!value) return null;
  const parsed = Number(value);
  // isFinite отфильтровывает NaN (мусорный текст) и Infinity: оба значения
  // отравляют все последующие сравнения и арифметику процентов.
  return Number.isFinite(parsed) ? parsed : null;
}

// Процент остатка квоты. При отсутствии данных возвращается null, а не 0:
// UI обязан различать «квота кончилась» и «квота неизвестна».
function toPercentRemaining(limit: number | null, remaining: number | null): number | null {
  // Нестрогое `== null` ловит и null, и undefined: значение могло прийти из
  // десериализованного JSON, где поле просто отсутствует.
  // limit <= 0 - защита деления на ноль: провайдер иногда выключает лимит,
  // но заголовки с нулями продолжает отдавать.
  if (limit == null || remaining == null || limit <= 0) return null;
  // Кламп 0..100: шлюзы порой рапортуют remaining больше limit (параллельные
  // окна, округления) - без клампа процент ушёл бы за границы здравый смысла.
  return Math.max(0, Math.min(100, (remaining / limit) * 100));
}

// Единственные «ворота безопасности» для всех временных меток снапшота.
//
// Принимают абсолютный момент в миллисекундах и возвращают строку ISO, либо
// null, если момент нереалистичный. Параметр context несёт исходный текст
// заголовка и его роль в warn-лог: по нему можно восстановить, что именно
// прислал провайдер, не повторяя запрос.
function toSafeIsoTimestamp(
  targetMs: number,
  context: { raw: string; kind: "reset" | "retry_after"; durationMs: number },
): string | null {
  // Первая проверка: конечность и диапазон. Math.abs закрывает оба конца
  // диапазона ECMAScript: формально отрицательные даты до 1970 года
  // существуют, но в контексте лимиты это всегда ошибка данных.
  if (!Number.isFinite(targetMs) || Math.abs(targetMs) > MAX_VALID_DATE_MS) {
    // Формат log.warn(контекст, сообщение) - стандарт pino: структуры
    // первичны, текст вторичен. Поле raw сохраняет исходный заголовок:
    // отбросив подсказку, мы оставляем доказательство для будущего разбора.
    log.warn(
      {
        raw: context.raw,
        kind: context.kind,
        durationMs: context.durationMs,
        targetMs,
      },
      "Dropping invalid OpenAI-compatible reset hint",
    );
    return null;
  }

  // Второй контроль: конструктор Date. getTime() возвращает NaN только для
  // Invalid Date - это канонический способ его обнаружить.
  const date = new Date(targetMs);
  if (Number.isNaN(date.getTime())) {
    // Сообщение то же самое, что и в первом страже: оба случая - «сброс
    // подсказки», а различает их только поле targetMs в контексте.
    // Одинаковый текст - осознанный выбор: один grep находит все отбрасывания.
    log.warn(
      {
        raw: context.raw,
        kind: context.kind,
        durationMs: context.durationMs,
        targetMs,
      },
      "Dropping invalid OpenAI-compatible reset hint",
    );
    return null;
  }

  // toISOString() всегда даёт UTC в формате ISO-8601: единый вид меток
  // упрощает сравнение и хранение снапшотов в БД.
  return date.toISOString();
}

// Парсер человекочитаемых длительностей: "1h", "30m", "1.5s", "2d4h".
//
// Этот формат - не стандарт RFC, а слуховая конвенция отдельных шлюзов,
// поэтому парсер строг до предельности: принимает только строку, целиком
// состоящую из компонентов длительности.

function parseDurationLikeMs(raw: string): number | null {
  // g - обязателен: matchAll() без глобального флага бросает исключение.
  // i - регистр не важен: "1H" и "1h" значат одно и то же.
  // (?:...) - незахватывающая группа: она группирует альтернативы единиц,
  // но не сдвигает нумерацию групп (match[1] - число, match[2] - единица).
  // Порядок альтернатив (ms|s|...) важен: стой "s" раньше "ms", строка
  // "30ms" разделилась бы на "30m" плюс мусор "s".
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi;
  // totalMs - накопленная сумма: многосоставные длительности («1 час 30
  // минут») просто складываются, арифметика с переносом единиц не нужна.
  let totalMs = 0;
  let matchCount = 0;
  // Пробелы вырезаются глобально: "1 h 30 m" и "1h30m" - одно и то же.
  const normalized = raw.replace(/\s+/g, "");
  // Накопление «съеденного» текста - дешёвый способ потом проверить, что
  // вся строка состояла из совпадений и в ней не осталось постороннего.
  let consumed = "";

  // for..of поверх matchAll() - идиоматичный перебор всех совпадений
  // регулярки (в отличие от exec, не нужно вручную двигать lastIndex).
  for (const match of normalized.matchAll(pattern)) {
    // match[0] - всё совпадение целиком, match[1]/[2] - группы-захваты.
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    // Регулярка гарантирует форму, так что проверка оборонительная: любой
    // сюрприз отбивает всю подсказку, а не половину результата.
    if (!Number.isFinite(amount)) return null;
    matchCount += 1;
    consumed += match[0];

    switch (unit) {
      case "ms":
        totalMs += amount;
        break;
      case "s":
        totalMs += amount * 1000;
        break;
      case "m":
        totalMs += amount * 60_000;
        break;
      case "h":
        totalMs += amount * 3_600_000;
        break;
      case "d":
        // 86_400_000: сутки считаются фиксированными. DST сюда не попадает -
        // он смещает часы локального календаря, а не длительность в UTC;
        // а високосных секунд в Unix-time нет, поэтому день всегда ровно
        // 86400 секунд. Единицы «месяц» в парсере намеренно нет: его
        // длительность плавающая (28..31 день), а значит неделимая в мс.
        totalMs += amount * 86_400_000;
        break;
      default:
        // Регулярка ограничивает единицы, до default дойти не может - но
        // ветка защищает от будущего редактирования pattern: без неё новый
        // символ тихо получил бы 0 миллисекунд вместо явного отказа.
        return null;
    }
  }

  // Строгая проверка полноты: пустое множество совпадений («просто текст»)
  // и частично разобранная строка («5s потом кофе») одинаково невалидны.
  // Без этой проверки "5 minutes" превратилось бы в 5 миллисекунд - тот
  // самый случай, когда неверное значение хуже отсутствующего.
  if (matchCount === 0 || consumed !== normalized) {
    return null;
  }

  return totalMs;
}

// Retry-After по RFC 9110: либо задержка в секундах, либо HTTP-дата.
// Сверх того пробуется нотация длительностей - часть прокси шлёт "10s"
// вместо канонического "10". Результат - миллисекунды от «сейчас» или null.
function parseRetryAfterMs(raw: string | null): number | null {
  if (!raw) return null;
  // Пробелы по краям допустимы в HTTP, но Number() и Date.parse() надёжнее
  // работают со строго обрезанной строкой.
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Числовая форма проверяется первой и намеренно раньше Date.parse:
  // снисходительный парсер дат V8 способен прочесть голое "120" как год 120
  // или 2120. Порядок проверок здесь - часть корректности.
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric >= 0) {
    // Числовой Retry-After по семантике — длительность в секундах.
    // Отрицательные секунды - нарушение протокола: трактуем как «нет данных».
    // Все внутренние расчёты модуля идут в миллисекундах, поэтому переводим
    // сразу на входе.
    return numeric * 1000;
  }

  // HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT"): это абсолютный момент,
  // поэтому из него вычитается «сейчас», чтобы получить относительную
  // задержку.
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    // max(0, ...) страхует от расхождения часов клиента и от уже
    // просроченной даты: «подождать минус пять секунд» выполнить нельзя.
    return Math.max(0, parsedDate - Date.now());
  }

  // Последняя попытка - нотация длительностей вроде "1.5h".
  const durationMs = parseDurationLikeMs(trimmed);
  if (durationMs == null) {
    return null;
  }

  return durationMs;
}

// Самый двусмысленный парсер модуля: заголовок reset не имеет единого
// формата. Реальные API кладут туда epoch-секунды, epoch-миллисекунды,
// HTTP-дату или чистую длительность. Различать интерпретации приходится
// эвристикой по порядку величины числа.
function parseRateLimitResetMs(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric >= 0) {
    // Миллисекундный диапазон (~2001..2286 гг.) проверяется первым:
    // он уже по смыслу, чем «секундный», и требует точной границы сверху.
    if (numeric >= EPOCH_MILLISECONDS_MIN && numeric <= EPOCH_MILLISECONDS_MAX) {
      // Абсолютный момент -> относительная задержка от «сейчас».
      return Math.max(0, numeric - Date.now());
    }
    // 1e9..1e12 - epoch-секунды (с сентября 2001).
    if (numeric >= EPOCH_SECONDS_MIN) {
      // Домножение на 1000 до вычитания: смешивать секунды с
      // миллисекундами в одном выражении - классический источник ошибок на
      // три порядка.
      return Math.max(0, numeric * 1000 - Date.now());
    }
    // Малое числовое значение reset-заголовка трактуется как длительность в секундах.
    // Значение меньше 1e9 в epoch-секундах - это до 2001 года: слишком
    // древний «момент в прошлом», чтобы быть правдой. Реалистичная
    // интерпретация - отсчёт длительности (у OpenAI сброс именно в секундах).
    return numeric * 1000;
  }

  // Нечисловое значение: сначала пробуем HTTP-дату, потом длительность.
  // Порядок важен: Date.parse всеяден и может «съесть» половину мусора,
  // тогда как строгий парсер длительностей не съест ничего лишнего.
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }

  // Последний шанс - самая консервативная форма: строка обязана состоять
  // из длительностей целиком.
  return parseDurationLikeMs(trimmed);
}

// Приводит заголовок reset к абсолютной ISO-дате.
//
// parseRateLimitResetMs возвращает относительные миллисекунды («сколько
// ждать»), а наружу нужен ответ «до какого момента». Склейка «сейчас +
// длительность» делает эта функция, а не парсер: парсер остаётся чистым
// преобразованием формата, которое легко тестировать без привязки ко времени.
function parseResetAtIso(raw: string | null): string | null {
  const durationMs = parseRateLimitResetMs(raw);
  if (durationMs == null) return null;
  // raw заведомо не null (иначе durationMs не был бы числом), но типы об
  // этом не знают: ?? "" - формальное сужение, а не-runtime поведение.
  const normalizedRaw = raw ?? "";
  return toSafeIsoTimestamp(Date.now() + durationMs, {
    raw: normalizedRaw,
    kind: "reset",
    durationMs,
  });
}

// Retry-After в секундах - именно в этих единицах снапшот хранит
// рекомендацию для повторного запроса.
//
// Странность на первый взгляд: результат всё равно проходит через
// toSafeIsoTimestamp, хотя секунды наружу не используются. Это осознанный
// фильтр Sanity: если вычисленный момент абсурден, то и секундам верить
// нельзя - лучше потерять подсказку, чем отдать кривую.
function parseRetryAfterSeconds(raw: string | null): number | null {
  const durationMs = parseRetryAfterMs(raw);
  if (durationMs == null) return null;
  const normalizedRaw = raw ?? "";
  const retryAtIso = toSafeIsoTimestamp(Date.now() + durationMs, {
    raw: normalizedRaw,
    kind: "retry_after",
    durationMs,
  });
  if (!retryAtIso) return null;
  // Math.ceil округляет вверх: подождать чуть дольше безопаснее, чем дёрнуться
  // на секунду раньше и получить новый 429.
  return Math.max(0, Math.ceil(durationMs / 1000));
}

// Выбор наибольшего момента из набора ISO-строк: используется, когда у
// одного scope несколько окон со своими reset-временами и нужно «худшее».
function pickLatestIso(values: Array<string | null | undefined>): string | null {
  // Предикат типа `(value): value is string` сужает тип массива после
  // filter() - компилятор знает, что дальше идут только строки.
  const parsed = values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => Date.parse(value))
    // Date.parse возвращает NaN на неразбираемом тексте - isFinite выбрасывает
    // такие значения, не бросая исключений.
    .filter((value) => Number.isFinite(value))
    // Компаратор обязателен: без него sort() сравнивает числа как строки,
    // и «9e12» оказалось бы больше «1.7e12».
    .sort((a, b) => b - a);
  if (parsed.length === 0) return null;
  // `!` (non-null assertion) спорен с пустым массивом: длина уже проверена.
  // Обратная конвертация через new Date приводит строки к каноническому ISO.
  return new Date(parsed[0]!).toISOString();
}

// Окно лимита (window) - изолированный счётчик одного scope: запросы или
// токены. Провайдеры ведут эти счётчики независимо и ограничивают их
// независимо, поэтому и в снапшоте каждое окно живёт отдельно.
function buildWindow(
  headers: Headers,
  scope: RuntimeLimitScope,
  limitHeader: string,
  remainingHeader: string,
  resetHeader: string,
): RuntimeLimitWindow | null {
  // Headers - стандартный API fetch: .get() регистронезависим и возвращает
  // строку или null, поэтому имена заголовков здесь заведомо в нижнем
  // регистре, а проверка `if (!value)` в readFiniteNumber покрывает отсутствие.
  const limit = readFiniteNumber(headers.get(limitHeader));
  const remaining = readFiniteNumber(headers.get(remainingHeader));
  const resetAt = parseResetAtIso(headers.get(resetHeader));
  // Если по всем трём заголовкам ничего не разобрано, окна просто нет:
  // null отличает «провайдер не ограничивает» от «лимит обнулён».
  if (limit == null && remaining == null && resetAt == null) {
    return null;
  }

  const used = limit != null && remaining != null ? Math.max(0, limit - remaining) : null;
  const percentRemaining = toPercentRemaining(limit, remaining);
  const percentUsed =
    percentRemaining != null ? Math.max(0, Math.min(100, 100 - percentRemaining)) : null;

  // Окно несёт и сырые числа, и производные проценты: денормализация
  // сознательная - потребитель читает всё за один раз и не обязан уметь
  // пересчитывать проценты, повторяя нашу логику клампов.
  return {
    scope,
    limit,
    remaining,
    used,
    percentUsed,
    percentRemaining,
    resetAt,
    warningThreshold: DEFAULT_WARNING_THRESHOLD,
  };
}

// Сводный статус всех окон. Приоритет строгий и монотонный по тяжести:
// явный override > BLOCKED > WARNING > OK > UNKNOWN.
//
// Принцип: набор лимитов настолько же силён, насколько его самое слабое
// окно, поэтому одного исчерпанного окна достаточно для BLOCKED.
function resolveStatus(
  windows: RuntimeLimitWindow[],
  statusOverride?: RuntimeLimitStatus,
): RuntimeLimitStatus {
  // Override задаёт вызывающий, когда у него есть прямое доказательство -
  // например, ответ 429, при котором заголовки x-ratelimit-* молчат.
  // Доказательство всегда важнее вывода из заголовков.
  if (statusOverride) return statusOverride;
  // Строгое сравнение с нулём: blocked - только явное исчерпание от
  // провайдера. Случайный remaining < 0 сюда не попадёт, но его перехватит
  // ветка WARNING по проценту.
  if (windows.some((window) => window.remaining === 0)) {
    return RuntimeLimitStatus.BLOCKED;
  }
  // Проверка typeof перед сравнением обязательна: percentRemaining - тип
  // number | null, а undefined или null в сравнении <= дали бы ложные срабатывания.
  if (
    windows.some(
      (window) =>
        typeof window.percentRemaining === "number" &&
        window.percentRemaining <= DEFAULT_WARNING_THRESHOLD,
    )
  ) {
    return RuntimeLimitStatus.WARNING;
  }
  // Окна есть, но ни одно не в опасной зоне: лимит известен и живой.
  if (windows.length > 0) {
    return RuntimeLimitStatus.OK;
  }
  // Окон нет совсем, но снапшот всё же строится (например, из-за Retry-After):
  // это UNKNOWN, а не OK - отсутствие данных не равно их благополучию.
  return RuntimeLimitStatus.UNKNOWN;
}

// Какой scope считать «главным»: именно его показывают в бейдже лимитов.
// Правило: проблемное окно важнее первого в массиве - пользователю нужно
// видеть то ограничение, из-за которого работа встанет.
function resolvePrimaryScope(
  windows: RuntimeLimitWindow[],
  status: RuntimeLimitStatus,
): RuntimeLimitScope | null {
  if (windows.length === 0) return null;
  // find() берёт первое подходящее окно: для выбора scope порядок кандидатов
  // не критичен - достаточно любого исчерпанного.
  if (status === RuntimeLimitStatus.BLOCKED) {
    // Конструкция `?. ... ?? ...`: если.find не нашёл (гонка состояний),
    // откат к первому окну. `!` - non-null assertion: элемент гарантирован
    // проверкой длины выше, но TypeScript не отслеживает это для индексов.
    return windows.find((window) => window.remaining === 0)?.scope ?? windows[0]!.scope;
  }
  if (status === RuntimeLimitStatus.WARNING) {
    return (
      windows.find(
        (window) =>
          typeof window.percentRemaining === "number" &&
          window.percentRemaining <= DEFAULT_WARNING_THRESHOLD,
      )?.scope ?? windows[0]!.scope
    );
  }
  return windows[0]!.scope;
}

// Среди окон, удовлетворяющих предикату, выбирает «худшее»: то, чей сброс
// наступит позже всех. Ответ на вопрос «как долго ждать в худшем случае»:
// если одно исчерпанное окно сбрасывается через секунду, а другое через час,
// честнее показать час.
function pickWindowByLatestReset(
  windows: RuntimeLimitWindow[],
  predicate: (window: RuntimeLimitWindow) => boolean,
): RuntimeLimitWindow | null {
  const matching = windows.filter(predicate);
  if (matching.length === 0) return null;

  // score() - вес сортировки: момент сброса в epoch-миллисекундах.
  const score = (window: RuntimeLimitWindow): number => {
    if (typeof window.resetAt === "string") {
      const parsed = Date.parse(window.resetAt);
      if (Number.isFinite(parsed)) return parsed;
    }
    // Неизвестный или битый reset - минимальный вес: точное время всегда
    // важнее отсутствия времени. SENTINEL -Infinity гарантирует это сравнение.
    return Number.NEGATIVE_INFINITY;
  };

  // reduce с начальным null - функциональный аналог цикла «лучший пока».
  // Каст `null as RuntimeLimitWindow | null` задаёт нулевой accumulator:
  // без него тип вывелся бы непустым, и null внутри сравнений не прошёл бы.
  return matching.reduce(
    (best, candidate) => {
      // Первый кандидат становится текущим «лучшим» без сравнений.
      if (!best) return candidate;
      const bestScore = score(best);
      const candidateScore = score(candidate);
      if (candidateScore > bestScore) return candidate;
      if (candidateScore < bestScore) return best;

      // Ничья по времени сброса: срочнее то окно, где остаток квоты меньше.
      // Неизвестный процент получает +Infinity - такое окно не выигрывает
      // ничью, уступая конкретному числу.
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

// Главное окно для отображения. Каскад из трёх шагов - учебный образец
// graceful degradation: точный кандидат с reset -> любое подходящее окно ->
// первое окно. Каждая ступенька ? - отказ от точности в пользу наличия.
function resolvePrimaryWindow(
  windows: RuntimeLimitWindow[],
  status: RuntimeLimitStatus,
): RuntimeLimitWindow | null {
  if (windows.length === 0) return null;
  if (status === RuntimeLimitStatus.BLOCKED) {
    return (
      pickWindowByLatestReset(windows, (window) => window.remaining === 0) ??
      windows.find((window) => window.remaining === 0) ??
      windows[0]!
    );
  }
  // WARNING: то же правило срочности, что и для BLOCKED - самое позднее
  // сброс-время среди окон, залезших в предупреждающую зону.
  if (status === RuntimeLimitStatus.WARNING) {
    return (
      pickWindowByLatestReset(
        windows,
        (window) =>
          typeof window.percentRemaining === "number" &&
          window.percentRemaining <= DEFAULT_WARNING_THRESHOLD,
      ) ??
      windows.find(
        (window) =>
          typeof window.percentRemaining === "number" &&
          window.percentRemaining <= DEFAULT_WARNING_THRESHOLD,
      ) ??
      windows[0]!
    );
  }
  // Статусы OK/UNKNOWN предпочтений не имеют: берётся первое окно -
  // порядок фиксирован вызывающим (сначала requests, затем tokens).
  return windows[0]!;
}

// Единственная публичная точка входа модуля: на вход - объект Headers
// ответа, на выход - снапшот для БД и UI либо null.
//
// Разница этих двух исходов принципиальна для потребителя: null означает
// «мы ничего не знаем о лимитах этого провайдера», а снапшот со статусом
// «мы знаем, что провайдер молчит». UI рисует эти состояния по-разному.
//
// Функция чистая: ничего не мутирует и не обращается к сети - Headers
// только читаются. Это позволяет вызывать её повторно для каждой попытки
// ретрая и тестировать без моков транспорта.
export function buildOpenAiCompatibleLimitSnapshot(
  headers: Headers,
  input: BuildOpenAiCompatibleLimitSnapshotInput,
): RuntimeLimitSnapshot | null {
  // Override заголовка retry-after: провайдер может прятать подсказку в
  // нестандартное поле, и вызывающий (знающий свой API) подменяет имя.
  const retryAfterHeader = input.retryAfterHeader ?? headers.get("retry-after");
  const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader);
  // Условие требует и наличия заголовка, и успешного разбора: одно без
  // другого невозможно, а конъюнкция страхует от будущих правок парсера,
  // где эти инварианты могут разъехаться.
  const retryAfterResetAt =
    retryAfterHeader && retryAfterSeconds != null
      ? toSafeIsoTimestamp(Date.now() + retryAfterSeconds * 1000, {
          raw: retryAfterHeader,
          kind: "retry_after",
          durationMs: retryAfterSeconds * 1000,
        })
      : null;
  // Окна requests и tokens строятся симметрично: различаются только имена
  // заголовков и scope. Отсутствие окна - не ошибка, а сигнал «провайдер
  // не публикует этот аспект лимита».
  const requestWindow = buildWindow(
    headers,
    RuntimeLimitScope.REQUESTS,
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
  );
  // Токенное окно - второе измерение лимита: короткие частые запросы упираются
  // в requests, длинные генерации - в tokens. Провайдеры ограничивают их
  // независимо, поэтому статус считается по худшему из двух.
  const tokenWindow = buildWindow(
    headers,
    RuntimeLimitScope.TOKENS,
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
  );

  // Предикат-фильтр `(window): window is RuntimeLimitWindow` убирает null из
  // типа массива: ниже windows - это уже RuntimeLimitWindow[], и обращения к
  // элементам не требуют кастов или проверок на undefined.
  const windows = [requestWindow, tokenWindow].filter(
    (window): window is RuntimeLimitWindow => window != null,
  );

  // Инвариант: если ни одного окна и Retry-After не разобран, снапшот
  // неинформативен - возвращаем null вместо пустышки. Но если хоть один
  // сигнал есть (хоть Retry-After), дальше идёт построение статуса.
  if (windows.length === 0 && retryAfterSeconds == null) {
    return null;
  }

  const status = resolveStatus(windows, input.statusOverride);
  const primaryWindow = resolvePrimaryWindow(windows, status);
  // Выбор resetAt - каскад приоритета: время главного окна -> самое позднее
  // время среди окон того же scope (если у главного его нет) -> момент из
  // Retry-After. Тире между вариантами рисует `??`: срабатывает первый непустой.
  const resetAt =
    primaryWindow?.resetAt ??
    (primaryWindow
      ? pickLatestIso(
          // Фallback внутри одного scope: берём максимум reset-времени среди
          // окон той же природы (requests не смешиваем с tokens) - разные
          // измерения сравнивать бессмысленно.
          windows
            .filter((window) => window.scope === primaryWindow.scope)
            .map((window) => window.resetAt),
        )
      : null) ??
    retryAfterResetAt;

  return {
    // Источник данных зафиксирован: снапшот мог прийти и из другого канала
    // (статус-страница провайдера, внутренний расчёт) - заголовки заслуживают
    // максимального доверия, и метка source это отражает.
    source: RuntimeLimitSource.API_HEADERS,
    status,
    // EXACT: числа взяты из заголовков один-в-один, без экстраполяции.
    // Честная метка точности позволяет потребителю не «уточнять» то, что
    // уже точно.
    precision: RuntimeLimitPrecision.EXACT,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    // Идентичность провайдера и рантайма приклеивается к снапшоту здесь, а
    // не выводится из headers: заголовки не рассказывают, кто их прислал.
    providerId: input.providerId,
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    primaryScope: primaryWindow?.scope ?? resolvePrimaryScope(windows, status),
    resetAt,
    retryAfterSeconds,
    // Порог предупреждения отдаётся наружу только если хоть одно окно знает
    // свой процент: иначе предупреждать не о чем, и поле честно становится null.
    warningThreshold: windows.some((window) => window.percentRemaining != null)
      ? DEFAULT_WARNING_THRESHOLD
      : null,
    windows,
    // Метаданные провайдера здесь недоступны: это заголовочный парсер, а не
    // разбор тела ответа.
    providerMeta: null,
  };
}
