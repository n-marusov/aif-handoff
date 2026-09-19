/**
 * Тонкий HTTP-адаптер поверх use case `applyTaskEvent`.
 *
 * Всю бизнес-логику применения события к задаче выполняет
 * packages/api/src/use-cases/taskEvents.ts; этот модуль только переводит
 * семантический результат ({ ok, code, error, task, broadcastType }) в форму,
 * которую ожидает маршрут: добавляет HTTP-статус, вычисленный из кода отказа.
 *
 * Маппинг код → статус живёт здесь одним местом:
 *  - not_found                              → 404
 *  - actor_not_authorized / assignment_required → 403
 *  - fast_fix_incomplete                    → 500
 *  - всё остальное                          → 409
 */
import { findTaskById } from "@aif/data";
import { applyTaskEvent } from "../use-cases/taskEvents.js";
import type { ApplyTaskEventInput, ApplyTaskEventResult } from "../use-cases/types.js";

// Строка задачи: выводится из findTaskById (row-типы не входят в публичный
// контракт @aif/data, поэтому тип объявляется локально, как в исходнике).
type PersistedTask = NonNullable<ReturnType<typeof findTaskById>>;

/**
 * Вход обработчика совпадает с контрактом use case: событие плюс actor/role-контекст.
 * Поля участников опциональны, потому что обработчик используется и при выключенном
 * participants mode.
 */
export type EventHandlerInput = ApplyTaskEventInput;

/**
 * Результат обработчика: ошибка с готовым HTTP-статусом либо задача для broadcast.
 * Сохранён прежним, чтобы маршруты и тесты не менялись.
 */
export type EventHandlerResult =
  | { ok: false; status: number; error: string; code?: string }
  | { ok: true; task: PersistedTask; broadcastType: "task:moved" | "task:updated" };

/** Единственное место маппинга кода отказа в HTTP-статус. */
function statusForCode(code?: string): number {
  switch (code) {
    case "not_found":
      return 404;
    case "actor_not_authorized":
    case "assignment_required":
      return 403;
    case "fast_fix_incomplete":
      return 500;
    default:
      return 409;
  }
}

function toHandlerResult(result: ApplyTaskEventResult): EventHandlerResult {
  if (result.ok) {
    // Runtime-задача в use case уже полная строка из findTaskById; тип
    // EventHandlerResult требует более широкую форму для маршрута, поэтому
    // сужение до PersistedTask безопасно.
    return { ok: true, task: result.task as PersistedTask, broadcastType: result.broadcastType };
  }
  return {
    ok: false,
    status: statusForCode(result.code),
    code: result.code,
    error: result.error,
  };
}

/**
 * Единственная публичная точка входа модуля: делегирует в use case и переводит
 * результат в транспортную форму. Никакой бизнес-логики здесь нет.
 */
export async function handleTaskEvent(input: EventHandlerInput): Promise<EventHandlerResult> {
  return toHandlerResult(await applyTaskEvent(input));
}

export { applyTaskEvent } from "../use-cases/taskEvents.js";
