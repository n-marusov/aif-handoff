/**
 * Гейт авторевью: предварительная проверка задачи лёгкой моделью до того, как её
 * увидит человек.
 *
 * Зачем отдельный модуль и почему он устроен именно так:
 * - Разбор идёт двумя путями. Основной - структурированный: ответ сайдкара
 *   разбирается парсером контракта, и только он умеет доказывать, что прошлая
 *   блокирующая находка действительно закрыта. Запасной путь - legacy-извлечение
 *   пунктов из свободного текста ревью, когда структурного комментария нет
 *   (например, после перезапуска процесса).
 * - Решение - чистая функция от входа и разбора. Запрос к модели и расстановка
 *   статусов разделены, поэтому ветвление логики проверяется тестами без вызовов
 *   рантайма.
 * - Идентификатор находки детерминирован и выводится из текста, поэтому "новая
 *   находка" здесь означает "текст, которого не было в прошлых находках", а
 *   переформулировка той же проблемы формально выглядит как новая.
 * - Сбой и "нечего исправлять" - разные вещи. Пустой ответ модели и сломанный
 *   формат не считаются успехом: неполный вердикт опаснее отказа, потому что
 *   выглядит как пройденное ревью.
 * - Стратегия closure_first добавляет эскалацию: если прошлые блокеры закрыты, но
 *   появились новые, цикл авторевью не продолжается, а задача уходит человеку.
 */

import { createRuntimeWorkflowSpec } from "@aif/runtime";
import type { AutoReviewFinding, AutoReviewStrategy } from "@aif/shared";
import {
  createAutoReviewFindingId,
  parseStructuredReviewComments,
  toAutoReviewState,
  type ParsedStructuredReviewComments,
} from "./reviewContract.js";
import { executeSubagentQuery } from "./subagentQuery.js";

// Режим разбора попадает в метрики, чтобы деградация до резервного разбора была
// видна в наблюдаемости: молчаливый переход на устаревший путь не должен выглядеть
// как нормальное поведение.
export type ReviewGateParserMode = "structured" | "fallback";

// Причина передаётся строкой-перечислением, а не флагом: она уходит дальше в
// статус задачи, и по ней разбираются, почему авторевью сдалось человеку.
export type ReviewGateManualHandoffReason =
  | "new_blockers_after_rework"
  | "malformed_review_output_fallback";

// Счётчики намеренно избыточны: previous и still приходят из разных источников
// (вход и разбор ответа), и их расхождение - первый признак того, что модель
// потеряла находку, а не закрыла её.
export interface ReviewGateMetrics {
  strategy: AutoReviewStrategy;
  iteration: number;
  previousBlockingCount: number;
  stillBlockingCount: number;
  newBlockingCount: number;
  totalBlockingCount: number;
  parserMode: ReviewGateParserMode;
}

// Общая часть всех исходов: любая ветка обязана вернуть метрики, блокирующие
// находки и markdown-список правок, чтобы вызывающий код не разбирал случаи.
type ReviewGateBaseResult = {
  metrics: ReviewGateMetrics;
  blockingFindings: AutoReviewFinding[];
  fixesMarkdown: string;
};

// Дискриминированный union по status: переходы стадии выбираются по нему, а
// autoReviewState равен null только у успеха - сохранять нечего, прошлые находки
// закрыты.
export type ReviewGateResult =
  | (ReviewGateBaseResult & {
      status: "success";
      autoReviewState: null;
    })
  | (ReviewGateBaseResult & {
      status: "request_changes";
      autoReviewState: ReturnType<typeof toAutoReviewState>;
    })
  | (ReviewGateBaseResult & {
      status: "manual_review_required";
      autoReviewState: ReturnType<typeof toAutoReviewState>;
      handoffReason: ReviewGateManualHandoffReason;
    });

