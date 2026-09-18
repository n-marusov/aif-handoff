/**
 * Субгент стадии Verify: сверяет реализацию с планом и собирает отчёт.
 *
 * Стадия совещательная (advisory): её задача - собрать доказательства, а не
 * остановить конвейер. Поэтому падение самого субагента (лимит инструментов,
 * ошибка потока, запрещённая команда) не пробрасывается наружу - в отзыв
 * пишется предупреждение, и задача идёт дальше в Review.
 *
 * Единственный блокирующий сигнал - размеченный блок aif-gate-result со
 * status=fail или blocking=true: это явное указание, что проверку провалили
 * по существу. Именно поэтому вердикт читается только из блока, а не из
 * текста: иначе любое упоминание слова fail в рассуждении ломало бы пайплайн.
 *
 * Отзыв не перезаписывается, а дописывается к существующему reviewComments:
 * к моменту проверки там уже могут быть заметки предыдущих стадий, терять их
 * нельзя. Исключение - отказ субагента: и туда, и сюда пишется один и тот же
 * текст предупреждения.
 */

import { findProjectById, findTaskById, setTaskFields } from "@aif/data";
import { createRuntimeWorkflowSpec } from "@aif/runtime";
import { logger } from "@aif/shared";
import { assertCurrentBranch, restorePersistedBranch } from "../gitBranch.js";
import { logActivity } from "../hooks.js";
import { StageManualBlockError } from "../stageErrorHandler.js";
import { executeSubagentQuery } from "../subagentQuery.js";

// Отдельный logger на модуль: префикс "verifier" в логах отделяет стадии друг
// от друга при разборе одного прогона задачи.
const log = logger("verifier");

// Поля необязательные: модель может вернуть только status, только blocking
// или вообще пустой объект. Отсутствие поля - не ошибка разбора, а честное
// "сигнала нет".
interface VerifyGateResult {
  status?: "pass" | "warn" | "fail";
  blocking?: boolean;
  blockers?: unknown[];
}

// Вердикт ищется в огороженном блоке, чтобы не путать его с текстом отчёта.
// Любая проблема (нет блока, битый JSON, не объект) означает "вердикта нет":
// возвращается null, а не исключение, потому что вызывающий код не должен
// оборачивать разбор в try.
function extractVerifyGateResult(resultText: string): VerifyGateResult | null {
  const fence = resultText.match(/```aif-gate-result\s*([\s\S]*?)```/);
  if (!fence) return null;

  try {
    const parsed: unknown = JSON.parse(fence[1].trim());
    // Массив формально проходит проверку typeof "object", поэтому исключается
    // отдельно - вердикт обязан быть именно объектом-записью.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    // Вердикт собирается по полям поштучно: неизвестный статус и мусорный
    // blockers просто не попадают в результат, а не роняют разбор.
    return {
      status:
        record.status === "pass" || record.status === "warn" || record.status === "fail"
          ? record.status
          : undefined,
      blocking: typeof record.blocking === "boolean" ? record.blocking : undefined,
      blockers: Array.isArray(record.blockers) ? record.blockers : undefined,
    };
  } catch {
    return null;
  }
}

