/**
 * Детерминированный commit-гейт для плана задачи.
 *
 * Зачем отдельный модуль: перед публикацией plan PR/MR нужно зафиксировать в git
 * ровно один файл - план задачи. Если коммитить все изменения рабочего дерева,
 * агент утащит в ветку плана незавершенный продуктовый код, и ревьюер увидит
 * мусор. Поэтому стейджится только путь плана плюс явно разрешенные пути, а
 * любой другой грязный файл блокирует коммит целиком.
 *
 * Почему возвращается отчет, а не исключение: ожидаемые состояния-стражи
 * (нет плана, не git-репозиторий, грязные продуктовые файлы) - это нормальные
 * исходы, а не сбои. Решение, считать ли их фатальными, принимает вызывающий
 * код (planReviewPublisher): только он знает контекст задачи.
 *
 * Тонкости:
 * - успех проверяется по сдвигу HEAD, а не по exit code: git commit может
 *   вернуть 0 и не создать коммит, если индекс оказался пустым.
 * - пути сравниваются как абсолютные (Set), а наружу отдаются в posix-форме:
 *   на Windows разделители другие, а git всегда пишет прямые слеши.
 * - вывод git может быть огромным, поэтому ошибки обрезаются до MAX_ERROR_LENGTH
 *   перед попаданием в лог и в отчет.
 */

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { findTaskById } from "@aif/data";
import {
  getProjectConfig,
  getCurrentBranch,
  getHeadCommitSha,
  isGitRepo,
  logger,
} from "@aif/shared";
import {
  buildPlanCommitSubject,
  resolveTargetProjectGitConventions,
  type TargetProjectGitConventions,
} from "./gitConventions.js";

// Пространство имен логгера совпадает с модулем: по нему удобно фильтровать
// события гейта отдельно от остального пайплайна агента.
const log = logger("plan-review:commit");

// Объединение статусов вместо boolean-флага: вызывающий код обязан разобрать
// каждый исход, а компилятор подскажет, если появится новый статус.
export type PlanReviewCommitStatus =
  | "committed"
  | "no_changes"
  | "blocked_missing_plan"
  | "blocked_dirty_product_files"
  | "not_a_git_repo"
  | "commit_failed";

// Отчет - это обычные данные: он уходит в лог, в API-ответ и в тесты, поэтому
// здесь нет методов и ничего несериализуемого.
export interface PlanReviewCommitReport {
  status: PlanReviewCommitStatus;
  commitSha: string | null;
  /** Ветка, в которую попал коммит плана. */
  branch: string | null;
  /** Путь staged-файла плана относительно корня репозитория. */
  planPath: string | null;
  conventionSource: string;
  /** Subject коммита, который был бы (или был) использован. */
  commitMessage: string | null;
  /** Относительные пути, добавленные в индекс этим вызовом. */
  stagedPaths: string[];
  /** Грязные продуктовые файлы (до MAX_DIRTY_PREVIEW), заблокировавшие коммит. */
  dirtyProductPaths: string[];
  error?: string;
}

// Границы нужны, чтобы отчет не разросся: превью грязных файлов и текст ошибки
// попадают в логи и в ответы API, а длинные списки там бесполезны.
const MAX_DIRTY_PREVIEW = 20;
const MAX_ERROR_LENGTH = 500;

// Внутренний результат вызова git: runGit никогда не бросает, поэтому код
// возврата и оба потока вывода нужно вернуть явно.
interface GitResult {
  stdout: string;
  stderr: string;
  status: number;
}

// Обертка над execFileSync. Важно, что запускается именно файл git, а не
// shell-строка: аргументы не проходят через интерпретатор, поэтому пробелы и
// спецсимволы в путях не превращаются в инъекцию.
function runGit(cwd: string, args: string[]): GitResult {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    cwd,
    // stdout и stderr забираем через pipe, чтобы вернуть их в отчет, а stdin
    // закрываем: иначе git может открыть интерактивный запрос (например,
    // запрос учетных данных) и процесс зависнет до таймаута всего пайплайна.
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  try {
    const stdout = execFileSync("git", args, options);
    return { stdout: stdout.toString(), stderr: "", status: 0 };
  } catch (err) {
    // В strict-режиме err имеет тип unknown, поэтому сужаем его структурным
    // типом с необязательными полями. Поле status отсутствует, если процесс
    // даже не запустился (например, git не установлен), - тогда считаем код 1.
    const failure = err as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      stdout: String(failure.stdout ?? "").trim(),
      stderr: String(failure.stderr ?? "").trim(),
      status: failure.status ?? 1,
    };
  }
}

