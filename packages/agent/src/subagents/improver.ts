/**
 * Субгент стадии Improve: вторая итерация над уже существующим планом.
 *
 * Зачем отдельный проход: планировщик пишет план "с нуля", а улучшитель
 * перечитывает результат с диска и дополняет пробелы, не переписывая всё
 * заново. Поэтому источником истины считается файл плана, а не поле задачи:
 * агент правит файл, и лишь успешно прочитанный файл переносится в БД.
 *
 * Ключевой инвариант - защита от деградации плана. Если стадия не смогла
 * прочитать файл или вернула текст, не похожий на полный план, сохраняется
 * прежняя версия (persistTaskPlanForTask с currentPlan). Так сбой модели не
 * затирает рабочий план мусором, и следующая стадия получает годный вход.
 *
 * Стадия работает в ветке задачи, поэтому ветка восстанавливается до запуска
 * и проверяется после: иначе агент мог бы оставить правки не в той ветке, а
 * пайплайн дальше работал бы с чужим состоянием репозитория.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findProjectById, findTaskById, persistTaskPlanForTask } from "@aif/data";
import { createRuntimeWorkflowSpec } from "@aif/runtime";
import { getProjectConfig, logger, looksLikeFullPlanUpdate } from "@aif/shared";
import { assertCurrentBranch, restorePersistedBranch } from "../gitBranch.js";
import { logActivity } from "../hooks.js";
import { executeSubagentQuery } from "../subagentQuery.js";

// Отдельный logger на модуль: префикс "improver" в логах отделяет стадии
// друг от друга при разборе одного прогона задачи.
const log = logger("improver");

// У fix-задач отдельный файл (fix_plan), у обычных - путь из задачи или
// значение по умолчанию из конфига проекта. Один резолвер нужен и для чтения
// с диска, и для подстановки @пути в промпт: разойтись они не должны.
function effectivePlanPath(
  task: { isFix: boolean; planPath: string },
  projectRoot: string,
): string {
  const cfg = getProjectConfig(projectRoot);
  return task.isFix ? cfg.paths.fix_plan : task.planPath || cfg.paths.plan;
}

// Отсутствующий файл и файл из одних пробелов трактуются одинаково - null.
// Вызывающему коду не нужно различать эти случаи: оба означают "плана нет".
function readPlanFromDisk(
  task: { isFix: boolean; planPath: string },
  projectRoot: string,
): string | null {
  const path = resolve(projectRoot, effectivePlanPath(task, projectRoot));
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8").trim();
  return content.length > 0 ? content : null;
}

// Функция ничего не возвращает: результат стадии - побочные эффекты в БД и в
// файле плана. Наружу пробрасывается только "задача не найдена", потому что
// это ошибка вызова, а не сбой самой стадии.
export async function runImprover(taskId: string, projectRoot: string): Promise<void> {
  const task = findTaskById(taskId);

  if (!task) {
    log.error({ taskId }, "Task not found for improve stage");
    throw new Error(`Task ${taskId} not found`);
  }

  // Ветку восстанавливаем до чтения плана: агент будет коммитить правки, и они
  // должны попасть в ветку задачи. У fix-задач отдельной ветки нет, поэтому
  // проверка на isFix.
  if (task.branchName && !task.isFix) {
    restorePersistedBranch({
      projectRoot,
      taskId,
      persistedBranchName: task.branchName,
    });
    logActivity(taskId, "Agent", `Restored feature branch: ${task.branchName}`);
  }

  // Файл на диске приоритетнее поля в БД: планировщик мог обновить файл, а БД
  // ещё хранит прошлый снимок. Резервный путь к task.plan срабатывает только тогда,
  // когда файла на диске нет.
  const currentPlan = readPlanFromDisk(task, projectRoot) ?? task.plan;
  // Пустой план улучшать нечем: агент всё равно начнёт сочинять с нуля, а это
  // работа планировщика, а не улучшителя.
  if (!currentPlan || currentPlan.trim().length === 0) {
    log.warn({ taskId }, "Plan is empty or missing, improve stage cannot proceed");
    logActivity(taskId, "Agent", "improve stage skipped: plan is empty or missing");
    return;
  }

  // Бюджет берётся из настроек проекта и совпадает с лимитом планировщика:
  // улучшение плана - та же по характеру работа. null означает "лимит не задан".
  const project = findProjectById(task.projectId);
  const planCheckerBudget = project?.planCheckerMaxBudgetUsd ?? null;
  // Путь для @-ссылки в промпте обязан совпадать с тем, что читаем с диска.
  const planPath = effectivePlanPath(task, projectRoot);
  // Слэш-команда - запасной путь для runtime без собственного агента
  // aif-improve: она попадает первой строкой промпта, чтобы модель видела
  // инструкцию раньше контекста задачи.
  const improveSlashCommand = `/aif-improve @${planPath}`;
  // Жёсткая рамка рабочей директории: без неё агент может уйти в родительские
  // каталоги и править файлы чужих проектов.
  const scopeConstraint = `IMPORTANT: Your working directory is ${projectRoot}
All file reads, searches, and plan updates must stay within this directory. Do NOT navigate to parent directories or other projects.`;
  // Обратная связь из PR/MR добавляется отдельным блоком и только когда она
  // непустая: пустая строка породила бы заголовок без содержимого и сбивала
  // модель с толку.
  const feedbackBlock =
    task.planReviewFeedback && task.planReviewFeedback.trim().length > 0
      ? `

Plan review feedback from PR/MR:
${task.planReviewFeedback.trim()}`
      : "";
  const prompt = `${improveSlashCommand}

HANDOFF_MODE: 1
HANDOFF_TASK_ID: ${taskId}
Autonomous Handoff mode: true.
Do not ask interactive questions.
Apply useful plan refinements directly to @${planPath}; if no changes are needed, leave the plan unchanged.

${scopeConstraint}

Task title: ${task.title}
Task description: ${task.description}${feedbackBlock}`;

  // Обязательных возможностей нет: улучшение плана - работа с текстом, подойдёт
  // любой runtime. Стратегия "slash_command" разрешает откат к команде, а
  // resume_if_available переиспользует сессию планировщика, чтобы не терять уже
  // изученный контекст проекта.
  const workflowSpec = createRuntimeWorkflowSpec({
    workflowKind: "improver",
    prompt,
    requiredCapabilities: [],
    fallbackSlashCommand: improveSlashCommand,
    fallbackStrategy: "slash_command",
    executionMode: "standard",
    sessionReusePolicy: "resume_if_available",
    systemPromptAppend: scopeConstraint,
  });

  // profileMode "plan" и бюджет плановой стадии: улучшитель тратит тот же
  // лимит, что и планировщик, а не бюджет ревью.
  const { resultText } = await executeSubagentQuery({
    taskId,
    projectRoot,
    agentName: "aif-improve",
    prompt,
    profileMode: "plan",
    maxBudgetUsd: planCheckerBudget,
    workflowSpec,
    workflowKind: "improver",
    fallbackSlashCommand: improveSlashCommand,
  });

  // Ветку проверяем уже после работы агента: если модель переключила ветку,
  // сохранение плана ниже ушло бы не туда.
  if (task.branchName && !task.isFix) {
    assertCurrentBranch(projectRoot, task.branchName);
  }

  // Файл читаем заново, а не доверяем resultText: агент правит именно файл,
  // а resultText может содержать лишь отчёт о проделанной работе.
  const improvedPlan = readPlanFromDisk(task, projectRoot);
  if (!improvedPlan) {
    // Плана нет - оставляем прежний: терять рабочий план из-за сбоя записи
    // нельзя, лучше сохранить устаревшую, но целую версию.
    log.warn({ taskId }, "Improve stage did not produce a readable plan; preserving previous plan");
    return;
  }

  // Эвристика на форму результата: если текст не похож на полный план, значит
  // модель вернула рассуждение или фрагмент. Такой результат отбрасываем и
  // возвращаем в БД прежнюю версию.
  if (!looksLikeFullPlanUpdate(currentPlan, improvedPlan)) {
    log.warn(
      {
        taskId,
        originalLength: currentPlan.length,
        improvedLength: improvedPlan.length,
        resultPreview: resultText.slice(0, 200),
      },
      "Improve stage produced a non-plan-like update; preserving previous plan",
    );
    // Явная запись прежнего плана: поле в БД могло отставать от файла, и после
    // отката оно должно снова совпадать с тем, что реально проверялось.
    persistTaskPlanForTask({
      taskId,
      planText: currentPlan,
      projectRoot,
      isFix: task.isFix,
      planPath: task.planPath,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  // Успешный путь: в БД уходит вычитанный из файла план, а не resultText.
  persistTaskPlanForTask({
    taskId,
    planText: improvedPlan,
    projectRoot,
    isFix: task.isFix,
    planPath: task.planPath,
    updatedAt: new Date().toISOString(),
  });
  logActivity(taskId, "Agent", "improve stage complete (aif-improve)");
  log.debug({ taskId }, "Improved plan saved to task");
}
