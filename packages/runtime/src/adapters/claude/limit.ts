/**
 * Нормализация лимитов Claude: превращает «сырое» событие rate-limit из Agent SDK
 * в единый runtime-нейтральный снапшот RuntimeLimitSnapshot.
 *
 * Зачем нужен целый слой нормализации: форма payload'а SDK нигде формально не
 * контрактится — поля опциональны, utilization приходит то долей (0..1), то
 * процентами (0..100), таймстампы — то в секундах, то в миллисекундах. Потребители
 * же (UI, координатор, gate'ы) должны видеть одну схему для всех адаптеров, иначе
 * вся экзотика Claude растечётся по интерфейсу. Этот модуль — единственное место,
 * где «понедопустимости» Claude переводятся в общий язык, и больше нигде про них
 * не знают.
 *
 * Работа с недоверенными данными: на входе `info: unknown`, поэтому внутри нет
 * ни одного прямого `as` к содержимому — только сужающие_accessors'ы (asRecord,
 * readString, readNumber, readBoolean), которые на мусор возвращают null, а не
 * падают и не выдают галлюцинацию типа (правило Nullable Cast). Любое поле может
 * отсутствовать, и каждый вычисляющий шаг умеет ответить «не знаю»: null —
 * честный ответ, выдуманные нули и «сейчас» были бы хуже.
 *
 * Философия результата: если из payload'а не извлечён ни один осмысленный сигнал,
 * возвращается null — отсутствие данных лучше, чем снапшот-«пустышка», который
 * UI покажет как реальное состояние аккаунта.
 *
 * Почему precision всегда HEURISTIC: все числа (проценты, таймер сброса) выведены
 * из косвенных полей события и догадки о разрядности, а не получены из тарифного
 * API. Честная пометка «приблизительно» позволяет UI рисовать «≈» и не обещать
 * точность, которой у нас нет.
 *
 * Зачем в снапшоте два словоря одновременно: типизированные поля (status, scope,
 * windows) — общий язык для UI и координатора, а providerMeta хранит исходный
 * словарь Claude (rateLimitType, overageStatus, surpassedThreshold) — он нужен при
 * разборе инцидентов, когда «почему UI так решил» неотделимо от «что пришло в
 * событии».
 */

import { logger } from "@aif/shared";
import {
  RuntimeLimitPrecision,
  RuntimeLimitScope,
  RuntimeLimitSource,
  RuntimeLimitStatus,
  type RuntimeLimitSnapshot,
  type RuntimeLimitWindow,
} from "../../types.js";
import type { ClaudeProviderIdentity } from "./providerIdentity.js";

// Словарь состояний/типов лимитов заимствован у SDK и живёт только здесь: наружу
// (в снапшот) он выходит уже в терминах RuntimeLimitStatus/RuntimeLimitScope.
// Держать сырые строки за границей модуля нельзя — их формат эволюционирует
// вместе с SDK.
type ClaudeRateLimitStatus = "allowed" | "allowed_warning" | "rejected";
type ClaudeRateLimitType =
  | "five_hour"
  | "seven_day"
  | "seven_day_opus"
  | "seven_day_sonnet"
  | "overage";

// Все поля опциональны: SDK шлёт разные наборы в разных режимах (базовое окно,
// overage-окно, оба). Опциональность здесь — документированная честность: парсер
// не делает вид, что знает больше, чем пришло в событии.
interface ClaudeRateLimitInfo {
  status?: ClaudeRateLimitStatus;
  resetsAt?: number;
  rateLimitType?: ClaudeRateLimitType;
  utilization?: number;
  overageStatus?: ClaudeRateLimitStatus;
  overageResetsAt?: number;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}

// info намеренно unknown: событие приходит из недр SDK и может оказаться чем
// угодно (вплоть до undefined), весь модуль строится на этом допущении.
interface NormalizeClaudeLimitSnapshotInput {
  info: unknown;
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
  checkedAt?: string;
  providerIdentity?: ClaudeProviderIdentity | null;
}

// Предельный размах Date в ECMA-262: ±8.64e15 мс от эпохи. Таймстамп вне этого
// диапазона создаёт Invalid Date с NaN внутри — дешевле отбросить его сейчас,
// чем чинить последствия в сериализации.
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;
// Именованный child-логгер: предупреждения о мусорных полях payload'а должны
// находиться по тегу "claude-limit", а не тонуть в общем потоке runtime'а.
const log = logger("claude-limit");

