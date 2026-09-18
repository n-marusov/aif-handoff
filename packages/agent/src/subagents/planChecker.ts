/**
 * Сабагент проверки плана: приводит план к формату чек-листа перед кодированием.
 *
 * Зачем: стадии реализации и верификации опираются на чекбоксы, чтобы отмечать
 * прогресс и отличать сделанное от оставшегося. Планы, написанные свободным
 * текстом, ломают этот контракт, поэтому нормализацию делает отдельный проход
 * между планированием и реализацией.
 *
 * Инварианты и подводные камни:
 * - Сначала локальные эвристики, и только потом LLM. Преобразование обычного
 *   списка в чекбоксы - детерминированная операция, и тратить на неё вызов
 *   модели с непредсказуемым результатом бессмысленно.
 * - Результат модели перепроверяется на «похожесть на полный план». Модель
 *   регулярно возвращает обрывок или пересказ, и сохранить такое вместо плана -
 *   значит потерять работу планировщика.
 * - Если ни модель, ни локальная конвертация не дали чек-листа, исходный план
 *   остаётся нетронутым: лучше план без чекбоксов, чем испорченный план.
 * - Ветка восстанавливается до чтения репозитория и проверяется после прогона -
 *   тот же контракт изоляции, что у implementer и reviewer.
 */
import { findProjectById, findTaskById, persistTaskPlanForTask } from "@aif/data";
import { logger, looksLikeFullPlanUpdate } from "@aif/shared";
import { executeSubagentQuery } from "../subagentQuery.js";
import { assertCurrentBranch, restorePersistedBranch } from "../gitBranch.js";
import { logActivity } from "../hooks.js";

const log = logger("plan-checker");
const AGENT_NAME = "plan-checker";

export function normalizeMarkdownFence(text: string): string {
  // Модель заворачивает ответ в тройные бэктики - классика. Бертём содержимое
  // первого блока; если блока нет, считаем ответ чистым текстом.
  const fenced = text.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  if (!fenced) return text.trim();
  return fenced[1].trim();
}

export function hasChecklistItems(text: string): boolean {
  return /^\s*[-*]\s+\[(?: |x|X)\]\s+/m.test(text);
}

/** Считает обычные буллеты, которые можно превратить в чекбоксы. */
export function countConvertibleBullets(text: string): number {
  const lines = text.split("\n");
  let count = 0;
  for (const line of lines) {
    // Обычный буллет, который ЕЩЁ НЕ чекбокс
    if (/^\s*[-*]\s+(?!\[(?: |x|X)\])/.test(line)) {
      // Пропускаем строки, похожие на заголовки/контекст (слишком короткие или без глагола действия)
      const content = line.replace(/^\s*[-*]\s+/, "").trim();
      if (content.length > 3) count++;
    }
  }
  return count;
}

/** Конвертирует обычные буллеты в чекбоксы локально (LLM не нужен). */
export function convertBulletsToCheckboxes(text: string): string {
  return text.replace(/^(\s*)([-*])\s+(?!\[(?: |x|X)\])/gm, "$1$2 [ ] ");
}

/** Проверяет, использует ли план формат чек-листа целиком. */
// «Уже чек-лист» означает и наличие чекбоксов, и отсутствие конвертируемых
// пунктов. Проверять только первое нельзя: план мог быть размечен наполовину.
export function isPlanAlreadyChecklist(text: string): boolean {
  const convertible = countConvertibleBullets(text);
  return hasChecklistItems(text) && convertible === 0;
}

