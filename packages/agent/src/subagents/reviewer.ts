/**
 * Сайдкар-ревьюер: собирает промпты, запускает проверки и приводит ответы к
 * контракту ревью.
 *
 * Стадия состоит из двух независимых сайдкаров - обзор кода и аудит безопасности.
 * Промпты у них разные (общая база плюс своя фокусировка), но формат ответа общий,
 * поэтому результат разбирается одним парсером с разным значением source.
 *
 * Инварианты и тонкости:
 * - Ревьюер обязан сравнивать код с веткой задачи, а не с текущим HEAD. Ветка
 *   восстанавливается до запуска сайдкаров и проверяется после: сайдкар работает в
 *   том же рабочем каталоге, и неудачное переключение оставит репозиторий на чужой
 *   ветке, а дифф окажется пустым.
 * - Секция "## Verification" принадлежит стадии верификации и не должна теряться
 *   при перезаписи комментариев, поэтому переносится хвостом в новый комментарий.
 * - Оба сайдкара пишут в одно поле задачи; без общего формата параллельные записи
 *   затирали бы друг друга, отсюда комбинированный комментарий с секциями.
 * - Резервный разбор legacy-формата обязателен: нераспознанный ответ лучше сохранить как
 *   есть, чем потерять замечания ревью целиком.
 */

import { findProjectById, findTaskById, setTaskFields } from "@aif/data";
import { createRuntimeWorkflowSpec, type RuntimeWorkflowSpec } from "@aif/runtime";
import { getEnv, logger, formatAttachmentsForPrompt } from "@aif/shared";
import { assertCurrentBranch, restorePersistedBranch } from "../gitBranch.js";
import { logActivity } from "../hooks.js";
import { executeSubagentQuery, startHeartbeat } from "../subagentQuery.js";
import {
  buildStructuredReviewComments,
  formatPreviousFindingsForPrompt,
  parseStructuredSidecarOutput,
} from "../reviewContract.js";

const log = logger("reviewer");

// Секция верификации всегда последняя, поэтому достаточно взять весь хвост от ее
// заголовка: границы по концу файла дают ровно нужный фрагмент без разбора
// структуры остальных секций.
function extractVerificationSection(reviewComments: string | null): string | null {
  const normalizedComments = reviewComments?.trim();
  if (!normalizedComments) return null;

  const match = /^## Verification\b.*$/m.exec(normalizedComments);
  if (!match || match.index === undefined) return null;

  return normalizedComments.slice(match.index).trim();
}

// Секция верификации создается другой стадией и живет дольше одного ревью,
// поэтому новое содержимое не заменяет ее, а пристраивается перед ней.
function preserveVerificationSection(reviewComments: string | null, nextReviewComments: string) {
  const verificationSection = extractVerificationSection(reviewComments);
  if (!verificationSection) {
    return nextReviewComments;
  }

  return `${nextReviewComments.trim()}\n\n${verificationSection}`;
}

// Единая точка запуска сайдкара: оба промпта идут через один и тот же путь
// исполнения, различаясь лишь агентом и спецификацией workflow.
// profileMode "review" выбирает профиль рантайма отдельно от фаз планирования и
// реализации, а agent передается только в режиме нативных субагентов: в режиме
// slash-команд роль агента играет сам текст команды внутри промпта.
async function runSidecar(
  prompt: string,
  taskId: string,
  projectRoot: string,
  agentName: string,
  maxBudgetUsd: number | null,
  useSubagentAgent: boolean,
  workflowSpec: RuntimeWorkflowSpec,
  fallbackSlashCommand?: string,
): Promise<string> {
  const { resultText } = await executeSubagentQuery({
    taskId,
    projectRoot,
    agentName,
    prompt,
    profileMode: "review",
    maxBudgetUsd,
    agent: useSubagentAgent ? agentName : undefined,
    workflowSpec,
    workflowKind: workflowSpec.workflowKind,
    fallbackSlashCommand,
  });
  return resultText;
}

