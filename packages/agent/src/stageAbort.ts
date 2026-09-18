/**
 * Реестр AbortController по задачам для параллельных стадий координатора.
 *
 * Один контроллер на задачу - обязательное условие: общий контроллер позволил бы
 * отмене одной стадии погасить соседние, которые прямо сейчас пишут в свои
 * репозитории. Реестр живёт в памяти процесса и не переживает перезапуск агента.
 */

/**
 * Реестр AbortController по задачам для конкурентных стадий координатора.
 * Поддерживает параллельное исполнение задач — у каждой свой контроллер.
 */

import { releaseTaskClaim } from "@aif/data";

const _activeAborts = new Map<string, AbortController>();

export function setActiveStageAbortController(taskId: string, abort: AbortController | null): void {
  if (abort) {
    _activeAborts.set(taskId, abort);
  } else {
    _activeAborts.delete(taskId);
  }
}

export function getActiveStageAbortController(taskId?: string): AbortController | null {
  // При нескольких активных стадиях ответ без taskId неоднозначен - лучше null.
  if (taskId) return _activeAborts.get(taskId) ?? null;
  // Обратная совместимость: если активна только одна — вернуть её
  if (_activeAborts.size === 1) {
    return _activeAborts.values().next().value ?? null;
  }
  return null;
}

/** Прерывает все активные стадии и отпускает их локи (используется при завершении). */
export function abortAllActiveStages(): void {
  for (const [taskId, abort] of _activeAborts) {
    // Повторный abort на уже отменённом сигнале безвреден, но пропускаем его
    // явно, чтобы не плодить лишние события.
    if (!abort.signal.aborted) abort.abort();
    // Снятие claim best-effort: при shutdown база может быть уже недоступна.
    try {
      releaseTaskClaim(taskId);
    } catch {
      /* best-effort при завершении */
    }
    // Удаление текущего ключа во время обхода Map безопасно: итератор не сбивается.
    _activeAborts.delete(taskId);
  }
}
