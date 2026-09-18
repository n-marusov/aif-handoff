/**
 * Хранилище вложений на файловой системе: раскладка каталогов, санитайз имён,
 * проверка пути и очистка.
 *
 * Почему файл устроен именно так:
 *  - в БД попадает только путь ОТНОСИТЕЛЬНО корня проекта: абсолютный путь сломался бы
 *    при переносе проекта, а относительный одинаков для API и для агента, который
 *    читает файл с диска;
 *  - имя санитайзится ДО склейки с каталогом, а итоговый путь затем проверяется на
 *    выход за FILES_DIR: одна полная защита от обхода каталогов вместо двух половин;
 *  - каталоги детерминированы от id (task/comment/chat), поэтому файлы не нужно
 *    разыскивать по БД для удаления: снос задачи - это снос одного поддерева;
 *  - ошибочный ввод (нет ни taskId, ни chatSessionId) бросает исключение, а не
 *    возвращает null: вызывающий обязан узнать, что вложение не сохранено.
 */
import { existsSync, mkdirSync, unlinkSync, readdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, normalize, basename, extname, resolve } from "node:path";
import { logger } from "@aif/shared";

const log = logger("attachmentStorage");

/** Базовый каталог для файлов вложений внутри корня проекта */
const FILES_DIR = ".ai-factory/files";

/** Максимальная длина имени файла после очистки */
const MAX_FILENAME_LENGTH = 200;

/**
 * Очищает имя файла: убирает разделители пути, схлопывает пробелы,
 * заменяет опасные символы и обрезает по длине.
 */
