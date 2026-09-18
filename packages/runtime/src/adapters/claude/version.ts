/**
 * Версионный «предохранитель» бинарника Claude Code: перед каждым запуском
 * адаптер убеждается, что конкретный исполняемый файл совместим с тем, как мы его
 * вызываем, и иначе останавливает запуск по понятной ошибке.
 *
 * Зачем это нужно: сборки Claude Code ниже CLAUDE_MIN_VERSION отвергают пустые
 * строки settings.attribution (документированный способ подавить трейлер
 * Co-Authored-By). Такие сборки умирают с кодом 1 и пустым stderr, и без guard'а
 * пользователь видел бы только необъяснимое «Claude Code process exited with
 * code 1». Guard превращает эту ловушку в конкретную инструкцию по апгрейду.
 *
 * Адаптер умеет запускать два разных артефакта, и способ узнать версию у каждого
 * свой:
 * - явный pathToClaudeCodeExecutable -> spawn `<path> --version`
 *   (probeClaudeVersion): это «чужой» бинарник, достоверный источник только его
 *   собственный вывод;
 * - встроенный в @anthropic-ai/claude-agent-sdk -> чтение manifest.json пакета
 *   (readBundledClaudeVersion) без спавна вовсе.
 * Центральный инвариант: проверяется ровно тот файл, который запустит query().
 * Поиск «claude из PATH» запрещён: была бы проверена одна копия, а выполнена
 * другая, и сигнал совместимости стал бы фиктивным.
 *
 * Общие решения по модулю:
 * - парсеры возвращают `ClaudeVersion | null` и не бросают исключений: вывод
 *   процессов и чужие JSON-файлы — недоверенные данные, нераспознанная строка
 *   версии это штатная ситуация, а не авария;
 * - при «версия неизвестна» guard только предупреждает и пропускает запуск:
 *   ложный отказ сломал бы заведомо рабочие конфигурации, а настоящую
 *   несовместимость всё равно увидит диагностика упавшего процесса;
 * - результаты probe'ов кэшируются на время процесса: бинарник не обновляется
 *   посреди жизни Node-процесса, а каждый spawn стоит заметных миллисекунд.
 *
 * Почему проверка идёт на каждом ране, а не один раз при старте адаптера: путь к
 * бинарнику может меняться от профиля к профилю (у каждого проекта свой
 * pathToClaudeCodeExecutable), а сам файл на диске способен поменяться между
 * двумя запусками в одном процессе. Повторный вызов защищён кэшем, так что
 * реальный probe для одного и того же пути всё равно происходит один раз.
 *
 * Почему сравнение версий написано своими руками, а не через библиотеку: нужна
 * ровно одна операция «меньше» над тремя числами, а лишняя зависимость в
 * транспортном слое — риск в цепочке поставок и повод для конфликта версий; сама
 * функция — пять строк и полностью покрыта тестами.
 */

// Два Node-API из разных миров: child_process для явного бинарника, module для
// разрешения встроенного пакета SDK. Никаких зависимостей от @aif/data или API —
// проверка версии не имеет права тянуть за собой соседние слои приложения.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ClaudeRuntimeAdapterError } from "./errors.js";

/**
 * Минимальная поддерживаемая версия Claude Code.
 *
 * Сборки ниже этой отвергают пустые строки settings.attribution на старте
 * (запущенный `claude` выходит с кодом 1 и пустым stderr), что выглядит как
 * необъяснимое `Claude Code process exited with code 1`. Пустые attribution-
 * строки — задокументированный механизм подавления трейлера Co-Authored-By, и
 * {@link import("./options.js").buildClaudeQueryOptions} передаёт их дословно, поэтому
 * адаптер отказывается запускаться против бинарника, который их не принимает.
 *
 * 2.1.191 — первый релиз, проверенно принимающий пустые attribution-строки
 * через SDK-транспорт. Основная механика совместимости — закреплённый
 * `@anthropic-ai/claude-agent-sdk`, чей встроенный нативный бинарник Claude Code
 * (объявлен в его `manifest.json`, см. {@link readBundledClaudeVersion})
 * поставляется не ниже этого минимума. Guard — runtime-страховка, которая
 * проверяет ровно тот бинарник, что запустит `query()`: встроенный (из
 * манифеста) без override исполняемого файла, либо явный
 * `pathToClaudeCodeExecutable`.
 */
