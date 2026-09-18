/**
 * Сторож зависших стадий: находит задачи, которые давно не подают признаков
 * жизни, и расчищает затор.
 *
 * Зачем: стадия может умереть тихо (упал процесс рантайма, оборвалась сеть,
 * рантайм вышел без кода завершения). Без внешнего наблюдателя такая задача
 * навсегда занимает слот и не двигается по доске.
 *
 * Инварианты и подводные камни:
 * - Сторож не выполняет стадию сам и не правит содержимое задачи. Его действие -
 *   только перевод в blocked_external с записью причины и срока повтора: так
 *   задача остаётся видимой для человека.
 * - Перевод идёт через compare-and-swap (expectedStatus). Пока сторож собирал
 *   данные, задачу могли перевести штатно; тогда гонку логируем и пропускаем,
 *   а не перезаписываем чужой результат.
 * - Источник возраста - максимум из времени последнего обновления и heartbeat.
 *   Брать только updatedAt нельзя: долгие стадии его не трогают, и живая задача
 *   выглядела бы зависшей.
 * - Задержка повтора случайна (5..15 минут), чтобы после общей аварии десятки
 *   задач не ринулись в бой одновременно.
 */

/**
 * Watchdog задач — обнаруживает и восстанавливает устаревшие/заблокированные задачи.
 * Выделен из coordinator.ts ради единственной ответственности.
 */

import {
  clearTaskRuntimeLimitSnapshot,
  listDueBlockedExternalTasks,
  listStaleInProgressTasks,
  transitionTaskStatus,
} from "@aif/data";
import { logger, getEnv, type TaskStatus } from "@aif/shared";
import { logActivity } from "./hooks.js";
import { notifyTaskBroadcast } from "./notifier.js";

const log = logger("task-watchdog");
const env = getEnv();
// Нижние границы защищают от опечатки в env: слишком малый таймаут превратил бы
// сторож в источник ложных срабатываний и бесконечных блокировок.
const STALE_TIMEOUT_MS = Math.max(env.AGENT_STAGE_STALE_TIMEOUT_MS, 60_000);
const STALE_MAX_RETRY = Math.max(env.AGENT_STAGE_STALE_MAX_RETRY, 1);
// Действия сторожа записываются от системного участника: в аудите должно быть
// видно, что перевод сделан автоматикой, а не человеком или самим агентом.
const WATCHDOG_ACTOR = {
  kind: "system" as const,
  id: "task-watchdog",
  displayNameSnapshot: "Task Watchdog",
};

export function getRandomBackoffMinutes(): number {
  return Math.floor(Math.random() * 11) + 5; // 5..15
}

// Функция-заглушка с единственной целью: точка расширения. Возврат того же
// статуса - осознанное решение, а не забытая логика: продолжать стадию с того же
// места безопаснее, чем угадывать откат на предыдущий статус.
function getResumeStatusForStaleTask(status: TaskStatus): TaskStatus {
  return status;
}

