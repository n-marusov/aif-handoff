/**
 * Инициализация целевого проекта под работу AI-рантаймов.
 *
 * Модуль готовит каталог проекта к запуску в нём агентов: базовый каркас
 * (каталог + git-репозиторий) и каталог .ai-factory/, который создаёт внешняя
 * CLI-утилита ai-factory. Всё выполняется синхронно через execFileSync: инициализация
 * - редкая и короткая операция, и асинхронный колбэк с промисами здесь только
 * усложнил бы обработку ошибок без какой-либо выгоды.
 *
 * Два сквозных приёма, повторяющихся в файле:
 * - «локально, потом npx»: сначала пробуем разрешить бин ai-factory из node_modules
 *   (быстро, без сети, версия зафиксирована package.json), при неудаче откатываемся
 *   к npx (глобальные установки и доборка из registry).
 * - проверка версии перед вызовом: опция --config есть не у всех версий ai-factory,
 *   и передавать её вслепую значит упасть на незнакомом флаге у старых установок.
 *
 * Идемпотентность: повторные вызовы для уже инициализированного проекта ничего не
 * делают; неудачная инициализация НЕ оставляет половинчатый .ai-factory/, поэтому
 * следующий вызов попробует снова - самовосстановление без внешнего контроля.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { initBaseProjectDirectory, logger } from "@aif/shared";
import type { RuntimeRegistry } from "./registry.js";

// logger-фабрика даёт именованный канал (runtime-project-init): в общих логах
// видно, какой модуль сказал.
const log = logger("runtime-project-init");
// Мост ESM→CJS: в ES-модулях нет require, а разрешить путь бина npm-пакета
// (ai-factory/bin/...) удобнее всего именно require.resolve - он знает про
// node_modules, exports-поля и симлинки workspace. createRequire привязывает
// разрешение к URL текущего файла, т.е. к node_modules этого пакета.
const moduleRequire = createRequire(import.meta.url);
// Платформу читаем один раз при загрузке модуля: она не меняется в процессе,
// и константа позволяет TS сузить ветвления (в отличие от обращения к process
// в каждом месте, где type narrowing не сработает).
const IS_WINDOWS = process.platform === "win32";

/** Минимальная версия ai-factory, поддерживающая флаг --config. */
// Feature-gate по версии: кортеж [major, minor, patch] как const - и типизация
// (length 3 гарантирован), и отсутствие случайного сравнения строк "2.10.0" < "2.9.3",
// которое дало бы неверный порядок из-за лексикографии.
const CONFIG_FLAG_MIN_VERSION = [2, 9, 3] as const;

// Разбор версии из произвольного текста: вывод --version может обрасти шапками
// npx, предупреждениями и прочим шумом, поэтому ищется первый фрагмент
// X.Y.Z где угодно строке, а не вся строка целиком. Нет совпадения - null,
// вызывающий код трактовает это как «не знаем» и выбирает консервативный путь.
function parseVersion(raw: string): [number, number, number] | null {
  const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  // Числа, не строки: иначе сравнение 10 vs 9 работало бы по алфавиту.
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Лексикографическое сравнение трёхкомпонентных версий без внешних зависимостей
// (semver не тянем ради 10 строк). Рано возвращаем при первом отличившемся
// разряде; если все три равны - «не меньше» истина. Цикл по индексу, а не
// ручное сравнение полей: меньше шансов ошибиться в ветвлениях.
function isVersionAtLeast(
  version: [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] > minimum[i]) return true;
    if (version[i] < minimum[i]) return false;
  }
  return true; // equal
}

// Определяет версию ai-factory двумя попытками: локальный бин, затем npx.
// execFileSync (не execSync со строкой): аргументы передаются массивом без
// разбора оболочкой - вызываемая программа получает их буквально, и никакая
// инъекция через shell-спецсимволы невозможна в принципе.
// stdio: ["ignore", "pipe", "ignore"] - stdin закрыт (процесс не должен ждать
// ввода), stdout читаем (нужен номер версии), stderr глушим: там шапки npx и
// предупреждения, которые не должны влиять на разбор, а неглушёный stderr мог
// бы засорить логи родителя.
// timeout 15_000 защищает от подвешенной npx-доустановки: без лимита этот
// синхронный вызов остановил бы весь event loop на неопределённый срок.
function getAiFactoryVersion(): string | null {
  const execOptions: { encoding: "utf8"; timeout: number; stdio: ["ignore", "pipe", "ignore"] } = {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "ignore"],
  };

  // 1. Локальная установка — быстрее всего, без сети
  try {
    // process.execPath - абсолютный путь к текущему node: так запускаем скрипт
    // тем же интерпретатором, который уже найден и работает, без поиска node в PATH.
    const aiFactoryBin = moduleRequire.resolve("ai-factory/bin/ai-factory.js");
    return execFileSync(process.execPath, [aiFactoryBin, "--version"], execOptions).trim();
  } catch {
    // не установлено локально — идём дальше
    // Пустой catch намеренный: отсутствие локальной установки - штатная ситуация
    // (не каждый проект держит ai-factory в зависимостях), а не ошибка.
  }

  // 2. npx (Windows: cmd /d /c npx) — покрывает глобальные установки и удалённую загрузку
  // На Windows npx - это батник npx.cmd: execFileSync не умеет запускать .cmd
  // напрямую (CreateProcess не знает про PATHEXT для батчей), поэтому идём через
  // cmd.exe. Флаг /d отключает реестровые AutoRun-команды (чтобы чужие настройки
  // не ломали запуск), /c - выполнить и выйти. ComSpec - переменная, в которой
  // Windows хранит путь к оболочке; фолбэк cmd.exe на случай экзотических окружений.
  try {
    if (IS_WINDOWS) {
      const shell = process.env.ComSpec ?? "cmd.exe";
      return execFileSync(shell, ["/d", "/c", "npx ai-factory --version"], execOptions).trim();
    }
    // На POSIX npx - обычный исполняемый файл с шебангом, его можно запускать
    // напрямую, и shell не нужен вовсе - ещё одна гарантия отсутствия инъекций.
    return execFileSync("npx", ["ai-factory", "--version"], execOptions).trim();
  } catch {
    // Обе попытки провалились (нет сети, нет node в PATH, ai-factory недоступен).
    // Возвращаем null: вызывающие функции переводят «не знаем» в консервативный
    // режим (без --config / ok:false с внятной ошибкой), а не падают здесь.
    return null;
  }
}