export const CLAUDE_MIN_VERSION = "2.1.191";
// Версия выбрана не «круглой датой», а эмпирически: это первый релиз, проверенно
// принимающий пустые attribution-строки через SDK-транспорт. Совместимость с
// остальными сборками держится на пине @anthropic-ai/claude-agent-sdk, а константа
// — последний рубеж, когда пин почему-то не сработал (custom-путь, битая установка).

// Разложенная версия. Числовые поля нужны потому, что semver-сравнение строк
// неверно: лексикографически "2.10.1" < "2.9.3", и эта ошибка была бы тихой.
export interface ClaudeVersion {
  major: number;
  minor: number;
  patch: number;
  // Сюда кладётся не исходный текст вывода, а пересобранная тройка
  // "major.minor.patch": исходники версий бывают с хвостами-помехами, а в логах
  // и сообщениях об ошибках нужен канонический вид.
  raw: string;
}

// Ищем первую тройку цифр внутри произвольного текста, а не сверяем строку
// целиком: `claude --version` печатает не только номер (бывает "v2.1.191 (Claude
// Code)" или вывод с путями), и незаякоренный regex устойчив к таким обрамлениям.
const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/;

/** Извлекает первую тройку `major.minor.patch` из строки версии. */
// Парсеры и probe'ы экспортированы не только ради внутреннего использования:
// тесты вызывают их напрямую, а другие части адаптера могут переиспользовать
// разрешение версии (например, диагностика среды). Публичность здесь — осознанное
// расширение поверхности API, а не случайность.
export function parseClaudeVersion(raw: string): ClaudeVersion | null {
  // Проверка typeof, несмотря на сигнатуру `string`: аргументы приходят из
  // вывода процессов и manifest.json, где объявленный тип никто не гарантирует.
  if (typeof raw !== "string") return null;
  const match = raw.match(VERSION_PATTERN);
  // Нераспознанный формат — это «не знаю», а не «несовместимо»: возвращаем null
  // и оставляем решение (блокировать или деградировать) вызывающему коду.
  if (!match) return null;
  // Все три разряда парсятся заранее и валидируются одним прогоном: «половинчатая
  // версия» (есть major, нет patch) в объекте существовать не должна.
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  // Страховка от абсурдных вводов: parseInt на сотнях цифр вернёт Infinity, и
  // такой «версии» лучше не существовать вовсе, чем участвовать в сравнениях.
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return { major, minor, patch, raw: `${major}.${minor}.${patch}` };
}

// Минимальная версия раскладывается в объект один раз при загрузке модуля, а не
// на каждое сравнение: guard вызывается перед каждым раном, и гонять regex по
// литеральной константе было бы чистой расточительностью.
const PARSED_MIN_VERSION: ClaudeVersion = (() => {
  const parsed = parseClaudeVersion(CLAUDE_MIN_VERSION);
  // Статический guard: CLAUDE_MIN_VERSION выше — литерал, он обязан парситься.
  // Единственный осознанный throw в модуле: битый литерал — опечатка
  // разработчика, а не runtime-ситуация, поэтому честно упасть при импорте,
  // чем молча сравнивать всё с «нулевой» версией.
  if (!parsed) {
    throw new Error(`Unable to parse CLAUDE_MIN_VERSION="${CLAUDE_MIN_VERSION}"`);
  }
  return parsed;
})();

