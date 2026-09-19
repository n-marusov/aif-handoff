/**
 * Персистентность вложений: превращает входящие payload'ы с inline-контентом
 * в метаданные, ссылающиеся на файлы проекта.
 *
 * Почему так: вложения приходят внутри JSON-запроса (обычно base64), но хранить
 * байты в БД нельзя - строка такого размера быстро упирается в лимиты SQLite и
 * раздувает бэкапы. Поэтому API перекладывает содержимое на диск, а в базе
 * оставляет только относительный путь. Путь относительный, а не абсолютный,
 * потому что проект может быть перенесён или смонтирован в другом контейнере,
 * где абсолютный префикс уже недействителен.
 *
 * Инварианты:
 * - Функция не падает целиком из-за одного файла: сбой записи деградирует до
 *   записи metadata-only, остальные вложения всё равно сохраняются.
 * - Повторная отправка уже сохранённого вложения (есть path) не перезаписывает
 *   файл: клиент может прислать тот же список без изменений.
 * - Порядок результатов совпадает с порядком входного массива.
 */

/**
 * Конвейер сохранения вложений: превращает входящую полезную нагрузку
 * вложений (с inline-контентом) в metadata поверх файлов (пути относительно корня проекта).
 */

import { logger } from "@aif/shared";
import { saveAttachment, deleteAttachment } from "./attachmentStorage.js";

const log = logger("attachmentPersistence");

export interface IncomingAttachment {
  name: string;
  mimeType: string;
  size: number;
  content: string | null;
  path?: string;
}

interface PersistedAttachment {
  name: string;
  mimeType: string;
  size: number;
  content: string | null;
  path?: string;
}

/**
 * Сохраняет входящие вложения в каталог проекта .ai-factory/files/ и возвращает
 * metadata, готовые для БД.
 *
 * Для каждого вложения:
 * - если уже есть `path` (прислан повторно из прошлого сохранения), оставить как есть;
 * - если есть inline `content`, записать на диск и заменить ссылкой на путь;
 * - если нет ни контента, ни path, сохранить как metadata-only.
 */
export async function persistAttachments(
  attachments: IncomingAttachment[],
  entityContext: {
    projectRoot: string;
    taskId?: string;
    commentId?: string;
    chatSessionId?: string;
  },
): Promise<PersistedAttachment[]> {
  // Пустой список - обычный случай при обновлении задачи без правки вложений,
  // поэтому выходим до логирования, чтобы не засорять журнал.
  if (attachments.length === 0) return [];

  log.info(
    {
      taskId: entityContext.taskId,
      chatSessionId: entityContext.chatSessionId,
      commentId: entityContext.commentId,
      count: attachments.length,
      // Суммарный размер считаем из заявленных размеров, а не из буферов:
      // декодирование здесь было бы лишней работой только ради метрики.
      totalBytes: attachments.reduce((sum, a) => sum + a.size, 0),
    },
    "Persisting attachments to project files",
  );

  // Аккумулируем в отдельный массив, а не фильтруем вход: часть записей
  // меняет имя и размер (санитайз имени файла), поэтому нужен новый объект.
  const persisted: PersistedAttachment[] = [];

  for (const attachment of attachments) {
    // Ветка "уже на диске": контент игнорируем намеренно, даже если он пришёл -
    // иначе повторное сохранение затирало бы файл, на который уже есть ссылки.
    // Уже на диске — оставить как есть
    if (attachment.path) {
      log.debug(
        { name: attachment.name, path: attachment.path },
        "Attachment already file-backed, skipping write",
      );
      persisted.push({
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        content: null,
        path: attachment.path,
      });
      continue;
    }

    // Проверка именно на null, а не на пустую строку: пустая строка - валидный
    // контент и должна превратиться в пустой файл, а не в запись без файла.
    // Нет контента — metadata-only
    if (attachment.content === null) {
      log.debug({ name: attachment.name }, "Metadata-only attachment, no content to persist");
      persisted.push({
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        content: null,
      });
      continue;
    }

    // Есть контент — записать на диск
    // try охватывает и декодирование: decodeContent может бросить на битом
    // base64, и это должно деградировать так же, как ошибка записи.
    try {
      const buffer = decodeContent(attachment.content, attachment.mimeType);
      const result = await saveAttachment({
        projectRoot: entityContext.projectRoot,
        taskId: entityContext.taskId,
        commentId: entityContext.commentId,
        chatSessionId: entityContext.chatSessionId,
        filename: attachment.name,
        content: buffer,
      });

      log.debug(
        { name: attachment.name, relativePath: result.relativePath, size: result.size },
        "Attachment written to project files",
      );

      // Берём санитайзенное имя и фактический размер: имя на диске могло быть
      // изменено (запрещённые символы, коллизии), и БД должна хранить правду.
      persisted.push({
        name: result.sanitizedName,
        mimeType: attachment.mimeType,
        size: result.size,
        content: null,
        path: result.relativePath,
      });
      // Ошибка одного вложения не должна отменять весь запрос: пользователь
      // увидит вложение в списке, просто без файла, и сможет загрузить его снова.
    } catch (err) {
      log.error(
        { name: attachment.name, taskId: entityContext.taskId, err },
        "Failed to persist attachment — storing as metadata-only",
      );
      persisted.push({
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        content: null,
      });
    }
  }

  return persisted;
}