export function sanitizeFilename(raw: string): string {
  let name = basename(raw);
  // Удаляем нулевые байты и управляющие символы
  name = name.replace(/[\x00-\x1f]/g, "");
  // Заменяем разделители пути и прочие опасные символы
  name = name.replace(/[/\\:*?"<>|]/g, "_");
  // Схлопываем пробелы
  name = name.replace(/\s+/g, " ").trim();
  // Гарантируем непустое значение
  // Проверка на "." и ".." нужна после basename: для входа ".." basename вернёт "..",
  // и без подмены склейка с каталогом вывела бы путь на уровень выше.
  if (!name || name === "." || name === "..") {
    name = "unnamed";
  }
  // Обрезаем, сохраняя расширение
  // Хвост обрезается по стему, а расширение сохраняется: len по длине расширения
  // не даёт отрезать его целиком и потерять тип файла.
  if (name.length > MAX_FILENAME_LENGTH) {
    const ext = extname(name);
    const stem = name.slice(0, MAX_FILENAME_LENGTH - ext.length);
    name = stem + ext;
  }
  return name;
}

/**
 * Строит детерминированный путь каталога для вложений задачи.
 */
function taskAttachmentDir(projectRoot: string, taskId: string): string {
  // Каталог комментариев лежит ВНУТРИ каталога задачи, поэтому очистка задачи
  // рекурсивно забирает и вложения комментариев - отдельного обхода не нужно.
  return join(projectRoot, FILES_DIR, "tasks", taskId);
}

/**
 * Строит детерминированный путь каталога для вложений комментария.
 */
function commentAttachmentDir(projectRoot: string, taskId: string, commentId: string): string {
  return join(projectRoot, FILES_DIR, "tasks", taskId, "comments", commentId);
}

/**
 * Строит детерминированный путь каталога для вложений сессии чата.
 */
function chatAttachmentDir(projectRoot: string, chatSessionId: string): string {
  return join(projectRoot, FILES_DIR, "chat", chatSessionId);
}

/**
 * Проверяет, что разрешённый путь остаётся в пределах ожидаемого базового
 * каталога. Защита от атак path traversal.
 */
function assertWithinBase(resolvedPath: string, baseDir: string): void {
  // normalize обеих сторон обязателен: без него "a/b/../.." и разные разделители
  // дали бы ложное срабатывание или, наоборот, пропустили выход за базу.
  const normalizedResolved = normalize(resolvedPath);
  const normalizedBase = normalize(baseDir);
  if (!normalizedResolved.startsWith(normalizedBase)) {
    log.error(
      { resolvedPath: normalizedResolved, baseDir: normalizedBase },
      "Path traversal attempt blocked",
    );
    throw new Error("Path traversal detected");
  }
}

/**
 * Превращает относительный путь вложения из БД в абсолютный путь в файловой системе.
 *
 * @param projectRoot - абсолютный путь к корневому каталогу проекта
 * @param relativePath - напр. ".ai-factory/files/tasks/<tid>/file.png"
 * @returns абсолютный путь на диске
 */
export function resolveAttachmentPath(projectRoot: string, relativePath: string): string {
  // Проверка выполняется и на чтении, а не только на записи: строка пути приходит
  // из БД и могла быть записана старой версией кода или подменена вручную.
  const resolved = resolve(projectRoot, relativePath);
  assertWithinBase(resolved, join(projectRoot, FILES_DIR));
  log.debug({ relativePath, resolved }, "Resolved attachment path");
  return resolved;
}

/**
 * Идентификаторы взаимоисключающие: chatSessionId для вложений чата, taskId для
 * вложений задачи, а вместе с commentId - для вложения конкретного комментария.
 * Одно поле вместо discriminated union выбрано ради совместимости с HTTP-слоем.
 */
export interface SaveAttachmentInput {
  projectRoot: string;
  taskId?: string;
  commentId?: string;
  chatSessionId?: string;
  filename: string;
  content: Buffer;
}

export interface SaveAttachmentResult {
  /** Относительный путь от корня проекта (хранится в БД) */
  relativePath: string;
  /** Очищенное имя файла */
  sanitizedName: string;
  /** Число записанных байтов */
  size: number;
}

/**
 * Сохраняет файл вложения на диск в каталог проекта .ai-factory/files/.
 * Создаёт каталоги по необходимости. Возвращает относительный путь для хранения в БД.
 */
export async function saveAttachment(input: SaveAttachmentInput): Promise<SaveAttachmentResult> {
  // Санитайз идёт первым: от него зависит и имя файла, и пригодность итогового
  // пути, поэтому он не может быть отложен до момента записи.
  const sanitizedName = sanitizeFilename(input.filename);
  let dir: string;
  // Порядок ветвлений задаёт приоритет: одно вложение может быть одновременно
  // привязано к чату и задаче, и без фиксированного порядка каталог зависел бы
  // от порядка проверок в вызывающем коде.
  if (input.chatSessionId) {
    dir = chatAttachmentDir(input.projectRoot, input.chatSessionId);
  } else if (input.commentId && input.taskId) {
    dir = commentAttachmentDir(input.projectRoot, input.taskId, input.commentId);
  } else if (input.taskId) {
    dir = taskAttachmentDir(input.projectRoot, input.taskId);
  } else {
    throw new Error("Either taskId or chatSessionId is required");
  }

  // Проверка повторяется на уже склеенном пути: sanitizeFilename убирает разделители,
  // но только здесь гарантируется, что результат всё ещё внутри FILES_DIR.
  const absolutePath = join(dir, sanitizedName);
  assertWithinBase(absolutePath, join(input.projectRoot, FILES_DIR));

  log.debug(
    {
      projectRoot: input.projectRoot,
      taskId: input.taskId,
      commentId: input.commentId,
      filename: sanitizedName,
      dir,
    },
    "Planning attachment save path and directory creation",
  );

  // recursive:true покрывает и случай существующего каталога: отдельная ветка
  // с existsSync была бы гонкой между проверкой и созданием.
  mkdirSync(dir, { recursive: true });
  await writeFile(absolutePath, input.content);

  // Путь хранится в относительном виде, потому что абсолютный привязан к машине,
  // где был записан, и не работает в докере или worktree с другим корнем.
  // Путь относительный от корня проекта, чтобы агенты читали его напрямую
  const relativePath = absolutePath.slice(input.projectRoot.length + 1);

  log.info(
    {
      taskId: input.taskId,
      commentId: input.commentId,
      filename: sanitizedName,
      size: input.content.length,
      relativePath,
    },
    "Attachment saved to project files",
  );

  return {
    relativePath,
    sanitizedName,
    size: input.content.length,
  };
}

/**
 * Читает файл вложения с диска.
 *
 * @param projectRoot - абсолютный путь к корневому каталогу проекта
 * @param relativePath - относительный путь в том виде, как сохранён в БД
 * @returns буфер файла
 */
export async function readAttachment(projectRoot: string, relativePath: string): Promise<Buffer> {
  // Путь не логируется целиком на уровне info: имена вложений могут содержать
  // пользовательские данные, для диагностики достаточно debug-строки выше.
  const absolutePath = resolveAttachmentPath(projectRoot, relativePath);
  log.debug({ relativePath }, "Reading attachment from project files");
  return readFile(absolutePath);
}

/**
 * Удаляет один файл вложения с диска.
 *
 * @param projectRoot - абсолютный путь к корневому каталогу проекта
 * @param relativePath - относительный путь в том виде, как сохранён в БД
 * @returns true, если удалён; false, если файла не было
 */
export function deleteAttachment(projectRoot: string, relativePath: string): boolean {
  const absolutePath = resolveAttachmentPath(projectRoot, relativePath);
  try {
    // Файл может быть уже удалён параллельной очисткой задачи - поэтому unlink
    // заключён в try и разбирается по коду ошибки, а не падает наружу.
    unlinkSync(absolutePath);
    log.info({ relativePath }, "Attachment deleted from project files");
    return true;
  } catch (err: unknown) {
    // ENOENT - не сбой, а нормальный исход: БД и диск разъезжаются, когда файл
    // удалили раньше строки, и повторное удаление не должно шуметь ошибкой.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log.warn({ relativePath }, "Attachment file not found during delete (already removed)");
      return false;
    }
    log.error({ relativePath, err }, "Failed to delete attachment file");
    throw err;
  }
}

/**
 * Удаляет все файлы вложений задачи (включая вложения комментариев).
 * Сносит весь каталог задачи под .ai-factory/files/.
 *
 * @returns число удалённых файлов или -1, если каталога не было
 */
export function cleanupTaskAttachmentFiles(projectRoot: string, taskId: string): number {
  const dir = taskAttachmentDir(projectRoot, taskId);
  if (!existsSync(dir)) {
    log.warn({ taskId, dir }, "Task attachment directory not found during cleanup");
    return -1;
  }

  let count = 0;
  // Подсчёт файлов идёт ДО rmSync: после удаления каталога считать уже нечего,
  // а число удалённых файлов возвращается вызывающему для отчётности.
  try {
    count = countFiles(dir);
    // force:true гасит гонку с параллельным удалением: если каталог исчез между
    // подсчётом и удалением, очистка всё равно считается успешной.
    rmSync(dir, { recursive: true, force: true });
    log.info({ taskId, filesRemoved: count }, "Task attachment directory cleaned up");
  } catch (err) {
    log.error({ taskId, err }, "Failed to clean up task attachment directory");
    throw err;
  }
  return count;
}

/**
 * Рекурсивно считает файлы в каталоге.
 */
function countFiles(dir: string): number {
  // withFileTypes даёт тип из записи каталога без отдельного stat на каждую запись,
  // что заметно на задачах с большим числом вложений.
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countFiles(join(dir, entry.name));
    } else {
      count++;
    }
  }
  return count;
}

/**
 * Проверяет, существует ли файл вложения на диске.
 */
export function attachmentFileExists(projectRoot: string, relativePath: string): boolean {
  // Через resolveAttachmentPath, а не через прямой join: проверка на выход за базу
  // обязана проходить до любого обращения к файловой системе.
  const absolutePath = resolveAttachmentPath(projectRoot, relativePath);
  return existsSync(absolutePath);
}