/** True, если `version` строго ниже поддерживаемого минимума. */
export function isVersionBelowMin(version: ClaudeVersion): boolean {
  const min = PARSED_MIN_VERSION;
  // Строгое «ниже»: версия, равная минимуму, считается совместной — 2.1.191
  // названа первым релизом, который умеет пустые attribution-строки, и отсекать
  // её саму было бы ошибкой на единицу.
  // Каскад по разрядам semver: первый несовпавший разряд решает исход, и
  // младшие разряды при другом старшем уже не учитываются.
  if (version.major !== min.major) return version.major < min.major;
  if (version.minor !== min.minor) return version.minor < min.minor;
  return version.patch < min.patch;
}

// Результат «разведки» версией: распарсенное значение, сырой вывод и текст
// проблемы. info/raw/error держатся раздельно, чтобы guard мог и принять решение
// по info, и залогировать первопричину (error + raw) при неизвестности.
export interface ClaudeVersionProbe {
  info: ClaudeVersion | null;
  raw: string | null;
  error: string | null;
}

// Единственная настройка probe — таймаут: всё остальное (потоки, буфер, склейка
// вывода) — инварианты метода, а не точки конфигурации.
export interface ProbeClaudeVersionOptions {
  timeoutMs?: number;
}

/**
 * Читает версию бинарника Claude Code, который Agent SDK запускает без
 * явного `pathToClaudeCodeExecutable`.
 *
 * SDK поставляет платформенный нативный бинарник, чья точная версия
 * объявлена в его `manifest.json` (поле `version`). Чтение этого файла даёт
 * ровно тот артефакт, который выполнит `query()` — без spawn `--version`, без
 * поиска по PATH и без двусмысленности platform/musl-резолвинга. Так
 * версионный guard проверяет тот же бинарник, что исполнит запуск без
 * override — инвариант, ради которого guard и существует.
 *
 * Пакет разрешается через главный вход, а `manifest.json` читается из того же
 * каталога (карта `exports` SDK не публикует `manifest.json` напрямую).
 * Возвращает `null`, когда пакет, файл или версия неразрешимы, чтобы
 * вызывающий мог деградировать (warn + продолжить).
 */
export function readBundledClaudeVersion(): ClaudeVersion | null {
  try {
    // createRequire из ESM-модуля: require.resolve даёт путь внутри чужого
    // пакета, который сам по себе ESM и «требовать» себя не умеет. Manifest ищем
    // рядом с главным входом, потому что exports-карта SDK не публикует
    // manifest.json как резолвимый путь.
    const moduleRequire = createRequire(import.meta.url);
    const mainPath = moduleRequire.resolve("@anthropic-ai/claude-agent-sdk");
    const manifestPath = join(dirname(mainPath), "manifest.json");
    if (!existsSync(manifestPath)) return null;
    // Manifest — это контракт самого SDK: файл бинарника рядом с ним может быть
    // симлинком/архивом платформы, а version в manifest пишет публикующий пайплайн.
    // Проверять исполняемый файл отдельно незачем — SDK и так запустит ровно его.
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
    // version остаётся unknown до последней секунды: parseClaudeVersion сам
    // решает, строка ли там и читается ли она, — и возвращает null при провале.
    return parseClaudeVersion(typeof manifest.version === "string" ? manifest.version : "");
  } catch {
    // Любая ошибка чтения (нет пакета, битый JSON, права) — это «версия
    // неизвестна»: null, а не исключение; решение о деградации принимает guard.
    return null;
  }
}

/**
 * Запускает `<executable> --version` (или `claude --version` из PATH, когда путь
 * не задан) и парсит сообщённую версию. Никогда не reject'ит: неразбираемая или
 * отсутствующая сборка разрешается в `{ info: null }`, и вызывающий сам решает —
 * требовать или деградировать.
 */
