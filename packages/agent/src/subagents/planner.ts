/**
 * Планировщик задачи: собирает промпт планирования, готовит execution root
 * (worktree или общий чекаут с feature-веткой) и разбирает артефакт плана.
 *
 * Почему модуль устроен именно так:
 *  - Планирование - единственный этап, который мутирует git-состояние проекта
 *    (создание или восстановление ветки, worktree), поэтому вся git-работа идёт
 *    под per-project локом и завершается проверкой assertCurrentBranch.
 *  - Источник истины по ветке - task.branchName в БД, а не текущий HEAD: любой
 *    повторный запуск обязан вернуться на сохранённую ветку или упасть явно.
 *  - Артефакт плана читается с диска, а не берётся из ответа агента: агент может
 *    напечатать путь, но не содержимое, и диск - единственный надёжный источник.
 *  - Три режима запуска (fix, skills-mode, native subagents) различаются только
 *    способом вызова; разбор результата и persist общие, чтобы они не разъезжались.
 */

import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  findProjectById,
  findGitHubIssueByTaskId,
  findTaskById,
  listTaskComments,
  persistTaskPlanForTask,
  setTaskFields,
} from "@aif/data";
import { createRuntimeWorkflowSpec } from "@aif/runtime";
import { logger, formatAttachmentsForPrompt, getEnv, getProjectConfig } from "@aif/shared";
import { executeSubagentQuery } from "../subagentQuery.js";
import { StageManualBlockError } from "../stageErrorHandler.js";
import {
  assertCurrentBranch,
  ensureFeatureBranch,
  ensureTaskWorktree,
  projectSupportsTaskWorktrees,
  restorePersistedBranch,
} from "../gitBranch.js";
import { withProjectGitLock } from "../gitOperationLock.js";
import { resolveIssueBranchName, type IssueProvider } from "../gitConventions.js";
import { logActivity } from "../hooks.js";

// Имя логгера совпадает с именем модуля: по нему фильтруются логи этапа планирования.
const log = logger("planner");
// Имя должно совпадать с agent definition в репозитории: при расхождении рантайм
// не найдёт определение и откатится на fallback slash-команду.
const AGENT_NAME = "plan-coordinator";
// Fix-задачи планируются не агентом, а скиллом aif-fix в режиме --plan-first.
const FIX_SKILL_NAME = "aif-fix";

// Способ получить рабочую копию: изолированный worktree, общий чекаут с
// feature-веткой или последовательный fix-поток без создания ветки.

/** Как планировщик подготавливает execution root для задачи. */
export type WorktreeProvisionMode = "worktree" | "in_tree" | "serial_fix";

// Входные данные вынесены в отдельный DTO: решение проверяется юнит-тестами без
// реального git и без чтения env.
export interface ShouldProvisionWorktreeInput {
  hasVcsIssue: boolean;
  flagEnabled: boolean;
  parallelEnabled: boolean;
  supportsTaskWorktrees: boolean;
}

/**
 * Решает, подготавливается ли задача в изолированном рабочем дереве задачи.
 *
 * Rollout-флаг (`AIF_TASK_WORKTREES_ENABLED`) гейтит ОБА случая: задачи с
 * issue и параллельные проекты: пока он выключен, даже задачи VCS-issue остаются
 * в общем чекауте с детерминированной issue-веткой, поэтому флаг — настоящий
 * kill-switch. Задачам с issue дополнительно не нужен `parallelEnabled` —
 * их изоляция обязательна для корректности (публикация PR/MR), а не только
 * для производительности.
 */
export function shouldProvisionWorktree(input: ShouldProvisionWorktreeInput): boolean {
  // Kill-switch проверяется первым: проект без поддержки worktree не должен
  // ломаться из-за включённого флага, поэтому остальные условия не важны.
  if (!input.flagEnabled || !input.supportsTaskWorktrees) return false;
  // Задача с внешним issue изолируется всегда, не дожидаясь параллельного режима:
  // её изоляция нужна для корректности публикации PR/MR, а не для скорости.
  if (input.hasVcsIssue) return true;
  return input.parallelEnabled;
}