// Предыдущие находки приходят массивом, а не undefined: пустой массив значит
// "первый проход", и такая форма не даёт вызывающему коду забыть контекст.
export interface ReviewGateInput {
  taskId: string;
  projectRoot: string;
  reviewComments: string | null;
  strategy: AutoReviewStrategy;
  iteration: number;
  previousFindings: AutoReviewFinding[];
}

// Литерал - часть контракта с моделью: он же встречается в тексте промпта ниже.
// Менять его нужно вместе с промптом и разбором, иначе успех перестанет
// распознаваться.
const SUCCESS_TOKEN = "SUCCESS";

// Пустой список печатается как "- none", а не пустой строкой: результат попадает
// в комментарий задачи, и пустое место читалось бы как потеря данных.
function formatFixesMarkdown(findings: AutoReviewFinding[]): string {
  if (findings.length === 0) {
    return "- none";
  }

  return findings
    .map((finding) => `- [${finding.id}] ${finding.source} | ${finding.text}`)
    .join("\n");
}

// Слияние по id: Map перезаписывает значение при повторе, но сохраняет позицию
// первого вхождения, поэтому порядок прошлых находок стабилен, а текст берётся из
// более свежей группы.
function mergeFindings(...groups: AutoReviewFinding[][]): AutoReviewFinding[] {
  const map = new Map<string, AutoReviewFinding>();
  for (const group of groups) {
    for (const finding of group) {
      map.set(finding.id, finding);
    }
  }
  return [...map.values()];
}

// Запасной путь для комментариев, которые не являются структурированным отчётом.
// Промпт жёстко фиксирует два допустимых ответа - слово SUCCESS или только
// markdown-пункты, - потому что разбор ниже не пытается спасти частично
// правильный вывод.
async function runLegacyFallbackExtraction(
  input: Pick<ReviewGateInput, "taskId" | "projectRoot" | "reviewComments">,
): Promise<AutoReviewFinding[]> {
  const normalizedComments = (input.reviewComments ?? "").trim();
  const prompt = `Read the review comments and extract only the points that must be fixed.

Review comments:
${normalizedComments.length > 0 ? normalizedComments : "No review comments provided."}

Rules:
1) If there are no issues that require fixes, return exactly one word: SUCCESS
2) If there are issues, return ONLY markdown bullet points in this exact format: "- <required fix>"
3) Output must be either:
   - exactly "SUCCESS"
   - or one or more lines, each starting with "- "
4) Do not include numbering, headings, prose, code fences, or any extra text`;

  // Спецификация намеренно одноразовая: sessionReusePolicy "never" гарантирует,
  // что вердикт не зависит от истории чата, а fallbackStrategy "none" запрещает
  // молчаливую подмену рантайма - при недоступности модели гейт должен упасть,
  // а не выдать вердикт другим способом.
  const workflowSpec = createRuntimeWorkflowSpec({
    workflowKind: "review-gate",
    prompt,
    requiredCapabilities: [],
    fallbackStrategy: "none",
    sessionReusePolicy: "never",
    systemPromptAppend: "Do not use tools or subagents. Reply directly in plain text.",
  });

  // Модели явно запрещено трогать репозиторий: гейт только читает уже собранные
  // комментарии, и запуск инструментов здесь дал бы побочные эффекты в рабочем
  // дереве.
  const { resultText } = await executeSubagentQuery({
    taskId: input.taskId,
    projectRoot: input.projectRoot,
    agentName: "review-gate",
    prompt,
    workflowSpec,
    workflowKind: "review-gate",
    systemPromptAppend: "Do not use tools or subagents. Reply directly in plain text.",
  });

  const normalizedResultText = resultText.trim();
  // Пустой ответ - сбой, а не "замечаний нет": принять его за успех значило бы
  // пропустить задачу дальше без проверки.
  if (!normalizedResultText) {
    throw new Error("Review auto-check returned empty response");
  }

  // Регистр игнорируется: строчный вариант токена однозначен. Любая другая
  // обёртка ответа успехом уже не считается и уйдёт в разбор пунктов.
  if (normalizedResultText.toUpperCase() === SUCCESS_TOKEN) {
    return [];
  }

  const trimmedLines = normalizedResultText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Частично правильный ответ считается мусором целиком: принять из него только
  // строки-пункты значило бы показать неполный список обязательных правок, а
  // неполный список выглядит как пройденное ревью.
  const bulletLines = trimmedLines.filter((line) => line.startsWith("- "));
  const hasOnlyBulletLines = bulletLines.length > 0 && bulletLines.length === trimmedLines.length;
  if (!hasOnlyBulletLines) {
    return [];
  }

  // Текст пункта идёт в id через хеш, поэтому один и тот же пункт в следующей
  // итерации получит тот же идентификатор и будет опознан как прошлая находка.
  return bulletLines.map((line) => {
    const text = line.slice(2).trim();
    return {
      id: createAutoReviewFindingId("review_gate", text),
      source: "review_gate" as const,
      text,
    };
  });
}

