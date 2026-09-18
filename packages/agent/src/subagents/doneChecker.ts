/**
 * Проверка стадии Done: решает, можно ли перевести задачу в Accepted.
 *
 * Стадия работает самопетлёй и вызывается на каждом цикле опроса, поэтому в
 * большинстве вызовов обязана ничего не делать. Отсюда ранние выходы: задача
 * не в done, задача не под управлением ИИ, нет ни merge, ни approve. Вызов
 * идемпотентен: пока сигнала нет, перехода не происходит, а после перехода
 * статус уже accepted и фильтр выходит на первой же проверке.
 *
 * Сигналов одобрения три, и они равнозначны: merge PR/MR, review approved и
 * команда /approve, пришедшая с отзывами из VCS. Поиск по тексту отзывов
 * нужен как обходной путь для площадок, которые не отдают состояние review
 * через API.
 *
 * Переход выполняется через updateTaskStatus с актором-агентом и
 * CLEAN_STATE_RESET: сброс чистит поля прогона, чтобы принятая задача не
 * тащила за собой состояние исполнения.
 */

import {
  findGitHubIssueByTaskId,
  findGitLabIssueByTaskId,
  findTaskById,
  updateTaskStatus,
} from "@aif/data";
import { CLEAN_STATE_RESET, logger } from "@aif/shared";
import { logActivity } from "../hooks.js";
import { notifyTaskBroadcast } from "../notifier.js";

const log = logger("done-checker");

/**
 * Проверяет, смержен или одобрен ли связанный PR/MR задачи, и если да —
 * авто-переводит из `done` в `accepted`.
 *
 * Работает как self-loop стадия в PIPELINE (как plan-checker):
 *   - PR смержен или одобрен ревью → переход в `accepted`
 *   - Иначе → no-op, остаёмся в `done`, повтор на следующем цикле опроса
 *
 * Также проверяет синхронизированные с VCS review-комментарии задачи на
 * команду `/approve` как альтернативный сигнал одобрения.
 */
export async function runDoneChecker(taskId: string, _projectRoot: string): Promise<void> {
  // Поиск задачи, а не бросок исключения: стадия вызывается циклом, и
  // удалённая между опросами задача не должна ронять планировщик целиком.
  const task = findTaskById(taskId);
  if (!task) {
    log.error({ taskId }, "Task not found for done-checker");
    return;
  }

  // Проверка executionOwner важна не меньше статуса: задача в done, которую
  // ведёт человек, не должна автоматически приниматься агентом.
  // Действуем только над задачами в статусе `done` с AI-владельцем исполнения.
  if (task.status !== "done" || task.executionOwner !== "ai") {
    return;
  }

  // Задача может быть привязана и к GitHub, и к GitLab одновременно, поэтому
  // запросы выполняются независимо; отсутствие записи - норма, а не ошибка.
  const githubIssue = findGitHubIssueByTaskId(taskId);
  const gitlabIssue = findGitLabIssueByTaskId(taskId);

  // Приводим к boolean явно: без завершающего false в переменной оказался бы
  // undefined, и в логах нельзя было бы отличить "нет данных" от "нет сигнала".
  // Проверяем состояние merge/одобрения
  const merged = githubIssue?.prState === "merged" || gitlabIssue?.mrState === "merged" || false;
  const reviewApproved =
    githubIssue?.reviewState === "approved" || gitlabIssue?.reviewState === "approved" || false;

  // Регистр не важен, а trim спасает от отзывов с переводами строк; пустые
  // поля приводятся к пустой строке, чтобы поиск не зависел от undefined.
  // Ищем команду /approve в VCS review-комментариях (синхронизированных из PR/MR)
  const approveCommandFound =
    (task.planReviewFeedback?.trim() ?? "").toLowerCase().includes("/approve") ||
    (task.reviewComments?.trim() ?? "").toLowerCase().includes("/approve") ||
    false;

  // Ни одного сигнала - выходим без записи в БД: стадия вызывается часто, и
  // лишние обновления давали бы шум в аудите и лишние рассылки в интерфейс.
  if (!merged && !reviewApproved && !approveCommandFound) {
    log.debug(
      { taskId, prState: githubIssue?.prState ?? null, mrState: gitlabIssue?.mrState ?? null },
      "Done-checker: PR not yet merged or approved, staying in done",
    );
    return;
  }

  // Логируем все три сигнала сразу: при разборе инцидента важно понять, какой
  // именно из них сработал, а какой лишь сопутствовал.
  log.info(
    {
      taskId,
      merged,
      reviewApproved,
      approveCommandFound,
      prNumber: githubIssue?.prNumber ?? null,
      mrIid: gitlabIssue?.iid ?? null,
    },
    "Done-checker: PR/MR approved, transitioning done \u2192 accepted",
  );

  // Формулировка причины повторяет приоритет проверок: merge важнее review
  // approved, а тот важнее команды из текста отзыва.
  const now = new Date().toISOString();
  logActivity(
    taskId,
    "Agent",
    merged
      ? `[${now}] [done-checker] PR/MR merged; auto-accepting task`
      : reviewApproved
        ? `[${now}] [done-checker] PR/MR review approved; auto-accepting task`
        : `[${now}] [done-checker] /approve comment detected; auto-accepting task`,
  );

  // Актор-агент фиксирует, что переход сделан автоматикой, а не человеком: это
  // видно в истории задачи и учитывается проверками прав.
  updateTaskStatus(taskId, "accepted", CLEAN_STATE_RESET, {
    kind: "agent",
    id: "done-checker",
    displayNameSnapshot: "Done Checker",
  });

  // Два события намеренно: moved перерисовывает карточку в новой колонке,
  // updated обновляет её содержимое. `void` - рассылка не должна задерживать
  // стадию и не влияет на результат перехода.
  void notifyTaskBroadcast(taskId, "task:moved", {
    title: task.title,
    fromStatus: "done",
    toStatus: "accepted",
  });
  void notifyTaskBroadcast(taskId, "task:updated", {
    title: task.title,
    fromStatus: "done",
    toStatus: "accepted",
  });
}
