/**
 * Сборка событий о состоянии лимитов провайдера (rate limit) из его снимка.
 *
 * Адаптеры добывают RuntimeLimitSnapshot из ответов API, а потребители (логи,
 * WebSocket, UI) читают универсальный RuntimeEvent. Модуль держит единую точку
 * перевода: тип, уровень и текст выводятся из статуса по одним правилам, поэтому все
 * рантаймы сообщают о лимитах одинаково, а подписчики матятся по канонической
 * константе типа вместо сравнения свободных строк.
 */

import {
  RuntimeLimitStatus,
  RUNTIME_LIMIT_EVENT_TYPE,
  type RuntimeEvent,
  type RuntimeLimitEventPayload,
  type RuntimeLimitSnapshot,
} from "./types.js";

// Уровень журнала выводится из статуса, а не выбирается вызывающим кодом: так
// политика тихости/громкости событий лимитов живёт в одном месте.
function resolveLevel(status: RuntimeLimitSnapshot["status"]): RuntimeEvent["level"] {
  switch (status) {
    case RuntimeLimitStatus.BLOCKED:
      // warn - сигнал, что задача реально встала из-за исчерпанного лимита;
      // дефолтные фильтры предупреждений должны это ловить.
      return "warn";
    case RuntimeLimitStatus.WARNING:
      // Приближение к лимиту - штатная ситуация, заметная на info, но не тревога.
      return "info";
    case RuntimeLimitStatus.OK:
      // Штатный ответ провайдера приходит часто, поэтому ему отведён самый тихий
      // уровень: иначе логи утонули бы в повторяющихся событийных записях.
      return "debug";
    default:
      // Защита от рассинхрона версий: enum живёт в @aif/shared и может вырасти раньше,
      // чем здесь добавят ветку. Неизвестный статус молчит, а не создаёт ложных
      // предупреждений.
      return "debug";
  }
}

// Текст сообщения предназначен только человеку. Программная логика ветвится по
// structured-полям payload (status в снимке), а не по строке - см. правило проекта
// о запрете строкового матчинга ошибок; поэтому формулировки можно менять свободно.
function resolveMessage(status: RuntimeLimitSnapshot["status"]): string {
  switch (status) {
    case RuntimeLimitStatus.BLOCKED:
      return "Runtime limit state changed: blocked";
    case RuntimeLimitStatus.WARNING:
      return "Runtime limit state changed: warning";
    case RuntimeLimitStatus.OK:
      return "Runtime limit state changed: ok";
    default:
      // Честная нейтральная формулировка: выдумывать название неизвестного статуса
      // хуже, чем обобщённый текст.
      return "Runtime limit state updated";
  }
}

// Единственная точка, где рождается событие лимита: константа типа и форма payload
// задаются здесь, поэтому любой producer получает идентичный результат.
export function buildRuntimeLimitEvent(
  snapshot: RuntimeLimitSnapshot,
  rawType?: string | null,
): RuntimeEvent {
  const data: RuntimeLimitEventPayload = {
    snapshot,
    // rawType - исходный тип события провайдера, нужен только для отладки; пустая
    // строка и null считаются отсутствием. Спред с тернарником вовсе исключает ключ
    // из объекта вместо записи undefined: payload остаётся стабильным при
    // сериализации в JSON, а потребители не путают «ключа нет» и «значение null».
    ...(rawType ? { rawType } : {}),
  };

  return {
    type: RUNTIME_LIMIT_EVENT_TYPE,
    // Время события - момент проверки лимита, а не момент сборки события: порядок
    // корректен даже при отложенной доставке или повторном проигрывании.
    timestamp: snapshot.checkedAt,
    level: resolveLevel(snapshot.status),
    message: resolveMessage(snapshot.status),
    // Расширение типа, а не снятие null: RuntimeEvent.data намеренно слаботипирован
    // для универсальных потребителей (логгер, WS), а контракт держит сам
    // RuntimeLimitEventPayload, объявленный выше.
    data: data as unknown as Record<string, unknown>,
  };
}
