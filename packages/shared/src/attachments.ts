/**
 * Разбор и форматирование вложений задачи.
 *
 * Вложения лежат в базе одной JSON-строкой, поэтому все потребители обязаны читать их
 * только через parseAttachments: он терпим к повреждённым записям и понимает оба формата -
 * старый (только content) и новый (файл в хранилище плюс path). Ошибка разбора здесь не
 * исключительная ситуация: возвращается пустой список, чтобы одна битая запись не
 * блокировала показ задачи целиком.
 */

export interface ParsedAttachment {
  name: string;
  mimeType: string;
  size: number;
  content: string | null;
  /** Относительный путь в каталоге storage/. Присутствует у файловых вложений. */
  path?: string;
}

/**
 * Разбирает сериализованный в JSON массив вложений из базы.
 *
 * Поддерживаются обе формы записей: старая (только content) и новая (файл в хранилище).
 */
export function parseAttachments(raw: string | null): ParsedAttachment[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    // Пришло не массивом - значит запись сделана другой версией кода или
    // повреждена; отдаём пустой список вместо исключения.
    if (!Array.isArray(parsed)) return [];
    // Элементы фильтруются, а не приводятся к типу: в JSON-колонке мог оказаться
    // любой мусор, и один битый элемент не должен ронять весь список.
    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        // Каждое поле проверяется по типу отдельно: значение по умолчанию лучше,
        // чем undefined, который позже всплывёт в UI или в промпте агента.
        const attachment: ParsedAttachment = {
          name: typeof item.name === "string" ? item.name : "file",
          mimeType: typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream",
          size: typeof item.size === "number" ? item.size : 0,
          content: typeof item.content === "string" ? item.content : null,
        };
        // path выставляется только для непустой строки: наличие пути - это и есть
        // признак того, что вложение вынесено в хранилище (см. isFileBackedAttachment).
        if (typeof item.path === "string" && item.path.length > 0) {
          attachment.path = item.path;
        }
        return attachment;
      });
  } catch {
    // Невалидный JSON - не повод падать: в истории задач есть записи, созданные
    // до появления текущей схемы вложений.
    return [];
  }
}

/**
 * Признак того, что содержимое вложения лежит в файловом хранилище, а не в поле content.
 *
 * Такие вложения нельзя отдавать в промпт целиком: агенту передаётся путь, и он читает
 * файл сам (см. formatAttachmentsForPrompt).
 */
export function isFileBackedAttachment(attachment: ParsedAttachment): boolean {
  return typeof attachment.path === "string" && attachment.path.length > 0;
}

/**
 * Максимальное число символов содержимого вложения, попадающего в промпт агента.
 *
 * Жёсткое ограничение: контекст модели не бесконечен, поэтому длинные вложения усекаются,
 * а не раздувают каждый запуск агента.
 */
const CONTENT_PREVIEW_LIMIT = 4000;

/** Пороговые значения для эвристики looksLikeFullPlanUpdate. */
const PLAN_SHORT_THRESHOLD = 120;
const PLAN_HEADING_THRESHOLD = 400;
const SHORT_PLAN_RETENTION = 0.6;
const LONG_PLAN_RETENTION = 0.5;
const SHORT_PLAN_MIN_LENGTH = 10;
const LONG_PLAN_MIN_LENGTH = 80;

/**
 * Формирует текстовое представление вложений для промпта агента.
 *
 * Для файловых вложений указывается путь относительно корня проекта: агент запускается с
 * cwd=корень проекта и читает файлы напрямую.
 *
 * @param raw - сериализованный в JSON массив вложений из базы
 */
export function formatAttachmentsForPrompt(raw: string | null): string {
  const attachments = parseAttachments(raw);
  if (attachments.length === 0) return "No task attachments were provided.";

  // Нумерация нужна, чтобы модель могла сослаться на вложение по номеру.
  return attachments
    .map((file, index) => {
      let detail: string;
      if (file.content) {
        detail = `\n    content:\n${file.content
          .slice(0, CONTENT_PREVIEW_LIMIT)
          .split("\n")
          .map((line) => `      ${line}`)
          .join("\n")}`;
      } else if (file.path) {
        // Путь относительный: агент запускается с cwd=корень проекта и читает файл
        // сам, поэтому содержимое в промпт не копируется.
        detail = `\n    file: ${file.path}`;
      } else {
        detail = "\n    content: [not provided]";
      }
      return `${index + 1}. ${file.name} (${file.mimeType}, ${file.size} bytes)${detail}`;
    })
    .join("\n");
}

// Заголовки приводятся к нижнему регистру: сравнение планов не должно зависеть от
// регистра, иначе "## План" и "## план" считались бы разными разделами. Принимаются
// заголовки ATX любого уровня: от # до ######.
export function extractHeadings(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, "").toLowerCase());
}

// Эвристика "новый текст - это полный план, а не правка одного фрагмента". Нужна
// потому, что модель иногда присылает только изменённый кусок, и запись его поверх
// плана потеряла бы остальные разделы. Решение принимается по объёму (порог зависит
// от длины прежнего плана) и по пересечению заголовков, а не по точному сравнению
// Markdown: посекционное сравнение здесь оказалось бы слишком хрупким.
export function looksLikeFullPlanUpdate(previousPlan: string, updatedPlan: string): boolean {
  const prev = previousPlan.trim();
  const next = updatedPlan.trim();
  // Прежний план пуст - любое непустое обновление является полным.
  if (!prev) return next.length > 0;
  if (!next) return false;
  // Для коротких планов требуется сохранить большую долю объёма (0.6), для длинных
  // достаточно половины: чем длиннее план, тем сильнее возможное законное сокращение.
  // Нижние границы не дают малым числам превратиться в ложное "это полный план".
  const minLength =
    prev.length < PLAN_SHORT_THRESHOLD
      ? Math.max(SHORT_PLAN_MIN_LENGTH, Math.floor(prev.length * SHORT_PLAN_RETENTION))
      : Math.max(LONG_PLAN_MIN_LENGTH, Math.floor(prev.length * LONG_PLAN_RETENTION));
  if (next.length < minLength) return false;

  // Дополнительная проверка структуры: если у прежнего плана есть заголовки, то
  // обновление считается полным только при совпадении хотя бы одного из них. Планы
  // без заголовков и совсем короткие проверяются только по объёму.
  const prevHeadings = extractHeadings(prev);
  if (prev.length < PLAN_HEADING_THRESHOLD || prevHeadings.length === 0) return true;
  const nextHeadings = new Set(extractHeadings(next));
  return prevHeadings.some((heading) => nextHeadings.has(heading));
}
