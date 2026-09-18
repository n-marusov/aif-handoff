/**
 * Извлечение снимков rate-limit из событий адаптеров и цепочек ошибок.
 *
 * Сам модуль stateless: он не хранит «текущие лимиты», а даёт чистые функции-
 * экстракторы. Состояние держит вызывающий слой (ws-хаб, UI-стор): он вызывает
 * observeRuntimeLimitEvent на каждом событии и переключает свой снапшот. Такая
 * раздельная ответственность позволяет одному потоку событий кормить несколько
 * наблюдателей без общего глобального кэша внутри пакета.
 *
 * Данные приходят из чужих источников (JSONL Codex, потоки Claude, HTTP OpenRouter),
 * поэтому все экстракторы мягкие: мусор или неверная форма дают null с
 * предупреждением в лог, но никогда не бросают исключение - потеря одного лимит-
 * события не должна ронять прогон агента, где лимиты лишь метрика наблюдения.
 */

import { buildRuntimeLimitSignature } from "@aif/shared";
import { RuntimeExecutionError } from "./errors.js";
import {
  RUNTIME_LIMIT_EVENT_TYPE,
  type RuntimeEvent,
  type RuntimeLimitEventPayload,
  type RuntimeLimitSnapshot,
} from "./types.js";

// Логгер описан локально и ПОЛНОСТЬЮ опционален (методы тоже с ?): модуль живёт
// на горячем пути каждого события и не имеет права падать из-за кривого логгера
// вызывающего. Держать свой тип вместо импорта pino - та же причина: zero-dep
// контракт «у меня есть debug/warn, если повезёт».
interface RuntimeLimitStateLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

// Единый bag настроек наблюдения вместо трёх параметров: вызывающих мест много,
// и почти всем нужны только defaults. logContext - «подпись» источника (runtimeId,
// projectId), которая приклеится к каждой записи лога отсюда.
interface RuntimeLimitEventOptions {
  logContext?: Record<string, unknown>;
  logger?: RuntimeLimitStateLogger;
  observedMessage?: string;
  malformedMessage?: string;
}

// Сообщения-константы, а не литералы на месте: тексты логов часто матчатся
// дашбордами/грепами, и опечатка в одном месте не должна менять формулировку
// в другом. Кастомные observedMessage/malformedMessage перекрывают дефолты,
// когда вызывающий хочет свою атрибуцию.
const DEFAULT_MALFORMED_MESSAGE = "Dropped runtime limit event with malformed snapshot payload";
const DEFAULT_OBSERVED_MESSAGE = "Observed runtime limit event";