// Отвечает на вопрос «можно ли передавать --config», и делает это консервативно:
// любая неизвестность (null версии, нераспознанный формат) - false. Цена ошибки
// несимметрична: лишний флаг у старой версии уронит всю инициализацию, а отсутствие
// флага у новой - лишь скатится на путь по умолчанию.
// Замечание о стоимости: функция дергает внешний процесс, поэтому вызывается
// один раз на инициализацию, а не на каждую команду.
function supportsConfigFlag(): boolean {
  const raw = getAiFactoryVersion();
  if (!raw) return false;
  const version = parseVersion(raw);
  if (!version) return false;
  return isVersionAtLeast(version, CONFIG_FLAG_MIN_VERSION);
}

export interface InitProjectOptions {
  /** Путь к корневому каталогу проекта. */
  projectRoot: string;
  /** Реестр runtime — из него собирают ID рантаймов для ai-factory init --agents. */
  // Реестр передаётся извне (DI), а не создаётся здесь: init не должен
  // пересобирать адаптеры и тем более тянуть секреты профилей - нужны только
  // дескрипторы с именами агентов.
  registry: RuntimeRegistry;
  /** Ограничить конкретными runtime ID. Без него используются все зарегистрированные рантаймы. */
  // Опциональное ограничение нужно для точечной инициализации под конкретный
  // рантайм (например, проект создали с одним провайдером, второй подключают позже).
  runtimeIds?: string[];
}

// Форма результата вместо исключений: вызывающий код (api) показывает ошибку
// пользователю в UI, и ok/error - естественный контракт для этого. При этом
// @throws всё же допустим (см. JSDoc ниже): сломанный каркас - не «пользовательская
// оплошность», а состояние, которое нельзя тихо проглотить.
export interface InitProjectResult {
  ok: boolean;
  error?: string;
}

// Команда как данные (command + args), а не как исполнение: resolve-функция
// остаётся чистой и тестируемой без реальных процессов, а исполнение - забота
// initProject, где есть cwd/timeout/обработка ошибок.
interface AiFactoryCommand {
  command: string;
  args: string[];
}

// Экранирование для cmd.exe: двойные кавычки внутри строки удваиваются ("") -
// это правило разбора аргументов Windows (CommandLineToArgvW/cmd), а не
// backslash-экранирование POSIX-шелов. Оболочка на Windows получает ОДНУ строку
// команды (args после /c склеиваются cmd), поэтому кавычки нельзя делегировать
// execFileSync - их нужно расставить вручную и корректно.
function quoteAgentIdsForCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

// Та же стратегия «локально → npx», что и при определении версии, но для самой
// команды init. Расхождение платформ на POSIX не требует кавычек: execFileSync
// передаёт каждый аргумент отдельной строкой, и запятые в claude,codex безвредны.
// На Windows вся команда собирается в одну строку для cmd /c, и вот там агент-
// список без кавычек был бы разбит cmd на токены (запятая - разделитель в cmd).
function resolveAiFactoryCommand(agentIds: string, useConfig: boolean): AiFactoryCommand {
  const configArgs = useConfig ? ["--config"] : [];

  try {
    // Локальная ветвь идёт без shell-кавычек вообще: process.execPath + массив
    // аргументов. Если ai-factory найден в node_modules, платформенные
    // тонкости cmd нас не касаются.
    const aiFactoryBin = moduleRequire.resolve("ai-factory/bin/ai-factory.js");
    return {
      command: process.execPath,
      args: [aiFactoryBin, "init", "--agents", agentIds, ...configArgs],
    };
  } catch {
    if (IS_WINDOWS) {
      const configSuffix = useConfig ? " --config" : "";
      return {
        command: process.env.ComSpec ?? "cmd.exe",
        args: [
          "/d",
          "/c",
          `npx ai-factory init --agents ${quoteAgentIdsForCmd(agentIds)}${configSuffix}`,
        ],
      };
    }

    return {
      command: "npx",
      args: ["ai-factory", "init", "--agents", agentIds, ...configArgs],
    };
  }
}