// Единственный способ прикоснуться к unknown как к объекту: проверить форму и
// только тогда сузить. Массив — тоже object в JS, но полей у него нет, поэтому
// !Array.isArray обязателен. Провал даёт {} — «пустой объект», дальше все
// read*'ы вернут null и снапшот деградирует корректно.
// Возврат именно {} (а не null) делает конвейер тотальным: вызывающему коду не
// нужны проверки на каждом шаге, а «не знаю» кодируется значением null у
// конкретных полей.
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Семейство read* — «тотальные» геттеры недоверенных данных: вместо исключения
// на неожиданном типе они отвечают null, заставляя вызывающий код явно обработать
// незнание. trim+проверка на пустоту у readString — чтобы "   " не притворилось
// значимым статусом.
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
  // Отдельно от readString: boolean-поле как строка ("true") — почти наверняка
  // мусорная адаптация старого формата, принимать её за настоящее значение
  // опасно: isUsingOverage управляет ветками статусов ниже.
  return typeof value === "boolean" ? value : null;
}

function readNumber(value: unknown): number | null {
  // Number.isFinite отсекает и NaN, и Infinity: JSON их формально не переносит,
  // но NaN в utilization неминуемо отравил бы арифметику процентов ниже.
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Таймстамп → ISO-строка с угадыванием разрядности. Порог 1e12 опирается на
// календарь: секундные счётчики от эпохи перешагнут его лишь в 33658 году, а
// миллисекундные живут выше него уже с 2001-го. Значит, вход ниже порога — это
// секунды (умножаем на 1000), выше — миллисекунды (берём как есть).
// Дальше двойной контроль (диапазон + Invalid Date): new Date() принимает что
// угодно и молча рождает NaN-дату, которую пришлось бы отлавливать в каждом
// потребителе снапшота, — поэтому мусор отсекается здесь и логируется.
function normalizeTimestamp(value: number | null): string | null {
  if (value == null) return null;
  const ms = value >= 1_000_000_000_000 ? value : value * 1000;
  // Предупреждение, а не тихий null: молча сброшенный reset hint позже выглядит
  // как «SDK не прислал данные», и диагностика уйдёт по ложному следу.
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_VALID_DATE_MS) {
    log.warn(
      {
        rawValue: value,
        normalizedMs: ms,
      },
      "Dropping invalid Claude reset hint while normalizing rate-limit metadata",
    );
    return null;
  }

  const date = new Date(ms);
  // После диапазонного guard'а проверка формально почти недостижима, но она
  // обязательна как последняя линия: toISOString() на Invalid Date бросает
  // RangeError, и лучше отсеять невозможное значение здесь, чем поймать
  // исключение из середины сборки снапшота.
  if (Number.isNaN(date.getTime())) {
    log.warn(
      {
        rawValue: value,
        normalizedMs: ms,
      },
      "Dropping invalid Claude reset hint while normalizing rate-limit metadata",
    );
    return null;
  }

  return date.toISOString();
}

// Приведение utilization к процентам 0..100 через разбор двух форматов. Диапазон
// 0..1 трактуется как доля, 0..100 — как процент: это единственные два формата,
// которые SDK использовал в разных версиях. Значение ровно 1 двусмысленно
// (100% доли или 1% процента?), и здесь выбран верхний вариант — полные 100%:
// при лимитах консервативная трактовка безопаснее оптимистичной.
// Всё, что не влезает ни в один формат, — мусор, и он честно становится null.
function normalizeUtilizationPercent(value: number | null): number | null {
  if (value == null) return null;
  if (value >= 0 && value <= 1) {
    return value * 100;
  }
  if (value >= 0 && value <= 100) {
    return value;
  }
  return null;
}

// Статус overage-окна «rejected» сам по себе ничего не значит: он описывает
// состояние запасного лимита, который может быть и не подключён. Отказ засчитывается
// только когда аккаунт реально работает в overage-режиме (isUsingOverage), иначе
// неактуальный флаг превратил бы здоровый аккаунт в BLOCKED.
function isActiveOverageRejection(info: ClaudeRateLimitInfo): boolean {
  return info.overageStatus === "rejected" && info.isUsingOverage === true;
}

// Оверейдж-окно «релевантно», только когда аккаунт им пользуется: для обычных
// пользователей там лежат заготовленные, но неиспользуемые поля, и считать их
// сигналом — значит выдумывать данные.
function isOverageWindowRelevant(info: ClaudeRateLimitInfo): boolean {
  return info.isUsingOverage === true;
}