export function probeClaudeVersion(
  executablePath: string | undefined,
  options: ProbeClaudeVersionOptions = {},
): Promise<ClaudeVersionProbe> {
  // Голый "claude" по умолчанию допустим только здесь, на нижнем уровне: сам
  // guard вызывает probe исключительно с явным путём либо не вызывает вовсе
  // (для встроенного бинарника работает manifest-путь).
  const command = executablePath ?? "claude";
  // Умеренный таймаут: --version — локальная операция, и зависший на секунды
  // бинарник не должен растягивать старт каждого рана.
  const timeoutMs = options.timeoutMs ?? 4_000;
  return new Promise((resolve) => {
    // settled нужен, потому что 'error' и 'close' у дочернего процесса способны
    // случиться оба (сбой запуска тоже завершается close), а разрешение промиса
    // засчитывается только первое — без флага более поздний «размытый» результат
    // затирал бы более точный.
    let settled = false;
    const finish = (result: ClaudeVersionProbe) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = execFile(command, ["--version"], {
      // execFile, а не exec: аргументы уходят без shell, поэтому путь из
      // конфигурации не может «случайно» стать командной строкой — инъекция
      // исключена конструктивно, а не проверкой.
      timeout: timeoutMs,
      // Без этого флага на Windows каждый probe мигает отдельной консолью.
      windowsHide: true,
      // Ответ --version весит десятки байт; крошечный maxBuffer ограничивает
      // ущерб, если по указанному пути окажется процесс, стримящий что-то огромное.
      maxBuffer: 1024,
    });
    // Оба потока накапливаются и разбираются вместе: разные сборки печатают
    // версию в stdout или stderr, и «правильный» поток выбрать нельзя.
    // Чтение идёт до конца процесса, а не инкрементально: вывод весит байты, и
    // потоковый парсер здесь был бы сложнее без единой выгоды.
    let stdout = "";
    let stderr = "";
    // Данные складываются строками без разбора: нас интересует только номер, а он
    // прийдёт одним коротким куском; перестановка частей по потокам не важна —
    // парсится склейка целиком.
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      // 'error' — сбой самого запуска (нет файла, нет прав), а не ненулевой код
      // возврата. ENOENT выделяется в отдельный текст: «Claude не установлен» и
      // «Claude не запустился» — разные диагнозы и разные подсказки пользователю.
      finish({
        info: null,
        raw: null,
        error:
          err.code === "ENOENT"
            ? `Claude executable not found: ${command}`
            : `Failed to probe Claude executable: ${err.message}`,
      });
    });
    child.on("close", (code) => {
      // Версия ищется в склейке обоих потоков: формат вывода менялся между
      // сборками Claude Code, поэтому парсим всё, что процесс сумел напечатать.
      const combined = `${stdout}\n${stderr}`.trim();
      const parsed = parseClaudeVersion(combined);
      if (parsed) {
        // Успех: raw тоже отдан — он попадает в debug-лог, и по нему видно, что
        // именно напечатал бинарник (полезно при разборе «версия не та»).
        finish({ info: parsed, raw: combined, error: null });
        return;
      }
      // Два разных текста для двух разных бед: «вывод есть, но версия в нём не
      // читается» и «процесс умер молча» ведут к разным действиям пользователя.
      finish({
        info: null,
        raw: combined || null,
        error:
          combined.length > 0
            ? `Unable to parse Claude version from output: ${combined}`
            : `Claude --version exited with code ${code} and no output`,
      });
    });
  });
}

// Форма глобала для юнит-тестов: неизвестное значение нас не интересует, важен
// сам факт, что тест подменил query() и реальный SDK-путь не используется.
// Проверка должна быть дешёвой и без побочных эффектов: она выполняется в начале
// каждого рана, поэтому это одно чтение свойства. Имя с двойным подчёркиванием —
// конвенция «служебный глобал тестов», чтобы не столкнуться с пользовательскими.
interface RuntimeGlobalWithQueryMock {
  __AIF_CLAUDE_QUERY_MOCK__?: unknown;
}

/** Юнит-тесты ставят мок query() через этот global; тогда guard неактуален. */
// Мок query() ставится именно как свойство globalThis: под ним нет реального
// бинарника, и проверка версии была бы ложным отказом в юнит-прогоне.
function isClaudeQueryMocked(): boolean {
  return Boolean((globalThis as RuntimeGlobalWithQueryMock).__AIF_CLAUDE_QUERY_MOCK__);
}

