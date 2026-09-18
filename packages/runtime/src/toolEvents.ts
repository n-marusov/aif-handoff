/**
 * Единая точка генерации tool-событий для всех адаптеров.
 *
 * Пока каждый адаптер сам собирал объекты RuntimeEvent, форма «съезжала":
 * разные сообщения, разные поля data, и UI приходилось подстраиваться под
 * провайдера. Эти билдеры инверсируют ответственность: адаптер поставляет
 * СЫРЫЕ факты (кто вызван, какой id, что за input), а форму события диктует
 * модуль. Consumers (чат, журнал активности, телеметрия) видят идентичный
 * формат независимо от рантайма.
 *
 * Контракт (детальнее в английском блоке ниже): каждый вызов инструмента даёт
 * ровно одно событие tool:use; интерактивный вопрос дополнительно порождает
 * tool:question. Порядок в массиве зафиксирован (use → question) - consumers
 * могут полагаться на него при рендере без сортировки.
 */

import type { RuntimeEvent, RuntimeToolQuestionPayload } from "./types.js";

/**
 * Нейтральные билдеры `RuntimeEvent`ов, связанных с инструментами.
 *
 * Каждый адаптер, обрабатывающий вызовы инструментов, должен выдавать события
 * через эти хелперы, чтобы потребители (чат, журнал активности, телеметрия)
 * видели одинаковую форму события независимо от породившего его runtime.
 *
 * Контракт:
 * - Вызов инструмента всегда порождает событие `tool:use`.
 * - Если инструмент — интерактивный вопрос (например, `AskUserQuestion` у
 *   Claude или его будущий аналог у Codex), адаптер разбирает свой нативный
 *   input в `RuntimeToolQuestionPayload` и передаёт его через `questionPayload`,
 *   и тогда вместе с `tool:use` выдаётся событие `tool:question`.
 */
export interface BuildToolUseEventsInput {
  /** Имя инструмента, как его сообщил провайдер (например, "Bash", "AskUserQuestion"). */
  toolName: string;
  /** Идентификатор вызова провайдера, если доступен — используется для дедупликации. */
  toolUseId: string | null;
  /** Сырой input инструмента (без обработки) — передаётся слушателям для логов/инспекции. */
  input: unknown;
  /** Метка времени ISO-8601, применяемая ко каждому выдаваемому событию. */
  timestamp: string;
  /** Необязательный человекочитаемый суффикс, добавляемый к сообщению tool:use. */
  detailSuffix?: string;
  /**
   * Нормализованный payload вопроса, когда инструмент интерактивный. Адаптеры
   * разбирают свою нативную форму и передают результат сюда; при `null` или
   * `undefined` хелпер выдаёт только `tool:use`.
   */
  questionPayload?: RuntimeToolQuestionPayload | null;
}

// Оба события несут ОДИН timestamp: они описывают один момент - появление
// вызова. Разное время запутало бы дедупликацию и сортировку в журнале.
// Фолбэк на toolName: если все вопросы пустые (или payload прислали кривой),
// строка не должна быть пустой - заголовок из имени инструмента читаем всегда.
export function toolQuestionEvent(
  payload: RuntimeToolQuestionPayload,
  timestamp: string,
): RuntimeEvent {
  // message для человека: вопросы склеиваются через " | " в одну строку.
  // Проверка typeof - защита от полу-доверенного payload: провайдер мог вернуть
  // не-строку, а message обязан быть валидной строкой для любого рендера.
  const joined = payload.questions
    .map((q) => (typeof q.question === "string" ? q.question.trim() : ""))
    .filter((text) => text.length > 0)
    .join(" | ");
  return {
    type: "tool:question",
    timestamp,
    level: "info",
    message: joined || payload.toolName,
    // Двойной каст через unknown: интерфейс без index signature формально не
    // присваивается Record<string, unknown>, хотя структура подходит. RuntimeEvent.data
    // намеренно широкий, и каст здесь - осознанное «мы знаем форму лучше TS»,
    // единственное место, где payload выходит за пределы типизации.
    data: payload as unknown as Record<string, unknown>,
  };
}

// Деструктуризация с дефолтами (detailSuffix="", questionPayload=null):
// необязательные поля превращаются в обязательные локально - дальше по функции
// не нужно помнить про undefined, и Boolean(questionPayload) читается однозначно.
export function buildToolUseEvents(params: BuildToolUseEventsInput): RuntimeEvent[] {
  const {
    toolName,
    toolUseId,
    input,
    timestamp,
    detailSuffix = "",
    questionPayload = null,
  } = params;
  // Флаг interactive в data - сигнал для UI: это не просто tool:use, на него
  // можно ответить. UI не обязан разбирать type второго события, чтобы решить,
  // показывать ли поле ввода.
  const interactive = Boolean(questionPayload);
  const events: RuntimeEvent[] = [
    {
      type: "tool:use",
      timestamp,
      level: "info",
      // detailSuffix подклеивается без разделителя: вызывающий сам включается
      // ведущий пробел/двоеточие (" /path"). Это согласовано с JSDoc-полем:
      // «human-friendly suffix» - суффикс, а не целое предложение.
      message: `${toolName}${detailSuffix}`,
      // input проходит без обработки (raw): здесь не место парсингу чужих
      // форматов, адаптер уже сделал всё, что мог, а инспекция/лог хотят
      // оригинал. id может быть null - не у каждого провайдера он есть, и
      // дедупликация тогда просто деградирует, а не ломается.
      data: { name: toolName, input, id: toolUseId, interactive },
    },
  ];
  if (questionPayload) {
    // Второе событие - не отдельный экспорт-вызов, а часть контракта: адаптер
    // не может «забыть» послать tool:question, если передал payload.
    events.push(toolQuestionEvent(questionPayload, timestamp));
  }
  return events;
}
