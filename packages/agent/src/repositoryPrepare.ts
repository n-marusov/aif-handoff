/**
 * Подготовка целевого репозитория перед запуском стадии.
 *
 * Сценарий один для двух входов - автоматического подключения VCS (Connect и
 * Sync) и обычной работы по клону: оба обязаны оставить корень проекта в
 * одинаковом состоянии, поэтому различия провайдеров сведены к минимуму.
 *
 * Инварианты и подводные камни, определившие форму кода:
 * - шаги идут строго по порядку и не пропускаются: remote add требует готового
 *   репозитория, checkout - сделанного fetch, submodule init - готового
 *   checkout, а push - существующего локального коммита;
 * - все шаги синхронные: подготовка выполняется до стадии, и асинхронность
 *   сделала бы порядок шагов неочевидным для читателя;
 * - любой сбой прекращает работу и бросает RepositoryPrepareError с машинным
 *   kind: вызывающий код ветвится по kind, а текст сообщения нужен только
 *   диагностике;
 * - повторный прогон безопасен: каждая ветка сначала смотрит на фактическое
 *   состояние (наличие .git, remote, ветки, scaffold), а не на флаги;
 * - токен не попадает ни в код, ни в конфиг git: helper подставляет значение
 *   переменной окружения в момент вызова, а хранится только её имя;
 * - состояние после подготовки живёт в git, поэтому функция возвращает лишь
 *   отметку времени, а не снимок репозитория.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@aif/shared";
import { initProject } from "@aif/runtime";
import { getRuntimeRegistrySync } from "./coordinator.js";

// Логгер с именем модуля: по нему сообщения подготовки отделяются от сообщений
// стадии в общем потоке агента.
const log = logger("repository-prepare");

// Перечисление закрыто: алгоритм подготовки общий для всех провайдеров, а
// различия сводятся к URL и имени переменной с токеном. Новый провайдер - это
// новое значение здесь, а не отдельная ветка в prepareRepository.
export type RepositoryProvider = "github" | "gitlab";

// kind - часть публичного контракта. Значение добавляется вместе с новым шагом
// подготовки, чтобы потребителю не приходилось разбирать текст ошибки: сообщение
// со временем меняется, kind - нет.
export type RepositoryPrepareErrorKind =
  | "init_repo_failed"
  | "remote_failed"
  | "credential_failed"
  | "safe_directory_failed"
  | "fetch_failed"
  | "checkout_failed"
  | "submodule_failed"
  | "init_failed"
  | "commit_failed"
  | "push_failed"
  | "registry_unavailable"
  | "project_not_found"
  | "connection_not_found";

/** Структурированная ошибка подготовки — потребители ветвятся по `kind`, никогда по тексту сообщения. */
export class RepositoryPrepareError extends Error {
  readonly kind: RepositoryPrepareErrorKind;
  readonly projectId: string;
  readonly provider: RepositoryProvider;

  constructor(
    kind: RepositoryPrepareErrorKind,
    message: string,
    projectId: string,
    provider: RepositoryProvider,
  ) {
    super(message);
    this.name = "RepositoryPrepareError";
    this.kind = kind;
    this.projectId = projectId;
    this.provider = provider;
  }
}

// Вход собирается из записи о подключении VCS, поэтому здесь лежит имя
// переменной с токеном, а не сам токен: секрет существует только в окружении
// агента и в конфигурации git не оседает.
export interface RepositoryPrepareInput {
  projectId: string;
  projectRoot: string;
  provider: RepositoryProvider;
  /** HTTPS URL remote (суффикс `.git` не обязателен, но принят). */
  remoteUrl: string;
  /** Переменная окружения с API-токеном внутри контейнера агента. */
  tokenEnvVar: string;
  /** Имя пользователя шелла, используемое HTTPS credential helper. */
  credentialUsername: string;
  /** Ветка, которую чекаутят с remote; резервное значение — `main`. */
  defaultBranch: string;
}

