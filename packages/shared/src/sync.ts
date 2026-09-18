// Типы и утилиты синхронизации задач между aif и handoff, включая разметку плана
// ссылками на задачи.
//
// Аннотация плана - это HTML-комментарий `<!-- handoff:task:<uuid> -->`: он невидим
// при рендере Markdown, но связывает раздел плана с задачей и переживает правки
// текста человеком (в отличие от обычной строки, которую легко удалить).

import { logger } from "./logger.js";

const log = logger("sync");

// ── Типы синхронизации ──────────────────────────────────────

// Направление важно для разрешения конфликтов: сторона-источник обычно и побеждает
// при расхождении меток времени.
export type SyncDirection = "aif_to_handoff" | "handoff_to_aif";

export interface ConflictResolution {
  applied: boolean;
  conflict: boolean;
  winner: "source" | "target" | null;
  sourceTimestamp: string;
  targetTimestamp: string;
  field: string;
}

export interface SyncEvent {
  type: "sync:task_created" | "sync:task_updated" | "sync:status_changed" | "sync:plan_pushed";
  taskId: string;
  direction: SyncDirection;
  timestamp: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
  conflictResolution?: ConflictResolution;
}

// ── Типы аннотаций плана ───────────────────────────────────

export interface PlanAnnotation {
  taskId: string;
  line: number;
}

// ── Утилиты аннотаций плана ───────────────────────────────

/** Шаблон для поиска аннотаций плана: <!-- handoff:task:<uuid> --> */
const ANNOTATION_REGEX =
  /<!--\s*handoff:task:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*-->/gi;

/**
 * Разбирает все аннотации задач handoff из markdown плана.
 * Возвращает массив { taskId, line }, отсортированный по номеру строки.
 */
export function parsePlanAnnotations(markdown: string): PlanAnnotation[] {
  const annotations: PlanAnnotation[] = [];
  const lines = markdown.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;
    // Сбрасываем lastIndex регулярного выражения для каждой строки.
    // Регулярка с флагом g хранит позицию в lastIndex, поэтому пересоздаётся на каждой
    // строке: переиспользование одного экземпляра давало бы пропуски совпадений.
    const regex = new RegExp(ANNOTATION_REGEX.source, "gi");
    while ((match = regex.exec(line)) !== null) {
      annotations.push({ taskId: match[1], line: i + 1 });
    }
  }

  log.debug({ count: annotations.length }, "Parsed plan annotations");
  return annotations;
}

/**
 * Вставляет аннотацию задачи handoff в markdown плана.
 * Если задан sectionHeading, вставка идёт после первого совпавшего заголовка.
 * Если заголовок не задан или не найден, вставка идёт в начало документа.
 * Если аннотация для taskId уже есть, её позиция обновляется.
 */
export function insertPlanAnnotation(
  markdown: string,
  taskId: string,
  sectionHeading?: string,
): string {
  const annotation = `<!-- handoff:task:${taskId} -->`;

  // Удаляем прежнюю аннотацию для этого taskId, если она уже есть.
  // Прежняя аннотация удаляется вместе с переводом строки, чтобы вставка новой не
  // оставляла пустую строку на месте старой позиции.
  const existingRegex = new RegExp(
    `<!--\\s*handoff:task:${taskId.replace(/-/g, "\\-")}\\s*-->\\n?`,
    "gi",
  );
  const hasExisting = existingRegex.test(markdown);
  let cleaned = markdown.replace(existingRegex, "");

  if (hasExisting) {
    log.warn({ taskId }, "Duplicate annotation found and resolved");
  }

  const lines = cleaned.split("\n");

  // Заголовок ищется по точному совпадению текста (без учёта отступов), а не по
  // вхождению подстроки: иначе "План" нашёлся бы внутри "План работ по релизу".
  if (sectionHeading) {
    // Ищем строку заголовка.
    const headingIndex = lines.findIndex((line) => {
      const trimmed = line.trim();
      // Сопоставляем заголовки markdown: # ..., ## ... и т.д.
      const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
      return headingMatch && headingMatch[1].trim() === sectionHeading.trim();
    });

    if (headingIndex !== -1) {
      lines.splice(headingIndex + 1, 0, annotation);
      log.debug(
        { taskId, line: headingIndex + 2, sectionHeading },
        "Inserted annotation after heading",
      );
    } else {
      // Заголовок не найден — вставляем в начало документа.
      // Молчаливый откат к началу документа вместо ошибки: план мог быть отредактирован
      // человеком, и потеря аннотации хуже, чем неточное место её вставки.
      lines.unshift(annotation);
      log.debug({ taskId, line: 1 }, "Section heading not found, inserted annotation at top");
    }
  } else {
    // Заголовок не задан — вставляем в начало документа.
    lines.unshift(annotation);
    log.debug({ taskId, line: 1 }, "Inserted annotation at top");
  }

  return lines.join("\n");
}