// Метрики собираются в одном месте, потому что оба решающих пути считают счётчики
// по-разному, но обязаны отдавать одинаковую форму - иначе наблюдаемость зависела
// бы от режима разбора.
function buildMetrics(input: {
  strategy: AutoReviewStrategy;
  iteration: number;
  previousBlockingCount: number;
  stillBlockingCount: number;
  newBlockingCount: number;
  totalBlockingCount: number;
  parserMode: ReviewGateParserMode;
}): ReviewGateMetrics {
  return {
    strategy: input.strategy,
    iteration: input.iteration,
    previousBlockingCount: input.previousBlockingCount,
    stillBlockingCount: input.stillBlockingCount,
    newBlockingCount: input.newBlockingCount,
    totalBlockingCount: input.totalBlockingCount,
    parserMode: input.parserMode,
  };
}

// Основной путь решения. Идентификаторы находок детерминированы и выводятся из
// текста, поэтому множества ниже сравнивают именно формулировки: пересечение -
// это всё ещё открытый блокер, разница - новые блокеры.
function buildStructuredDecision(
  input: ReviewGateInput,
  parsed: ParsedStructuredReviewComments,
): ReviewGateResult {
  // Сравнение идёт по id, а не по тексту напрямую: id уже нормализует регистр и
  // пробелы, так что косметическая правка формулировки не создаёт "новый" блокер.
  const previousIds = new Set(input.previousFindings.map((finding) => finding.id));
  const stillBlockingIds = new Set(
    parsed.previousFindings
      .filter((finding) => finding.status === "still_blocking")
      .map((finding) => finding.id),
  );
  // Новой считается находка, которой не было в прошлых: так как id выводится из
  // текста, переформулированная проблема формально пройдёт как новая - это
  // известное ограничение, заложенное в контракт идентификатора.
  const newBlockingFindings = parsed.blockingFindings.filter(
    (finding) => !previousIds.has(finding.id),
  );
  const metrics = buildMetrics({
    strategy: input.strategy,
    iteration: input.iteration,
    previousBlockingCount: input.previousFindings.length,
    stillBlockingCount: stillBlockingIds.size,
    newBlockingCount: newBlockingFindings.length,
    totalBlockingCount: parsed.blockingFindings.length,
    parserMode: "structured",
  });

  // Пустой список блокеров - единственный признак успеха: разбор структурного
  // вывода строгий, поэтому сюда нельзя попасть с неполными данными.
  if (parsed.blockingFindings.length === 0) {
    return {
      status: "success",
      metrics,
      blockingFindings: [],
      fixesMarkdown: "- none",
      autoReviewState: null,
    };
  }

  const autoReviewState = toAutoReviewState({
    strategy: input.strategy,
    iteration: input.iteration,
    findings: parsed.blockingFindings,
  });

  // Эскалация для closure_first: прошлые блокеры закрыты (stillBlockingIds пуст),
  // но появились новые. Продолжать цикл авторевью в этом случае нельзя -
  // переработка породила другую проблему, и решение о ней должен принять человек.
  if (
    input.strategy === "closure_first" &&
    input.previousFindings.length > 0 &&
    stillBlockingIds.size === 0 &&
    newBlockingFindings.length > 0
  ) {
    return {
      status: "manual_review_required",
      handoffReason: "new_blockers_after_rework",
      metrics,
      blockingFindings: parsed.blockingFindings,
      fixesMarkdown: formatFixesMarkdown(parsed.blockingFindings),
      autoReviewState,
    };
  }

  return {
    status: "request_changes",
    metrics,
    blockingFindings: parsed.blockingFindings,
    fixesMarkdown: formatFixesMarkdown(parsed.blockingFindings),
    autoReviewState,
  };
}

