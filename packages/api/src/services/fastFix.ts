/**
 * Fast Fix: быстрая правка уже существующего плана по комментарию человека.
 *
 * Почему это отдельный путь, а не обычный этап пайплайна: правка должна занимать
 * секунды и не разворачивать полный цикл (планирование, улучшение, ревью),
 * поэтому здесь один прогон runtime с лёгкой моделью и возвратом текста плана.
 *
 * Инварианты:
 * - Задача, переданная человеку (executionOwner === "human"), не запускает ИИ:
 *   проверка делается дважды - до сборки промпта и перед вызовом runtime,
 *   потому что владелец может смениться в процессе.
 * - Промпт требует именно ПОЛНЫЙ markdown плана, а не патч: результат
 *   перезаписывает файл целиком, и короткий ответ потерял бы план.
 * - Пустой ответ - ошибка, а не "ничего не изменилось": иначе файл плана мог бы
 *   остаться в неопределённом состоянии.
 */

import { findTaskById } from "@aif/data";
import { parseAttachments } from "@aif/shared";
import { UsageSource } from "@aif/runtime";
import { resolveApiLightModel, runApiRuntimeOneShot } from "./runtime.js";

export class AiHandoffRequiredError extends Error {
  // Отдельный класс нужен, чтобы HTTP-слой отдал понятный отказ (нужна передача
  // задачи ИИ), а не общую 500-ку: различать сбои по тексту сообщения нельзя.
  readonly code = "ai_handoff_required" as const;

  constructor(message: string) {
    super(message);
    this.name = "AiHandoffRequiredError";
  }
}

interface FastFixComment {
  author: string;
  message: string;
  attachments: string | null;
  createdAt: string;
}

interface RunFastFixQueryInput {
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  latestComment: FastFixComment;
  projectRoot: string;
  planPath: string;
  previousPlan: string;
  // Прошлая попытка приходит, когда её признали слишком короткой: текст
  // передаётся модели как пример того, что повторять не надо.
  priorAttempt?: string;
  // Флаг решает, разрешено ли модели трогать файлы; когда инструменты
  // недоступны, шаг обновления файла убирается из промпта целиком.
  shouldTryFileUpdate?: boolean;
}

function formatLatestCommentForPrompt(comment: FastFixComment): string {
  // Вложения хранятся строкой JSON, поэтому парсинг терпимый: битое значение
  // просто не даст списка файлов, а не уронит весь запрос.
  const attachments = parseAttachments(comment.attachments);
  const attachmentLines = attachments.length
    ? attachments
        .map((file, index) => {
          let detail: string;
          if (file.content) {
            // Обрезаем inline-контент: вложение может быть большим, а бюджет
            // промпта ограничен - остальное модель прочитает по пути, если нужно.
            detail = `\n     content:\n${file.content
              .slice(0, 4000)
              .split("\n")
              .map((line) => `       ${line}`)
              .join("\n")}`;
          } else if (file.path) {
            detail = `\n     file: ${file.path}`;
          } else {
            // Три состояния различаем явно: inline-контент, ссылка на файл и
            // только метаданные. Иначе модель додумала бы содержимое сама.
            detail = "\n     content: [not provided]";
          }
          return `${index + 1}. ${file.name} (${file.mimeType}, ${file.size} bytes)${detail}`;
        })
        .join("\n")
    : // Явное "none" вместо пустой строки: модель должна видеть, что вложений
      // нет, а не гадать, почему секция осталась пустой.
      "none";

  return [
    `[${comment.createdAt}] ${comment.author}`,
    `message: ${comment.message}`,
    "attachments:",
    attachmentLines,
  ].join("\n");
}