// Итоговый статус аккаунта = максимум тревожности по обоим окнам. Порядок веток
// и есть приоритет: BLOCKED из любого окна перебивает всё, предупреждение или
// сам факт жизни на overage — следующее, «разрешено» — только позитивный ответ
// базового окна. Всё остальное (пустой payload, незнакомые строки) — UNKNOWN,
// который потребители рисуют нейтрально, а не зелёным.
function mapStatus(info: ClaudeRateLimitInfo): RuntimeLimitStatus {
  const baseWindowRejected = info.status === "rejected";
  const overageWindowRejected = isActiveOverageRejection(info);

  if (baseWindowRejected || overageWindowRejected) {
    return RuntimeLimitStatus.BLOCKED;
  }
  if (info.status === "allowed_warning" || info.isUsingOverage === true) {
    return RuntimeLimitStatus.WARNING;
  }
  if (info.status === "allowed") {
    return RuntimeLimitStatus.OK;
  }
  // UNKNOWN — не «заглушка на всякий случай», а содержательный ответ: статуса в
  // payload'е нет, и мы не знаем о лимитах больше ничего. Смешать его с OK было бы
  // опаснее — UI показал бы зелёный индикатор там, где данные просто не пришли.
  return RuntimeLimitStatus.UNKNOWN;
}

// Тип лимита SDK отображается на ось ограничения: overage — это про деньги
// (SPEND, сброс по пополнению баланса), все окна five_hour/seven_day — про время
// (TIME, сброс по часам/суткам). Незнакомые будущие типы падают в OTHER, а не
// ломают маппинг: честная неопознанность лучше выдуманного scope.
function mapScope(rateLimitType: ClaudeRateLimitType | null): RuntimeLimitScope {
  if (rateLimitType === "overage") {
    return RuntimeLimitScope.SPEND;
  }
  if (
    rateLimitType === "five_hour" ||
    rateLimitType === "seven_day" ||
    rateLimitType === "seven_day_opus" ||
    rateLimitType === "seven_day_sonnet"
  ) {
    return RuntimeLimitScope.TIME;
  }
  return RuntimeLimitScope.OTHER;
}

// Выбор «главного» окна — то, чьи проценты и таймер покажут в UI. Правило:
// главное то окно, которое объясняет текущий статус. При BLOCKED из overage-окна
// показывать базовое five_hour — значит соврать о причине блокировки; при
// WARNING на overage — базовое окно тоже не ответ. Отсюда и топоразбор:
// заголовок ветки = статус, содержимое = релевантность overage.
// Базовый тип при этом обнуляется, если payload прислал rateLimitType "overage"
// без активного overage-режима: это поле того же окна, что мы уже отмели выше.
function resolvePrimaryRateLimitType(
  info: ClaudeRateLimitInfo,
  status: RuntimeLimitStatus,
): ClaudeRateLimitType | null {
  const overageRelevant = isOverageWindowRelevant(info);
  const baseType =
    info.rateLimitType === "overage" && !overageRelevant ? null : (info.rateLimitType ?? null);

  if (status === RuntimeLimitStatus.BLOCKED) {
    // При блокировке первичен виновник: активный отказ overage вытесняет базовый
    // тип, иначе окно и причина расходились бы в одном снапшоте.
    return isActiveOverageRejection(info) ? "overage" : baseType;
  }

  if (status === RuntimeLimitStatus.WARNING) {
    return overageRelevant ? "overage" : baseType;
  }

  // Последняя строка работает и для OK, и для UNKNOWN: правило одно — «показываем
  // то окно, в котором реально живёт аккаунт». Ветка существует, чтобы функция
  // осталась тотальной и не зависела от перечисления статусов выше.
  return overageRelevant ? "overage" : baseType;
}