// Функция ничего не возвращает: результат стадии - запись в reviewComments.
// Наружу пробрасывается только блокирующий вердикт и "задача не найдена".
export async function runVerifier(taskId: string, projectRoot: string): Promise<void> {
  const task = findTaskById(taskId);

  if (!task) {
    log.error({ taskId }, "Task not found for verify stage");
    throw new Error(`Task ${taskId} not found`);
  }

  // Ветку восстанавливаем до запуска агента: проверка читает файлы проекта и
  // должна видеть то же состояние, что и исполнитель. У fix-задач отдельной
  // ветки нет, поэтому проверка на isFix.
  if (task.branchName && !task.isFix) {
    restorePersistedBranch({
      projectRoot,
      taskId,
      persistedBranchName: task.branchName,
    });
    logActivity(taskId, "Agent", `Restored feature branch: ${task.branchName}`);
  }

  // Бюджет боковой проверки, а не основной: верификация - вспомогательный
  // проход, и её стоимость не должна равняться стоимости реализации. null
  // означает "лимит не задан".
  const project = findProjectById(task.projectId);
  const sidecarBudget = project?.reviewSidecarMaxBudgetUsd ?? null;
  // Слэш-команда - запасной путь для runtime без собственного агента
  // aif-verify; в промпте она стоит первой строкой.
  const verifySlashCommand = "/aif-verify";
  // Жёсткая рамка рабочей директории: без неё агент может уйти в родительские
  // каталоги и проверять чужие проекты.
  const scopeConstraint = `IMPORTANT: Your working directory is ${projectRoot}
All file reads, searches, and verification commands must stay within this directory. Do NOT navigate to parent directories or other projects.`;
  // Маркеры HANDOFF_* в промпте машинные: по ним вложенный агент понимает, что
  // работает автономно и к какой задаче привязан его отчёт.
  const prompt = `${verifySlashCommand}

HANDOFF_MODE: 1
HANDOFF_TASK_ID: ${taskId}
Autonomous Handoff mode: true.
Do not ask interactive questions.
If verification finds issues, report them in the final aif-gate-result block and stop.

${scopeConstraint}

Task title: ${task.title}
Task description: ${task.description}`;

  // Обязательных возможностей нет - проверка сводится к чтению файлов и
  // запуску команд. Новая сессия выбрана намеренно: проверяющий не должен
  // видеть рассуждения исполнителя, иначе он унаследует его допущения и
  // пропустит ошибку, которую обязан заметить свежим взглядом.
  const workflowSpec = createRuntimeWorkflowSpec({
    workflowKind: "verifier",
    prompt,
    requiredCapabilities: [],
    fallbackSlashCommand: verifySlashCommand,
    fallbackStrategy: "slash_command",
    executionMode: "standard",
    sessionReusePolicy: "new_session",
    systemPromptAppend: scopeConstraint,
  });

  // Объявляем заранее: значение должно пережить блок try и использоваться на
  // основном пути, тогда как catch завершает функцию досрочно.
  let resultText: string;
  // try охватывает только сам вызов: сбой рантайма здесь означает "нет
  // вердикта", а не "проверка не пройдена".
  try {
    const subagentResult = await executeSubagentQuery({
      taskId,
      projectRoot,
      agentName: "aif-verify",
      prompt,
      profileMode: "review",
      maxBudgetUsd: sidecarBudget,
      workflowSpec,
      workflowKind: "verifier",
      fallbackSlashCommand: verifySlashCommand,
    });
    resultText = subagentResult.resultText;
  } catch (err) {
    // Сабагент не смог завершить верификацию (лимит цикла инструментов, ошибка
    // потока, запрещённая команда и т.п.). Верификация совещательная — не должна
    // блокировать конвейер. Логируем сбой, пишем предупреждающую заметку и
    // идём на ревью.
    log.warn({ taskId, err }, "Verify subagent failed; proceeding without blocking");
    const failedAt = new Date().toISOString();
    logActivity(
      taskId,
      "Agent",
      `verify subagent failed at ${failedAt}: ${err instanceof Error ? err.message : String(err)}; proceeding without blocking`,
    );
    const existingReview = task.reviewComments?.trim();
    const warningNote = [
      "## Verification",
      "",
      "**⚠️ Verification subagent did not complete successfully.**",
      "",
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      "",
      "The task proceeds to review without a full verification gate. Inspect the implementation manually.",
    ].join("\n");
    const combinedReview = existingReview ? `${existingReview}\n\n${warningNote}` : warningNote;
    setTaskFields(taskId, {
      reviewComments: combinedReview,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  if (task.branchName && !task.isFix) {
    assertCurrentBranch(projectRoot, task.branchName);
  }

  // Отзыв не перезаписывается, а дополняется: в reviewComments уже могут быть
  // заметки предыдущих стадий, и терять их нельзя.
  const existingReview = task.reviewComments?.trim();
  const combinedReview = existingReview
    ? `${existingReview}\n\n## Verification\n\n${resultText}`
    : `## Verification\n\n${resultText}`;
  setTaskFields(taskId, {
    reviewComments: combinedReview,
    updatedAt: new Date().toISOString(),
  });

  // Блокировка только по структурному вердикту; сам текст отчёта уже сохранён
  // выше, поэтому детали останутся в отзыве даже после остановки пайплайна.
  const gate = extractVerifyGateResult(resultText);
  if (gate?.status === "fail" || gate?.blocking === true) {
    log.warn({ taskId, blockers: gate.blockers ?? [] }, "Verify stage returned blocking result");
    throw new StageManualBlockError(
      "Verify stage returned a blocking gate result. Review the Verification section for details.",
      "Verify stage returned a blocking gate result",
    );
  }

  logActivity(taskId, "Agent", "verify stage complete (aif-verify)");
  log.debug({ taskId, gateStatus: gate?.status ?? null }, "Verification report saved to task");
}