export async function runFastFixQuery(input: RunFastFixQueryInput): Promise<string> {
  const task = findTaskById(input.taskId);
  if (!task) {
    // Отсутствие задачи - гонка удаления или ошибка вызова: пробрасываем наверх,
    // а не маскируем текстом, чтобы это было видно в логах и метриках.
    throw new Error(`Task ${input.taskId} not found for fast fix runtime resolution`);
  }
  // Первая проверка владельца: до тяжёлой сборки промпта нет смысла работать,
  // если задачу уже забрал человек.
  if (task.executionOwner === "human") {
    throw new AiHandoffRequiredError("The task must be handed to AI before fast fix can run");
  }

  // Дефолт true: обычно у runtime есть доступ к файлам, и план обновляется на
  // диске тем же прогоном, что и в ответе модели.
  const includeFileUpdateStep = input.shouldTryFileUpdate ?? true;
  // Два варианта промпта отличаются только блоком PRIOR_ATTEMPT: без него
  // модель приняла бы прошлый короткий ответ за образец для подражания.
  const prompt = input.priorAttempt
    ? `You are editing an existing implementation plan markdown.

TASK TITLE:
${input.taskTitle}

TASK DESCRIPTION:
${input.taskDescription}

CURRENT PLAN (must be preserved, with only necessary edits):
<<<CURRENT_PLAN
${input.previousPlan}
CURRENT_PLAN

PLAN PATH (must be the only plan file you update):
@${input.planPath}

LATEST HUMAN COMMENT TO APPLY:
${formatLatestCommentForPrompt(input.latestComment)}

PRIOR ATTEMPT THAT WAS TOO SHORT (do not use as final output):
<<<PRIOR_ATTEMPT
${input.priorAttempt}
PRIOR_ATTEMPT

Requirements:
1) Return the FULL updated plan markdown, not a summary and not only a patch.
2) Keep existing sections and details unless the comment explicitly asks to change them.
3) Apply only the requested quick fix.
${
  includeFileUpdateStep
    ? `4) Also update the plan file @${input.planPath} in the workspace (if you can access files/tools): overwrite it with the FULL updated plan.\n5) Do not create or modify any other plan file paths.\n6) Output markdown only in your final response.`
    : "4) Do not use tools/subagents. Return the FULL updated plan markdown directly.\n5) Output markdown only in your final response."
}`
    : `You are editing an existing implementation plan markdown.

TASK TITLE:
${input.taskTitle}

TASK DESCRIPTION:
${input.taskDescription}

CURRENT PLAN (must be preserved, with only necessary edits):
<<<CURRENT_PLAN
${input.previousPlan}
CURRENT_PLAN

PLAN PATH (must be the only plan file you update):
@${input.planPath}

LATEST HUMAN COMMENT TO APPLY:
${formatLatestCommentForPrompt(input.latestComment)}

Requirements:
1) Return the FULL updated plan markdown, not a summary and not only a patch.
2) Keep existing sections and details unless the comment explicitly asks to change them.
3) Apply only the requested quick fix.
${
  includeFileUpdateStep
    ? `4) Also update the plan file @${input.planPath} in the workspace (if you can access files/tools): overwrite it with the FULL updated plan.\n5) Do not create or modify any other plan file paths.\n6) Output markdown only in your final response.`
    : "4) Do not use tools/subagents. Return the FULL updated plan markdown directly.\n5) Output markdown only in your final response."
}`;

  // Для быстрой правки берём лёгкую модель: здесь важнее скорость и цена, чем
  // максимальная глубина рассуждений.
  const modelOverride = await resolveApiLightModel(task.projectId, input.taskId);
  // Задачу перечитываем прямо перед вызовом runtime: владелец мог смениться,
  // пока собирался промпт, и тогда ИИ работать уже не должен.
  const executionBoundaryTask = findTaskById(input.taskId);
  if (!executionBoundaryTask || executionBoundaryTask.executionOwner === "human") {
    throw new AiHandoffRequiredError("The task must be handed to AI before fast fix can run");
  }
  const { result } = await runApiRuntimeOneShot({
    projectId: task.projectId,
    projectRoot: input.projectRoot,
    taskId: input.taskId,
    prompt,
    workflowKind: "fast-fix",
    modelOverride,
    systemPromptAppend: includeFileUpdateStep
      ? undefined
      : "Do not use tools or subagents. Reply directly with markdown only.",
    // Расход помечаем как FAST_FIX, чтобы он не смешивался с расходами этапов
    // планирования и ревью в отчётах по токенам.
    usageContext: { source: UsageSource.FAST_FIX },
  });

  // Usage фиксируется автоматически через обёртку реестра runtime и DB sink
  // (см. bootstrap в packages/api/services/runtime.ts). Ручной вызов
  // incrementTaskTokenUsage здесь не требуется.

  const resultText = (result.outputText ?? "").trim();
  // Пустой вывод означает, что модель не выполнила инструкцию; вернуть пустую
  // строку значило бы отдать вызывающему коду невалидный план.
  if (!resultText) {
    throw new Error("Fast fix did not return updated plan text");
  }
  return resultText;
}

// Реэкспорт сохранён для обратной совместимости: вызывающий код исторически
// импортировал withTimeout именно из этого модуля.
export { withTimeout } from "@aif/shared";
