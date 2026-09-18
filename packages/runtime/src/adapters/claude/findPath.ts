/**
 * Поиск исполняемого файла Claude Code на хосте.
 *
 * У двух потребителей разные требования к бинарнику, и это определяет деление
 * модуля надвое. Процессный (CLI) транспорт запускает командную строку и доволен
 * любым файлом, который ОС умеет исполнить. SDK-транспорт требует настоящий
 * нативный бинарник и падает на npm-обёртках (claude.cmd / .ps1 / .bat): это
 * текстовые скрипты, которым нужен shell, а SDK его не поднимает. Отсюда две
 * функции с разной степенью строгости:
 * - resolveClaudeSdkExecutablePath «санирует» явный путь пользователя и может
 *   вернуть undefined — этот ответ означает «не мешать SDK искать самому»;
 * - findClaudePath ищет среди типовых мест установки и возвращает первый живой.
 *
 * Почему ручной список путей, а не надежда на PATH: процессы, запущенные демоном,
 * из Docker или из systemd, получают урезанное окружение — ни nvm, ни глобальный
 * npm там не инициализированы. Поэтому сначала типовые каталоги, затем npm prefix
 * и только в самом конце — системные локаторы (where/which).
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, join, resolve, win32 as pathWin32 } from "node:path";

// Нормализация «пути как его ввёл человек»: обрезаем пробелы и снимаем парные
// кавычки — на Windows путь к программе часто копируют прямо из проводника в
// кавычках, и без снятия existsSync такую строку не найдёт. Пустой результат —
// undefined, чтобы вызывающий код не проверял длину руками.
function normalizePathValue(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const normalized = path.trim().replace(/^"(.*)"$/, "$1");
  return normalized.length > 0 ? normalized : undefined;
}

// Проверка на npm-обёртки Windows — их четыре исторических имени. Именно
// расширение, а не имя: под claude.exe и под скриптом может лежать один и тот же
// пакет, но для SDK это разные вещи по исполнимости.
function isWindowsClaudeWrapperBasename(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "claude" ||
    normalized === "claude.cmd" ||
    normalized === "claude.ps1" ||
    normalized === "claude.bat"
  );
}

// Явный путь от пользователя → путь, пригодный для SDK, либо undefined.
// platform и options параметризованы, а не читаются из process — так функцию
// можно тестировать на обоих семействах ОС без CI-матрицы.
export function resolveClaudeSdkExecutablePath(
  path: string | null | undefined,
  platform = process.platform,
  // Опция нужна для сценариев, где голое unix-имя всё-таки осмысленно (сам CLI
  // транспорт): по умолчанию SDK-путь такую строку отвергает, но вызывающий
  // может сознательно разрешить.
  options: { allowBareUnixExecutable?: boolean } = {},
): string | undefined {
  const normalizedPath = normalizePathValue(path);
  // Пустая строка и undefined ведут себя одинаково — «пользователь ничего не
  // задал», что для SDK значит «ищи сам».
  if (!normalizedPath) return undefined;
  if (platform !== "win32") {
    // Голое имя без расширения (“claude”) — это не путь, а ссылка на PATH: SDK
    // сам разрешит его через свой поиск, а передача такого значения как
    // executable-пути дала бы неоднозначный результат. Исключение — явное
    // разрешение вызывающего (allowBareUnixExecutable).
    if (!options.allowBareUnixExecutable && extname(normalizedPath) === "") {
      return undefined;
    }
    return normalizedPath;
  }

  const fileName = pathWin32.basename(normalizedPath).toLowerCase();
  // Нативный исполняемый — идеальный случай, отдаём как есть. Сравнение
  // регистронезависимое: Windows не различает регистр в именах файлов.
  if (fileName === "claude.exe") {
    return normalizedPath;
  }
  // Незнакомая обёртка/кастомный файл — доверяем пользователю и передаём путь
  // без правок: он мог сам назвать настоящий бинарник любым именем.
  if (!isWindowsClaudeWrapperBasename(fileName)) {
    return normalizedPath;
  }

  // Обёртка .cmd/.ps1: рядом с ней в node_modules глобального пакета лежит
  // настоящий нативный claude.exe того же релиза. Ищем его как «сестринский» к
  // обёртке — это тот же код, но без shell-прослойки. Не нашли — возвращаем
  // undefined: лучше позволить SDK выполнить собственный поиск, чем совать ему
  // скрипт, который он не сможет запустить.
  // pathWin32 используется явно, а не через path: разбор Windows-путей должен
  // работать одинаково и при запуске на Windows, и в тестах на Linux — иначе
  // функция вела бы себя по-разному в проде и CI.
  const nativeExecutablePath = pathWin32.resolve(
    pathWin32.dirname(normalizedPath),
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe",
  );
  return existsSync(nativeExecutablePath) ? nativeExecutablePath : undefined;
}

// Поиск среди типовых мест установки. HOME ?? USERPROFILE — кросс-платформенный
// домашний каталог: на Unix это HOME, на Windows USERPROFILE, и падать, если
// первого нет, нельзя.
//
// Заранее неизвестно, где установлен Claude, и ни один способ не гарантирован:
// поэтому каскад «список -> npm -> PATH». Возврат undefined в самом конце —
// нормальный исход «не нашли»: вызывающий код сам решает, ставить ли диагностику,
// а не получает исключение из поисковой функции.
/** Ищет путь исполняемого файла Claude CLI в типовых местах установки. */
export function findClaudePath(): string | undefined {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  // Порядок кандидатов — это тоже логика: .exe идёт раньше .cmd, потому что
  // нативный бинарник не требует shell и переживёт все режимы запуска, а .cmd —
  // лишь запасной вариант. Комментарии внутри массива описывают эту градацию.
  const candidates =
    /* v8 ignore next */
    // Маркер покрытия: ветка win32 на Linux-CI не выполняется, и без пометки
    // покрытие «просаживалось» бы на всей платформенной вилке.
    process.platform === "win32"
      ? [
          // Предпочитаем .exe (настоящий бинарник) вместо .cmd (npm-обёртка, которой нужен shell)
          resolve(process.env.APPDATA ?? "", "npm/claude.exe"),
          resolve(process.env.LOCALAPPDATA ?? "", "npm/claude.exe"),
          resolve(homeDir, "scoop/shims/claude.exe"),
          resolve(homeDir, ".local/bin/claude.exe"),
          // Откат к .cmd-обёрткам — CLI-транспорт берёт их через shell: true,
          // а SDK-транспорт пропускает .cmd-пути и позволяет SDK искать самому.
          resolve(process.env.APPDATA ?? "", "npm/claude.cmd"),
          resolve(process.env.LOCALAPPDATA ?? "", "npm/claude.cmd"),
          resolve(homeDir, "scoop/shims/claude.cmd"),
          resolve(homeDir, ".local/bin/claude.cmd"),
        ]
      : [
          // Unix-набор — типовые места глобальной установки: системный префикс,
          // каталог пользователя (~/.local/bin — конвенция pip/npm-подобных
          // установщиков), homebrew на Apple Silicon и глобальный npm-префикс nvm.
          "/usr/local/bin/claude",
          resolve(homeDir, ".local/bin/claude"),
          "/opt/homebrew/bin/claude",
          resolve(homeDir, ".npm-global/bin/claude"),
          "/usr/bin/claude",
        ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // Резерв: проверяем глобальный npm prefix (покрывает Docker и custom npm prefix)
  // Каталог префикса узнаётся у самого npm: жёстко прошить его нельзя — он
  // настраивается пользователем и различается в образах/дистрибутивах.
  try {
    const npmPrefix = execFileSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (npmPrefix) {
      const npmCandidate = join(npmPrefix, "bin", "claude");
      if (existsSync(npmCandidate)) return npmCandidate;
    }
  } catch {
    // Поглощение ошибки осознанное: отсутствие npm — не беда, ниже есть ещё один
    // независимый способ (where/which). Диагностика здесь только шумела бы.
    // npm недоступен или таймаут
  }

  // Резерв: спрашиваем в PATH, где живёт claude (покрывает глобальные npm/npx-установки, nvm и т.п.)
  // where на Windows и which на Unix — одна и та же семантика «покажи путь из
  // PATH», но разные имена. Команда внешняя, поэтому и здесь не обойтись без
  // поглощения ошибок: в минимальном окружении нет ни того, ни другого.
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const result = execFileSync(command, ["claude"], {
      // Внешняя команда может висеть на сканировании огромного PATH — жёсткий
      // потолок в 3 секунды; stdout читается, stderr глушится — он не нужен.
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
      // Вывод локатора построчный: Windows даёт CRLF, Unix — LF; пути из вывода
      // часто в кавычках — снимаем их перед проверкой на существование.
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^"(.*)"$/, "$1"))
      // existsSync отсекает «протухшие» записи PATH: локатор честно печатает всё,
      // что помнит, а нам нужен первый реально существующий файл.
      .find((line) => line.length > 0 && existsSync(line));

    if (result) return result;
  } catch {
    // Ни локатора, ни claude в PATH — нормальный исход «не нашли»: наружу уйдёт
    // undefined, и вызывающий код сам решит, поставить ли диагностику/предложить
    // установку. Исключение здесь только сорвало бы весь поиск.
    // команда-локатор недоступна или claude не в PATH
  }

  return undefined;
}