// Ключ -z включает NUL-разделитель записей и отключает экранирование имен:
// пробелы, кавычки и юникод приходят в исходном виде, а разбор сводится к
// тривиальному split по нулевому символу.
/** Список грязных путей относительно корня репозитория (изменённые + untracked файлы). */
function listDirtyPaths(root: string): string[] {
  const { stdout, status } = runGit(root, ["status", "--porcelain", "-uall", "-z"]);
  if (status !== 0) return [];
  const paths: string[] = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    // Записи rename/copy несут второй NUL-запись только с исходным путём.
    // У неё нет префикса "XY ", поэтому пропускаем — назначения достаточно.
    if (record[2] !== " ") continue;
    const path = record.slice(3);
    if (path) paths.push(path);
  }
  return paths;
}

// Показывает файлы, попавшие в индекс относительно HEAD: именно это, а не
// предположения вызывающего кода, определяет содержимое будущего коммита.
function listStagedPaths(root: string): string[] {
  const { stdout, status } = runGit(root, ["diff", "--cached", "--name-only", "-z"]);
  if (status !== 0) return [];
  return stdout.split("\0").filter(Boolean);
}

// Модель часто копирует путь вместе с символом @ (как в некоторых IDE),
// поэтому его срезаем. Пустая строка означает "план по умолчанию из конфига".
function normalizePlanPath(rawPath: string, projectRoot: string): string {
  const trimmed = rawPath.trim().replace(/^@+/, "");
  if (!trimmed) {
    return getProjectConfig(projectRoot).paths.plan;
  }
  return trimmed;
}

// stderr от git бывает очень длинным; обрезаем, чтобы отчет оставался читаемым.
function sanitizeError(stderr: string): string {
  return stderr.slice(0, MAX_ERROR_LENGTH);
}

// Сравнивать пути между собой нужно в одном виде, иначе Windows-разделители
// разведут один и тот же файл по двум разным элементам множества.
/** Git-пути всегда используют прямые слеши, даже на Windows. */
function toPosixPath(pathValue: string): string {
  return pathValue.split("\\").join("/");
}

/**
 * Создаёт детерминированный коммит только с планом на текущей ветке. Могут
 * быть staged только файл плана задачи (плюс явно разрешённые пути); любой
 * прочий грязный файл считается продуктовой работой и блокирует коммит, пока
 * рабочее дерево не очищено.
 *
 * Для ожидаемых защитных состояний возвращает структурированный отчёт, а не
 * бросает; вызывающие код (публикатор plan review) решают, фатальна ли защита.
 */