export function parseUpdatedAtMs(value: string): number | null {
  // SQLite хранит часть временных меток без зоны (формат "YYYY-MM-DD HH:MM:SS"),
  // и Date.parse в такой форме трактуется по-разному в зависимости от движка.
  // Поэтому нормализуем к ISO с суффиксом Z сами.
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
  const normalized =
    !hasTimezone && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

export function releaseDueBlockedTasks(): void {
  const nowIso = new Date().toISOString();
  // Выборка делает БД: она же учитывает retryAfter и владельца задачи, чтобы
  // сторож не конкурировал с другими процессами за один и тот же список.
  const blockedTasks = listDueBlockedExternalTasks(nowIso);

  log.debug({ candidateCount: blockedTasks.length }, "Due blocked tasks found for release");

  for (const task of blockedTasks) {
    // Без сохранённого статуса-источника возвращать задачу некуда: запись
    // считается неполной, и лучше оставить её заблокированной.
    if (!task.blockedFromStatus) continue;

    const transition = transitionTaskStatus({
      taskId: task.id,
      status: task.blockedFromStatus,
      expectedStatus: "blocked_external",
      extra: {
        blockedReason: null,
        blockedFromStatus: null,
        retryAfter: null,
        // Попытка исчерпана и разблокирована: счётчик повторных попыток
        // возвращается к нулю, чтобы следующие генерации/стадии стартовали
        // с чистого листа, а не наследовали историю старой блокировки.
        retryCount: 0,
      },
      actor: WATCHDOG_ACTOR,
      action: "task.watchdog_released",
    });
    if (!transition.ok) {
      // Проигранная гонка статусов - не ошибка: задача уже ушла дальше, и трогать
      // её больше нельзя. Логируем код и идём дальше.
      log.warn(
        { taskId: task.id, code: transition.code },
        "Skipped blocked task release after status race",
      );
      continue;
    }
    // Снимок лимита рантайма сбрасываем вместе с освобождением: лимит относился к
    // прерванной попытке и не должен влиять на следующий заход.
    clearTaskRuntimeLimitSnapshot(task.id, nowIso);
    void notifyTaskBroadcast(task.id, "task:moved", {
      title: task.title,
      fromStatus: "blocked_external",
      toStatus: task.blockedFromStatus,
    });
    logActivity(
      task.id,
      "Agent",
      `coordinator released blocked_external -> ${task.blockedFromStatus} after retry window elapsed`,
    );

    log.info(
      { taskId: task.id, restoreTo: task.blockedFromStatus },
      "Task released from blocked_external after backoff",
    );
  }
}

export function recoverStaleInProgressTasks(): void {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  // Фильтрация по статусу - на стороне БД: тянуть все задачи в память ради
  // отсеивания завершённых было бы лишней работой на каждом цикле опроса.
  const candidates = listStaleInProgressTasks();

  for (const task of candidates) {
    const heartbeatMs = task.lastHeartbeatAt ? parseUpdatedAtMs(task.lastHeartbeatAt) : null;
    const updatedAtMs = parseUpdatedAtMs(task.updatedAt);
    // Максимум, а не минимум: активность после обновления задачи считается
    // признаком жизни. Иначе долгая стадия, которая пишет только heartbeat,
    // выглядела бы зависшей и попала бы в кварантин.
    const referenceMs =
      heartbeatMs != null && updatedAtMs != null
        ? Math.max(heartbeatMs, updatedAtMs)
        : (heartbeatMs ?? updatedAtMs);
    if (referenceMs == null) continue;

    const ageMs = now - referenceMs;
    // Порог сравнивается с возрастом, а не с абсолютным временем: часы могут
    // расходиться (контейнер, общая ФС), а разница остаётся корректной.
    if (ageMs < STALE_TIMEOUT_MS) continue;

    const retryCount = task.retryCount ?? 0;
    const resumeStatus = getResumeStatusForStaleTask(task.status);
    const ageMinutes = Math.floor(ageMs / 60_000);
    const reasonBase = `Watchdog: task stale in ${task.status} for ${ageMinutes}m`;

    if (retryCount >= STALE_MAX_RETRY) {
      // Лимит автоповторов исчерпан: дальше только человек. Возврат ставится в
      // blockedFromStatus, чтобы освобождение было осознанным действием.
      const transition = transitionTaskStatus({
        taskId: task.id,
        status: "blocked_external",
        expectedStatus: task.status,
        extra: {
          blockedReason: `${reasonBase}; auto-retry limit reached (${STALE_MAX_RETRY})`,
          blockedFromStatus: resumeStatus,
          retryAfter: null,
        },
        actor: WATCHDOG_ACTOR,
        action: "task.watchdog_quarantined",
      });
      if (!transition.ok) {
        log.warn(
          { taskId: task.id, code: transition.code },
          "Skipped stale-task quarantine after status race",
        );
        continue;
      }
      clearTaskRuntimeLimitSnapshot(task.id, nowIso);
      void notifyTaskBroadcast(task.id, "task:moved", {
        title: task.title,
        fromStatus: task.status,
        toStatus: "blocked_external",
      });
      logActivity(
        task.id,
        "Agent",
        `coordinator moved to blocked_external (watchdog max retry reached, resume=${resumeStatus})`,
      );

      log.error(
        { taskId: task.id, status: task.status, retryCount, staleMinutes: ageMinutes },
        "Task quarantined by stale watchdog after max retries",
      );
      continue;
    }

    const backoffMinutes = getRandomBackoffMinutes();
    const retryAfter = new Date(now + backoffMinutes * 60_000).toISOString();
    // retryCount увеличивается уже на постановке в блокировку: так повторная
    // попытка не может обойти лимит, даже если она снова зависнет.
    const transition = transitionTaskStatus({
      taskId: task.id,
      status: "blocked_external",
      expectedStatus: task.status,
      extra: {
        blockedReason: `${reasonBase}; auto-recover scheduled`,
        blockedFromStatus: resumeStatus,
        retryAfter,
        retryCount: retryCount + 1,
      },
      actor: WATCHDOG_ACTOR,
      action: "task.watchdog_recovery_scheduled",
    });
    if (!transition.ok) {
      log.warn(
        { taskId: task.id, code: transition.code },
        "Skipped stale-task recovery after status race",
      );
      continue;
    }
    clearTaskRuntimeLimitSnapshot(task.id, nowIso);
    void notifyTaskBroadcast(task.id, "task:moved", {
      title: task.title,
      fromStatus: task.status,
      toStatus: "blocked_external",
    });
    logActivity(
      task.id,
      "Agent",
      `coordinator moved to blocked_external (watchdog stale recovery, resume=${resumeStatus}, retryAfter=${retryAfter})`,
    );

    log.warn(
      {
        taskId: task.id,
        status: task.status,
        staleMinutes: ageMinutes,
        retryAfter,
        nextStatus: resumeStatus,
        retryCount: retryCount + 1,
      },
      "Task recovered by stale watchdog",
    );
  }
}