export async function runPlanChecker(taskId: string, projectRoot: string): Promise<void> {
  const task = findTaskById(taskId);

  if (!task) {
    log.error({ taskId }, "Task not found for plan checklist verification");
    throw new Error(`Task ${taskId} not found`);
  }

  // Тот же контракт восстановления ветки, что у implementer/reviewer: обязан
  // идти до любого чтения репо или записи плана. BranchIsolationError → blocked_external.
  if (task.branchName && !task.isFix) {
    restorePersistedBranch({
      projectRoot,
      taskId,
      persistedBranchName: task.branchName,
    });
    logActivity(taskId, "Agent", `Restored feature branch: ${task.branchName}`);
  }

  if (!task.plan || task.plan.trim().length === 0) {
    log.warn({ taskId }, "Skipping plan checklist verification: task has no plan");
    return;
  }

  // Быстрый путь: пропустить вызов LLM, если план уже в правильном формате чек-листа
  if (isPlanAlreadyChecklist(task.plan)) {
    log.info({ taskId }, "Plan already in checklist format — skipping plan-checker agent");
    return;
  }

  // Сначала пробуем локальную конвертацию — если нужна только простая bullet→checkbox
  const convertible = countConvertibleBullets(task.plan);
  if (convertible > 0 && hasChecklistItems(task.plan)) {
    const locallyConverted = convertBulletsToCheckboxes(task.plan);
    if (isPlanAlreadyChecklist(locallyConverted)) {
      log.info(
        { taskId, convertedItems: convertible },
        "Converted plain bullets to checkboxes locally — skipping plan-checker agent",
      );
      persistTaskPlanForTask({
        taskId,
        planText: locallyConverted,
        projectRoot,
        isFix: task.isFix,
        planPath: task.planPath ?? undefined,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
  }

  const project = findProjectById(task.projectId);
  const planCheckerBudget = project?.planCheckerMaxBudgetUsd ?? null;

  log.info({ taskId, title: task.title }, "Starting plan-checker agent");

  const prompt = `You are validating an implementation plan markdown before coding starts.
Task title: ${task.title}

Current plan markdown:
${task.plan}

Requirements:
1) Ensure the plan is a checklist where actionable items use markdown checkboxes in "- [ ] Item" format.
2) Convert plain bullet tasks into unchecked checkboxes when needed.
3) Keep headings and non-actionable context text intact.
4) Preserve completed items "- [x]" as completed.
5) Return the FULL updated plan markdown, not a partial snippet.
6) Return only the corrected plan markdown, no explanations.
7) Do not use tools or subagents.`;

  const { resultText } = await executeSubagentQuery({
    taskId,
    projectRoot,
    agentName: AGENT_NAME,
    prompt,
    profileMode: "plan",
    maxBudgetUsd: planCheckerBudget,
  });

  // Пост-проверка дрейфа: сабагент не должен был переключить HEAD.
  if (task.branchName && !task.isFix) {
    assertCurrentBranch(projectRoot, task.branchName);
  }

  const normalizedPlan = normalizeMarkdownFence(resultText);
  if (normalizedPlan.length === 0) {
    throw new Error("Plan checker returned empty content");
  }

  const hasChecklist = hasChecklistItems(normalizedPlan);
  const looksLikeFull = looksLikeFullPlanUpdate(task.plan, normalizedPlan);

  if (!hasChecklist || !looksLikeFull) {
    log.warn(
      {
        taskId,
        hasChecklist,
        looksLikeFull,
        originalLength: task.plan.length,
        returnedLength: normalizedPlan.length,
        preview: normalizedPlan.slice(0, 200),
      },
      "Plan checker returned non-plan-like content; attempting local fallback",
    );

    // Резервный путь: пробуем локальную конвертацию ИСХОДНОГО плана
    const fallback = convertBulletsToCheckboxes(task.plan);
    if (hasChecklistItems(fallback)) {
      log.info({ taskId }, "Local fallback conversion succeeded — saving converted plan");
      persistTaskPlanForTask({
        taskId,
        planText: fallback,
        projectRoot,
        isFix: task.isFix,
        planPath: task.planPath ?? undefined,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    log.warn({ taskId }, "Local fallback also failed; keeping existing task plan");
    return;
  }

  persistTaskPlanForTask({
    taskId,
    planText: normalizedPlan,
    projectRoot,
    isFix: task.isFix,
    planPath: task.planPath ?? undefined,
    updatedAt: new Date().toISOString(),
  });

  log.debug({ taskId }, "Verified plan saved to task");
}