// Минимальный структурный логгер: методы опциональны, потому что guard не имеет
// права требовать логгер — вызывающий код без него (скрипты, тесты) должен
// получать ровно ту же проверку, просто «немую». Вызовы идут через ?. — см.
// logger?.warn?.() ниже.
export interface ClaudeVersionGuardLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

// Инъекция зависимостей вместо подмены импортов: guard остаётся тестируемым без
// реальных spawn-процессов и без чтения node_modules, а в проде обе функции
// берутся по умолчанию (см. assertClaudeExecutableCompatible).
export interface AssertClaudeVersionDeps {
  /** Тестовый хук: внедрить фейковый probe вместо запуска `claude`. */
  probeClaudeVersion?: (
    executablePath: string | undefined,
    options?: ProbeClaudeVersionOptions,
  ) => Promise<ClaudeVersionProbe>;
  /** Тестовый хук: внедрить фейковый читатель встроенной версии вместо чтения manifest.json. */
  readBundledClaudeVersion?: () => ClaudeVersion | null;
}

// Обёртка кэша: сейчас это просто проброс probe, но структура оставляет место
// для будущих полей (время кэширования, источник) без смены типа значения Map.
interface CachedProbe {
  probe: ClaudeVersionProbe;
}

/** Кэш на время жизни процесса, ключ — путь к исполняемому файлу (версии внутри процесса не меняются). */
// Ключ — путь к бинарнику либо служебный маркер встроенного: пока процесс жив,
// содержимое файла по этому пути считается неизменным, поэтому probe выполняется
// один раз, а не на каждый ран. Негативные результаты кэшируются наравне с
// успешными: отсутствие бинарника посреди процесса так же маловероятно, как и
// его апгрейд «на горячую».
// Память: словарь растёт только по числу РАЗНЫХ путей (на практике один-два),
// поэтому вытеснение/лимит здесь не нужны — усложнили бы код без пользы.
const probeCache = new Map<string, CachedProbe>();

/**
 * Подсказка апгрейда для ошибки ниже минимума. При явном override исполняемого
 * файла бинарником управляет пользователь (`npm i -g`); версия встроенного в SDK
 * бинарника связана с `@anthropic-ai/claude-agent-sdk`, поэтому лечение —
 * поднять эту зависимость.
 */
// Подсказка зависит от того, кому «принадлежит» бинарник: явным путём управляет
// пользователь (поможет глобальная переустановка), а встроенная в SDK версия
// жёстко привязана к релизу @anthropic-ai/claude-agent-sdk — советовать там
// `npm i -g` бессмысленно, SDK глобальный пакет не увидит.
function formatUpgradeHint(
  source: "explicit" | "bundled",
  executablePath: string | undefined,
): string {
  return source === "bundled"
    ? "Upgrade @anthropic-ai/claude-agent-sdk in this project to a release whose bundled Claude Code is at or above the minimum"
    : executablePath
      ? `Upgrade the binary at ${executablePath}: npm i -g @anthropic-ai/claude-code@latest`
      : "Install/upgrade Claude Code: npm i -g @anthropic-ai/claude-code@latest";
}

// Результат разрешения версии: тройка probe'а плюс источник, который нужен и для
// текста подсказки, и для логов (для встроенного бинарника «локации» как пути нет).
interface ResolvedVersion {
  info: ClaudeVersion | null;
  raw: string | null;
  error: string | null;
  source: "explicit" | "bundled";
}

/**
 * Определяет версию ровно того бинарника Claude Code, который запустит `query()`:
 *
 * - `executablePath` задан → spawn `<path> --version`. `buildClaudeQueryOptions`
 *   передаёт тот же путь в `query()`, так что проверяемый артефакт —
 *   запускаемый.
 * - `executablePath` не задан → Agent SDK исполняет свой встроенный нативный
 *   бинарник; его версия читается из `manifest.json` через
 *   {@link readBundledClaudeVersion}. Никакого поиска по PATH, чтобы guard
 *   никогда не проверял другой `claude`, чем поднимает SDK.
 *
 * Результаты кэшируются по ключу на время жизни процесса (кэш обходится при
 * инъекции зависимостей, чтобы юнит-тесты оставались герметичными).
 */