// Точка входа слоя нормализации. Сначала «недоверенный вход → типизированный
// чанк» (поля через read*-геттеры, null'ы превращаются в undefined для чистоты
// интерфейса), затем несколько независимых вычислений поверх, и в конце — сборка
// снапшота. Функция не бросает исключений и не трогает сеть: это чистая
// детерминированная проекция, которую можно гонять на любом историческом payload.
export function normalizeClaudeLimitSnapshot(
  input: NormalizeClaudeLimitSnapshotInput,
): RuntimeLimitSnapshot | null {
  const raw = asRecord(input.info);
  const info: ClaudeRateLimitInfo = {
    status: readString(raw.status) as ClaudeRateLimitStatus | undefined,
    resetsAt: readNumber(raw.resetsAt) ?? undefined,
    rateLimitType: readString(raw.rateLimitType) as ClaudeRateLimitType | undefined,
    utilization: readNumber(raw.utilization) ?? undefined,
    overageStatus: readString(raw.overageStatus) as ClaudeRateLimitStatus | undefined,
    overageResetsAt: readNumber(raw.overageResetsAt) ?? undefined,
    overageDisabledReason: readString(raw.overageDisabledReason) ?? undefined,
    isUsingOverage: readBoolean(raw.isUsingOverage) ?? undefined,
    surpassedThreshold: readNumber(raw.surpassedThreshold) ?? undefined,
  };

  const status = mapStatus(info);
  const primaryRateLimitType = resolvePrimaryRateLimitType(info, status);
  const scope = mapScope(primaryRateLimitType);
  // Проценты считаются один раз и оттуда же выводится «остаток» — иначе два
  // независимых 100-x могли бы разойтись из-за плавающей точки. Ограничение
  // 0..100 страхует от utilization > 100: SDK честно шлёт перегрев лимита,
  // но прогресс-бар с 130% был бы багом UI.
  const percentUsed = normalizeUtilizationPercent(info.utilization ?? null);
  const percentRemaining =
    percentUsed == null ? null : Math.max(0, Math.min(100, 100 - percentUsed));
  // Таймер сброса берётся из «своего» окна: для overage сначала его resetsAt,
  // с падением на общий resetsAt; для остальных типов — сразу общий. Иначе UI
  // показывал бы «сброс через час», когда блокировка сядет только после оплаты.
  const resetAt =
    primaryRateLimitType === "overage"
      ? (normalizeTimestamp(info.overageResetsAt ?? null) ??
        normalizeTimestamp(info.resetsAt ?? null))
      : normalizeTimestamp(info.resetsAt ?? null);

  // Порог «показать или не показать»: unknown-статус без единого полезного поля
  // означает, что событие было пустым. Возвращать такой снапшот — плодить пустые
  // бейджи «лимит неизвестен» в UI, которые пользователь прочитает как реальный
  // сигнал. null здесь — способ сказать «данных нет, не рисуй ничего».
  const hasMeaningfulSignal =
    status !== RuntimeLimitStatus.UNKNOWN ||
    resetAt != null ||
    percentUsed != null ||
    primaryRateLimitType != null ||
    info.isUsingOverage === true;

  if (!hasMeaningfulSignal) {
    return null;
  }

  const window: RuntimeLimitWindow = {
    scope,
    // name — машинный идентификатор окна (five_hour / seven_day / overage): по
    // нему потребитель может построить свою подпись, не разбирая scope.
    name: primaryRateLimitType,
    percentUsed,
    percentRemaining,
    resetAt,
  };

  return {
    // SDK_EVENT — важное отличие от снимков, полученных опросом тарифного API:
    // этот снапшот отражает то, что SDK сказал в конкретный момент рана, и не
    // обновляется сам.
    source: RuntimeLimitSource.SDK_EVENT,
    status,
    // Точность честно объявлена как HEURISTIC: проценты и сброс выведены из
    // косвенных полей и угадывания разрядности, а не из тарифного API. Ниже
    // UI сможет нарисовать «≈», а не «точные цифры» — ложная точность опаснее.
    precision: RuntimeLimitPrecision.HEURISTIC,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    providerId: input.providerId,
    runtimeId: input.runtimeId,
    // profileId остаётся null, когда ран шёл на настройках по умолчанию: null здесь
    // честно означает «профиль не выбран», а не «неизвестно».
    profileId: input.profileId ?? null,
    primaryScope: scope,
    resetAt,
    // retryAfterSeconds/warningThreshold — null не «забыли заполнить», а факт:
    // SDK в этом событии их не присылает, выдумывать значение было бы подделкой
    // источника данных.
    retryAfterSeconds: null,
    warningThreshold: null,
    // Окно одно, хотя схема допускает список: у Claude-события сейчас только
    // «главное» окно (см. resolvePrimaryRateLimitType); форма списка — запас под
    // будущие multi-window payload'ы без смены контракта.
    windows: [window],
    // providerMeta — «сырой этаж»: оригинальные поля сохраняются как есть, чтобы
    // при разборе инцидентов не пришлось перепроверять SDK-события по логам.
    // Идентичность провайдера (fingerprint/label) идёт сюда, а не в типизированную
    // часть снапшота: она специфична для Claude и не должна просачиваться в общий
    // контракт runtime'ов.
    providerMeta: {
      providerFamily: input.providerIdentity?.providerFamily ?? null,
      providerLabel: input.providerIdentity?.providerLabel ?? null,
      quotaSource: input.providerIdentity?.quotaSource ?? null,
      accountFingerprint: input.providerIdentity?.accountFingerprint ?? null,
      accountLabel: input.providerIdentity?.accountLabel ?? null,
      // Дублирование полей из типизированной части — намеренное: здесь лежат
      // оригинальные значения SDK без интерпретации, и при разборе «почему UI
      // показал BLOCKED» видно и решение, и его источник.
      rateLimitType: primaryRateLimitType,
      status: info.status ?? null,
      overageStatus: info.overageStatus ?? null,
      isUsingOverage: info.isUsingOverage ?? null,
      surpassedThreshold: info.surpassedThreshold ?? null,
      overageDisabledReason: info.overageDisabledReason ?? null,
    },
  };
}