// Точка входа стадии ревью. Ошибки не глушатся: координатор должен увидеть сбой
// стадии и принять решение о повторной попытке, поэтому исключение пробрасывается
// наружу после записи в лог активности.
export async function runReviewer(taskId: string, projectRoot: string): Promise<void> {
  const env = getEnv();
  const task = findTaskById(taskId);

  if (!task) {
    log.error({ taskId }, "Task not found for review");
    throw new Error(`Task ${taskId} not found`);
  }

  // Ревьюер должен сравнивать изменения с feature-веткой задачи — а не с тем, где
  // оказался HEAD. Тот же контракт обязательного восстановления, как у implementer/plan-checker.
  // Восстановление обязательно и для ревью, а не только для реализации: сравнение
  // с основной веткой дало бы дифф, не относящийся к задаче.
  if (task.branchName && !task.isFix) {
    restorePersistedBranch({
      projectRoot,
      taskId,
      persistedBranchName: task.branchName,
    });
    logActivity(taskId, "Agent", `Restored feature branch: ${task.branchName}`);
  }

  const project = findProjectById(task.projectId);
  const sidecarBudget = project?.reviewSidecarMaxBudgetUsd ?? null;
  const useSubagents = task.useSubagents;
  const strategy = env.AGENT_AUTO_REVIEW_STRATEGY;
  // Счетчик итераций монотонен и начинается с единицы: именно он отличает первое
  // ревью от повторных и передается модели в промпте.
  const reviewIteration = (task.reviewIterationCount ?? 0) + 1;
  const previousFindings = task.autoReviewState?.findings ?? [];
  // Прошлые находки раскладываются по тем же двум корзинам, что и новые проверки:
  // вердикт по находке возвращается тому сайдкару, который ее нашел, иначе он не
  // сможет ни подтвердить закрытие, ни объяснить, почему она все еще блокирует.
  const reviewPreviousFindingState = previousFindings.filter((finding) =>
    ["code_review", "review_gate"].includes(finding.source),
  );
  const securityPreviousFindingState = previousFindings.filter(
    (finding) => finding.source === "security_audit",
  );
  const reviewPreviousFindings = formatPreviousFindingsForPrompt(reviewPreviousFindingState);
  const securityPreviousFindings = formatPreviousFindingsForPrompt(securityPreviousFindingState);

  log.info(
    { taskId, title: task.title, useSubagents, strategy, reviewIteration },
    "Starting review stage",
  );

  // Ограничение области дублируется в промпте и в systemPromptAppend намеренно:
  // модель может проигнорировать одну из двух подсказок, а выход за пределы
  // рабочего каталога ломает и дифф, и доверие к выводам ревью.
  const scopeConstraint = `IMPORTANT: Your working directory is ${projectRoot}
All file reads, searches, and analysis must stay within this directory. Do NOT navigate to parent directories or other projects.`;

  // Текст контракта обязан совпадать с тем, что принимает parseStructuredSidecarOutput:
  // заголовки - ключи секций, запрет на лишние заголовки сохраняет их однозначными,
  // а запрет на code fences нужен потому, что строки внутри фенса выглядели бы как
  // пункты списка и попали бы в находки.
  const reviewOutputContract = `Output contract:
Return markdown only with these exact sections, in this exact order:

## Blocking Findings
- <blocking finding>
or
- none

## Advisories
- <non-blocking advisory>
or
- none

## Previous Findings
- [<id>] resolved | <short closure note>
- [<id>] still_blocking | <short reason>
or
- none

Rules:
- Blocking Findings must list only issues that should block automatic completion for this review source.
- Advisories are non-blocking suggestions or follow-ups.
- Reuse only IDs provided in the Previous Findings input below.
- Do not add any headings before, between, or after these sections.
- Do not use code fences.`;

  // База промпта одна для обоих сайдкаров: различаются только фокусировка и
  // входной список прошлых находок, поэтому формат ответа и правила описаны в
  // общем блоке, а не дублируются.
  const reviewPromptBase = `Review the implementation for this task:

${scopeConstraint}

Title: ${task.title}
Description: ${task.description}
Task attachments:
${formatAttachmentsForPrompt(task.attachments)}

Implementation Log:
${task.implementationLog ?? "No implementation log available."}

Auto-review strategy: ${strategy}
Review iteration: ${reviewIteration}

Previous Findings Input:
${reviewPreviousFindings}

Review changed code for correctness, regression risks, performance, and maintainability.

${reviewOutputContract}`;

  const securityPromptBase = `Audit the implementation for security risks:

${scopeConstraint}

Title: ${task.title}
Description: ${task.description}
Task attachments:
${formatAttachmentsForPrompt(task.attachments)}

Auto-review strategy: ${strategy}
Review iteration: ${reviewIteration}

Previous Findings Input:
${securityPreviousFindings}

Focus on auth, validation, secrets, injection, and unsafe shell/file handling in changed code.

${reviewOutputContract}`;
  // В режиме навыков нативные субагенты недоступны, и роль проверяющего берет на
  // себя slash-команда: промпт остается тем же, меняется только способ запуска.
  const reviewPrompt = useSubagents ? reviewPromptBase : `/aif-review ${reviewPromptBase}`;
  const securityPrompt = useSubagents
    ? securityPromptBase
    : `/aif-security-checklist ${securityPromptBase}`;
  const reviewAgentName = useSubagents ? "review-sidecar" : "aif-review";
  const securityAgentName = useSubagents ? "security-sidecar" : "aif-security-checklist";
  // Спецификация workflow несет требования к рантайму: объявлять поддержку
  // агентских определений нужно только там, где она действительно обязательна,
  // иначе задача не запустится на рантайме без этой возможности.
  const reviewWorkflow = createRuntimeWorkflowSpec({
    workflowKind: "reviewer",
    prompt: reviewPrompt,
    requiredCapabilities: useSubagents ? ["supportsAgentDefinitions"] : [],
    agentDefinitionName: useSubagents ? reviewAgentName : undefined,
    fallbackSlashCommand: "/aif-review",
    fallbackStrategy: useSubagents ? "slash_command" : "none",
    executionMode: useSubagents ? "native_subagents" : "standard",
    sessionReusePolicy: "new_session",
    systemPromptAppend: scopeConstraint,
  });
  const securityWorkflow = createRuntimeWorkflowSpec({
    workflowKind: "review-security",
    prompt: securityPrompt,
    requiredCapabilities: useSubagents ? ["supportsAgentDefinitions"] : [],
    agentDefinitionName: useSubagents ? securityAgentName : undefined,
    fallbackSlashCommand: "/aif-security-checklist",
    fallbackStrategy: useSubagents ? "slash_command" : "none",
    executionMode: useSubagents ? "native_subagents" : "standard",
    sessionReusePolicy: "new_session",
    systemPromptAppend: scopeConstraint,
  });

  try {
    // Heartbeat обновляет отметку активности все время работы сайдкаров: проверка
    // может идти минутами, и без него задача выглядела бы зависшей.
    const heartbeatTimer = startHeartbeat(taskId);

    let reviewResult = "";
    let securityResult = "";
    try {
      if (useSubagents) {
        // Два независимых обзора идут параллельно: они не делят состояние и не
        // влияют на выводы друг друга, а последовательный запуск лишь удвоил бы
        // время стадии.
        [reviewResult, securityResult] = await Promise.all([
          runSidecar(
            reviewPrompt,
            taskId,
            projectRoot,
            reviewAgentName,
            sidecarBudget,
            true,
            reviewWorkflow,
            "/aif-review",
          ),
          runSidecar(
            securityPrompt,
            taskId,
            projectRoot,
            securityAgentName,
            sidecarBudget,
            true,
            securityWorkflow,
            "/aif-security-checklist",
          ),
        ]);
      } else {
        // В режиме навыков запуск последовательный: два параллельных агента в одном
        // рабочем каталоге могли бы состязаться за него.
        reviewResult = await runSidecar(
          reviewPrompt,
          taskId,
          projectRoot,
          reviewAgentName,
          sidecarBudget,
          false,
          reviewWorkflow,
          "/aif-review",
        );
        securityResult = await runSidecar(
          securityPrompt,
          taskId,
          projectRoot,
          securityAgentName,
          sidecarBudget,
          false,
          securityWorkflow,
          "/aif-security-checklist",
        );
      }
    } finally {
      try {
        // Остановка таймера не должна подменить собой исходную ошибку стадии, если
        // сайдкар уже упал: сбой очистки здесь не важен для результата.
        clearInterval(heartbeatTimer);
      } catch {
        /* страховка */
      }
    }

    // Пост-проверка дрейфа: review-сайдкары не должны были переключить HEAD.
    // Проверка после запуска симметрична восстановлению до него: сайдкар мог сам
    // переключить ветку, и тогда дальше анализировался бы уже не тот код.
    if (task.branchName && !task.isFix) {
      assertCurrentBranch(projectRoot, task.branchName);
    }

    log.info({ taskId }, "Review and security sidecars completed");

    // Источники указываются вручную: из текста ответа их не видно, а от них
    // зависят и id находок, и раскладка прошлых находок по сайдкарам.
    const parsedReview = parseStructuredSidecarOutput(
      reviewResult,
      "code_review",
      reviewPreviousFindingState,
    );
    const parsedSecurity = parseStructuredSidecarOutput(
      securityResult,
      "security_audit",
      securityPreviousFindingState,
    );

    // Оба разбора должны быть успешны: смешать структурированный комментарий с
    // сырым текстом нельзя, потому что повторный разбор такого гибрида не пройдет и
    // состояние авторевью потеряет связь со своими комментариями.
    const combinedReview =
      parsedReview && parsedSecurity
        ? buildStructuredReviewComments({
            strategy,
            iteration: reviewIteration,
            codeReview: parsedReview,
            securityAudit: parsedSecurity,
            rawCodeReview: reviewResult,
            rawSecurityAudit: securityResult,
          })
        : `## Code Review\n\n${reviewResult}\n\n## Security Audit\n\n${securityResult}`;

    // Резервный путь сохраняет ответ как есть: пусть формат и неструктурированный, но
    // замечания не теряются, а предупреждение в логе объясняет причину.
    if (!parsedReview || !parsedSecurity) {
      log.warn(
        {
          taskId,
          parsedReview: Boolean(parsedReview),
          parsedSecurity: Boolean(parsedSecurity),
        },
        "Structured review contract not satisfied, falling back to legacy review comment format",
      );
    }

    // Запись одна на оба сайдкара, поэтому секция верификации добавляется здесь -
    // иначе она была бы потеряна при перезаписи комментариев ревью.
    setTaskFields(taskId, {
      reviewComments: preserveVerificationSection(task.reviewComments, combinedReview),
      updatedAt: new Date().toISOString(),
    });

    logActivity(
      taskId,
      "Agent",
      useSubagents
        ? "review stage complete (review-sidecar + security-sidecar)"
        : "review stage complete (aif-review + aif-security-checklist)",
    );
    log.debug({ taskId }, "Review comments saved to task");
  } catch (err) {
    logActivity(taskId, "Agent", `review stage failed — ${(err as Error).message}`);
    throw err;
  }
}
