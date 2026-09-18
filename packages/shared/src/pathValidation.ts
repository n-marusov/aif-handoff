/**
 * Валидация корневого пути проекта перед файловыми операциями и вызовами оболочки.
 *
 * Корень проекта подставляется в команды оболочки и в файловые вызовы, а приходит из
 * данных, которые задаёт пользователь. Поэтому здесь отсекаются: пустой путь,
 * относительный путь, нулевой байт, метасимволы оболочки и системные каталоги.
 * Возвращается текст ошибки, а не исключение: вызывающий сам решает, как его показать.
 */

import { resolve, isAbsolute } from "node:path";

// Метасимволы оболочки в пути позволяют выйти за пределы простого пути: разделитель
// команд, конвейер, обратные кавычки и подстановки превратили бы путь в лишнюю команду.
const SHELL_META_CHARS = /[;&|`$(){}!<>]/;

// Приведение к виду, пригодному для сравнения: разделители Windows переводятся в
// прямые слэши (иначе c:\windows не совпадёт с c:/windows), хвостовые слэши
// срезаются, регистр игнорируется. Без этого список запретов обходится тривиально.
function normalizeForPolicy(input: string): string {
  return input.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Проверяет, безопасен ли корневой путь проекта для файловых операций и вызовов
 * оболочки. Возвращает null, если путь допустим, либо текст ошибки.
 */
export function validateProjectRootPath(rootPath: string): string | null {
  if (!rootPath || rootPath.trim().length === 0) {
    return "rootPath must not be empty";
  }

  if (!isAbsolute(rootPath)) {
    return "rootPath must be an absolute path";
  }

  const resolved = resolve(rootPath);

  // Нулевой байт обрезает строку на уровне системных вызовов, поэтому позволял бы
  // замаскировать реальный путь под безобидный префикс.
  if (resolved.includes("\0")) {
    return "rootPath must not contain null bytes";
  }

  if (SHELL_META_CHARS.test(resolved)) {
    return "rootPath must not contain shell metacharacters";
  }

  // Сравниваем и нормализованный resolved, и нормализованный исходный ввод:
  // первый ловит приведённые формы пути, второй — попытку обхода проверки
  // через альтернативную запись.
  const normalizedResolved = normalizeForPolicy(resolved);
  const normalizedInput = normalizeForPolicy(rootPath);
  const blocked = [
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/var",
    "/sys",
    "/proc",
    "/dev",
    "c:/windows",
    "c:/program files",
    "c:/program files (x86)",
    "c:/programdata",
  ];
  for (const dir of blocked) {
    if (
      normalizedResolved === dir ||
      normalizedResolved.startsWith(`${dir}/`) ||
      normalizedInput === dir ||
      normalizedInput.startsWith(`${dir}/`)
    ) {
      return `rootPath must not point to system directory: ${dir}`;
    }
  }

  return null;
}