// Решение на запасном пути строится осторожнее структурного: структурный вывод -
// единственный, кто может доказать закрытие прошлого блокера, поэтому результат
// legacy-извлечения никогда не закрывает прошлые находки сам по себе.
function buildFallbackDecision(
  input: ReviewGateInput,
  fallbackFindings: AutoReviewFinding[],
): ReviewGateResult {
  // Структурированный вывод — единственный путь, способный доказать, что прошлый
  // блокер действительно закрыт. Если после прежних итераций мы скатились в
  // резервный разбор, сохраняем все прошлые блокеры и эскалируем к ручному ревью,
  // вместо догадок, что кривой вывод означает сходимость цикла.
  const mergedFindings =
    input.previousFindings.length > 0
      ? mergeFindings(input.previousFindings, fallbackFindings)
      : fallbackFindings;
  const metrics = buildMetrics({
    strategy: input.strategy,
    iteration: input.iteration,
    // При резервном разборе все прошлые блокеры считаются всё ещё открытыми: доказать их
    // закрытие этот путь не умеет, поэтому счётчик равен их числу.
    previousBlockingCount: input.previousFindings.length,
    stillBlockingCount: input.previousFindings.length > 0 ? input.previousFindings.length : 0,
    newBlockingCount: fallbackFindings.length,
    totalBlockingCount: mergedFindings.length,
    parserMode: "fallback",
  });

  // Раз прошлые блокеры есть, а структурного доказательства их закрытия нет,
  // единственный безопасный исход - ручное ревью: молчаливое "сошлось" здесь
  // могло бы пропустить незакрытую проблему.
  if (input.previousFindings.length > 0) {
    return {
      status: "manual_review_required",
      handoffReason: "malformed_review_output_fallback",
      metrics,
      blockingFindings: mergedFindings,
      fixesMarkdown: formatFixesMarkdown(mergedFindings),
      autoReviewState: toAutoReviewState({
        strategy: input.strategy,
        iteration: input.iteration,
        findings: mergedFindings,
      }),
    };
  }

  if (fallbackFindings.length === 0) {
    return {
      status: "success",
      metrics,
      blockingFindings: [],
      fixesMarkdown: "- none",
      autoReviewState: null,
    };
  }

  return {
    status: "request_changes",
    metrics,
    blockingFindings: fallbackFindings,
    fixesMarkdown: formatFixesMarkdown(fallbackFindings),
    autoReviewState: toAutoReviewState({
      strategy: input.strategy,
      iteration: input.iteration,
      findings: fallbackFindings,
    }),
  };
}

// Точка входа гейта. Сначала пробуется строгий структурный разбор уже
// сохранённого комментария: он не требует вызова модели и восстанавливает
// состояние после перезапуска. Только если структуры нет, делается запрос к
// лёгкой модели и включается запасной путь.
export async function evaluateReviewCommentsForAutoMode(
  input: ReviewGateInput,
): Promise<ReviewGateResult> {
  const parsedStructuredComments = parseStructuredReviewComments(input.reviewComments);
  if (parsedStructuredComments) {
    return buildStructuredDecision(input, parsedStructuredComments);
  }

  const fallbackFindings = await runLegacyFallbackExtraction(input);
  return buildFallbackDecision(input, fallbackFindings);
}