/**
 * Инициализирует каталог проекта всеми runtime-специфичными структурами.
 *
 * 1. Создаёт корень проекта + git-репозиторий (базовый каркас)
 * 2. Выполняет `ai-factory init --agents claude,codex`, если `.ai-factory/` ещё нет
 *
 * `.ai-factory/` создаётся исключительно командой `ai-factory init`. Если она
 * падает, каталог остаётся отсутствующим, и последующие вызовы повторят попытку.
 * Существующие проекты с `.ai-factory/` намеренно не переинициализируются здесь;
 * совместимость со старым состоянием bootstrap обеспечивают guards rollout runtime.
 *
 * Безопасно вызывать многократно — пропуск, если `.ai-factory/` уже существует.
 *
 * @throws Error, если `ai-factory init` падает — вызывающий обязан обработать это,
 *   чтобы не создавать проекты со сломанным каркасом.
 */
export function initProject(options: InitProjectOptions): InitProjectResult {
  const { projectRoot, registry, runtimeIds } = options;

  const aiFactoryDir = resolve(projectRoot, ".ai-factory");
  const alreadyInitialized = existsSync(aiFactoryDir);

  // Порядок важен: сначала базовый каркас (каталог + git), потом агентные
  // файлы. initBaseProjectDirectory намеренно НЕ создаёт .ai-factory/ - этот
  // каталог принадлежит внешней утилите, и двойной контроль над ним породил бы
  // конфликт версий «кто владелец».
  // 1. Базовый каркас: корень проекта + git (НЕ создаёт .ai-factory/)
  initBaseProjectDirectory(projectRoot);

  // 2. ai-factory init — только для свежих проектов
  // Ранний выход по alreadyInitialized: проверка сделана ДО scaffold-шага,
  // потому что она не зависит от него, а сам scaffold идемпотентен.
  if (alreadyInitialized) return { ok: true };

  const descriptors = registry.listRuntimes();
  // Фильтр по capability: не каждый адаптер понимает инициализацию проекта
  // (например, чисто-API-провайдеры без агентных файлов). Молча пропускать
  // неподдерживающие - ответственность дескриптора, а не этого модуля.
  const initCapable = descriptors.filter((d) => d.supportsProjectInit);
  const targets = runtimeIds ? initCapable.filter((d) => runtimeIds.includes(d.id)) : initCapable;

  const agentIds = [
    // Set в середине конвейера убирает дубли: два разных рантайма могут назвать
    // одного и того же агента (например, оба кладут .claude/), а ai-factory
    // принимает список через запятую и повтор в нём - мусор.
    ...new Set(
      targets.flatMap((descriptor) => {
        const agentName = descriptor.projectInitAgentName?.trim();
        if (agentName) return [agentName];

        // Пропуск с предупреждением вместо падения: один «неописанный» рантайм
        // не должен блокировать инициализацию всех остальных - частичный успех
        // здесь полезнее total-failure.
        log.warn(
          { projectRoot, runtimeId: descriptor.id },
          "Skipping runtime during ai-factory init because projectInitAgentName is missing",
        );
        return [];
      }),
    ),
  ].join(",");
  // Пустая строка означает «некого инициализировать» (нет init-capable рантаймов
  // или у всех нет agentName). Это не ошибка: проект просто не требует agent-
  // файлов, и ok:true корректнее, чем ложная тревога.
  if (!agentIds) return { ok: true };

  try {
    const useConfig = supportsConfigFlag();
    const command = resolveAiFactoryCommand(agentIds, useConfig);
    log.debug({ useConfig }, "ai-factory --config flag support");
    execFileSync(command.command, command.args, {
      // cwd обязателен: ai-factory ищет проект «от текущей директории», и без
      // явного cwd инициализация ушла бы в каталог процесса API, а не проекта.
      cwd: projectRoot,
      // Вывод не разбирается: успех = нулевой код возврата. stdio:"ignore"
      // не даёт болтовне CLI просочиться в логи сервиса.
      stdio: "ignore",
      timeout: 60_000,
    });
    log.info({ projectRoot, agents: agentIds }, "ai-factory init completed");
    return { ok: true };
  } catch (err) {
    // Нормализация unknown: throw в JS может быть чем угодно, поэтому err instanceof
    // Error - обязательная проверка перед чтением message.
    const message =
      err instanceof Error ? err.message : "ai-factory init failed with unknown error";
    log.error(
      { projectRoot, agents: agentIds, err },
      "ai-factory init failed — project scaffold is incomplete",
    );
    return {
      ok: false,
      // Текст ошибки намеренно содержит инструкцию (проверить npx ai-factory
      // --version): пользователь увидит её в UI без доступа к логам, и она
      // должна быть полезна сама по себе.
      error: `Project initialization failed: could not run "ai-factory init". ${message}. Make sure ai-factory is available (npx ai-factory --version) and try again.`,
    };
  }
}