// Ответ агента - свободный текст, и путь к плану в нём не гарантирован. Это
// единственное место, где путь вылавливается эвристикой: порядок шаблонов задаёт
// приоритет, поэтому более специфичный вариант "plan written to" идёт первым.
function extractPlanPathFromResult(resultText: string): string | null {
  // Второй шаблон нужен для скиллов, которые сообщают "saved to".
  const patterns = [/plan written to\s+([^\n]+)/i, /saved to\s+([^\n]+)/i];

  for (const pattern of patterns) {
    const match = resultText.match(pattern);
    if (!match) continue;
    // Захват идёт до конца строки, поэтому в путь попадает markdown-обёртка;
    // нормализация нужна до того, как результат вернётся вызывающему.
    const normalized = normalizeExtractedPlanPath(match[1]);
    if (normalized) return normalized;
  }

  return null;
}

// Захваченный хвост строки обычно содержит markdown-обёртку и знаки препинания;
// без очистки resolve() получил бы путь, которого нет на диске.
function normalizeExtractedPlanPath(pathText: string): string | null {
  const normalized = pathText
    .trim()
    .replace(/^[@`"'(\[]+/, "")
    .replace(/[)\].,`"']+$/, "")
    .trim();
  // Пустая строка означает, что шаблон поймал только обёртку: это не путь, и
  // вызывающий должен попробовать следующий шаблон.
  return normalized.length > 0 ? normalized : null;
}

// Дефолтный путь берётся из конфига проекта, а не из константы: у разных
// проектов своя раскладка docs. Строка из одних @ или пробелов равнозначна
// отсутствию пути.
function normalizePlanPath(path: string | null | undefined, projectRoot: string): string {
  const defaultPlan = getProjectConfig(projectRoot).paths.plan;
  if (!path) return defaultPlan;
  // Ведущая @ - синтаксис ссылки на файл в промпте; в самом пути она лишняя.
  return path.trim().replace(/^@+/, "") || defaultPlan;
}

// Различие между явным путём из задачи и дефолтным критично на следующем шаге:
// при явном пути generic-фоллбэки запрещены, иначе план может быть прочитан из
// чужого файла, лежащего в том же дереве.
function isExplicitTaskPlanPath(
  customPlanPath: string | null | undefined,
  normalizedPlanPath: string,
  defaultPlanPath: string,
): boolean {
  return Boolean(customPlanPath?.trim()) && normalizedPlanPath !== defaultPlanPath;
}

// Единая точка чтения артефакта плана с диска. Кандидаты упорядочены по доверию:
// сначала канонический путь задачи, затем путь, названный агентом, затем
// фоллбэки скиллов. Возвращается первый существующий непустой файл.
function readPlanFromDisk(
  projectRoot: string,
  resultText: string,
  isFix: boolean,
  customPlanPath?: string,
  minModifiedMs?: number,
): string | null {
  const cfg = getProjectConfig(projectRoot);
  const normalizedPlanPath = normalizePlanPath(customPlanPath, projectRoot);
  // Для fix-задач канонический путь - fix_plan из конфига, а не путь задачи.
  const canonicalPlanPath = resolve(projectRoot, isFix ? cfg.paths.fix_plan : normalizedPlanPath);
  // Эта ветка решает, допустимы ли вообще generic-фоллбэки, поэтому
  // вычисляется заранее, до наполнения списка кандидатов.
  const explicitTaskPlanPath =
    !isFix && isExplicitTaskPlanPath(customPlanPath, normalizedPlanPath, cfg.paths.plan);
  const candidatePaths: string[] = [canonicalPlanPath];
  const pathFromResult = extractPlanPathFromResult(resultText);
  if (pathFromResult) {
    // Абсолютный путь используется как есть, относительный трактуется от
    // execution root: агент пишет его относительно своей рабочей копии.
    const resolved = pathFromResult.startsWith("/")
      ? pathFromResult
      : resolve(projectRoot, pathFromResult);
    candidatePaths.push(resolved);
  }

  // Runы скилла могут писать запасные пути, даже когда запрошен дефолтный @path.
  if (isFix) {
    candidatePaths.push(resolve(projectRoot, "FIX_PLAN.md"));
  } else if (!explicitTaskPlanPath) {
    candidatePaths.push(resolve(projectRoot, cfg.paths.plan));
    candidatePaths.push(resolve(projectRoot, "PLAN.md"));
  } else {
    log.warn(
      {
        requestedPlanPath: canonicalPlanPath,
        skippedFallbackPlanPaths: [
          resolve(projectRoot, cfg.paths.plan),
          resolve(projectRoot, "PLAN.md"),
        ],
      },
      "Skipping generic plan fallback paths because an explicit task plan path was requested",
    );
  }

  // Один и тот же файл может попасть в список дважды (например, дефолтный путь
  // совпал с путём из ответа); Set исключает повторное чтение.
  const seen = new Set<string>();
  for (const candidatePath of candidatePaths) {
    if (seen.has(candidatePath)) continue;
    seen.add(candidatePath);
    if (!existsSync(candidatePath)) continue;
    // Файл, не изменённый во время текущего запуска, - это план прошлого прогона;
    // принять его за результат значит молча вернуть устаревший план.
    if (minModifiedMs != null && statSync(candidatePath).mtimeMs < minModifiedMs) {
      log.warn(
        { planPath: candidatePath, minModifiedMs },
        "Ignoring stale plan file that was not modified during this planning run",
      );
      continue;
    }
    // Пустой файл равнозначен отсутствующему: он не должен перетирать план,
    // уже сохранённый в БД, поэтому проверка контента идёт до возврата.
    const content = readFileSync(candidatePath, "utf8").trim();
    if (content.length > 0) return content;
  }

  return null;
}

// Служебная строка вида "plan written to ..." - это транспортная метка, а не
// часть плана, и в БД она попадать не должна. Если после очистки не осталось
// ничего, возвращается исходный текст: лучше шумный результат, чем пустой.
function normalizePlannerResult(resultText: string): string {
  const cleaned = resultText
    .replace(/^plan written to .*$/im, "")
    .replace(/^saved to .*$/im, "")
    .trim();

  return cleaned.length > 0 ? cleaned : resultText.trim();
}

// Очистка устаревшего артефакта перед первым планированием: файл на диске мог
// остаться от предыдущей жизни задачи на той же ветке и был бы принят за результат.
function clearPlanFileBeforeFreshPlanning(input: {
  taskId: string;
  executionRoot: string;
  planPath: string;
  hasPersistedPlan: boolean;
  hasPlanReviewFeedback: boolean;
  isFix: boolean;
}): void {
  // Три случая, когда файл на диске - намеренный вход, а не мусор: fix-режим
  // (работает со своим fix_plan), ревью-фидбек (нужен старый план как база правок)
  // и уже сохранённый план в БД (репланнинг не должен стартовать с нуля).
  if (input.isFix || input.hasPlanReviewFeedback || input.hasPersistedPlan) return;

  const cfg = getProjectConfig(input.executionRoot);
  const canonicalPath = resolve(input.executionRoot, input.planPath);
  // Generic-фоллбэки чистятся вместе с каноническим путём: скилл мог записать
  // план именно туда, и тогда он будет найден при чтении с диска.
  const genericFallbackPaths = [
    resolve(input.executionRoot, cfg.paths.plan),
    resolve(input.executionRoot, "PLAN.md"),
  ];
  const pathsToDelete = [canonicalPath, ...genericFallbackPaths];

  for (const planFileOnDisk of pathsToDelete) {
    if (!existsSync(planFileOnDisk)) continue;
    try {
      unlinkSync(planFileOnDisk);
      log.warn(
        { taskId: input.taskId, planPath: planFileOnDisk },
        "Deleted pre-existing plan file before fresh planning; planner will generate a new task-specific plan",
      );
    } catch (error) {
      log.error(
        {
          taskId: input.taskId,
          planPath: planFileOnDisk,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to delete pre-existing plan file before fresh planning",
      );
      // Неудачное удаление блокирует этап вручную: продолжать с чужим планом на
      // диске опаснее, чем остановиться и дать оператору разобраться.
      throw new StageManualBlockError(
        `Unable to prepare a fresh plan file for task ${input.taskId}. Inspect ${planFileOnDisk} and retry.`,
      );
    }
  }
}

// В промпт попадает только последний комментарий: планировщику нужен актуальный
// фидбек, а не накопленная история обсуждения, которая раздувает промпт и
// провоцирует агента пересказывать уже учтённые замечания.
function formatCommentsForPrompt(
  comments: Array<{
    author: "human" | "agent";
    message: string;
    attachments: string | null;
    createdAt: string;
  }>,
): string {
  // Явная заглушка вместо пустого блока: агент должен видеть, что комментариев
  // нет, а не догадываться об этом по отсутствию секции.
  if (comments.length === 0) return "No user comments were provided.";

  const latest = comments.slice(-1);
  return latest
    .map((comment, index) => {
      const formatted = formatAttachmentsForPrompt(comment.attachments);
      // Форматтер вложений возвращает фразу-заглушку для пустого списка; внутри
      // блока вложений она читается как мусор, поэтому подменяется на none.
      const attachmentLines =
        formatted === "No task attachments were provided." ? "    none" : formatted;

      // Нумерованный заголовок с датой и автором нужен, чтобы агент мог сослаться
      // на источник правки и не смешивал людей с агентами.
      return [
        `${index + 1}. [${comment.createdAt}] ${comment.author}`,
        `   message: ${comment.message}`,
        "   attachments:",
        attachmentLines,
      ].join("\n");
    })
    .join("\n\n");
}

// Контекст задачи передаётся как JSON-строка в аргументе команды: так кавычки и
// переводы строк из описания задачи не ломают разбор slash-команды.
function buildFixCommandText(taskContext: string): string {
  return `/aif-fix --plan-first ${JSON.stringify(taskContext)}`;
}

// Точка входа этапа планирования. Побочные эффекты: создание или восстановление
// ветки либо worktree, запись branchName/worktreePath в БД и persist плана.
// Функция ничего не возвращает - координатор читает готовый план из БД.
export async function runPlanner(taskId: string, projectRoot: string): Promise<void> {
  const task = findTaskById(taskId);
  // Сортировка по времени, а не по id: промпт использует последний комментарий,
  // и порядок не должен зависеть от того, как БД вернула строки.
  const comments = listTaskComments(taskId).sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );

  if (!task) {
    // Задача могла быть удалена между постановкой в очередь и запуском: это
    // фатальная ошибка этапа, а не повод для автоматического повтора.
    log.error({ taskId }, "Task not found for planning");
    throw new Error(`Task ${taskId} not found`);
  }

  // Три режима исполнения разводятся двумя флагами: fix всегда идёт через скилл,
  // задача без субагентов - через slash-команду aif-plan, остальные - через агента.
  const useSubagents = task.useSubagents;
  const executionName = task.isFix ? FIX_SKILL_NAME : useSubagents ? AGENT_NAME : "aif-plan";
  log.info({ taskId, title: task.title, isFix: task.isFix }, "Starting planning flow");
  const project = findProjectById(task.projectId);
  // Бюджет - настройка проекта; null означает отсутствие ограничения.
  const plannerBudget = project?.plannerMaxBudgetUsd ?? null;
  // Если задача уже привязана к worktree, план пишется туда, а не в корень проекта;
  // корень остаётся запасным вариантом для in-tree прогонов.
  let executionRoot = task.worktreePath ?? projectRoot;

  const taskAttachmentsForPrompt = formatAttachmentsForPrompt(task.attachments);
  const commentsForPrompt = formatCommentsForPrompt(comments);

  // Обратная связь VCS plan-review (тело review GitHub / заметки MR GitLab) —
  // полноправный вход перепланирования: если опубликованный PR/MR плана отклонён,
  // planner обязан пересмотреть тот же план с учётом комментариев ревьюера.
  const planReviewFeedback = task.planReviewFeedback?.trim();
  if (planReviewFeedback) {
    log.debug(
      { taskId, feedbackLength: planReviewFeedback.length },
      "Attached VCS plan review feedback to planner prompt",
    );
  }
  const planReviewFeedbackSection = planReviewFeedback
    ? `\nVCS plan review feedback (address every point in the revised plan):\n${planReviewFeedback}`
    : "";

  // Значения уходят в промпт строками: скилл aif-plan ожидает текстовые true/false
  // и имя режима, а не булевы значения.
  const plannerMode = task.plannerMode || "full";
  // Нормализация идёт от текущего executionRoot: worktree для задачи может быть
  // выделен позже, поэтому здесь получается относительный путь, а resolve
  // выполняется уже от финального корня.
  const planPath = normalizePlanPath(task.planPath, executionRoot);
  const planDocs = task.planDocs ? "true" : "false";
  const planTests = task.planTests ? "true" : "false";

  // Детерминированная работа с веткой. Два контракта, применяются по порядку:
  //
  //  1. ВОССТАНОВЛЕНИЕ для ЛЮБОЙ привязанной не-fix задачи — работает независимо от
  //     plannerMode (full или fast). `task.branchName` — источник истины: как только
  //     прошлый прогон его сохранил, каждая последующая стадия ОБЯЗАНА оказаться на
  //     этой ветке или упасть громко. Перепланирование с mode=fast (ручное,
  //     по комментарию) раньше полностью пропускало восстановление и давало
  //     planner писать туда, где оказался HEAD.
  //
  //  2. СОЗДАНИЕ только в full-режиме для непривязанных не-fix задач. Fast-режим
  //     остаётся на текущей ветке по замыслу (см. aif-handoff#83) — первичная
  //     подготовка ветки касается только full-режима.
  //
  // Сбои бросают BranchIsolationError (грязное рабочее дерево, отсутствующая
  // base-ветка, сбой checkout, branch_missing и т.п.). Координатор классифицирует
  // его как blocked_external с retryAfter=null, чтобы оператор осмотрел рабочее
  // дерево, вместо молчаливого возврата стадии в плохое состояние.
  // preparedBranch - не просто имя ветки, а контракт: пока он не null, финальная
  // проверка assertCurrentBranch обязательна, иначе план привяжется к чужому HEAD.
  let preparedBranch: string | null = task.branchName ?? null;
  // Restore разделён на две ветки, потому что для worktree и для общего чекаута
  // отличается только текст активности, а не сама git-операция.
  if (!task.isFix && task.worktreePath) {
    if (task.branchName) {
      restorePersistedBranch({
        projectRoot: executionRoot,
        taskId,
        persistedBranchName: task.branchName,
      });
      preparedBranch = task.branchName;
      logActivity(taskId, "Agent", `Restored task worktree branch: ${task.branchName}`);
    }
  } else if (!task.isFix && task.branchName) {
    restorePersistedBranch({
      projectRoot: executionRoot,
      taskId,
      persistedBranchName: task.branchName,
    });
    preparedBranch = task.branchName;
    logActivity(taskId, "Agent", `Restored feature branch: ${task.branchName}`);
  } else if (!task.isFix && plannerMode === "full") {
    // Провайдер берётся из env, а не из настроек проекта: вся интеграция с VCS в
    // агенте идёт через один env-переключатель.
    const env = getEnv();
    const provider: IssueProvider = env.GIT_PROVIDER === "gitlab" ? "gitlab" : "github";
    // Сегодня в planner подключена только связь с GitHub-issue; GitLab-задачи
    // пойдут тем же путём, как только появится поиск их issue.
    // При выключенном флаге задача ведёт себя как обычная: без issue нет ни
    // детерминированной ветки, ни обязательной изоляции.
    const githubIssue =
      provider === "github" && env.AIF_GITHUB_ISSUE_PR_ENABLED
        ? findGitHubIssueByTaskId(taskId)
        : null;
    const issueNumber = githubIssue?.issueNumber ?? null;
    // Наличие issue меняет требования к изоляции: для него нужна детерминированная
    // ветка, пригодная для публикации PR/MR.
    const hasVcsIssue = issueNumber !== null;
    const useWorktree = shouldProvisionWorktree({
      hasVcsIssue,
      flagEnabled: env.AIF_TASK_WORKTREES_ENABLED,
      parallelEnabled: Boolean(project?.parallelEnabled),
      supportsTaskWorktrees: projectSupportsTaskWorktrees(projectRoot),
    });
    // Имя ветки для issue детерминировано: повторный запуск по тому же issue обязан
    // попасть в ту же ветку, иначе PR/MR потеряет связь с задачей.
    const issueBranchName = hasVcsIssue
      ? resolveIssueBranchName({ projectRoot, provider, issueNumber }).branchName
      : null;
    // Режим вычисляется один раз и используется и в логе, и в имени операции под
    // git-локом, чтобы они не разошлись.
    const mode: WorktreeProvisionMode = useWorktree ? "worktree" : "in_tree";
    log.info(
      {
        taskId,
        flagEnabled: env.AIF_TASK_WORKTREES_ENABLED,
        provider,
        branchName: issueBranchName,
        mode,
      },
      "Planner provisioning decision",
    );

    // Подготовка, мутирующая репозиторий, сериализуется по корню проекта, чтобы
    // параллельное планирование не конфликтовало с ref-локами самого git.
    await withProjectGitLock({ projectRoot, operation: `planner-${mode}` }, () => {
      // Внутри callback нельзя делать длительную работу: лок удерживается на всё
      // время git-операций проекта и блокирует параллельные задачи.
      if (useWorktree) {
        const worktreeResult = ensureTaskWorktree({
          projectRoot,
          taskId,
          title: task.title,
          projectId: task.projectId,
          explicitBranchName: issueBranchName,
        });
        // skipped означает, что подходящее дерево уже было: это нормальный исход,
        // а не ошибка, поэтому БД обновляется только при реальном результате.
        if (
          worktreeResult.action !== "skipped" &&
          worktreeResult.branchName &&
          worktreeResult.worktreePath
        ) {
          preparedBranch = worktreeResult.branchName;
          executionRoot = worktreeResult.worktreePath;
          setTaskFields(taskId, {
            branchName: worktreeResult.branchName,
            worktreePath: worktreeResult.worktreePath,
            updatedAt: new Date().toISOString(),
          });
          logActivity(
            taskId,
            "Agent",
            `Task worktree ${worktreeResult.action}: ${worktreeResult.worktreePath} (${worktreeResult.branchName})`,
          );
        } else if (worktreeResult.reason) {
          // Причина без результата означает, что изоляцию обеспечить не удалось;
          // без неё задачи с issue публиковать некуда, поэтому ручная блокировка.
          throw new StageManualBlockError(
            `This task requires an isolated Git worktree: ${worktreeResult.reason}`,
          );
        }
        return;
      }

      // Ветка в общем чекауте: worktreePath у задачи остаётся пустым, и все
      // последующие этапы работают в корне проекта.
      const branchResult = ensureFeatureBranch({
        projectRoot: executionRoot,
        taskId,
        title: task.title,
        explicitBranchName: issueBranchName,
      });
      if (branchResult.action !== "skipped" && branchResult.branchName) {
        preparedBranch = branchResult.branchName;
        setTaskFields(taskId, {
          branchName: branchResult.branchName,
          updatedAt: new Date().toISOString(),
        });
        logActivity(
          taskId,
          "Agent",
          `Feature branch ${branchResult.action}: ${branchResult.branchName}`,
        );
      } else if (branchResult.reason) {
        // Для issue-задач отсутствие ветки - блокировка (публиковать PR/MR некуда),
        // для обычных - всего лишь отладочный лог: ветку создаст другой этап.
        if (hasVcsIssue) {
          throw new StageManualBlockError(
            `Issue #${issueNumber} requires a feature branch: ${branchResult.reason}`,
          );
        }
        log.debug({ taskId, reason: branchResult.reason }, "Branch creation skipped");
      }
    });
  }

  // Свежая задача Handoff не должна считать существующий артефакт плана в
  // подготовленной ветке/worktree контекстом. Задачи VCS-issue используют
  // детерминированные имена веток и пути планов (`github-issue-N.md` /
  // `gitlab-issue-N.md`), поэтому удаление и пересоздание задачи для того же
  // внешнего issue может чекаутить ветку со старым файлом плана. Оставим его —
  // и `/aif-plan`, и чтение с диска после прогона подхватят его, а исполнителю
  // хватит старого чек-листа для no-op. Перепланирование и задачи с уже
  // сохранённым планом в БД намеренно сохраняют свой артефакт.
  // Предикат дублирует решение внутри clearPlanFileBeforeFreshPlanning, но нужен
  // ещё и ниже - для mtime-гейта при чтении плана с диска.
  const shouldRequireFreshPlanFile = !task.isFix && !planReviewFeedback && !task.plan?.trim();

  clearPlanFileBeforeFreshPlanning({
    taskId,
    executionRoot,
    planPath,
    hasPersistedPlan: Boolean(task.plan?.trim()),
    hasPlanReviewFeedback: Boolean(planReviewFeedback),
    isFix: task.isFix,
  });

  // Контекст собирается один раз и переиспользуется всеми тремя режимами, включая
  // fix-команду, чтобы варианты промпта не расходились по составу входа.
  const taskContext = `Title: ${task.title}
Description: ${task.description}
Task attachments:
${taskAttachmentsForPrompt}
User comments and replanning feedback:
${commentsForPrompt}${planReviewFeedbackSection}`;
  // prompt и workflowSpec заполняются в каждой ветке: рантайм должен получить ровно
  // один согласованный spec, а не набор взаимоисключающих флагов.
  let prompt: string;
  let workflowSpec: ReturnType<typeof createRuntimeWorkflowSpec>;
  // HANDOFF_BRANCH_PREPARED=1 сообщает скиллу aif-plan / plan-polisher, что
  // создание ветки для этого прогона уже на Handoff. Скилл НЕ должен выполнять
  // собственный `git checkout -b`; вместо этого он проверяет, что текущая
  // ветка совпадает с HANDOFF_BRANCH_NAME, и иначе сообщает о блокере. См.
  // ai-factory#96.
  const handoffBranchLines = preparedBranch
    ? `\nHANDOFF_BRANCH_PREPARED: 1\nHANDOFF_BRANCH_NAME: ${preparedBranch}`
    : "";
  // HANDOFF_MODE переводит скилл в автономный режим: без него скилл начнёт задавать
  // интерактивные вопросы, на которые в очереди никто не ответит.
  const handoffContext = `HANDOFF_MODE: 1\nHANDOFF_TASK_ID: ${taskId}${handoffBranchLines}`;
  // Тот же текст уходит и в systemPromptAppend: агент должен видеть ограничение по
  // каталогу, даже если потеряет его в теле промпта.
  const scopeConstraint = `IMPORTANT: Your working directory is ${executionRoot}\nAll files must be created and modified inside this directory. Do NOT navigate to parent directories or other projects.`;
  // Строка команды собирается заранее: она служит и fallback для рантайма, и
  // metadata-контрактом для скилла, поэтому не должна собираться заново на месте.
  const plannerSlashCommand = `/aif-plan ${plannerMode} @${planPath} docs:${planDocs} tests:${planTests}`;
  // Для не-fix задач остаётся undefined: иначе рантайм подставил бы fix-команду в
  // обычный запуск планирования.
  const fixSlashCommand = task.isFix ? buildFixCommandText(taskContext) : undefined;

  if (task.isFix) {
    // Fix-ветка: обязательных capabilities нет, потому что команда скилла
    // исполняется рантаймом без agent definition.
    prompt = `${handoffContext}\n${scopeConstraint}\n\n${fixSlashCommand}`;
    workflowSpec = createRuntimeWorkflowSpec({
      workflowKind: "planner",
      prompt,
      requiredCapabilities: [],
      fallbackSlashCommand: fixSlashCommand,
      fallbackStrategy: "slash_command",
      sessionReusePolicy: "resume_if_available",
      systemPromptAppend: scopeConstraint,
    });
  } else if (useSubagents) {
    // Единственная ветка, требующая supportsAgentDefinitions: если рантайм её не
    // заявляет, сработает fallback на plannerSlashCommand.
    prompt = `Plan the implementation for the following task.

${handoffContext}
${scopeConstraint}

Autonomous Handoff mode: true.
Do not ask interactive questions.
Do not perform Handoff MCP sync yourself.

Mode: ${plannerMode}, tests: ${planTests}, docs: ${planDocs}.
Plan file: @${planPath}

${taskContext}

Create or refine an implementation-ready markdown checklist plan.
CRITICAL: Do NOT modify, create, or delete any files during planning. Do NOT write any code, create any new files (such as test.md), or make any changes to the project. Your ONLY task is to write a checklist plan document to @${planPath}. The plan must contain actionable checklist items in format "- [ ] Step description". Never mark items as completed "- [x]" — all items start unchecked.

CRITICAL OUTPUT CONSTRAINT: The plan MUST contain ONLY structured sections (headings, checklist items, tables, code blocks). Do NOT include:
- Agent reasoning, investigation notes, or analysis («I will inspect...», «Let me check...», «First I need to...»)
- Alternatives considered or tool call traces
- Any chain-of-thought or narrative text
- Explanatory paragraphs outside defined sections
- First-person statements
If you catch yourself writing any of these, remove them before outputting the plan.

Always write the final plan to @${planPath}.`;
    workflowSpec = createRuntimeWorkflowSpec({
      workflowKind: "planner",
      prompt,
      requiredCapabilities: ["supportsAgentDefinitions"],
      agentDefinitionName: AGENT_NAME,
      fallbackSlashCommand: plannerSlashCommand,
      fallbackStrategy: "slash_command",
      executionMode: "native_subagents",
      sessionReusePolicy: "resume_if_available",
      systemPromptAppend: scopeConstraint,
      metadata: {
        plannerMode,
        planDocs,
        planTests,
      },
    });
  } else {
    prompt = `${handoffContext}\n${scopeConstraint}\n\n${plannerSlashCommand}\n\n${taskContext}\n\nCreate an implementation-ready markdown checklist plan.\nCRITICAL: Do NOT modify, create, or delete any files during planning. Do NOT write any code, create any new files, or make any changes to the project. Your ONLY task is to write a checklist plan document to @${planPath}.\nThe plan must contain actionable checklist items in format "- [ ] Step description". Never mark items as completed "- [x]" — all items start unchecked.\n\nCRITICAL OUTPUT CONSTRAINT: The plan MUST contain ONLY structured sections (headings, checklist items, tables, code blocks). Do NOT include:\n- Agent reasoning, investigation notes, or analysis\n- Alternatives considered or tool call traces\n- Any chain-of-thought or narrative text\n- Explanatory paragraphs outside defined sections\n- First-person statements\nIf you catch yourself writing any of these, remove them before outputting the plan.\n\nAlways write the final plan to @${planPath}.`;
    workflowSpec = createRuntimeWorkflowSpec({
      workflowKind: "planner",
      prompt,
      requiredCapabilities: [],
      fallbackSlashCommand: plannerSlashCommand,
      fallbackStrategy: "slash_command",
      sessionReusePolicy: "resume_if_available",
      systemPromptAppend: scopeConstraint,
      metadata: {
        plannerMode,
        planDocs,
        planTests,
      },
    });
  }

  // Отметка времени ставится только для прогона, который обязан создать свежий файл:
  // для остальных mtime-гейт не применяется и старый план допустим.
  const planRunStartedAtMs = shouldRequireFreshPlanFile ? Date.now() : undefined;
  // Бюджет берётся из настроек проекта, а agent передаётся только в native-режиме:
  // в остальных рантайм сам решает, как исполнить промпт.
  const { resultText: rawResult } = await executeSubagentQuery({
    taskId,
    projectRoot: executionRoot,
    agentName: executionName,
    prompt,
    profileMode: "plan",
    maxBudgetUsd: plannerBudget,
    agent: task.isFix || !useSubagents ? undefined : AGENT_NAME,
    workflowSpec,
    workflowKind: "planner",
    fallbackSlashCommand: task.isFix ? undefined : plannerSlashCommand,
  });

  // Дрейф ветки на уровне скилла: если сабагент planner (или его вложенный
  // plan-polisher) молча создал или переключил ветку, отличную от подготовленной,
  // план, который мы собираемся сохранить, относится к чужому HEAD.
  // Показываем это как BranchIsolationError, чтобы координатор заблокировал
  // задачу вместо коммита дрейфа.
  if (preparedBranch) {
    // assertCurrentBranch бросает BranchIsolationError; это ожидаемый путь
    // блокировки, а не внутренняя ошибка, поэтому пробрасывается наружу.
    assertCurrentBranch(executionRoot, preparedBranch);
  }

  // Диск имеет приоритет над текстом ответа: агент мог вернуть пересказ, а файл
  // содержит канонический план. Нормализованный ответ - только резервный вариант.
  const diskPlan = readPlanFromDisk(
    executionRoot,
    rawResult,
    !!task.isFix,
    planPath,
    planRunStartedAtMs,
  );
  const resultText = diskPlan ?? normalizePlannerResult(rawResult);

  // Persist идёт в тот же executionRoot: для worktree-задач план сохраняется вместе
  // с веткой, к которой он относится.
  persistTaskPlanForTask({
    taskId,
    planText: resultText,
    projectRoot: executionRoot,
    isFix: task.isFix,
    planPath,
    updatedAt: new Date().toISOString(),
  });

  log.debug({ taskId }, "Plan saved to task");
}