async function resolveEffectiveVersion(
  executablePath: string | undefined,
  probeFn: NonNullable<AssertClaudeVersionDeps["probeClaudeVersion"]>,
  readBundledFn: NonNullable<AssertClaudeVersionDeps["readBundledClaudeVersion"]>,
  deps: AssertClaudeVersionDeps | undefined,
): Promise<ResolvedVersion> {
  if (executablePath) {
    const cacheKey = executablePath;
    // Кэш обходится, когда подключена инъекция deps: иначе фейковый probe из
    // одного теста «отравил» бы результат другого, и герметичность пропала.
    let probe = deps ? undefined : probeCache.get(cacheKey)?.probe;
    if (!probe) {
      // probeClaudeVersion не бросает исключений и не «зависает» дольше таймаута,
      // поэтому await здесь безопасен без try/catch — любой исход ложится в кэш
      // как есть, включая негатив: повторный spawn при отсутствии бинарника
      // ничего не изменит.
      probe = await probeFn(executablePath);
      if (!deps) probeCache.set(cacheKey, { probe });
    }
    return { ...probe, source: "explicit" };
  }

  // Для встроенного бинарника путь нестабилен между ОС и установками, поэтому
  // в кэше он занимает один фиксированный ключ на весь процесс.
  const cacheKey = "<bundled>";
  // Ветка без spawn: версия известна из файла пакета. Это заметно дешевле запуска
  // процесса и не зависит от PATH/шеллов — именно поэтому основной путь в
  // контейнерах идёт через манифест, а не через `claude --version`.
  let probe = deps ? undefined : probeCache.get(cacheKey)?.probe;
  if (!probe) {
    const info = readBundledFn();
    // Не удалось прочитать manifest — это «версия неизвестна», а не
    // «несовместимо»: синтетический probe с текстом ошибки продолжит путь
    // warn-and-proceed внутри guard'а, блокировки не будет.
    probe = info
      ? { info, raw: info.raw, error: null }
      : {
          info: null,
          raw: null,
          error:
            "Unable to read the bundled Claude Code version from @anthropic-ai/claude-agent-sdk manifest.json",
        };
    if (!deps) probeCache.set(cacheKey, { probe });
  }
  return { ...probe, source: "bundled" };
}

/**
 * Настаивает на минимальной версии Claude Code перед стартом запуска.
 *
 * - Ниже минимума → бросает {@link ClaudeRuntimeAdapterError} (code
 *   `CLAUDE_VERSION_UNSUPPORTED`, category `transport`) с практичным
 *   сообщением вместо необъяснимого `Claude Code process exited with code 1`.
 * - Версия не определяется (бинарник отсутствует / вывод неразбираем / манифест
 *   не читается) → warning и продолжение; сам запуск проявит реальные сбои
 *   через {@link import("./diagnostics.js").diagnoseClaudeError}.
 *   Требовательность к неопределённости блокировала бы валидные конфигурации.
 * - На минимуме или выше → debug-запись эффективной версии.
 *
 * Проверяется всегда тот бинарник, что запустит `query()`: явный
 * `pathToClaudeCodeExecutable` при наличии, иначе встроенный бинарник Agent
 * SDK (версия из `manifest.json`). Guard никогда не зондирует посторонний
 * `claude` из PATH.
 *
 * Полностью пропускается в юнит-тестах (env `VITEST` или `NODE_ENV === "test"`
 * без интеграционного флага), когда query() SDK замокан, или при
 * `AIF_CLAUDE_SKIP_VERSION_CHECK=1`. Интеграционный smoke-тест принудительно
 * включает проверку через `AIF_CLAUDE_INTEGRATION=1`.
 */