// Результат намеренно не описывает состояние репозитория: единственный источник
// правды - сам git, и копия этого состояния в объекте быстро разошлась бы с
// реальностью.
export interface RepositoryPrepareResult {
  preparedAt: string;
}

// execFileSync выбрасывает обычный Error и прячет stderr внутри message, поэтому
// здесь нужен только человекочитаемый хвост - он уйдёт в текст типизированной
// ошибки.
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Все команды выполняются с cwd = корень проекта: git ищет репозиторий вверх по
// дереву, и без явного cwd он мог бы найти чужой .git.
// stdin отключён намеренно: git не должен ждать ввода (например, логина), иначе
// агент зависнет. stdout и stderr перехватываются, чтобы вывод git не смешивался
// с логами стадии.
function runGit(projectRoot: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Отличие от runGit только в возврате stdout: нужен там, где ответ git является
// данными (текущая ветка, список изменённых файлов), а не только кодом возврата.
function captureGit(projectRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// У `git remote` нет машинного формата вывода, поэтому список разбирается
// построчно. Ошибка трактуется так же, как отсутствие remote: на этом шаге
// безопаснее попробовать добавить origin заново, чем упасть на диагностике.
function hasRemote(projectRoot: string, name: string): boolean {
  try {
    return captureGit(projectRoot, ["remote"])
      .split("\n")
      .map((line) => line.trim())
      .includes(name);
  } catch {
    return false;
  }
}

// Проверка идёт до checkout и именно она различает пустой origin и готовый: от
// этого зависит, создаётся ветка локально или принимается с удалённой стороны.
// Используется код возврата show-ref, а не разбор вывода.
function remoteBranchExists(projectRoot: string, branch: string): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

// safe-обёртки намеренно гасят ошибку git и возвращают нулевое значение: это
// проверки состояния, вызываемые в ветках, где сбой не должен валить весь шаг.
function safeGetBranch(projectRoot: string): string | null {
  try {
    return captureGit(projectRoot, ["branch", "--show-current"]) || null;
  } catch {
    return null;
  }
}

// Отсутствие HEAD означает репозиторий без коммитов - единственный признак
// "пустого" локального репозитория, на который опираются checkout и push ниже.
function safeHasHead(projectRoot: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd: projectRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Провайдер-независимый авто-бутстрап локального git-репозитория проекта.
 *
 * GitHub и GitLab делят этот алгоритм, чтобы Connect и Sync оставляли корень
 * проекта в одинаково подготовленном состоянии — точкой входа является VCS-
 * подключение, а не ручной клон.
 *
 * Порядок операций:
 * 1. поднять отсутствующий репозиторий (`git init` — эквивалент клона для
 *    пустого каталога, чтобы `origin`/fetch было к чему прикрепить);
 * 2. добавить remote `origin`;
 * 3. настроить HTTPS credential helper (токен остаётся в окружении; шелл
 *    раскрывает на лету только имя его переменной);
 * 4. зарегистрировать `safe.directory`;
 * 5. сделать fetch `origin`;
 * 6. чекаутить **ветку по умолчанию** remote — как бы она ни называлась. Локальный
 *    репозиторий без коммитов принудительно принимает удалённую ветку (семантика
 *    клона); иначе ветка сбрасывается на состояние remote;
 * 7. инициализировать git-подмодули, если есть `.gitmodules` — гарантирует
 *    доступность связных зависимостей после checkout ветки;
 * 8. инициализировать скаффолдинг AI Factory, если нет `.ai-factory/`;
 * 9. настроить локальную git-идентичность (user.email / user.name), чтобы
 *    последующие коммиты не падали с "Author identity unknown" в контейнерах;
 * 10. закоммитить оставшиеся файлы скаффолдинга;
 * 11. если ветки по умолчанию на remote ещё не было, запушить скаффолдинг как
 *    начальное содержимое этой ветки.
 *
 * Выполняется синхронно и бросает типизированную {@link RepositoryPrepareError}
 * при первом сбое (без молчаливых повторов).
 */
export function prepareRepository(input: RepositoryPrepareInput): RepositoryPrepareResult {
  const { projectId, projectRoot, provider, remoteUrl, tokenEnvVar, credentialUsername } = input;
  // defaultBranch приходит из записи синка и может оказаться пустой строкой, а
  // у GitHub и GitLab ветка по умолчанию называется main: это запасной вариант.
  const defaultBranch = input.defaultBranch?.trim() || "main";

  // Вход логируется до первой мутации: если подготовка упадёт, в логе останется
  // состояние, с которым шаг начинался.
  log.info(
    { projectId, provider, projectRoot, defaultBranch, origin: remoteUrl },
    "Preparing repository",
  );

  // 1. Поднимаем обычный каталог: `git remote add` нужен репозиторий, и корень
  // проекта, созданный без него, упал бы ещё до всякого fetch.
  if (!existsSync(join(projectRoot, ".git"))) {
    // Каталог может ещё не существовать - git init сам его не создаёт и упал бы с
    // менее понятным сообщением.
    mkdirSync(projectRoot, { recursive: true });
    try {
      runGit(projectRoot, ["init"]);
      log.info({ projectId, provider, projectRoot }, "Initialized git repository before prepare");
    } catch (err) {
      throw new RepositoryPrepareError(
        "init_repo_failed",
        `git init failed: ${errorMessage(err)}`,
        projectId,
        provider,
      );
    }
  }

  // 2. origin
  if (!hasRemote(projectRoot, "origin")) {
    try {
      runGit(projectRoot, ["remote", "add", "origin", remoteUrl]);
      log.debug({ projectId, provider, origin: remoteUrl }, "Added origin remote");
    } catch (err) {
      throw new RepositoryPrepareError(
        "remote_failed",
        `git remote add failed: ${errorMessage(err)}`,
        projectId,
        provider,
      );
    }
  } else {
    // Ветка существует ради лога: молчаливое повторное подключение потом трудно
    // отличить от первого.
    log.debug({ projectId, provider }, "Origin remote already present");
  }

  // 3. credential helper (токен читается из env контейнера агента в рантайме)
  if (!process.env[tokenEnvVar]?.trim()) {
    throw new RepositoryPrepareError(
      "credential_failed",
      `Environment variable ${tokenEnvVar} is not set in the agent container.`,
      projectId,
      provider,
    );
  }
  // Строка helper-а - шелл-функция, которую git выполняет сам. Конструкция
  // `$${tokenEnvVar}` раскрывается в ссылку на переменную окружения, а не в
  // секрет: значение подставит шелл в момент вызова.
  const credentialHelper = `!f() { echo username=${credentialUsername}; echo password=$${tokenEnvVar}; }; f`;
  try {
    // Уровень репозитория: используется для fetch/push этого репозитория
    runGit(projectRoot, ["config", "credential.helper", credentialHelper]);
    // Глобальный уровень: наследуется git clone при init подмодулей (новые репозитории
    // не наследуют repo-конфиг). Область — контейнер, поэтому несколько
    // проектов на одном агенте делят один credential helper.
    execFileSync("git", ["config", "--global", "credential.helper", credentialHelper], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    log.debug({ projectId, provider }, "Configured credential helper (repo + global)");
  } catch (err) {
    throw new RepositoryPrepareError(
      "credential_failed",
      `git config credential.helper failed: ${errorMessage(err)}`,
      projectId,
      provider,
    );
  }

  // 4. safe.directory (идемпотентно)
  try {
    // Запись добавляется флагом --add и потому накапливается при каждом прогоне:
    // дубликаты безвредны, а правка уже существующей записи была бы рискованнее.
    execFileSync("git", ["config", "--global", "--add", "safe.directory", projectRoot], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    log.debug({ projectId, provider, projectRoot }, "Added safe.directory");
  } catch (err) {
    throw new RepositoryPrepareError(
      "safe_directory_failed",
      `git config safe.directory failed: ${errorMessage(err)}`,
      projectId,
      provider,
    );
  }

  // 5. fetch origin
  try {
    // fetch идёт до checkout: без него не существует refs/remotes/origin/*, и
    // проверить наличие ветки на удалённой стороне невозможно.
    runGit(projectRoot, ["fetch", "origin"]);
    log.debug({ projectId, provider }, "Fetched origin");
  } catch (err) {
    throw new RepositoryPrepareError(
      "fetch_failed",
      `git fetch origin failed: ${errorMessage(err)}. Check token access.`,
      projectId,
      provider,
    );
  }

  // 6. определяем ветку по умолчанию (как бы она ни называлась). Пустой origin:
  // сохраняем локальную ветку, переименовываем в defaultBranch и пушим скаффолдинг
  // как начальное содержимое на шаге 9.
  // Признак запоминается: он понадобится дважды - при выборе ветки checkout и при
  // решении, публиковать ли scaffold как начальное содержимое.
  const remoteExists = remoteBranchExists(projectRoot, defaultBranch);
  if (remoteExists) {
    // У репозитория с нулём коммитов нет истории, которую нужно беречь: форсируем
    // checkout, чтобы untracked-файлы скаффолдинга не мешали принять remote
    // (именно так Sync теперь ведёт себя как clone).
    const adoptForcefully = !safeHasHead(projectRoot);
    // -B, а не -b: локальная ветка принудительно ставится на origin/defaultBranch,
    // потому что источником правды считается удалённая ветка. Локальные, ещё не
    // отправленные коммиты при этом не сохраняются.
    const args = adoptForcefully
      ? ["checkout", "-f", "-B", defaultBranch, `origin/${defaultBranch}`]
      : ["checkout", "-B", defaultBranch, `origin/${defaultBranch}`];
    try {
      runGit(projectRoot, args);
      log.info(
        { projectId, provider, defaultBranch, adopted: adoptForcefully },
        adoptForcefully
          ? "Adopted remote default branch into a repository without commits"
          : "Checked out remote default branch",
      );
    } catch (err) {
      throw new RepositoryPrepareError(
        "checkout_failed",
        `git ${args.join(" ")} failed: ${errorMessage(err)}`,
        projectId,
        provider,
      );
    }
  } else {
    try {
      // Обратный случай: ветки на удалённой стороне нет. Локальная история не
      // трогается, меняется только имя - чтобы push ниже ушёл в ожидаемое.
      const current = safeGetBranch(projectRoot);
      if (current && current !== defaultBranch) {
        runGit(projectRoot, ["branch", "-M", defaultBranch]);
        log.info({ projectId, provider, defaultBranch }, "Renamed local branch");
      }
    } catch (err) {
      throw new RepositoryPrepareError(
        "checkout_failed",
        `git branch -M ${defaultBranch} failed: ${errorMessage(err)}`,
        projectId,
        provider,
      );
    }
  }

  // 7. инициализируем git-подмодули (идемпотентно) — только когда проект
  // объявляет подмодули через `.gitmodules`. После checkout URL подмодулей
  // известны; это подтягивает связные зависимости, чтобы дерево было полным.
  if (existsSync(join(projectRoot, ".gitmodules"))) {
    try {
      // --recursive обязателен для вложенных сабмодулей: без него внешний слой
      // инициализируется, а внутренний остаётся пустым.
      runGit(projectRoot, ["submodule", "update", "--init", "--recursive"]);
      log.info({ projectId, provider }, "Initialized git submodules");
    } catch (err) {
      throw new RepositoryPrepareError(
        "submodule_failed",
        `git submodule update --init --recursive failed: ${errorMessage(err)}`,
        projectId,
        provider,
      );
    }
  } else {
    log.debug({ projectId, provider }, "No .gitmodules found; skipping submodule init");
  }

  // 8. init AI Factory (идемпотентно) — только когда скаффолдинга нет.
  if (!existsSync(join(projectRoot, ".ai-factory"))) {
    // Реестр запрашивается в момент вызова, а не импортируется значением на
    // уровне модуля: к моменту загрузки файла инициализация рантаймов может быть
    // не завершена, и модульная константа зафиксировала бы null навсегда.
    const registry = getRuntimeRegistrySync();
    if (!registry) {
      throw new RepositoryPrepareError(
        "registry_unavailable",
        "Runtime registry is not initialized yet",
        projectId,
        provider,
      );
    }
    // initProject возвращает результат, а не бросает: так сбой скаффолда
    // приводится к тому же контракту ошибок, что и сбои git.
    const initResult = initProject({ projectRoot, registry });
    if (!initResult.ok) {
      throw new RepositoryPrepareError(
        "init_failed",
        initResult.error ?? "ai-factory init failed",
        projectId,
        provider,
      );
    }
    log.debug({ projectId, provider }, "AI Factory init step completed");
  } else {
    log.debug({ projectId, provider }, "AI Factory scaffold already present");
  }

  // 9. убеждаемся, что для этого репозитория настроена git-идентичность
  // (Docker-контейнеры могут не иметь глобальных user.name/user.email — "Author identity unknown").
  // Идентичность задаётся локально в этом репозитории, а не глобально: агент
  // обслуживает несколько проектов, и общий конфиг протёк бы между ними.
  try {
    runGit(projectRoot, ["config", "user.email", "aif-handoff@ai-factory"]);
    runGit(projectRoot, ["config", "user.name", "AIF Handoff"]);
  } catch (err) {
    throw new RepositoryPrepareError(
      "commit_failed",
      `git config user failed: ${errorMessage(err)}`,
      projectId,
      provider,
    );
  }

  // 9. коммитим скаффолдинг — любые untracked/изменённые файлы (свежий init или
  // остатки частичного прогона), чтобы ветка по умолчанию была чистой. Чистое
  // дерево — не ошибка.
  // Проверка идёт по porcelain-выводу, а не по `git diff`: нужны и новые файлы,
  // и изменения в уже отслеживаемых.
  const dirty = captureGit(projectRoot, ["status", "--porcelain"]);
  if (dirty.length > 0) {
    try {
      runGit(projectRoot, ["add", "-A"]);
      // Хуки пропускаются осознанно: коммит технический, а хуки проекта могут
      // требовать ещё не установленных зависимостей.
      runGit(projectRoot, ["commit", "-m", "chore: ai-factory scaffold", "--no-verify"]);
      log.info(
        { projectId, provider, fileCount: dirty.split("\n").length },
        "Committed AI Factory scaffold",
      );
    } catch (err) {
      throw new RepositoryPrepareError(
        "commit_failed",
        `git commit scaffold failed: ${errorMessage(err)}`,
        projectId,
        provider,
      );
    }
  } else {
    log.debug({ projectId, provider }, "No scaffold files to commit");
  }

  // Нумерация шагов в комментариях повторяет девятку и перескакивает на 11: это
  // исторический след, сам порядок выполнения строго линейный.
  // 11. путь пустого origin: пушим скаффолдинг как начальную ветку по умолчанию
  // (только когда есть локальный коммит для пуша).
  // Пуш выполняется только для пустого origin. Если ветка на удалённой стороне
  // уже была, её содержимое считается источником правды, и публикация отдана
  // штатному workflow стадии.
  if (!remoteExists && safeHasHead(projectRoot)) {
    try {
      runGit(projectRoot, ["push", "-u", "origin", defaultBranch]);
      log.info({ projectId, provider, defaultBranch }, "Pushed scaffold as initial default branch");
    } catch (err) {
      throw new RepositoryPrepareError(
        "push_failed",
        `git push -u origin ${defaultBranch} failed: ${errorMessage(err)}`,
        projectId,
        provider,
      );
    }
  } else if (!remoteExists) {
    log.debug({ projectId, provider }, "No local commit to push; skipping");
  }

  // Возвращается только отметка времени - для аудита; фактическое состояние
  // проверяется командами git, а не этим объектом.
  return { preparedAt: new Date().toISOString() };
}