// Дешёвая структурная стража: проверяется только «объект, не массив, не null».
// Полная валидация полей намеренно НЕ здесь - она живёт в normalizeRuntimeLimitSnapshot
// (@aif/shared), куда снапшот всё равно уходит. Дублировать разбор здесь означало
// бы два разных определения «валидного снапшота», которые неизбежно разъехались
// бы со временем.
function isRuntimeLimitSnapshot(value: unknown): value is RuntimeLimitSnapshot {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Цепочка options?.logger?.warn?.() - страховка на каждом звене: ни один из
// них не обязан существовать. Функция ничего не возвращает и не бросает:
// логирование повреждённого события не имеет права менять управление вызывающего.
function logMalformedRuntimeLimitEvent(
  event: RuntimeEvent,
  options?: RuntimeLimitEventOptions,
): void {
  options?.logger?.warn?.(
    {
      ...(options?.logContext ?? {}),
      eventType: event.type,
      runtimeEventTimestamp: event.timestamp,
    },
    options?.malformedMessage ?? DEFAULT_MALFORMED_MESSAGE,
  );
}

// Фильтр по типу события: проверка на конкретную константу-литерал
// RUNTIME_LIMIT_EVENT_TYPE, а не на «похож ли payload» - так мусорный data в
// обычном событии не будет ложно интерпретирован как лимит.
export function extractRuntimeLimitSnapshotFromEvent(
  event: RuntimeEvent,
  options?: RuntimeLimitEventOptions,
): RuntimeLimitSnapshot | null {
  if (event.type !== RUNTIME_LIMIT_EVENT_TYPE) {
    return null;
  }

  // event.data приходит как unknown: каст - только обещание компилятору, а
  // фактическую форму гарантирует проверка ниже, после каста обращаемся к
  // payload?.snapshot с optional chaining - data может оказаться и null.
  const payload = event.data as RuntimeLimitEventPayload | undefined;
  if (!isRuntimeLimitSnapshot(payload?.snapshot)) {
    // Невалидный снапшот - не исключение, а «событие проигнорировано + warn»:
    // адаптер мог прислать неполный лимит на парсинге своей же документации.
    logMalformedRuntimeLimitEvent(event, options);
    return null;
  }

  return payload.snapshot;
}

// FR: REQ-FR-accounting.blocking.block-on-limit-exceeded (criteria 2, 7) — гейт блокировки
// должен уметь отличить исчерпанный лимит (BLOCKED) от близкого к исчерпанию (WARNING),
// поэтому наблюдение за событиями лимитов вынесено в отдельную чистую свёртку.
// BR: BR-trigger.automation.runtime-limit-gate — состояние лимитов нормализуется в одном
// месте, чтобы api, agent и UI видели одну и ту же картину.
// Пошаговая свёртка (fold): (текущий снапшот, событие) → новый снапшот. Если
// событие не про лимиты - возвращается currentSnapshot без изменений, вызывающему
// не нужна отдельная проверка типа события. Политика «побеждает последний»:
// события идут из потока в реальном времени, и более поздний снимок свежее по
// определению; перестановки событий здесь не решаются.
export function observeRuntimeLimitEvent(
  event: RuntimeEvent,
  currentSnapshot: RuntimeLimitSnapshot | null,
  options?: RuntimeLimitEventOptions,
): RuntimeLimitSnapshot | null {
  const snapshot = extractRuntimeLimitSnapshotFromEvent(event, options);
  if (!snapshot) {
    return currentSnapshot;
  }

  // debug, не info: это на КАЖДОМ лимит-событии, шум на info забил бы логи.
  // Поля ?? null - не косметика: стабильная схема лога (всегда набор ключей),
  // чтобы JSON-логгер не выдавал записи с пропавшими полями, и фильтры по
  // полям работали предсказуемо.
  options?.logger?.debug?.(
    {
      ...(options?.logContext ?? {}),
      runtimeId: snapshot.runtimeId ?? null,
      providerId: snapshot.providerId,
      profileId: snapshot.profileId ?? null,
      status: snapshot.status,
      precision: snapshot.precision,
      source: snapshot.source,
      resetAt: snapshot.resetAt ?? null,
    },
    options?.observedMessage ?? DEFAULT_OBSERVED_MESSAGE,
  );

  return snapshot;
}

// Поиск последнего лимит-снапшота в уже сохранённой ленте событий (например,
// история сессии из файла). Обход С КОНЦА: лимит нужен «актуальный», а события
// упорядочены по времени - типичный hit происходит на первых итерациях, и весь
// массив не читается.
// Индекс events[index]! с non-null assertion: границами цикла присутствие
// элемента гарантировано, а ! документирует этот инвариант (он переживёт и
// включение noUncheckedIndexedAccess, не потребовав правок). В массиве
// фиксированной длины такое утверждение безопасно.
export function extractLatestRuntimeLimitSnapshot(
  events: RuntimeEvent[] | null | undefined,
  options?: RuntimeLimitEventOptions,
): RuntimeLimitSnapshot | null {
  // !events?.length - одним условием отсекаются null, undefined и []
  if (!events?.length) {
    return null;
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const snapshot = extractRuntimeLimitSnapshotFromEvent(events[index]!, options);
    if (snapshot) {
      return snapshot;
    }
  }

  return null;
}

// Снимок лимита может приехать не только в потоке событий, но и «зашитым» в
// FR: REQ-FR-accounting.blocking.block-on-limit-exceeded (criterion 8) — при HTTP 429 адаптер
// кладёт снапшот лимита внутрь ошибки, поэтому извлечение живёт рядом с обработкой событий.
// ошибку (429 с текущим состоянием лимитов). Поэтому у ошибки он ищется тоже.
// instanceof RuntimeExecutionError - не строковая магия по сообщению, а проверка
// класса: проектное правило «классификация только по структурированным полям».
// Рекурсия по cause - стандартная цепочка обёрт Error: адаптер мог завернуть
// исходную ошибку с лимитом в свою; глубина цепочек мала и конечна (каждая
// обёртка создаётся кодом, а не пользователем), стек-переполнение не грозит.
export function extractRuntimeLimitSnapshotFromError(error: unknown): RuntimeLimitSnapshot | null {
  if (error instanceof RuntimeExecutionError && error.limitSnapshot) {
    return error.limitSnapshot;
  }
  // "cause" in error + проверка на truthy: cause типизирован как unknown, и
  // рекурсия имеет смысл только когда обёртка реально существует (у базового
  // Error поле cause опционально и обычно отсутствует).
  if (error instanceof Error && "cause" in error && error.cause) {
    return extractRuntimeLimitSnapshotFromError(error.cause);
  }
  return null;
}

// Подпись для «нужно ли сохранять лимиты?» в cron/worker-цикле. Возвращаемое
// значение - непрозрачная (opaque) строка-идентичность: вызывающий сравнивает её с прошлой
// (строгое === вместо глубокого сравнения объектов) и пишет в БД только при
// изменении. Три исхода принципиально различимы: persist:<sig> - изменилось,
// clear - надо стереть сохранённый (лимиты закончились/сбросились), null -
// ничего не делать. Префиксы исключают коллизию: подписанный текст никогда не
// спутается с управленческим маркером clear.
// clearOnMissing - флаг политики: для одних источников «нет снапшота» значит
// «данных ещё нет» (не трогать), для других - «лимитов больше нет» (стереть).
export function buildRuntimeLimitCacheSignature(
  snapshot: RuntimeLimitSnapshot | null,
  clearOnMissing: boolean,
): string | null {
  if (snapshot) {
    return `persist:${buildRuntimeLimitSignature(snapshot)}`;
  }
  if (clearOnMissing) {
    return "clear";
  }
  return null;
}

// BR: BR-trigger.automation.runtime-limit-gate — ключ адресации строится из проекта, профиля и
// задачи: наблюдатель проекта и наблюдатель конкретной задачи не должны получать чужое
// состояние, но одно и то же состояние не должно уходить дважды одному получателю.
// Ключ room'а WebSocket-рассылки лимитов. projectId обязателен (?? null +
// ранний null: без проекта событие некуда слать - молча пропускаем).
// Третья позиция (taskId) всегда присутствует на своей позиции через ?? "":
// ключи "p1:r1:" и "p1:r1:42" различимы, а пустой хвост - это «проектный
// наблюдатель без привязки к задаче». Склейка через : безопасна: и projectId,
// и profileId - UUID/имена без двоеточий.
export function buildRuntimeLimitBroadcastCacheKey(input: {
  projectId?: string | null;
  taskId?: string | null;
  runtimeProfileId: string;
}): string | null {
  const projectId = input.projectId ?? null;
  if (!projectId) {
    return null;
  }
  return `${projectId}:${input.runtimeProfileId}:${input.taskId ?? ""}`;
}
