/**
 * Implementer-субагент: стадия "Implementing" в жизненном цикле задачи.
 *
 * Модуль собирает промпт для реализации утвержденного плана, прогоняет его через
 * executeSubagentQuery внутри рабочего дерева задачи и формирует артефакты, которых ждет
 * координатор: implementationLog, обновленный план и признаки для решения о переходе дальше.
 *
 * Почему модуль устроен именно так:
 *
 * 1. Ветка - это контракт, а не деталь реализации. Планировщик фиксирует task.branchName, и все
 *    последующие стадии обязаны оказаться именно на ней. Поэтому restorePersistedBranch
 *    вызывается до любых чтений конфига и плана, а assertCurrentBranch - после каждого прогона
 *    модели, включая служебный sync-запрос. Иначе чужие диффы приписывались бы задаче.
 *
 * 2. Модель - ненадежный исполнитель. Она может заявить об успехе без единой правки файлов,
 *    переключить ветку или вернуть текст про отсутствие прав на запись. Поэтому модуль не
 *    доверяет прозе ответа: факт изменений измеряется по git, а затем сверяется с файлами,
 *    объявленными в плане.
 *
 * 3. Проверки намеренно не останавливают конвейер целиком. Незакрытый чеклист, выход за
 *    объявленный скоуп и пропущенные файлы превращаются в примечания к implementationLog и
 *    уходят дальше к ревьюеру, вместо тихого пропуска или жесткого падения.
 *
 * 4. Два режима исполнения. При useSubagents=true работает нативный координатор с воркерами и
 *    слоями (fan-out), при false - обычный запуск со слэш-командой. Промпт собирается одним
 *    выражением, чтобы порядок блоков был детерминированным и не зависел от ветвлений.
 *
 * 5. Свежая сессия на каждый запуск. Перезапущенная задача живет в том же worktree, но не должна
 *    тянуть контекст предыдущей попытки, поэтому sessionReusePolicy всегда равен "never".
 *
 * Готча: IMPLEMENTATION_NOOP_MARKER - часть внешнего контракта. Строку читают координатор и UI,
 * поэтому ее текст нельзя менять, не обновив всех читателей.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  findProjectById,
  findTaskById,
  getLatestReworkComment,
  listTaskExecutorHistory,
  persistTaskPlanForTask,
  setTaskFields,
  type TaskRow,
} from "@aif/data";
import {
  logger,
  formatAttachmentsForPrompt,
  looksLikeFullPlanUpdate,
  getEnv,
  getHeadCommitSha,
  getProjectConfig,
  listChangedFiles,
} from "@aif/shared";
import { createRuntimeWorkflowSpec } from "@aif/runtime";
import { logActivity } from "../hooks.js";
import { executeSubagentQuery } from "../subagentQuery.js";
import { taskRequiresPlanReview } from "../planReviewPublisher.js";
import {
  analyzeLayerDisjointness,
  collectDeclaredFiles,
  collectDeclaredFilesFromPlanText,
  computePendingPlanLayers,
  computePlanLayers,
  formatLayerDecisions,
  formatLayerSummary,
  hasPendingChecklistItems,
  isOutsideDeclaredScope,
} from "../planLayers.js";
import { assertCurrentBranch, restorePersistedBranch } from "../gitBranch.js";

// Имя агента держится на уровне модуля: оно используется и как agentName для subagentQuery, и
// как agentDefinitionName в нативном режиме, поэтому единый источник исключает расхождение
// между режимами исполнения.
const log = logger("implementer");
const AGENT_NAME = "implement-coordinator";
// Маркер вынесен в экспортируемую константу, а не оставлен литералом на месте использования:
// эту строку распознают снаружи (координатор, UI) как признак пустого прогона, поэтому
// формулировку нельзя менять в одностороннем порядке.
export const IMPLEMENTATION_NOOP_MARKER =
  "[error] The approved plan expected implementation changes but NO files were changed";

// Отдельная функция, чтобы координатор и тесты применяли ровно ту же логику распознавания, что
// и запись маркера ниже. Сравнение через includes, потому что перед маркером может стоять
// пояснительный текст модели.
export function hasImplementationNoOp(implementationLog: string | null | undefined): boolean {
  return implementationLog?.includes(IMPLEMENTATION_NOOP_MARKER) ?? false;
}

function formatReworkCommentForPrompt(
  comment: {
    author: string;
    createdAt: string;
    message: string;
    attachments: string | null;
  } | null,
): string {
  // Отсутствие комментария доработки - легитимный случай (например, ручной перезапуск), поэтому
  // возвращается явная строка-заглушка вместо null: промпт всегда должен получить хоть какой-то
  // текст, иначе модель начнет додумывать контекст доработки.
  if (!comment) return "No rework comments found for rework request.";
  // Формат совпадает с остальными блоками промпта: плоский текст без markdown-оберток, чтобы
  // вложения не конкурировали с заголовками самого промпта.
  return [
    `[${comment.createdAt}] ${comment.author}`,
    `message: ${comment.message}`,
    "attachments:",
    formatAttachmentsForPrompt(comment.attachments),
  ].join("\n");
}

function formatAutoReviewStateForPrompt(
  state:
    | {
        strategy: string;
        iteration: number;
        findings: Array<{ id: string; text: string; source: string }>;
      }
    | null
    | undefined,
): string {
  // Отсутствие снапшота и пустой снапшот трактуются одинаково: для промпта важно лишь наличие
  // конкретных findings для разбора, а различать эти случаи модели незачем.
  if (!state || state.findings.length === 0) {
    return "No persisted blocking findings snapshot.";
  }

  // Строка на каждый finding, а не JSON: модель увереннее удерживает плоские списки, а
  // идентификаторы остаются различимыми, чтобы в ответе можно было сослаться на конкретный id.
  return [
    `strategy: ${state.strategy}`,
    `iteration: ${state.iteration}`,
    "findings:",
    ...state.findings.map((finding) => `- [${finding.id}] ${finding.source} | ${finding.text}`),
  ].join("\n");
}

// Эвристика по свободному тексту ответа, а не классификация структурированной ошибки: адаптеры
// не всегда возвращают типизированный отказ при проблемах с правами записи, и единственным
// наблюдаемым сигналом остается формулировка модели. Совпадение приводит к исключению наверх -
// задача не должна считаться реализованной, если модель сообщила о невозможности писать файлы.
function isBlockedImplementationResult(resultText: string): boolean {
  const normalized = resultText.toLowerCase();
  return (
    normalized.includes("status: blocked") ||
    normalized.includes("permission system") ||
    normalized.includes("permission denied") ||
    normalized.includes("write permission") ||
    normalized.includes("cannot proceed") ||
    normalized.includes("blocked —")
  );
}

function readCanonicalPlan(
  task: { isFix: boolean; planPath: string },
  projectRoot: string,
): string | null {
  // Конфиг читается здесь, а не передается аргументом: путь к плану - производная от конвенций
  // проекта, и вызывающий код не должен знать про fix_plan/plan.
  const cfg = getProjectConfig(projectRoot);
  // Сначала проверяется путь, соответствующий типу задачи, и только затем путь другого типа. Это
  // сохраняет совместимость с задачами, которые мигрировали между fix- и обычным потоком, не
  // меняя поле planPath.
  const preferredPath = resolve(
    projectRoot,
    task.isFix ? cfg.paths.fix_plan : task.planPath || cfg.paths.plan,
  );
  if (existsSync(preferredPath)) {
    const content = readFileSync(preferredPath, "utf8").trim();
    if (content.length > 0) return content;
  }

  // Резервный путь нужен, чтобы не потерять план, лежащий во втором по приоритету месте. Пустое
  // содержимое при этом не считается планом: проверка длины отделяет "файл есть, но пуст" от
  // реального плана.
  const fallbackPath = resolve(projectRoot, task.isFix ? cfg.paths.plan : cfg.paths.fix_plan);
  if (existsSync(fallbackPath)) {
    const content = readFileSync(fallbackPath, "utf8").trim();
    if (content.length > 0) return content;
  }

  // null, а не пустая строка: вызывающий код различает "плана нет" и "план пуст" и подставляет
  // task.plan как последний источник через оператор ??.
  return null;
}

function getChecklistProgress(planText: string | null): {
  parsedTaskCount: number;
  pendingTaskCount: number;
} {
  // Отсутствие плана и план без задач для вызывающего кода эквивалентны: оба случая означают,
  // что автосинхронизацию чеклиста запускать не нужно.
  if (!planText) return { parsedTaskCount: 0, pendingTaskCount: 0 };
  // План разбирается дважды - целиком и только по незакрытым пунктам. Благодаря этому сравнение
  // прогресса до и после синхронизации опирается на одну и ту же логику разбора.
  const parsed = computePlanLayers(planText);
  const pending = computePendingPlanLayers(planText);
  return {
    parsedTaskCount: parsed.tasks.length,
    pendingTaskCount: pending.tasks.length,
  };
}

// Намеренно "тупой" отдельный прогон модели: без доступа к инструментам он только приводит
// чекбоксы плана в соответствие с фактическим логом реализации. Вынесено из основного промпта,
// потому что главный исполнитель склонен переписывать структуру плана, а здесь ее нужно
// сохранить дословно (проверку делает вызывающий код через looksLikeFullPlanUpdate).
async function runChecklistSyncQuery(input: {
  task: TaskRow;
  projectRoot: string;
  planText: string;
  implementationResult: string;
}): Promise<string> {
  const prompt = `You are finalizing task checklist state in a markdown implementation plan.

TASK TITLE:
${input.task.title}

TASK DESCRIPTION:
${input.task.description}

IMPLEMENTATION RESULT LOG (source of truth for what was done):
${input.implementationResult}

CURRENT PLAN MARKDOWN:
<<<CURRENT_PLAN
${input.planText}
CURRENT_PLAN

Requirements:
1) Return the FULL updated plan markdown.
2) Update only checkbox states ("- [ ]" / "- [x]") to reflect implemented work from the log.
3) Do not rewrite structure, titles, ordering, prose, or dependencies.
4) Preserve all unchecked tasks that are not completed yet.
5) Output markdown only.
6) Do not use tools or subagents.`;

  const workflowSpec = createRuntimeWorkflowSpec({
    workflowKind: "implementer_checklist_sync",
    prompt,
    requiredCapabilities: [],
    sessionReusePolicy: "never",
    systemPromptAppend: "Do not use tools or subagents. Reply directly with markdown only.",
    metadata: {
      checklistSync: true,
    },
  });

  const { resultText } = await executeSubagentQuery({
    taskId: input.task.id,
    projectRoot: input.projectRoot,
    agentName: "implement-checklist-sync",
    prompt,
    workflowSpec,
    workflowKind: "implementer_checklist_sync",
  });
  // Пустой ответ означает, что модель проигнорировала требование вернуть markdown. Молча
  // вернуть прежний план нельзя: вызывающий код принял бы это за успешную синхронизацию.
  const normalizedResult = resultText.trim();
  if (!normalizedResult) {
    throw new Error("Checklist sync did not return plan markdown");
  }
  return normalizedResult;
}

// Точка входа стадии реализации. Функция ничего не возвращает: результат фиксируется через
// setTaskFields, а координатор принимает решение по состоянию задачи, а не по возвращенному
// значению. Исключения выбрасываются только там, где продолжать выполнение нельзя.
export async function runImplementer(taskId: string, projectRoot: string): Promise<void> {
  // Задача перечитывается из БД, а не принимается готовым объектом: между постановкой в очередь
  // и запуском стадии поля могли измениться (ветка, флаг rework, бюджет).
  const task = findTaskById(taskId);

  if (!task) {
    log.error({ taskId }, "Task not found for implementation");
    throw new Error(`Task ${taskId} not found`);
  }

  // Страж гейта plan-review (защита вглубь). Координатор направляет на стадию
  // исполнителя только одобренные plan-review задачи, но задача может попасть
  // в этот раннер без одобренного плана (legacy VCS-задача после включения
  // фича-флага, ручной перевод статуса или прямой вызов).
  // Отказываемся трогать продуктовые файлы, пока PR/MR плана не одобрен.
  // Возврат без исключения оставляет задачу на план-ревью gate, и координатор перепроверит ее на
  // следующем тике. Это устойчивее к гонке с одобрением, чем падение и перевод задачи в error.
  if (taskRequiresPlanReview(taskId) && task.planReviewState !== "approved") {
    log.warn(
      { taskId, status: task.status, planReviewState: task.planReviewState ?? null },
      "Implementation blocked before plan approval; task stays on the plan-review gate",
    );
    return;
  }

  // Восстановление ветки ОБЯЗАТЕЛЬНО до любого чтения repo/config/plan. Если
  // planner подготовил feature-ветку, но auto-queue (или действие чата/человека)
  // сдвинул HEAD между стадиями, каждое последующее чтение — конфиг,
  // канонический план, поиск незакрытых задач, ранний no-op-выход —
  // работало бы на неправильной ветке и молча отдавало бы некорректное
  // состояние.
  //
  // `task.branchName` — контракт источника истины: раз planner его задал,
  // каждая последующая стадия ОБЯЗАНА оказаться на этой ветке или упасть громко.
  // Дрейф конфига (git.enabled / create_branches, выключенные между стадиями)
  // не может отпустить нас на текущий HEAD — `restorePersistedBranch` бросает
  // исключение вместо shortcut "skipped", который использует `ensureFeatureBranch`.
  if (task.branchName && !task.isFix) {
    restorePersistedBranch({
      projectRoot,
      taskId,
      persistedBranchName: task.branchName,
    });
    logActivity(taskId, "Agent", `Restored feature branch: ${task.branchName}`);
  }

  // Бюджет и режим исполнения читаются один раз, до сборки промпта: оба влияют на
  // workflowSpec, а повторное чтение в середине прогона могло бы дать рассогласование.
  const project = findProjectById(task.projectId);
  const implementerBudget = project?.implementerMaxBudgetUsd ?? null;
  const useSubagents = task.useSubagents;
  const executionName = useSubagents ? AGENT_NAME : "aif-implement";
  const cfg = getProjectConfig(projectRoot);
  // Канонический план с диска приоритетнее поля в БД: файл - источник истины для чеклиста, а
  // task.plan может оказаться устаревшим снимком момента постановки задачи.
  const canonicalPlan = readCanonicalPlan(task, projectRoot);
  const selectedPlan = canonicalPlan ?? task.plan;
  const effectivePlanPath = task.isFix ? cfg.paths.fix_plan : task.planPath || cfg.paths.plan;
  // Путь отдается модели как @-упоминание: так одна и та же строка годится и для тела промпта, и
  // для слэш-команды, и для system-подсказки.
  const planSection = `@${effectivePlanPath}`;
  const layerComputation = selectedPlan
    ? computePendingPlanLayers(selectedPlan)
    : { tasks: [], layers: [] };
  const parsedPlanComputation = selectedPlan
    ? computePlanLayers(selectedPlan)
    : { tasks: [], layers: [] };
  const parsedTaskCount = parsedPlanComputation.tasks.length;
  const pendingTaskCount = layerComputation.tasks.length;
  // Объединение через Set: один и тот же файл может быть объявлен и в структурированной задаче, и
  // в свободном тексте плана; дубликаты исказили бы сравнение с фактически измененными файлами.
  const expectedPlanFiles = Array.from(
    new Set([
      ...collectDeclaredFiles(parsedPlanComputation.tasks),
      ...collectDeclaredFilesFromPlanText(selectedPlan),
    ]),
  ).sort();
  // Намерение изменить файлы складывается из трех независимых сигналов: незакрытые задачи
  // слоев, объявленные пути и незавершенные пункты чеклиста. Любой из них означает, что прогон
  // без правок файлов - ошибка, а не легитимный no-op.
  const planHasImplementationIntent =
    pendingTaskCount > 0 || expectedPlanFiles.length > 0 || hasPendingChecklistItems(selectedPlan);
  const requiresPlanReviewImplementationEvidence = taskRequiresPlanReview(taskId);
  const shouldEnforceImplementationChanges =
    requiresPlanReviewImplementationEvidence && planHasImplementationIntent;
  // Комментарий доработки запрашивается только в режиме rework: на обычном прогоне лишний запрос
  // к БД бессмыслен, а null здесь означает "доработки нет", не "доработка без текста".
  const latestReworkComment = task.reworkRequested
    ? (getLatestReworkComment(taskId) ?? null)
    : null;
  // Снапшот замечаний авто-ревью берётся из сохраненного состояния задачи, а не пересчитывается
  // заново: промпт должен видеть ровно тот список, по которому принималось решение о доработке.
  const blockingFindingsSnapshot = task.reworkRequested
    ? formatAutoReviewStateForPrompt(task.autoReviewState)
    : "No persisted blocking findings snapshot.";
  // Ответственность за выполнение попадает в промпт, чтобы модель понимала, кто инициировал
  // запуск: при ручном переназначении это меняет ожидаемую трактовку результата.
  const latestOwnershipEntry = listTaskExecutorHistory(taskId).at(-1);
  const handoffResponsibility = latestOwnershipEntry
    ? [
        `ownershipRevision=${latestOwnershipEntry.ownershipRevision}`,
        `executionOwner=${latestOwnershipEntry.executionOwner}`,
        `initiatedBy=${latestOwnershipEntry.actor.displayNameSnapshot ?? latestOwnershipEntry.actor.kind}`,
        `responsibleParticipants=${
          latestOwnershipEntry.assignees.map((assignee) => assignee.displayName).join(", ") ||
          "none"
        }`,
      ].join("; ")
    : "No executor handoff history.";

  // Ранний выход для полностью выполненного плана. Без него реализатор каждый раз поднимал бы
  // модель, та не находила бы работы, а прогон затем попадал бы под проверку "изменений нет" и
  // засорял лог ошибкой. Условие намеренно строгое: любое незакрытое намерение (rework,
  // объявленные файлы, незавершенный чеклист) отменяет выход.
  if (
    selectedPlan &&
    parsedTaskCount > 0 &&
    pendingTaskCount === 0 &&
    !task.reworkRequested &&
    expectedPlanFiles.length === 0 &&
    !hasPendingChecklistItems(selectedPlan)
  ) {
    const nowIso = new Date().toISOString();
    const noOpResult =
      "No pending tasks detected in plan (all tasks already completed). " +
      "Implementer skipped coordinator execution.";
    // План все равно перезаписывается, и лог фиксируется: координатор и UI должны увидеть
    // осмысленный результат стадии, а не отсутствие артефактов.
    persistTaskPlanForTask({
      taskId,
      planText: selectedPlan,
      projectRoot,
      isFix: task.isFix,
      planPath: task.planPath,
      updatedAt: nowIso,
    });
    setTaskFields(taskId, {
      implementationLog: noOpResult,
      lastHeartbeatAt: nowIso,
      updatedAt: nowIso,
    });
    logActivity(taskId, "Agent", `${executionName} skipped — no pending tasks in plan`);
    log.info({ taskId }, "Implementer no-op: all plan tasks already completed");
    return;
  }

  log.info({ taskId, title: task.title, useSubagents }, "Starting implementation stage");

  // Планирование Уровня 2: до допуска fan-out проверяем, что задачи каждого
  // слоя исполнения затрагивают непересекающиеся файлы, и показываем контракт воркеров.
  // Анализ пересечений решает, можно ли распараллелить воркеров внутри слоя. Вердикт считается
  // до запуска модели, потому что именно от него зависит текст промпта (контракт воркеров).
  const layerAnalyses = analyzeLayerDisjointness(layerComputation.layers, layerComputation.tasks);
  const declaredFiles = collectDeclaredFiles(layerComputation.tasks);
  const maxWorkers = getEnv().AIF_IMPLEMENT_MAX_WORKERS;
  // Источник значения различается для диагностики: env означает явную настройку оператора,
  // default - встроенное ограничение. По одному лишь числу эти случаи неразличимы.
  const maxWorkersSource = process.env.AIF_IMPLEMENT_MAX_WORKERS?.trim() ? "env" : "default";
  // Флаг переиспользуется позже при проверке скоупа: контроль объявленных границ имеет смысл
  // только тогда, когда слой действительно отправлялся на параллельный fan-out.
  const hasParallelLayer = layerAnalyses.some((layer) => layer.decision === "parallel");
  // Базовая точка для пост-валидации скоупа (объявленные vs фактические файлы).
  // Базовая точка для git-диффа: без нее нельзя отделить правки этой стадии от изменений,
  // накопленных на той же ветке предыдущими задачами.
  const layerBaselineSha = task.branchName && !task.isFix ? getHeadCommitSha(projectRoot) : null;
  log.debug(
    {
      taskId,
      layers: layerComputation.layers,
      maxWorkers,
      maxWorkersSource,
      declaredFiles,
      expectedPlanFiles,
      parsedTaskCount,
      pendingTaskCount,
      planHasImplementationIntent,
    },
    "Resolved implementer fan-out plan",
  );
  // Решения по слоям логируются до запуска, чтобы при разборе инцидента было видно, почему
  // слой пошел последовательно, а не параллельно, и какие файлы пересеклись.
  for (const layer of layerAnalyses) {
    if (layer.tasks.length <= 1) continue;
    if (layer.decision === "parallel") {
      log.info(
        { taskId, layerIndex: layer.layerIndex + 1, tasks: layer.tasks, maxWorkers },
        "Implementer layer scheduled for parallel fan-out",
      );
    } else {
      log.info(
        {
          taskId,
          layerIndex: layer.layerIndex + 1,
          tasks: layer.tasks,
          overlappingFiles: layer.overlappingFiles,
          undeclaredTasks: layer.undeclaredTasks,
        },
        "Implementer layer reduced to sequential execution",
      );
    }
  }

  // Слои и решения по ним идут одним блоком: модель должна видеть разбиение и вердикт рядом,
  // иначе она начнет выводить параллельность самостоятельно.
  const layerPlanSection =
    layerAnalyses.length > 0
      ? `

Execution layers (from the plan):
${formatLayerSummary(layerComputation.layers)}

Layer decisions (AUTHORITATIVE — obey them):
${formatLayerDecisions(layerAnalyses)}`
      : "\n\nExecution layers: none parsed from the plan — run the checklist sequentially.";

  // Строка встраивается внутрь блока правил, поэтому содержит маркер списка и не содержит
  // переводов строки - иначе она разорвала бы нумерацию пунктов промпта.
  const fanOutLine = `- Worker fan-out: at most ${maxWorkers} implement-worker subagent(s) per parallel layer (AIF_IMPLEMENT_MAX_WORKERS).`;

  // Контракт добавляется только при наличии параллельного слоя: в последовательном режиме лишние
  // ограничения лишь размывают промпт и провоцируют отговорки про чужие файлы.
  const workerContractBlock = hasParallelLayer
    ? `

Parallel worker contract (mandatory for layers marked "parallel"):
- Workers are EDIT-ONLY: no git commands (checkout/commit/push/worktree), and never write the plan file.
- The coordinator owns git writes and the plan checklist; workers report changed files instead of committing.
- A worker may only edit the files declared for its own task: ${
        declaredFiles.length > 0 ? declaredFiles.join(", ") : "(none declared)"
      }.
- Run repo-wide builds/tests ONCE per layer, after all of the layer's workers finish.
- Take one checkpoint per layer so a failed layer can be rolled back before the next one starts.`
    : "";

  // Ограничение рабочего каталога попадает в промпт дважды: в тело и в system-приложение.
  // Модель, потерявшая эту рамку, пишет файлы вне репозитория задачи.
  const scopeConstraint = `IMPORTANT: Your working directory is ${projectRoot}
All files must be created and modified inside this directory. Do NOT create files outside of it.`;
  // Одна и та же строка служит и первым сообщением промпта, и fallback-командой для рантайма,
  // поэтому она собирается заранее, а не по месту каждого использования.
  const implementSlashCommand = `/aif-implement ${planSection}`;
  // Контекст handoff передается отдельным блоком и только в режиме субагентов: слэш-команда
  // несет те же данные через собственный механизм подстановки.
  const handoffContext = `HANDOFF_MODE: 1
HANDOFF_TASK_ID: ${taskId}
HANDOFF_SKIP_REVIEW: ${task.skipReview ? "1" : "0"}`;

  // Локальная переменная вместо прямых обращений к полю: признак доработки используется в
  // нескольких блоках промпта, и одно место чтения упрощает аудит ветвлений.
  const isRework = task.reworkRequested;

  // Шапка доработки подаётся громко, чтобы модель не могла пропустить, что это
  // возвращённая задача с явным human/agent комментарием на доработку.
  // Текст собирается один раз, а место вставки выбирается позже по режиму (см. ниже): так
  // версии для координатора и для слэш-команды не расходятся по содержанию.
  const reworkHeaderBlock = isRework
    ? `================================================
  REWORK REQUEST — THIS IS THE PRIMARY TASK
================================================

You are addressing a REWORK REQUEST on a previously-completed task. The rework comment below is your PRIMARY instruction — it supersedes the checklist state of the plan. The task was previously marked DONE, but the reviewer is NOT satisfied and has requested changes. Address EXACTLY the request below. Do not re-do previously completed work unless the request explicitly asks for it.

<<<REWORK_COMMENT
${formatReworkCommentForPrompt(latestReworkComment)}
REWORK_COMMENT

<<<FULL_REVIEW_COMMENTS
${task.reviewComments ?? "No review comments available."}
FULL_REVIEW_COMMENTS

<<<BLOCKING_FINDINGS_SNAPSHOT
${blockingFindingsSnapshot}
BLOCKING_FINDINGS_SNAPSHOT

================================================
`
    : "";

  // Протокол заставляет модель явно перечислить, что именно исправлено и что осталось
  // незакрытым. Без этого доработка легко превращается в отписку "все готово".
  const reworkProtocolBlock = isRework
    ? `

Rework handling protocol:
1) FIRST, restate the rework request in your own words (1-2 sentences) so it's clear you understood it. Reference specific files, functions, or plan items mentioned in the request.
2) Identify which files in the codebase and/or plan items need to change to satisfy the request.
3) Make the minimal set of changes required. Do NOT refactor unrelated code.
4) If the rework request cannot be satisfied (e.g. it asks for something impossible or contradicts an earlier decision), say so EXPLICITLY in the final result text — do not silently skip it or claim "already done".
5) If the plan checklist shows all items completed, do not interpret that as "nothing to do" — the rework comment is the source of truth for this run.
6) In the final result text, explicitly list which blocking finding IDs from BLOCKING_FINDINGS_SNAPSHOT were addressed and which IDs remain unresolved.`
    : "";

  // Ключевая установка дублируется в system-части: тело промпта может быть усечено рантаймом
  // при больших задачах, а системная часть переживает усечение.
  const reworkSystemAppend = isRework
    ? "\n\nREWORK MODE: A previously-completed task has been reopened. The rework comment inside the prompt is the primary instruction. Do not treat a fully-checked plan as 'nothing to do'."
    : "";

  // Порядок конкатенации значим: ограничение каталога задает рамку, а режим доработки лишь
  // уточняет ее поверх.
  const effectiveSystemAppend = `${scopeConstraint}${reworkSystemAppend}`;

  // В режиме координатора шапка доработки идёт самым верхом промпта, чтобы не
  // утонуть под вводной строкой. В skill-режиме первую строку сохраняет
  // слэш-команда, чтобы Claude Code её развернул, а шапка доработки
  // переезжает в тело промпта.
  // Заголовок доработки не может стоять первым в режиме слэш-команды: Claude Code распознает
  // команду только в начале сообщения, поэтому заголовок переезжает в тело промпта.
  const topReworkHeader = useSubagents ? reworkHeaderBlock : "";
  const bodyReworkHeader = useSubagents ? "" : reworkHeaderBlock;

  // Пошаговая инструкция нужна только там, где нет нативного агента с определением: слэш-команда
  // опирается на собственный текст, и без явных шагов модель ограничивается описанием действий.
  const nonSubagentExecutionBlock = useSubagents
    ? ""
    : `AUTOMATED EXECUTION INSTRUCTIONS (read carefully):
This is an automated implementation run. You MUST execute bash commands
or use file-writing tools to create/modify the required files. Do NOT just
describe what should be done — actually do it.

1. Read the plan at ${planSection}.
2. For each pending task in the plan, implement it by running concrete
   bash commands (echo, mkdir, cat, writeFile, etc.).
3. After creating/modifying files, verify they exist with ls/cat.
4. Update the plan's checklist (mark completed tasks as [x]).
5. If tests are required by the plan, run them and report results.
6. Output a brief summary of what was created/modified.`;

  // Промпт собирается одним шаблоном без промежуточных склеек: так виден итоговый порядок
  // блоков, а условные фрагменты заранее сведены к пустым строкам.
  const prompt = `${topReworkHeader}${useSubagents ? "Implement the task using the provided plan." : implementSlashCommand}

${
  useSubagents
    ? `${handoffContext}
Autonomous Handoff mode: true.
Do not ask interactive questions.
Do not perform Handoff MCP sync yourself.
`
    : ""
}

${scopeConstraint}

${bodyReworkHeader}Latest executor responsibility: ${handoffResponsibility}

Title: ${task.title}
Description: ${task.description}
Task attachments:
${formatAttachmentsForPrompt(task.attachments)}

Plan path:
${planSection}

${isRework ? "Rework mode: true (requested from done/request_changes)." : "Rework mode: false."}

Execution rules:
- Respect task dependencies and checklist state from the plan file.
- Keep plan checklist state accurate while implementing.
- Run tests/lint/verification relevant to the changes.
- IMPORTANT: The plan file is ${effectivePlanPath}. Always read from and annotate this exact file — do not create plan files at other paths.${fanOutLine}${layerPlanSection}${workerContractBlock}${
    useSubagents ? "" : `\n\n${nonSubagentExecutionBlock}`
  }${reworkProtocolBlock}`;
  // Требования к возможностям рантайма зависят от режима: нативному координатору нужны
  // определения агентов и инструменты рабочего пространства, слэш-команде - только инструменты.
  const workflowSpec = createRuntimeWorkflowSpec({
    workflowKind: "implementer",
    prompt,
    requiredCapabilities: useSubagents
      ? ["supportsAgentDefinitions", "supportsWorkspaceTools"]
      : ["supportsWorkspaceTools"],
    agentDefinitionName: useSubagents ? AGENT_NAME : undefined,
    fallbackSlashCommand: implementSlashCommand,
    fallbackStrategy: useSubagents ? "slash_command" : "none",
    executionMode: useSubagents ? "native_subagents" : "standard",
    // Перезапущенная задача переиспользует то же рабочее дерево, но НЕ должна нести
    // устаревший контекст модели с прошлой попытки — всегда начинаем свежую сессию.
    sessionReusePolicy: "never",
    systemPromptAppend: effectiveSystemAppend,
    // Метаданные уходят в аудит рантайма: по ним видно, что именно координатор знал о задаче в
    // момент запуска, уже после того как состояние в БД изменилось.
    metadata: {
      reworkRequested: task.reworkRequested,
      skipReview: task.skipReview ?? false,
      maxWorkers,
      parallelLayers: layerAnalyses.filter((layer) => layer.decision === "parallel").length,
      layerBaselineSha,
    },
  });

  // Явная запись причины новой сессии: при разборе расхождений важно убедиться, что модель не
  // получила контекст предыдущей попытки на том же worktree.
  log.info(
    {
      taskId,
      previousSessionId: null,
      reason: isRework ? "rework_requested" : "fresh_session_on_restart",
    },
    "Implementer starting a fresh session",
  );

  // Флаг попытки ретрая объявлен рядом с результатом, а не внутри замыкания: он нужен после
  // прогона при формировании итоговых примечаний.
  let runResultText = "";
  let noOpRetryAttempted = false;

  // Обертка над executeSubagentQuery. Помимо запуска она проверяет ветку сразу после ответа
  // модели: это самая ранняя точка, где переключение ветки субагентом еще можно приписать именно
  // ему, а не последующим действиям координатора.
  const executeImplementationRun = async (runPrompt: string): Promise<string> => {
    const { resultText } = await executeSubagentQuery({
      taskId,
      projectRoot,
      agentName: executionName,
      prompt: runPrompt,
      maxBudgetUsd: implementerBudget,
      agent: useSubagents ? AGENT_NAME : undefined,
      skipReview: task.skipReview ?? false,
      workflowSpec: {
        ...workflowSpec,
        promptInput: {
          ...workflowSpec.promptInput,
          prompt: runPrompt,
        },
      },
      fallbackSlashCommand: implementSlashCommand,
    });

    if (task.branchName && !task.isFix) {
      assertCurrentBranch(projectRoot, task.branchName);
    }

    return resultText;
  };

  runResultText = await executeImplementationRun(prompt);

  // Объединение изменений относительно базовой точки и текущего рабочего дерева: первое ловит
  // правки поверх уже закоммиченного, второе - незакоммиченные и новые файлы. Ни один из
  // источников по отдельности не дает полной картины.
  const changedFilesAfterFirstRun = Array.from(
    new Set([
      ...(layerBaselineSha && task.branchName && !task.isFix
        ? listChangedFiles(projectRoot, layerBaselineSha)
        : []),
      ...listChangedFiles(projectRoot),
    ]),
  ).sort();

  // Единственная автоматическая повторная попытка. Она оправдана только для задач с
  // утвержденным планом и явным намерением изменений: в остальных случаях пустой дифф легитимен,
  // и ретрай лишь сжег бы бюджет.
  if (shouldEnforceImplementationChanges && changedFilesAfterFirstRun.length === 0) {
    noOpRetryAttempted = true;
    const expectedFilesLine =
      expectedPlanFiles.length > 0
        ? expectedPlanFiles.join(", ")
        : "(files not parsable from plan)";
    log.warn(
      {
        taskId,
        expectedPlanFiles,
        parsedTaskCount,
        pendingTaskCount,
      },
      "[FIX] Implementer produced no file changes; retrying with corrective execution prompt",
    );
    logActivity(
      taskId,
      "Agent",
      `[FIX] Implementer produced no file changes; retrying approved plan execution. Expected files: ${expectedFilesLine}`,
    );

    // В corrective-промпт подставляется ответ предыдущей попытки: модель должна увидеть свои
    // собственные слова, иначе велик шанс получить тот же результат.
    const correctivePrompt = `${prompt}

================================================
CORRECTIVE RETRY — PREVIOUS ATTEMPT MADE NO FILE CHANGES
================================================
The immediately previous implementation attempt returned this text but changed ZERO files:
<<<PREVIOUS_RESULT
${runResultText}
PREVIOUS_RESULT

This is not acceptable for the approved plan. You MUST now make concrete file-system changes inside ${projectRoot}.
Expected file targets from the approved plan: ${expectedFilesLine}

Rules for this retry:
1. Do not claim success until git status or equivalent file checks show the required files exist/changed.
2. If the plan says to create a simple file such as test.md or hello.md, create that file now with the exact requested content.
3. After editing, run concrete verification commands such as ls/cat/test/grep as appropriate.
4. Final response MUST include a "Changed files" section listing the actual files created or modified.
5. If you still cannot change files, return "STATUS: BLOCKED" and explain the exact tool/permission failure.`;

    runResultText = await executeImplementationRun(correctivePrompt);
  }

  // Пост-проверка дрейфа: если сабагент переключил ветку во время исполнения
  // (например, буйный skill выполнил `git checkout` или plan-polisher последовал
  // legacy Шагу 1.4), обязаны заблокироваться до записи плана/лога — иначе
  // припишем этой задаче диффы с чужой ветки.
  // Проверка повторяется именно здесь, потому что между стартом и этим местом прошел ответ
  // модели - увести HEAD мог только он.
  if (task.branchName && !task.isFix) {
    assertCurrentBranch(projectRoot, task.branchName);
  }

  // Базовый текст ответа сохраняется отдельно: ниже он дополняется служебными примечаниями, но
  // проверки должны смотреть на то, что вернула модель, без наших добавок.
  let finalResultText = runResultText;

  // Исключение, а не запись в лог: без прав на запись стадия бессмысленна, и задача должна
  // остановиться с явной причиной, а не продолжиться с пустым результатом.
  if (isBlockedImplementationResult(runResultText)) {
    throw new Error("Implementer blocked by permissions");
  }

  // План перечитывается с диска: модель могла отредактировать его в ходе реализации, и именно
  // эта версия должна уйти в автосинхронизацию чеклиста.
  let syncedPlan = readCanonicalPlan(task, projectRoot) ?? task.plan;
  let checklistAutoSynced = false;
  const checklistBeforeSync = getChecklistProgress(syncedPlan);

  // Автосинхронизация запускается только при реально незакрытых пунктах: лишний прогон модели
  // тратит бюджет и рискует переписать план без необходимости.
  if (
    syncedPlan &&
    checklistBeforeSync.parsedTaskCount > 0 &&
    checklistBeforeSync.pendingTaskCount > 0
  ) {
    const repairedPlan = await runChecklistSyncQuery({
      task,
      projectRoot,
      planText: syncedPlan,
      implementationResult: finalResultText,
    });
    // Ответ принимается только если он похож на полный план. Иначе сохраняется прежний текст:
    // частичный ответ модели затер бы структуру плана.
    if (looksLikeFullPlanUpdate(syncedPlan, repairedPlan)) {
      syncedPlan = repairedPlan;
      checklistAutoSynced = true;
    } else {
      log.warn(
        { taskId },
        "Checklist auto-sync returned non-plan-like response, keeping original plan",
      );
    }
  }

  // Вторая пост-проверка дрейфа: сам `runChecklistSyncQuery` запускает
  // сабагента. Даже если основной исполнитель закончил на правильном HEAD, проход
  // синка может переключить ветку посреди процесса. Перепроверяем до записи плана/лога.
  if (task.branchName && !task.isFix) {
    assertCurrentBranch(projectRoot, task.branchName);
  }

  // Контроль скоупа (безопасность Уровня 2). Когда слой реально расходился
  // веером, затронутые файлы прогона обязаны остаться внутри объединения
  // объявленных областей изменений. Координатор не может приписать отдельные
  // файлы отдельным воркерам, поэтому нарушение показывается громко (лог +
  // заметка ревьюеру) вместо молчаливого коммита.
  // Нарушения не выбрасывают исключение: параллельный слой мог законно задеть общий файл, и
  // решение остается за ревьюером. Роль координатора - сделать факт заметным, а не решать за
  // него, поэтому нарушения превращаются в примечание ниже.
  const scopeViolations: string[] = [];
  if (hasParallelLayer && declaredFiles.length > 0 && layerBaselineSha) {
    const touchedFiles = listChangedFiles(projectRoot, layerBaselineSha);
    scopeViolations.push(
      ...touchedFiles.filter((file) => isOutsideDeclaredScope(file, declaredFiles)),
    );
    if (scopeViolations.length > 0) {
      log.warn(
        {
          taskId,
          baselineSha: layerBaselineSha,
          outOfScopeFiles: scopeViolations.slice(0, 20),
        },
        "Implementer touched files outside the layer's declared change scope",
      );
    } else {
      log.debug(
        { taskId, touchedFileCount: touchedFiles.length },
        "Implementer stayed inside the declared change scope",
      );
    }
  }

  // Прогресс пересчитывается после синхронизации, а не переиспользуется прежний: сама
  // синхронизация могла не сработать, и в этом случае предупреждение должно остаться.
  const checklistAfterSync = getChecklistProgress(syncedPlan);
  const checklistWarning =
    syncedPlan && checklistAfterSync.parsedTaskCount > 0 && checklistAfterSync.pendingTaskCount > 0
      ? `[warning] Checklist remains incomplete after auto-sync: ${checklistAfterSync.pendingTaskCount} pending task(s).`
      : null;
  if (checklistWarning) {
    log.warn(
      { taskId, pendingTaskCount: checklistAfterSync.pendingTaskCount },
      "Checklist remains incomplete after auto-sync; continuing without blocking",
    );
  }

  // Примечания собираются в массив и приклеиваются к ответу модели: так ревьюер в одном логе
  // видит и ее текст, и машинно проверенные факты о прогоне.
  const finalResultNotes: string[] = [];
  if (noOpRetryAttempted) {
    finalResultNotes.push(
      "[fix] First implementation attempt changed no files; coordinator automatically retried the approved plan execution.",
    );
  }
  if (checklistAutoSynced) {
    finalResultNotes.push("[note] Plan checklist auto-synced after implementation.");
  }
  if (checklistWarning) {
    finalResultNotes.push(checklistWarning);
  }
  if (scopeViolations.length > 0) {
    const shown = scopeViolations.slice(0, 20).join(", ");
    const suffix = scopeViolations.length > 20 ? ` (+${scopeViolations.length - 20} more)` : "";
    finalResultNotes.push(
      `[warning] Files changed outside the declared layer scope: ${shown}${suffix}. The layer was scheduled for parallel fan-out — review before merging.`,
    );
  }

  // Конкретная сводка изменений — показываем точно, какие файлы затронул этот
  // прогон исполнителя, чтобы PR/активность отражали работу по плану, а не
  // зависели от прозы модели (которая может заявить успех без единой правки).
  // `listChangedFiles(projectRoot, ref)` сообщает только об отслеживаемых
  // изменениях, поэтому собираем ещё untracked-файлы (созданные, но не
  // `git add`-нутые) через porcelain-вариант и объединяем оба списка.
  // Список файлов включается в лог только при непустом результате: пустой раздел читался бы как
  // "изменений нет" и дублировал бы предупреждение ниже.
  const trackedChanges =
    layerBaselineSha && task.branchName && !task.isFix
      ? listChangedFiles(projectRoot, layerBaselineSha)
      : [];
  const allDirty = listChangedFiles(projectRoot);
  const changedFiles = Array.from(new Set([...trackedChanges, ...allDirty])).sort();
  // Проверка на непустоту стоит перед добавлением примечания, чтобы не плодить раздел с пустым
  // списком: отсутствие изменений уже описано отдельным предупреждением ниже.
  if (changedFiles.length > 0) {
    finalResultNotes.push(
      `[files] Files changed by this implementation:\n${changedFiles
        .map((file) => `- ${file}`)
        .join("\n")}`,
    );
  }

  // Верификация изменений — если план ожидал продуктовых правок, а прогон
  // ничего не затронул, выводим громкое предупреждение, чтобы пустое «я
  // реализовал» не прошло молча. Используем объединение tracked + untracked файлов.
  // Проверки ниже взаимоисключающие: либо не изменен ни один файл (ошибка), либо изменены не
  // все объявленные (предупреждение о пропущенных).
  const planDeclaredFiles = expectedPlanFiles;
  if (shouldEnforceImplementationChanges && changedFiles.length === 0) {
    const scope =
      planDeclaredFiles.length > 0
        ? planDeclaredFiles.join(", ")
        : "(files not parsable from plan)";
    const warning =
      `[error] The approved plan expected implementation changes but NO files were changed: ${scope}. ` +
      `The implementation produced no work-tree changes even after corrective retry — inspect the implementation log and work tree.`;
    finalResultNotes.push(warning);
    log.error(
      {
        taskId,
        pendingTaskCount: layerComputation.tasks.length,
        expectedPlanFiles: planDeclaredFiles,
        retryAttempted: noOpRetryAttempted,
        changedFiles,
      },
      "Implementer completed without changing any files despite pending plan tasks",
    );
  } else if (planDeclaredFiles.length > 0) {
    // Сравнение идет со списком объявленных файлов, а не с задачами плана: пути - единственная
    // единица, сопоставимая между текстом плана и рабочим деревом.
    const missed = planDeclaredFiles.filter((file) => !changedFiles.includes(file));
    if (missed.length > 0) {
      finalResultNotes.push(
        `[warning] Plan declared file(s) not modified: ${missed.join(", ")}. Review before proceeding.`,
      );
    }
  }

  // Ответ модели и служебные примечания склеиваются один раз: дальше это единый артефакт,
  // который видят координатор, ревьюер и UI.
  const enrichedResult =
    finalResultNotes.length > 0
      ? `${finalResultText}\n\n${finalResultNotes.join("\n")}`
      : finalResultText;

  // Единая метка времени на все записи стадии: heartbeat и updatedAt должны совпадать, иначе
  // мониторинг зависших задач увидит искусственный разрыв.
  const nowIso = new Date().toISOString();
  if (syncedPlan) {
    persistTaskPlanForTask({
      taskId,
      planText: syncedPlan,
      projectRoot,
      isFix: task.isFix,
      planPath: task.planPath,
      updatedAt: nowIso,
    });
  }

  // Сброс признака доработки происходит только здесь - после успешной записи результата. Сбрось
  // мы его раньше, при падении стадии задача потеряла бы признак доработки.
  setTaskFields(taskId, {
    implementationLog: enrichedResult,
    reworkRequested: false,
    lastHeartbeatAt: nowIso,
    updatedAt: nowIso,
  });

  log.debug({ taskId }, "Implementation log saved to task");
}
