/**
 * Use case: атомарный старт QA-прогона (startQaRun).
 *
 * Перенесено из packages/api/src/routes/tasks.ts при clean-architecture refactoring:
 * решение "можно ли запустить QA" и CAS-захват слота — бизнес-логика, маршрут
 * остаётся тонким контроллером. Транспортная часть (broadcast WS-событий и
 * fire-and-forget диспатч раннера) осталась в маршруте, поэтому при успехе сюда
 * возвращается lockId: его маршрут передаёт в dispatchQaRun, который освобождает
 * claim в finally.
 *
 * Коды отказа семантические (без HTTP): маршрут сам решает, какой статус отдать.
 */
import { findTaskById, claimTask, releaseTaskClaim, tryStartQaRun } from "@aif/data";
import { logger } from "@aif/shared";
import type { StartQaRunInput, StartQaRunResult } from "./types.js";

const log = logger("use-case:qa-run");

/**
 * Атомарный старт QA (manual + auto trigger).
 * CAS по qaStatus предотвращает двойной запуск конкурирующих запросов.
 */
export function startQaRun(input: StartQaRunInput): StartQaRunResult & { lockId?: string } {
  const { projectId, taskId, executionRoot, lockDurationMs = 60 * 1000 } = input;
  log.debug({ useCase: "startQaRun", taskId, projectId, executionRoot }, "use case entry");

  const task = findTaskById(taskId);
  if (task?.executionOwner !== "ai") {
    log.debug(
      { useCase: "startQaRun", taskId, outcome: "denied", code: "ai_handoff_required" },
      "use case exit",
    );
    return { started: false, code: "ai_handoff_required" };
  }
  const lockId = `qa:${crypto.randomUUID()}`;
  if (!claimTask(taskId, lockId, lockDurationMs)) {
    const current = findTaskById(taskId);
    const code = current?.executionOwner === "human" ? "ai_handoff_required" : "task_locked";
    log.debug({ useCase: "startQaRun", taskId, outcome: "denied", code }, "use case exit");
    return { started: false, code };
  }
  if (!tryStartQaRun(taskId)) {
    releaseTaskClaim(taskId, lockId);
    log.debug(
      { useCase: "startQaRun", taskId, outcome: "denied", code: "already_running" },
      "use case exit",
    );
    return { started: false, code: "already_running" };
  }

  log.debug({ useCase: "startQaRun", taskId, outcome: "started", lockId }, "use case exit");
  // lockId возвращается маршруту: он диспатчит раннер и освобождает claim в finally.
  return { started: true, lockId };
}