/**
 * Удаляет файлы хранилища для вложений, которые заменяются.
 * Вызывать перед сохранением нового набора при обновлении.
 */
export function cleanupReplacedAttachments(
  projectRoot: string,
  oldAttachments: PersistedAttachment[],
  newAttachments: IncomingAttachment[],
): void {
  // Сначала фиксируем пути, которые остаются в новой версии: файл, вновь
  // присланный тем же путём, удалять нельзя - он уже часть нового состояния.
  const newPaths = new Set(newAttachments.filter((a) => a.path).map((a) => a.path!));

  // Сравниваем по точному пути, а не по имени: два вложения с одинаковым
  // именем в разных каталогах - это разные файлы.
  for (const old of oldAttachments) {
    if (old.path && !newPaths.has(old.path)) {
      log.debug({ path: old.path }, "Cleaning up replaced attachment");
      deleteAttachment(projectRoot, old.path);
    }
  }
}

/**
 * Декодирует строку контента в буфер.
 * Понимает base64 data URI и обычный текст.
 */
function decodeContent(content: string, mimeType: string): Buffer {
  // Формат определяем по префиксу, а не по MIME-типу: клиенты присылают
  // и data URI, и сырой base64 для одного и того же типа файла.
  // data URI: "data:<mime>;base64,<data>"
  // Флаг s нужен потому, что base64 при переносе строк может содержать \n.
  const dataUriMatch = content.match(/^data:[^;]+;base64,(.+)$/s);
  if (dataUriMatch) {
    return Buffer.from(dataUriMatch[1], "base64");
  }

  // Бинарные типы почти всегда приходят сырым base64 без обёртки data URI.
  // Список явный: неизвестный MIME безопаснее прочитать как текст, чем
  // случайно записать на диск мусор из неверно угаданного base64.
  // Голый base64 для бинарных MIME-типов
  if (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("audio/") ||
    mimeType.startsWith("video/") ||
    mimeType === "application/pdf" ||
    mimeType === "application/octet-stream"
  ) {
    try {
      const buf = Buffer.from(content, "base64");
      // Buffer.from молча игнорирует недопустимые символы, поэтому одного
      // отсутствия исключения мало: сверяем round-trip с учётом переносов.
      // Проверка корректности: если перекодирование совпало, base64 был валидным
      if (buf.toString("base64") === content.replace(/\s/g, "")) {
        return buf;
      }
    } catch {
      // Единственный ожидаемый сбой - битый base64; он не ошибка для вызывающего
      // кода, поэтому просто идём в текстовую ветку ниже.
      // Проваливаемся в текстовую ветку
    }
  }

  // Фолбэк для text/* и всего неопознанного: трактуем строку как UTF-8,
  // это самый безопасный вариант - данные не теряются.
  // Текстовый контент
  return Buffer.from(content, "utf-8");
}