export async function assertClaudeExecutableCompatible(
  executablePath: string | undefined,
  logger?: ClaudeVersionGuardLogger,
  // Свободный контекст для логов: вызывающий код добавляет сюда корреляционные
  // поля (runtimeId, profileId), и они попадают в обе строки — warn и debug.
  context: Record<string, unknown> = {},
  deps?: AssertClaudeVersionDeps,
): Promise<void> {
  const isIntegration = process.env.AIF_CLAUDE_INTEGRATION === "1";
  // Пропуск — не «отключение проверки», а способ не блокировать среды, где
  // проверка заведомо нерепрезентативна (мок/юнит-прогон). Для сознательного
  // обхода на реальной машине есть отдельный рубильник
  // AIF_CLAUDE_SKIP_VERSION_CHECK=1 — он развязан с тестовыми переменными.
  // Ранний выход во всех «небоевых» режимах: явный skip-флаг, мок query() и
  // юнит-прогон (VITEST/NODE_ENV=test). Integration-смоук флагует себя отдельно
  // и принудительно включает проверку: он как раз про реальный бинарник.
  if (
    process.env.AIF_CLAUDE_SKIP_VERSION_CHECK === "1" ||
    isClaudeQueryMocked() ||
    ((Boolean(process.env.VITEST) || process.env.NODE_ENV === "test") && !isIntegration)
  ) {
    return;
  }
  const probeFn = deps?.probeClaudeVersion ?? probeClaudeVersion;
  const readBundledFn = deps?.readBundledClaudeVersion ?? readBundledClaudeVersion;

  // Единая точка выбора «какой бинарник проверяем»: вся логика разрешения
  // (spawn против manifest, кэш) спрятана в resolveEffectiveVersion, а guard
  // ниже работает уже с готовым ответом.
  const { info, raw, error, source } = await resolveEffectiveVersion(
    executablePath,
    probeFn,
    readBundledFn,
    deps,
  );

  // Контекст pino: каждое поле — ответ на будущий вопрос из тикета («какой
  // бинарник проверяли», «что он напечатал», «против какого минимума»). Логи —
  // единственный след, когда пользовательский процесс уже завершился.
  if (!info) {
    // Версия не определима — предупреждаем и идём дальше. Блокировать запуск из-
    // за собственного незнания означало бы отсечь валидные конфигурации; факти-
    // ческую несовместимость покажет упавший процесс через diagnoseClaudeError.
    logger?.warn?.(
      {
        ...context,
        executablePath: executablePath ?? null,
        versionSource: source,
        probeError: error,
        probeOutput: raw,
        minVersion: CLAUDE_MIN_VERSION,
      },
      "WARN [runtime:claude] Could not determine Claude Code version; skipping compatibility check (run may fail if the binary is outdated)",
    );
    return;
  }

  // В сообщение попадает «происхождение» бинарника вместо пути: для встроенного
  // варианта путь в node_modules только запутал бы пользователя, а для явного —
  // путь уже есть в executablePath.
  const location =
    source === "bundled"
      ? "bundled with @anthropic-ai/claude-agent-sdk"
      : (executablePath ?? "PATH");

  if (isVersionBelowMin(info)) {
    // Структурированная ошибка по правилам проекта: код CLAUDE_VERSION_UNSUPPORTED
    // и категория "transport" — потребители ветвятся по этим полям, а человек из
    // текста получает и причину (пустые attribution-строки), и команду апгрейда.
    throw new ClaudeRuntimeAdapterError(
      `Claude Code ${info.raw} at ${location} is below the supported minimum ` +
        `${CLAUDE_MIN_VERSION}: older builds reject the empty attribution strings used to suppress ` +
        `Co-Authored-By trailers and exit with code 1. ${formatUpgradeHint(source, executablePath)}`,
      "CLAUDE_VERSION_UNSUPPORTED",
      "transport",
    );
  }

  // Успех тоже логируется: «какая именно версия была признана совместной» —
  // первый вопрос при разборе странных ранов на чужих машинах.
  logger?.debug?.(
    {
      ...context,
      executablePath: executablePath ?? null,
      versionSource: source,
      claudeVersion: info.raw,
      minVersion: CLAUDE_MIN_VERSION,
    },
    "[runtime:claude] Claude Code version compatibility check passed",
  );
}
