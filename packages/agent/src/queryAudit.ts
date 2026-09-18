/**
 * Аудит запросов к рантайму: журнал для разбора инцидентов, без влияния на работу.
 *
 * Назначение: сохранить промпт, опции и контекст выполнения каждого запроса, чтобы
 * потом можно было восстановить, что именно ушло провайдеру.
 *
 * Почему так:
 * - Запись best-effort. Аудит не является частью результата задачи, поэтому любая
 *   ошибка ввода-вывода глушится: уронить агента из-за аудита было бы хуже, чем
 *   потерять строку журнала.
 * - Значения санитизируются перед записью: редактирование секретов и обрезка
 *   глубины, элементов массива и ключей объекта. Промпты и опции приходят из
 *   внешних источников и могут содержать токены или огромные структуры.
 * - Файл ротируется по размеру с ограниченным числом архивов, чтобы каталог logs/
 *   не рос неограниченно.
 * - Имя файла выводится из имени агента с заменой небезопасных символов: значение
 *   приходит извне и не должно уводить запись за пределы каталога.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { getEnv, redactProviderText } from "@aif/shared";

interface QueryAuditRecord {
  timestamp: string;
  taskId: string;
  agentName: string;
  projectRoot: string;
  prompt: string;
  options: Record<string, unknown>;
}

// Пределы санитизации. Глубина, число элементов и ключей ограничены, чтобы одна
// запись не раздула журнал и не замедлила синхронную запись.
const MAX_AUDIT_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_AUDIT_ROTATIONS = 5;
const MAX_AUDIT_DEPTH = 4;
const MAX_AUDIT_ARRAY_ITEMS = 24;
const MAX_AUDIT_OBJECT_KEYS = 48;

// Каталог logs/ создаётся на месте: режим аудита может быть включён позже старта
// процесса, и полагаться на его существование нельзя.
function getAuditFilePath(agentName: string): string {
  // Замена всего, что не входит в белый список, отсекает разделители пути и "..",
  // поэтому имя агента не может вывести файл за пределы logs/.
  const safeName = agentName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = resolve(process.cwd(), "logs");
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `${safeName}.log`);
}

// Ротация по размеру: сначала удаляется самый старый архив, затем архивы
// сдвигаются на шаг вверх, и только потом текущий файл становится .1. Порядок
// важен - обратный обход не перетирает ещё не перемещённые файлы.
function rotateAuditFileIfNeeded(filePath: string): void {
  // Проверка существования до statSync: между двумя вызовами файл может исчезнуть,
  // и ранний выход избавляет от лишнего исключения на каждом запросе.
  if (!existsSync(filePath)) return;

  const size = statSync(filePath).size;
  if (size < MAX_AUDIT_FILE_BYTES) return;

  // Освобождение слота под новый архив: без удаления самый старый файл остался бы
  // на месте, и число файлов росло бы при каждом сдвиге.
  const oldest = `${filePath}.${MAX_AUDIT_ROTATIONS}`;
  if (existsSync(oldest)) {
    // Удаляем самый старый архив, чтобы число файлов журнала оставалось ограниченным.
    unlinkSync(oldest);
  }

  for (let i = MAX_AUDIT_ROTATIONS - 1; i >= 1; i -= 1) {
    const from = `${filePath}.${i}`;
    const to = `${filePath}.${i + 1}`;
    if (existsSync(from)) {
      renameSync(from, to);
    }
  }

  renameSync(filePath, `${filePath}.1`);
}

// Рекурсивная санитизация произвольного значения. Возвращаемый результат всегда
// пригоден для JSON.stringify: функции, символы и прочее сводятся к строке.
function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  // Глубина проверяется первой: циклические и слишком глубокие структуры
  // отсекаются до любого обхода.
  if (depth > MAX_AUDIT_DEPTH) {
    return "[TRUNCATED_DEPTH]";
  }
  if (typeof value === "string") {
    // Строки проходят через редактор секретов: именно в них чаще всего попадают
    // ключи провайдера и токены.
    return redactProviderText(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    // Массивы обрезаются с явной меткой: усечение должно быть видно при чтении
    // журнала, а не выглядеть как полные данные.
    const sanitized = value
      .slice(0, MAX_AUDIT_ARRAY_ITEMS)
      .map((item) => sanitizeAuditValue(item, depth + 1));
    if (value.length > MAX_AUDIT_ARRAY_ITEMS) {
      sanitized.push("[TRUNCATED_ARRAY]");
    }
    return sanitized;
  }
  if (typeof value === "object") {
    // Объекты обрезаются по числу ключей; флаг _truncated отличает "обрезано" от
    // "поля не было".
    const entries = Object.entries(value as Record<string, unknown>);
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of entries.slice(0, MAX_AUDIT_OBJECT_KEYS)) {
      sanitized[key] = sanitizeAuditValue(nested, depth + 1);
    }
    if (entries.length > MAX_AUDIT_OBJECT_KEYS) {
      sanitized._truncated = true;
    }
    return sanitized;
  }
  // Всё остальное (функции, символы, bigint) приводится к строке: иначе
  // JSON.stringify молча потерял бы значение.
  return String(value);
}

// Единственная точка входа. Проверка флага идёт внутри try: выключенный аудит не
// должен требовать от вызывающего никаких дополнительных условий.
export function writeQueryAudit(record: QueryAuditRecord): void {
  try {
    if (!getEnv().AGENT_QUERY_AUDIT_ENABLED) return;
    // Ротация выполняется до добавления строки, чтобы размер проверялся на
    // предсказуемом состоянии файла.
    const filePath = getAuditFilePath(record.agentName);
    rotateAuditFileIfNeeded(filePath);
    // Одна строка - одна запись: перевод строки служит разделителем, поэтому
    // объект сериализуется целиком и без переносов внутри.
    appendFileSync(filePath, `${JSON.stringify(sanitizeAuditValue(record))}\n`, "utf8");
  } catch {
    // Проглатывание ошибок осознанное: аудит не влияет на результат выполнения
    // задачи, а исключение здесь прервало бы рабочий процесс.
    // Только best-effort журналирование: ошибки записи аудита не должны прерывать выполнение агента.
  }
}