export function ensurePlanReviewCommit(input: {
  taskId: string;
  /** Корень репозитория проекта; рабочее дерево git по умолчанию это он. */
  projectRoot: string;
  /** Необязательный путь рабочего дерева git (worktree задачи или общий checkout). */
  executionRoot?: string;
  /** Доп. относительные пути, разрешённые рядом с планом. */
  extraAllowedPaths?: string[];
  /** Заранее разрешённые конвенции (для тестируемости; иначе разрешаются сами). */
  conventions?: TargetProjectGitConventions;
}): PlanReviewCommitReport {
  // Задача нужна для заголовка коммита и пути плана. Отсутствие записи в БД -
  // это ошибка программиста, а не рабочий сценарий, поэтому здесь исключение.
  const task = findTaskById(input.taskId);
  if (!task) {
    throw new Error(`Task ${input.taskId} not found for plan review commit`);
  }
  // План может готовиться как в отдельном worktree задачи, так и в общем чекауте
  // проекта: наружу эта разница не видна, она остается в локальной переменной.
  const executionRoot = input.executionRoot ?? input.projectRoot;

  // Ранний выход до любых изменений в репозитории: без git коммитить некуда, и
  // вызывающий получает честный статус вместо исключения.
  if (!isGitRepo(executionRoot)) {
    log.warn(
      { taskId: task.id, executionRoot },
      "Plan review commit blocked: not a git repository",
    );
    return {
      status: "not_a_git_repo",
      commitSha: null,
      branch: null,
      planPath: null,
      conventionSource: "n/a",
      commitMessage: null,
      stagedPaths: [],
      dirtyProductPaths: [],
    };
  }

  // Гарантируем локальную настроенность Git-идентичности, чтобы детерминированные коммиты
  // работали и в средах (например, Docker-контейнерах) без глобального конфига.
  // user.email - индикатор полной идентичности: git откажется коммитить, если не
  // заданы оба поля. В контейнерах глобальный конфиг обычно пуст, поэтому
  // локально дописываем пару name/email, но только когда она не настроена.
  const who = runGit(executionRoot, ["config", "user.email"]);
  if (!who.stdout.trim()) {
    runGit(executionRoot, ["config", "user.name", "AI Factory Agent"]);
    runGit(executionRoot, ["config", "user.email", "agent@aif.handoff"]);
    log.debug(
      { taskId: task.id, executionRoot },
      "Set fallback Git identity for plan review commit",
    );
  }

  // Соглашения проекта разрешаются один раз и передаются вниз: повторный разбор
  // мог бы дать разные значения в пределах одного вызова. Возможность передать
  // готовый объект снаружи оставлена для тестов.
  const conventions = input.conventions ?? resolveTargetProjectGitConventions(executionRoot);
  // planPath хранится в БД как есть (может быть относительным и с символом @),
  // поэтому приводим его к двум видам сразу: относительный путь для git-вывода
  // и абсолютный - для проверки существования файла.
  const planRel = normalizePlanPath(task.planPath, executionRoot);
  const planAbs = resolve(executionRoot, planRel);
  const branch = getCurrentBranch(executionRoot);

  // Нет файла - нет коммита: пустой план нельзя выдавать за результат работы.
  if (!existsSync(planAbs)) {
    log.warn(
      { taskId: task.id, executionRoot, planRel, conventionSource: conventions.source },
      "Plan review commit blocked: plan file is missing",
    );
    return {
      status: "blocked_missing_plan",
      commitSha: null,
      branch,
      planPath: planRel,
      conventionSource: conventions.source,
      commitMessage: null,
      stagedPaths: [],
      dirtyProductPaths: [],
    };
  }

  // Белый список путей - сердце гейта. Все, что не попало в это множество,
  // считается продуктовым кодом и блокирует коммит.
  const allowedAbs = new Set<string>([
    planAbs,
    ...(input.extraAllowedPaths ?? []).map((p) => resolve(executionRoot, p)),
  ]);
  // Те же пути, но в posix-форме: git отдает относительные пути от корня
  // рабочего дерева именно так, поэтому и сравнение идет по этому множеству.
  const allowedRel = new Set<string>(
    [...allowedAbs].map((abs) => toPosixPath(relative(executionRoot, abs))),
  );

  // Префиксы инфраструктурных каталогов — скаффолдинг, созданный инструментами
  // (planner, initProject), а не продуктовый код. Разрешаем файлы под этими
  // префиксами в коммите плана, чтобы ревью плана не блокировалось артефактами
  // подготовки, но реальные продуктовые файлы всё равно ловились.
  // Замыкающий слеш в префиксах обязателен: без него ".claude" совпал бы и
  // с каталогом вида ".claude-backup" в корне репозитория.
  const INFRASTRUCTURE_PREFIXES = [".ai-factory/", ".claude/", ".llm-backup/"];

  // Список грязных файлов берется у git, а не из внутреннего состояния агента:
  // это единственный источник правды о том, что реально изменилось на диске.
  const dirty = listDirtyPaths(executionRoot);
  const dirtyAbs = new Set(dirty.map((path) => resolve(executionRoot, path)));
  // Продуктовым считается любой грязный путь, который не разрешен явно и не
  // лежит под инфраструктурным префиксом; resolve нужен из-за различий в
  // написании путей у git и у вызывающего кода.
  const dirtyProductPaths = dirty.filter((path) => {
    if (allowedAbs.has(resolve(executionRoot, path))) return false;
    const rel = toPosixPath(path);
    return !INFRASTRUCTURE_PREFIXES.some((prefix) => rel.startsWith(prefix));
  });

  // Fail-closed: при любом постороннем изменении коммит не создается вообще.
  // Частичный коммит хуже отказа: в ветку плана попал бы чужой код.
  if (dirtyProductPaths.length > 0) {
    // В отчет кладется только превью: полный список нужен редко, а логи и
    // ответы API должны оставаться компактными.
    const preview = dirtyProductPaths.slice(0, MAX_DIRTY_PREVIEW);
    log.warn(
      {
        taskId: task.id,
        executionRoot,
        dirtyCount: dirty.length,
        allowedCount: allowedRel.size,
        disallowedCount: dirtyProductPaths.length,
        disallowedPreview: preview,
        conventionSource: conventions.source,
      },
      "Plan review commit blocked by dirty product files",
    );
    return {
      status: "blocked_dirty_product_files",
      commitSha: null,
      branch,
      planPath: planRel,
      conventionSource: conventions.source,
      commitMessage: null,
      stagedPaths: [],
      dirtyProductPaths: preview,
    };
  }

  // Разрешенные грязные файлы - это и есть будущее содержимое коммита. Пустой
  // список означает, что план не менялся, то есть коммит не нужен.
  const dirtyAllowed = dirty.filter((path) => allowedAbs.has(resolve(executionRoot, path)));
  if (dirtyAllowed.length === 0) {
    log.debug(
      { taskId: task.id, executionRoot, planRel, conventionSource: conventions.source },
      "Plan review commit skipped: no plan changes to commit",
    );
    return {
      status: "no_changes",
      commitSha: null,
      branch,
      planPath: planRel,
      conventionSource: conventions.source,
      commitMessage: null,
      stagedPaths: [],
      dirtyProductPaths: [],
    };
  }

  // Тема коммита строится кодом по конвенциям проекта, а не моделью: на одних и
  // тех же данных повторный запуск обязан дать то же самое сообщение.
  const commitMessage = buildPlanCommitSubject(task.title, conventions);
  // Снимок HEAD до коммита. Позже по нему проверим, что коммит действительно
  // создан, а не просто завершился с нулевым кодом возврата.
  const beforeSha = getHeadCommitSha(executionRoot);

  log.debug(
    {
      taskId: task.id,
      executionRoot,
      dirtyCount: dirtyAllowed.length,
      allowedPaths: dirtyAllowed,
      conventionSource: conventions.source,
    },
    "Staging plan files for deterministic plan commit",
  );
  // Стейдим по одному пути и обязательно после "--": так файл, имя которого
  // начинается с дефиса, не будет прочитан git как опция.
  for (const relPath of dirtyAllowed) {
    runGit(executionRoot, ["add", "--", relPath]);
  }

  // Проверяем фактический индекс, а не свой список: git мог ничего не
  // застейджить, например если путь закрыт правилами в .gitignore.
  const staged = listStagedPaths(executionRoot);
  const stagedAllowed = staged.filter((path) => allowedRel.has(path));
  // Индекс пуст после добавления - это сбой шага, а не "нечего коммитить":
  // выше мы уже убедились, что изменения есть и они разрешены.
  if (stagedAllowed.length === 0) {
    log.warn(
      { taskId: task.id, executionRoot, planRel },
      "Plan review commit blocked: nothing allowed could be staged",
    );
    return {
      status: "commit_failed",
      commitSha: null,
      branch,
      planPath: planRel,
      conventionSource: conventions.source,
      commitMessage,
      stagedPaths: [],
      dirtyProductPaths: [],
      error: "No allowed plan paths were staged",
    };
  }

  // --no-verify отключает пользовательские хуки. В автоматическом прогоне они
  // непредсказуемы (могут требовать интерактива или отсутствующих инструментов)
  // и превращали бы детерминированный шаг в источник случайных падений.
  const commit = runGit(executionRoot, ["commit", "--no-verify", "-m", commitMessage]);
  // Ошибку git логируем с обрезанным stderr: сообщение нужно человеку, а не
  // только модели, поэтому оно уходит в лог уровня error.
  if (commit.status !== 0) {
    log.error(
      {
        taskId: task.id,
        executionRoot,
        planRel,
        stagedPaths: stagedAllowed,
        err: sanitizeError(commit.stderr),
      },
      "Deterministic plan commit failed",
    );
    return {
      status: "commit_failed",
      commitSha: null,
      branch,
      planPath: planRel,
      conventionSource: conventions.source,
      commitMessage,
      stagedPaths: stagedAllowed,
      dirtyProductPaths: [],
      error: sanitizeError(commit.stderr),
    };
  }

  // HEAD после коммита читаем отдельным вызовом, а не из stdout: git не обязан
  // печатать sha в предсказуемом формате, а состояние репозитория надежно.
  const commitSha = getHeadCommitSha(executionRoot);
  log.info(
    {
      taskId: task.id,
      executionRoot,
      commitSha,
      branch,
      planRel,
      stagedPaths: stagedAllowed,
      conventionSource: conventions.source,
    },
    "Plan review commit created",
  );

  // Финальный страж: успех засчитывается, только если HEAD реально сдвинулся.
  // Совпадение с beforeSha означает, что нового коммита не появилось.
  if (!commitSha || (beforeSha && commitSha === beforeSha)) {
    return {
      status: "commit_failed",
      commitSha: null,
      branch,
      planPath: planRel,
      conventionSource: conventions.source,
      commitMessage,
      stagedPaths: stagedAllowed,
      dirtyProductPaths: [],
      error: "Commit did not advance HEAD",
    };
  }

  return {
    status: "committed",
    commitSha,
    branch,
    planPath: planRel,
    conventionSource: conventions.source,
    commitMessage,
    stagedPaths: stagedAllowed,
    dirtyProductPaths: [],
  };
}
