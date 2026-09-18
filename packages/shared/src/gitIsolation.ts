// Изоляция работы агента с git: ветки, worktree и защитные проверки состояния.
//
// Каждая задача получает собственную ветку и отдельную рабочую копию (worktree), поэтому
// параллельные исполнители не мешают друг другу: они не делят ни индекс, ни рабочее
// дерево. Отсюда и требования к состоянию: грязное дерево, расхождение с базовой веткой
// или чужой HEAD должны останавливать работу до того, как будут сделаны правки.
//
// Модуль серверный: использует node:child_process, node:fs и node:path, поэтому
// экспортируется только через Node-вход пакета (@aif/shared), но не через browser.
//
// Все вызовы git идут через runGit, а проверки состояния возвращают null или false
// вместо исключений. Исключением (BranchIsolationError) сигнализируется только
// невозможность продолжить работу.

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { logger } from "./logger.js";
import { getProjectConfig, type AifProjectGit } from "./projectConfig.js";

const log = logger("git-isolation");

// Ошибка изоляции с машиночитаемым признаком kind. По нему вызывающий код решает, что
// делать: заблокировать задачу, вернуть на доработку или прекратить попытку. Разбирать
// текст сообщения для таких решений нельзя - формулировки меняются.
export class BranchIsolationError extends Error {
  readonly kind:
    | "dirty_worktree"
    | "branch_missing"
    | "branch_drift"
    | "base_branch_unavailable"
    | "base_update_failed"
    | "checkout_failed"
    | "create_failed"
    | "invalid_branch_name"
    | "git_disabled_with_persisted_branch"
    | "not_a_repo_with_persisted_branch"
    | "worktree_create_failed"
    | "worktree_path_collision";
  readonly branchName: string | null;
  readonly projectRoot: string;

  constructor(
    kind: BranchIsolationError["kind"],
    message: string,
    projectRoot: string,
    branchName: string | null,
  ) {
    super(message);
    this.name = "BranchIsolationError";
    this.kind = kind;
    this.projectRoot = projectRoot;
    this.branchName = branchName;
  }
}

// Проверка типа через instanceof: единственный надёжный способ отличить ошибку
// изоляции от прочих сбоев.
export function isBranchIsolationError(err: unknown): err is BranchIsolationError {
  return err instanceof BranchIsolationError;
}

// Вход подготовки ветки задачи. switchOnly означает "только переключиться на уже
// существующую ветку", а explicitBranchName позволяет использовать имя из внешнего
// источника вместо сгенерированного.
export interface EnsureFeatureBranchInput {
  projectRoot: string;
  taskId: string;
  title: string;
  explicitBranchName?: string | null;
  switchOnly?: boolean;
}

export interface EnsureFeatureBranchResult {
  action: "skipped" | "created" | "switched";
  branchName: string | null;
  reason?: string;
}

export interface EnsureTaskWorktreeInput {
  projectRoot: string;
  taskId: string;
  title: string;
  explicitBranchName?: string | null;
  explicitWorktreePath?: string | null;
  /**
   * Стабильный идентификатор проекта для сегмента worktree. Если он не задан, сегмент
   * строится детерминированно из пути: `<basename>-<короткий хеш(projectRoot)>`.
   */
  projectId?: string | null;
}

/** Одна запись из вывода `git worktree list --porcelain`. */
export interface WorktreeEntry {
  /** Абсолютный путь рабочей копии. */
  path: string;
  /** Коммит, на котором сейчас стоит worktree (null, если неизвестен). */
  head: string | null;
  /** Короткое имя ветки без префикса `refs/heads/` (null при detached или bare). */
  branch: string | null;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

export interface EnsureTaskWorktreeResult {
  action: "skipped" | "created" | "reused";
  branchName: string | null;
  worktreePath: string | null;
  reason?: string;
}

/** Максимальная длина слага в имени ветки. */
const BRANCH_SLUG_MAX = 40;

/**
 * Превращает заголовок задачи в ASCII-имя для ветки: кириллица и спецсимволы в именах
 * веток создают проблемы при работе с удалёнными репозиториями и в командной оболочке.
 */
export function slugifyTitle(title: string): string {
  const normalized = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const trimmed = normalized.slice(0, BRANCH_SLUG_MAX).replace(/-+$/, "");
  return trimmed || "task";
}

// Имя ветки собирается из префикса, слага заголовка и идентификатора задачи. Краткий
// идентификатор в конце гарантирует уникальность: разные заголовки могут дать один слаг.
export function buildBranchName(prefix: string, title: string, taskId: string): string {
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const slug = slugifyTitle(title);
  const shortId = taskId.replace(/-/g, "").slice(0, 6);
  return `${normalizedPrefix}${slug}-${shortId}`;
}

// Сегмент пути для worktree: всё небезопасное в имени каталога заменяется. Сегмент
// становится частью пути на диске, поэтому входным данным здесь доверять нельзя.
function sanitizeWorktreeSegment(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "task";
}

// Каталог worktree по умолчанию. Имя начинается с точки, чтобы каталог не попадал в
// индексы и в вывод инструментов проекта.
const WORKTREE_ROOT_DIR_NAME = ".worktrees";
const PROJECT_SEGMENT_HASH_LENGTH = 8;

/**
 * Детерминированный сегмент worktree для проекта.
 *
 * Предпочитается сохранённый идентификатор проекта, чтобы два проекта с одинаковым именем
 * каталога не столкнулись. Если идентификатора нет, сегмент выводится из пути файловой
 * системы и тоже стабилен: `<basename>-<короткий хеш(projectRoot)>`.
 */
export function buildProjectWorktreeSegment(
  projectRoot: string,
  projectId?: string | null,
): string {
  const trimmedId = projectId?.trim();
  if (trimmedId) return sanitizeWorktreeSegment(trimmedId);
  const hash = createHash("sha1")
    .update(resolve(projectRoot))
    .digest("hex")
    .slice(0, PROJECT_SEGMENT_HASH_LENGTH);
  return sanitizeWorktreeSegment(`${basename(projectRoot)}-${hash}`);
}

/**
 * Корень, в котором размещаются worktree задач. Приоритет источников: явное
 * переопределение → переменная `AIF_WORKTREE_ROOT` → `<dirname(projectRoot)>/.worktrees`.
 *
 * Вынесение за пределы проекта позволяет держать worktree на отдельном томе.
 */
export function resolveWorktreeRoot(
  projectRoot: string,
  explicitRoot?: string | null,
): { worktreeRoot: string; source: "explicit" | "env" | "default" } {
  const explicit = explicitRoot?.trim();
  if (explicit) return { worktreeRoot: resolve(explicit), source: "explicit" };
  const fromEnv = process.env.AIF_WORKTREE_ROOT?.trim();
  if (fromEnv) return { worktreeRoot: resolve(fromEnv), source: "env" };
  return {
    worktreeRoot: resolve(dirname(projectRoot), WORKTREE_ROOT_DIR_NAME),
    source: "default",
  };
}

function isWithinProjectMount(candidate: string, projectRoot: string): boolean {
  const mount = resolve(dirname(projectRoot));
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === mount || normalizedCandidate.startsWith(`${mount}${sep}`);
}

export interface BuildTaskWorktreePathInput {
  projectRoot: string;
  branchName: string;
  projectId?: string | null;
  worktreeRoot?: string | null;
}

/**
 * Путь worktree, привязанный к ветке.
 *
 * Путь - чистая функция от ветки и сегмента проекта, но не от идентификатора задачи:
 * повторный запуск той же задачи обязан попасть в тот же каталог, чтобы сохранённый
 * worktree можно было переиспользовать, а не получать конфликт `git worktree add`.
 */
export function buildTaskWorktreePath(input: BuildTaskWorktreePathInput): string {
  const { projectRoot, branchName } = input;
  const { worktreeRoot, source } = resolveWorktreeRoot(projectRoot, input.worktreeRoot);
  const projectSegment = buildProjectWorktreeSegment(projectRoot, input.projectId);
  const branchSegment = sanitizeWorktreeSegment(branchName.replace(/\//g, "-"));
  const worktreePath = resolve(worktreeRoot, projectSegment, branchSegment);

  if (source !== "default" && !isWithinProjectMount(worktreeRoot, projectRoot)) {
    log.warn(
      { projectRoot, worktreeRoot, source, branchName, projectSegment },
      "Configured worktree root is outside the project mount; task worktrees will be created on an external path",
    );
  }
  log.debug(
    { projectRoot, branchName, worktreeRoot, worktreePath, projectSegment, source },
    "Resolved branch-scoped task worktree path",
  );
  return worktreePath;
}

function normalizeWorktreeEntry(partial: Partial<WorktreeEntry>): WorktreeEntry {
  // Git отдаёт пути worktree с POSIX-разделителями даже на Windows; приводим их к
  // нативному виду, чтобы вызывающий код мог сравнивать с результатами path.join.
  const rawPath = partial.path ?? "";
  return {
    path: rawPath ? resolve(rawPath) : rawPath,
    head: partial.head ?? null,
    branch: partial.branch ?? null,
    bare: partial.bare ?? false,
    detached: partial.detached ?? false,
    prunable: partial.prunable ?? false,
  };
}

function normalizePathForCompare(path: string): string {
  return resolve(path)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

/**
 * Разбирает вывод `git worktree list --porcelain` в структурированные записи.
 *
 * Формат человекочитаемый и менялся между версиями git, поэтому строки нормализуются
 * здесь, а не разбираются по месту. Если проект не является рабочим деревом git,
 * возвращается пустой массив: исключений функция не бросает.
 */
export function listWorktrees(projectRoot: string): WorktreeEntry[] {
  const { stdout, status } = runGit(projectRoot, ["worktree", "list", "--porcelain"], {
    ignoreExit: true,
  });
  if (status !== 0 || !stdout) return [];

  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      if (current?.path) entries.push(normalizeWorktreeEntry(current));
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current?.path) entries.push(normalizeWorktreeEntry(current));
      current = { path: line.slice("worktree ".length).trim() };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line.startsWith("prunable")) {
      // git дописывает причину, например "prunable gitdir file points to non-existent
      // location", поэтому сравнение строки целиком никогда бы не сработало.
      current.prunable = true;
    }
  }
  if (current?.path) entries.push(normalizeWorktreeEntry(current));
  return entries;
}

function findWorktreeForBranch(entries: WorktreeEntry[], branchName: string): WorktreeEntry | null {
  return entries.find((entry) => !entry.bare && entry.branch === branchName) ?? null;
}

/**
 * Пригоден ли путь как рабочая копия git: git умеет определить там HEAD и, если задана
 * `expectedBranch`, выгружена именно эта ветка.
 *
 * Зарегистрированный, но сломанный worktree (каталог удалён, ссылка `.git` пропала, HEAD
 * отделён) даёт false: его переиспользование сломало бы все последующие операции.
 */
export function isWorktreeUsable(path: string, expectedBranch?: string | null): boolean {
  if (!path || !existsSync(path)) return false;
  const current = getCurrentBranch(path);
  if (!current) return false;
  return !expectedBranch || current === expectedBranch;
}

function isAdoptableWorktree(entry: WorktreeEntry, branchName: string): boolean {
  return !entry.prunable && isWorktreeUsable(entry.path, branchName);
}

/**
 * Убирает устаревшие регистрации worktree (отсутствующие или сломанные рабочие копии).
 *
 * Возвращается число регистраций, которые git сообщил как удалённые; 0 означает, что git
 * ничего не вывел. Без этой уборки список worktree постепенно засоряется.
 */
export function pruneWorktrees(projectRoot: string): number {
  const { stdout, status } = runGit(projectRoot, ["worktree", "prune", "--verbose"], {
    ignoreExit: true,
  });
  if (status !== 0 || !stdout) return 0;
  return stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * Принудительное удаление каталога worktree (`git worktree remove --force`).
 *
 * Флаг --force необходим: worktree может остаться с незакоммиченными изменениями, и без
 * флага git откажется его убирать, накапливая мусор на диске. Возвращается false, если git
 * отказал.
 */
export function removeWorktreeForce(projectRoot: string, worktreePath: string): boolean {
  const { status } = runGit(projectRoot, ["worktree", "remove", "--force", worktreePath], {
    ignoreExit: true,
  });
  return status === 0;
}

// Единственная точка вызова git. Возвращаются код возврата и оба потока вывода: часть
// функций проверяет код, часть разбирает stdout, и ни один вызов не должен терять stderr.
function runGit(
  cwd: string,
  args: string[],
  opts: { ignoreExit?: boolean } = {},
): { stdout: string; stderr: string; status: number } {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  try {
    const stdout = execFileSync("git", args, options);
    return { stdout: stdout.toString().trim(), stderr: "", status: 0 };
  } catch (err) {
    const error = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
    };
    const stdout = error.stdout ? error.stdout.toString().trim() : "";
    const stderr = error.stderr ? error.stderr.toString().trim() : String(err);
    const status = typeof error.status === "number" ? error.status : 1;
    // Ошибка протоколируется на уровне debug всегда, даже когда она ожидаемая
    // (ignoreExit): проглоченная ошибка git однажды сделала инцидент с worktree
    // недиагностируемым по логам.
    log.debug(
      { cwd, args, status, stderr, ignoreExit: opts.ignoreExit ?? false },
      "git command failed",
    );
    return { stdout, stderr, status };
  }
}

// Является ли каталог рабочим деревом git. Проверка идёт через git, поэтому корректно
// работает и внутри worktree, где .git - это файл, а не каталог.
export function isGitRepo(projectRoot: string): boolean {
  if (!existsSync(join(projectRoot, ".git"))) {
    const { status } = runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"], {
      ignoreExit: true,
    });
    return status === 0;
  }
  return true;
}

// Текущая ветка или null, если HEAD отделён (detached). null здесь - значимый
// результат: вызывающий код обязан отличать "ветки нет" от ошибки git.
export function getCurrentBranch(projectRoot: string): string | null {
  const { stdout, status } = runGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"], {
    ignoreExit: true,
  });
  if (status !== 0 || !stdout || stdout === "HEAD") return null;
  return stdout;
}

// SHA текущего коммита - база для проверки того, появились ли новые коммиты с момента
// запуска задачи.
export function getHeadCommitSha(projectRoot: string): string | null {
  const { stdout, status } = runGit(projectRoot, ["rev-parse", "--verify", "HEAD"], {
    ignoreExit: true,
  });
  return status === 0 && stdout ? stdout : null;
}

// Число коммитов между двумя точками. Нужно для решения о том, есть ли что публиковать:
// пустая разница означает отсутствие работы.
export function countCommitsBetween(
  projectRoot: string,
  baseSha: string,
  headSha: string,
): number | null {
  const { stdout, status } = runGit(projectRoot, ["rev-list", "--count", `${baseSha}..${headSha}`]);
  if (status !== 0 || !/^\d+$/.test(stdout)) return null;
  return Number.parseInt(stdout, 10);
}

// Проверка существования ветки: сначала локально, затем в удалённом репозитории. Порядок
// важен - локальная проверка дешевле и не требует сети.
export function branchExists(projectRoot: string, branchName: string): boolean {
  const { status } = runGit(
    projectRoot,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    { ignoreExit: true },
  );
  if (status === 0) return true;

  // Запасной случай для репозитория без коммитов ("No commits yet"): git show-ref
  // возвращает ненулевой код для любой ветки, потому что файла refs/heads/<name> ещё нет,
  // хотя HEAD уже указывает на имя ветки по умолчанию. Поэтому вторым признаком
  // проверяется текущая ссылка HEAD.
  const currentBranch = getCurrentBranch(projectRoot);
  return currentBranch === branchName;
}

function remoteBranchExists(projectRoot: string, branchName: string): boolean {
  const { status } = runGit(
    projectRoot,
    ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branchName}`],
    { ignoreExit: true },
  );
  return status === 0;
}

function getOriginHeadBranch(projectRoot: string): string | null {
  const { stdout, status } = runGit(
    projectRoot,
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    {
      ignoreExit: true,
    },
  );
  if (status !== 0 || !stdout) return null;
  const prefix = "refs/remotes/origin/";
  if (!stdout.startsWith(prefix)) return null;
  const branchName = stdout.slice(prefix.length).trim();
  return branchName || null;
}

// Признак чистоты рабочего дерева. Ложное "чисто" приводит к смешиванию чужих правок в
// коммите, поэтому проверка обязательна перед переключением ветки и созданием worktree.
export function workingTreeClean(projectRoot: string): boolean {
  const { stdout, status } = runGit(projectRoot, ["status", "--porcelain"], { ignoreExit: true });
  return status === 0 && stdout.length === 0;
}

/**
 * Обновление текущей ветки быстрой перемоткой (`git pull --ff-only origin <branch>`).
 *
 * Безопасно вызывать на любом репозитории: функция сразу вернёт управление с
 * предупреждением в логе, если репозиторий в состоянии detached HEAD, удалённый репозиторий
 * origin не настроен, коммитов ещё нет либо перемотка не удалась по любой другой причине
 * (сеть, конфликт слияния).
 *
 * Предназначена для сценариев синхронизации проекта, где состояние git нужно обновить
 * перед синхронизацией issue и PR. Исключений не бросает.
 */
export function pullDefaultBranch(projectRoot: string): void {
  const currentBranch = getCurrentBranch(projectRoot);
  if (!currentBranch) {
    log.warn({ projectRoot }, "pullDefaultBranch: cannot pull from detached HEAD");
    return;
  }

  const { status, stderr } = runGit(projectRoot, ["pull", "--ff-only", "origin", currentBranch], {
    ignoreExit: true,
  });
  if (status !== 0) {
    log.debug(
      { projectRoot, currentBranch, stderr },
      "pullDefaultBranch: best-effort git pull skipped (no remote, empty repo, or pull conflict)",
    );
  }
}

// Человекочитаемое описание того, что мешает работе: список изменённых файлов попадает в
// сообщение об ошибке, чтобы причина была понятна без ручной диагностики.
export function describeDirtyWorkingTree(projectRoot: string): string | null {
  const { stdout, status } = runGit(projectRoot, ["status", "--porcelain"], { ignoreExit: true });
  if (status !== 0 || stdout.length === 0) return null;
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const summary = lines.slice(0, 5).join(", ");
  return lines.length > 5 ? `${summary}, +${lines.length - 5} more` : summary;
}

/**
 * Файлы, изменённые относительно `sinceRef` (и закоммиченные, и незакоммиченные), с путями
 * относительно репозитория. Без ссылки возвращается текущее содержимое грязного рабочего
 * дерева. Используется для проверки, что исполнитель не вышел за объявленные границы
 * изменений.
 */
export function listChangedFiles(projectRoot: string, sinceRef?: string | null): string[] {
  const ref = sinceRef?.trim();
  if (ref) {
    const { stdout, status } = runGit(projectRoot, ["diff", "--name-only", ref], {
      ignoreExit: true,
    });
    if (status !== 0 || !stdout) return [];
    return Array.from(
      new Set(
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    ).sort();
  }

  const { stdout, status } = runGit(projectRoot, ["status", "--porcelain"], { ignoreExit: true });
  if (status !== 0 || !stdout) return [];
  const files = stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .map((entry) => (entry.includes(" -> ") ? entry.split(" -> ").at(-1)! : entry))
    .filter(Boolean);
  return Array.from(new Set(files)).sort();
}

/**
 * Пути файлов, закоммиченных в указанном коммите.
 *
 * Используется `git diff-tree --no-commit-id -r --name-only`: команда работает с любым
 * объектом (обычный или слитый коммит) и не требует рабочей копии. Если SHA не существует
 * или не является коммитом, возвращается пустой массив.
 */
export function listCommitFiles(projectRoot: string, commitSha: string): string[] {
  if (!commitSha) return [];
  const { stdout, status } = runGit(
    projectRoot,
    ["diff-tree", "--no-commit-id", "-r", "--name-only", commitSha],
    { ignoreExit: true },
  );
  if (status !== 0 || !stdout) return [];
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

// Проверки-утверждения: бросают BranchIsolationError вместо возврата флага. Применяются
// там, где продолжать работу с нарушенным состоянием опасно.
export function assertWorkingTreeClean(projectRoot: string, branchName: string | null): void {
  const dirty = describeDirtyWorkingTree(projectRoot);
  if (dirty) {
    throw new BranchIsolationError(
      "dirty_worktree",
      `Working tree at ${projectRoot} has uncommitted changes (${dirty}). Commit, stash, or discard them before continuing.`,
      projectRoot,
      branchName,
    );
  }
}

// Текущая ветка должна совпадать с ожидаемой. Защита от ситуации, когда задачу запустили
// в чужом worktree или ветку переключили извне.
export function assertCurrentBranch(projectRoot: string, expected: string): void {
  const current = getCurrentBranch(projectRoot);
  if (current !== expected) {
    throw new BranchIsolationError(
      "branch_drift",
      `Branch drift detected: expected HEAD=${expected}, actual HEAD=${current ?? "detached"}.`,
      projectRoot,
      expected,
    );
  }
}

/**
 * Проверяет, что строка пригодна как имя ветки git, через `git check-ref-format --branch`.
 *
 * Отклоняются пустые префиксы ("" → "/slug"), двойные слэши, особые для git ссылки вида
 * `@{-1}` и всё остальное, что git не даст выгрузить через `checkout -b`. Нормализация на
 * этом слое превращает неожиданные ошибки `checkout_failed` или `create_failed` посреди
 * процесса в детерминированный блокер `invalid_branch_name` ещё до любых изменений.
 */
export function validateBranchName(projectRoot: string, branchName: string): void {
  if (!branchName || branchName.trim().length === 0) {
    throw new BranchIsolationError(
      "invalid_branch_name",
      `Branch name is empty or whitespace-only.`,
      projectRoot,
      branchName || null,
    );
  }
  if (branchName.startsWith("/") || branchName.endsWith("/") || branchName.includes("//")) {
    throw new BranchIsolationError(
      "invalid_branch_name",
      `Branch name "${branchName}" has invalid slashes.`,
      projectRoot,
      branchName,
    );
  }
  const { status, stderr } = runGit(projectRoot, ["check-ref-format", "--branch", branchName], {
    ignoreExit: true,
  });
  if (status !== 0) {
    throw new BranchIsolationError(
      "invalid_branch_name",
      `Branch name "${branchName}" is not a valid git ref: ${stderr || "rejected by git check-ref-format"}.`,
      projectRoot,
      branchName,
    );
  }
}

// Настройки git из конфигурации проекта с умолчаниями. Отдельная функция нужна, чтобы
// все проверки ниже работали с одним и тем же разбором конфигурации.
function resolveGitConfig(projectRoot: string): AifProjectGit {
  return getProjectConfig(projectRoot).git;
}

// Наличие config.yaml определяет, можно ли доверять настройкам git из проекта: без файла
// берутся умолчания, а не частично заполненная конфигурация.
function hasProjectConfigFile(projectRoot: string): boolean {
  return existsSync(join(projectRoot, ".ai-factory", "config.yaml"));
}

// Базовая ветка и источник, откуда она взята: конфигурация, origin/HEAD или умолчание git.
// Источник важен для диагностики, когда выбранная база оказалась неожиданной.
interface ResolvedBaseBranch {
  branchName: string;
  createFromRemote: boolean;
}

// Попытка определить базовую ветку по origin/HEAD. Это самый надёжный источник: он
// отражает то, что удалённый репозиторий реально считает основной веткой.
function resolveOriginHeadBaseBranch(projectRoot: string): ResolvedBaseBranch | null {
  const originHeadBranch = getOriginHeadBranch(projectRoot);
  if (!originHeadBranch) return null;
  if (branchExists(projectRoot, originHeadBranch)) {
    return { branchName: originHeadBranch, createFromRemote: false };
  }
  if (remoteBranchExists(projectRoot, originHeadBranch)) {
    return { branchName: originHeadBranch, createFromRemote: true };
  }
  return null;
}

// Резервный вариант: ветка по умолчанию из настроек git. Нужен, когда origin/HEAD не
// выставлен - частый случай у только что склонированных репозиториев.
function resolveGitDefaultBaseBranch(
  projectRoot: string,
  fallbackBase: string,
): ResolvedBaseBranch {
  const originHeadBase = resolveOriginHeadBaseBranch(projectRoot);
  if (originHeadBase) {
    log.warn(
      {
        projectRoot,
        configuredBase: fallbackBase,
        resolvedBase: originHeadBase.branchName,
        source: "origin/HEAD",
        createFromRemote: originHeadBase.createFromRemote,
      },
      "No project git base branch is configured; using origin default branch",
    );
    return originHeadBase;
  }
  if (branchExists(projectRoot, "master")) {
    log.warn(
      { projectRoot, configuredBase: fallbackBase, resolvedBase: "master" },
      "No project git base branch is configured; using legacy master branch",
    );
    return { branchName: "master", createFromRemote: false };
  }
  // Последний запасной вариант: для репозитория без коммитов читаем HEAD напрямую.
  const currentBranch = getCurrentBranch(projectRoot);
  if (currentBranch) {
    log.warn(
      { projectRoot, configuredBase: fallbackBase, resolvedBase: currentBranch, source: "HEAD" },
      "No project git base branch is configured; using current HEAD branch",
    );
    return { branchName: currentBranch, createFromRemote: false };
  }
  return { branchName: fallbackBase, createFromRemote: false };
}

// Итоговый выбор базовой ветки с учётом приоритета источников.
function resolveBaseBranch(
  projectRoot: string,
  configuredBase: string,
  configFileExists: boolean,
): ResolvedBaseBranch {
  if (!configFileExists) {
    return resolveGitDefaultBaseBranch(projectRoot, configuredBase);
  }
  if (branchExists(projectRoot, configuredBase)) {
    return { branchName: configuredBase, createFromRemote: false };
  }
  if (configuredBase !== "main") {
    return { branchName: configuredBase, createFromRemote: false };
  }
  const originHeadBase = resolveOriginHeadBaseBranch(projectRoot);
  if (originHeadBase) {
    log.warn(
      {
        projectRoot,
        configuredBase,
        resolvedBase: originHeadBase.branchName,
        source: "origin/HEAD",
        createFromRemote: originHeadBase.createFromRemote,
      },
      "Configured base branch is missing; falling back to origin default branch",
    );
    return originHeadBase;
  }
  if (branchExists(projectRoot, "master")) {
    log.warn(
      { projectRoot, configuredBase, resolvedBase: "master" },
      "Configured base branch is missing; falling back to legacy master branch",
    );
    return { branchName: "master", createFromRemote: false };
  }
  // Последний запасной вариант: при нуле коммитов ("No commits yet") ни show-ref, ни
  // origin/HEAD не могут назвать текущую ветку, поэтому HEAD читается напрямую.
  const currentBranch = getCurrentBranch(projectRoot);
  if (currentBranch) {
    log.warn(
      { projectRoot, configuredBase, resolvedBase: currentBranch, source: "HEAD" },
      "Configured base branch is missing; falling back to current HEAD branch",
    );
    return { branchName: currentBranch, createFromRemote: false };
  }
  return { branchName: configuredBase, createFromRemote: false };
}

// Обработка результата обновления базовой ветки. При strict_base_update неудача обновления
// становится жёсткой ошибкой: если проект требует начинать ветку от актуальной базы,
// молчаливое продолжение привело бы к конфликтам в PR/MR.
function handleBaseBranchRefreshResult(input: {
  projectRoot: string;
  branchName: string;
  baseBranch: string;
  config: AifProjectGit;
  result: { stdout: string; stderr: string; status: number };
  operation: string;
}): void {
  const { projectRoot, branchName, baseBranch, config, result, operation } = input;
  if (result.status === 0) return;

  if (config.strict_base_update) {
    throw new BranchIsolationError(
      "base_update_failed",
      `${operation} failed: ${result.stderr || "unknown error"}. ` +
        `Project has git.strict_base_update=true; refusing to branch from a stale base.`,
      projectRoot,
      branchName,
    );
  }
  log.warn(
    {
      projectRoot,
      branchName,
      baseBranch,
      stderr: result.stderr,
    },
    "Could not fast-forward base branch before creating feature branch; continuing from local base (git.strict_base_update=false)",
  );
}

// Обновление базовой ветки перед созданием worktree. Вынесено отдельно, чтобы политика
// строгости была применима и к сценарию общей ветки.
function refreshBaseBranchForWorktree(input: {
  projectRoot: string;
  branchName: string;
  baseBranch: string;
  config: AifProjectGit;
}): void {
  const { projectRoot, branchName, baseBranch, config } = input;
  const current = getCurrentBranch(projectRoot);
  const args =
    current === baseBranch
      ? ["pull", "--ff-only", "origin", baseBranch]
      : ["fetch", "origin", `${baseBranch}:${baseBranch}`];
  const result = runGit(projectRoot, args, { ignoreExit: true });
  handleBaseBranchRefreshResult({
    projectRoot,
    branchName,
    baseBranch,
    config,
    result,
    operation: `git ${args.join(" ")}`,
  });
}

// Два режима изоляции: общая ветка проекта или отдельный worktree на каждую задачу. Выбор
// фиксируется конфигурацией, и от него зависит весь дальнейший ход подготовки.
export function projectUsesSharedBranchIsolation(projectRoot: string): boolean {
  const config = resolveGitConfig(projectRoot);
  return config.enabled && config.create_branches && isGitRepo(projectRoot);
}

// Поддерживает ли проект worktree. Проверка отдельная, потому что режим зависит и от
// конфигурации, и от того, является ли каталог рабочим деревом git.
export function projectSupportsTaskWorktrees(projectRoot: string): boolean {
  return projectUsesSharedBranchIsolation(projectRoot);
}

// Копирование с проверкой существования: часть служебных файлов проекта может
// отсутствовать, и это не ошибка.
function copyPathIfExists(source: string, destination: string): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
}

// Переносятся только последние патчи: полная копия каталога была бы избыточной, а
// актуальные изменения нужны агенту в новой рабочей копии.
function copyLatestPatchFiles(
  projectRoot: string,
  worktreePath: string,
  patchesPath: string,
): void {
  const sourceDir = resolve(projectRoot, patchesPath);
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) return;

  const entries = readdirSync(sourceDir)
    .map((name) => {
      const fullPath = join(sourceDir, name);
      const stats = statSync(fullPath);
      return { name, fullPath, mtimeMs: stats.mtimeMs, isFile: stats.isFile() };
    })
    .filter((entry) => entry.isFile && entry.name !== "patch-cursor.json")
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 10);

  const destinationDir = resolve(worktreePath, patchesPath);
  mkdirSync(destinationDir, { recursive: true });
  for (const entry of entries) {
    copyPathIfExists(entry.fullPath, join(destinationDir, entry.name));
  }
}

// Исключение пути worktree из индекса целевого проекта. Без этого новый каталог попал бы
// в git add -A и уехал в коммит.
function excludeWorktreePath(worktreePath: string, relativePath: string): void {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) return;

  const { stdout, status, stderr } = runGit(
    worktreePath,
    ["rev-parse", "--git-path", "info/exclude"],
    {
      ignoreExit: true,
    },
  );
  if (status !== 0 || !stdout) {
    log.warn(
      { worktreePath, relativePath, stderr },
      "Could not resolve git exclude path for copied worktree context",
    );
    return;
  }

  const excludePath = resolve(worktreePath, stdout);
  mkdirSync(dirname(excludePath), { recursive: true });
  const pattern = `/${normalized}/`;
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (existing.split("\n").includes(pattern)) return;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(excludePath, `${prefix}# AIF copied planning context\n${pattern}\n`);
}

// Копирование контекста проекта в новый worktree: служебные файлы и патчи, без которых
// агент не увидит настройки проекта. Копирование ограничено по путям.
function copyProjectContextToWorktree(projectRoot: string, worktreePath: string): void {
  const cfg = getProjectConfig(projectRoot);
  const contextFiles = [
    ".ai-factory/config.yaml",
    cfg.paths.description,
    cfg.paths.architecture,
    cfg.paths.research,
    "AGENTS.md",
    "CLAUDE.md",
  ];
  const contextDirs = [".claude", ".ai-factory/skill-context"];
  const requiredParentPaths = [
    cfg.paths.plan,
    cfg.paths.fix_plan,
    cfg.paths.roadmap,
    cfg.paths.patches,
    cfg.paths.evolutions,
    cfg.paths.evolution,
  ];

  for (const relativePath of requiredParentPaths) {
    mkdirSync(dirname(resolve(worktreePath, relativePath)), { recursive: true });
  }

  for (const relativePath of contextFiles) {
    copyPathIfExists(resolve(projectRoot, relativePath), resolve(worktreePath, relativePath));
  }
  for (const relativePath of contextDirs) {
    copyPathIfExists(resolve(projectRoot, relativePath), resolve(worktreePath, relativePath));
  }
  copyLatestPatchFiles(projectRoot, worktreePath, cfg.paths.patches);
  excludeWorktreePath(worktreePath, cfg.paths.patches);
}

// Создание worktree повторяется: возможны гонки с параллельными задачами и остатки
// прошлых каталогов. Несколько попыток дешевле, чем отказ задачи.
const WORKTREE_CREATE_MAX_ATTEMPTS = 3;
// Ограничение на размер stderr в сообщении об ошибке.
const STDERR_LOG_MAX = 2_000;

// Главная точка подготовки: создаёт ветку и worktree под задачу либо сообщает, почему
// работа пропущена. Возвращается действие и причина, а не флаг: интерфейсу и журналу нужно
// объяснить, почему изоляция не была настроена.
export function ensureTaskWorktree(input: EnsureTaskWorktreeInput): EnsureTaskWorktreeResult {
  const { projectRoot, taskId, title, explicitBranchName, explicitWorktreePath, projectId } = input;
  const config = resolveGitConfig(projectRoot);

  if (!config.enabled) {
    return { action: "skipped", branchName: null, worktreePath: null, reason: "git.enabled=false" };
  }
  if (!isGitRepo(projectRoot)) {
    return {
      action: "skipped",
      branchName: null,
      worktreePath: null,
      reason: "not a git work tree",
    };
  }
  if (!config.create_branches) {
    return {
      action: "skipped",
      branchName: null,
      worktreePath: null,
      reason: "git.create_branches=false",
    };
  }

  const branchName = explicitBranchName?.trim()
    ? explicitBranchName.trim()
    : buildBranchName(config.branch_prefix, title, taskId);
  validateBranchName(projectRoot, branchName);

  const expectedWorktreePath = explicitWorktreePath?.trim()
    ? resolve(explicitWorktreePath.trim())
    : buildTaskWorktreePath({ projectRoot, branchName, projectId });

  // Логика "переиспользовать, а не падать": если ветка УЖЕ выгружена в ЗДОРОВОМ worktree,
  // используется эта копия вместо попытки `git worktree add` по пути, который git отклонит
  // (ветка может быть выгружена только в одном worktree). Именно это превращает инцидент
  // с сохранённым worktree в безобидное продолжение работы.
  //
  // Сама регистрация НЕ доказывает работоспособность: git продолжает показывать worktree,
  // у которых удалён каталог или пропала ссылка `.git` (обычно с пометкой `prunable`).
  // Переиспользование такого каталога сломало бы все последующие этапы ошибками
  // `branch_drift` или "not a git repository", поэтому нездоровые регистрации удаляются, а
  // подготовка переходит к созданию новой копии.
  const existingEntries = listWorktrees(projectRoot);
  const occupant = findWorktreeForBranch(existingEntries, branchName);
  if (occupant && isAdoptableWorktree(occupant, branchName)) {
    if (normalizePathForCompare(occupant.path) !== normalizePathForCompare(expectedWorktreePath)) {
      log.info(
        {
          taskId,
          branchName,
          worktreePath: occupant.path,
          expectedWorktreePath,
        },
        "Adopted existing worktree for branch",
      );
    }
    copyProjectContextToWorktree(projectRoot, occupant.path);
    return { action: "reused", branchName, worktreePath: occupant.path };
  }

  if (occupant) {
    // Ветку нужно освободить перед попыткой новой `worktree add`.
    const prunedRegistrations = pruneWorktrees(projectRoot);
    log.warn(
      {
        taskId,
        branchName,
        staleWorktreePath: occupant.path,
        stalePrunable: occupant.prunable,
        staleFolderExists: existsSync(occupant.path),
        prunedRegistrations,
        expectedWorktreePath,
      },
      "Skipped stale worktree registration for branch; pruning before fresh provisioning",
    );
  }

  if (existsSync(expectedWorktreePath)) {
    if (isWorktreeUsable(expectedWorktreePath, branchName)) {
      copyProjectContextToWorktree(projectRoot, expectedWorktreePath);
      return { action: "reused", branchName, worktreePath: expectedWorktreePath };
    }
    const occupantAtPath = existingEntries.find(
      (entry) =>
        normalizePathForCompare(entry.path) === normalizePathForCompare(expectedWorktreePath),
    );
    const boundTo = occupantAtPath?.branch ?? null;
    throw new BranchIsolationError(
      "worktree_path_collision",
      `Worktree path ${expectedWorktreePath} already exists${
        boundTo ? ` and is bound to ${boundTo}` : ""
      }, not ${branchName}. Remove or prune the stale worktree before retrying.`,
      projectRoot,
      branchName,
    );
  }

  const resolvedBaseBranch = resolveBaseBranch(
    projectRoot,
    config.base_branch,
    hasProjectConfigFile(projectRoot),
  );
  const baseRef = resolvedBaseBranch.createFromRemote
    ? `origin/${resolvedBaseBranch.branchName}`
    : resolvedBaseBranch.branchName;
  if (
    !resolvedBaseBranch.createFromRemote &&
    !branchExists(projectRoot, resolvedBaseBranch.branchName)
  ) {
    throw new BranchIsolationError(
      "base_branch_unavailable",
      `Base branch ${resolvedBaseBranch.branchName} does not exist in ${projectRoot}. Cannot create worktree branch ${branchName} from a known base.`,
      projectRoot,
      branchName,
    );
  }

  if (!branchExists(projectRoot, branchName)) {
    refreshBaseBranchForWorktree({
      projectRoot,
      branchName,
      baseBranch: resolvedBaseBranch.branchName,
      config,
    });
  }

  // Ограниченный повтор, управляемый СВЕЖИМ структурированным состоянием, а не текстом
  // ошибки: после каждой неудачной попытки заново читаются `git worktree list` и ссылки
  // веток, и принимается то, что появилось за это время (параллельная подготовка,
  // частично созданный worktree, ссылка от конкурентного fetch).
  let lastStderr = "";
  let lastStatus = 1;
  let lastArgs: string[] = [];
  for (let attempt = 1; attempt <= WORKTREE_CREATE_MAX_ATTEMPTS; attempt += 1) {
    const branchNowExists = branchExists(projectRoot, branchName);
    const args = branchNowExists
      ? ["worktree", "add", expectedWorktreePath, branchName]
      : ["worktree", "add", "-b", branchName, expectedWorktreePath, baseRef];
    const { status, stderr } = runGit(projectRoot, args, { ignoreExit: true });
    if (status === 0) {
      copyProjectContextToWorktree(projectRoot, expectedWorktreePath);
      log.info(
        { projectRoot, worktreePath: expectedWorktreePath, branchName, taskId, attempt },
        "Created task worktree",
      );
      return { action: "created", branchName, worktreePath: expectedWorktreePath };
    }

    lastStatus = status;
    lastStderr = stderr;
    lastArgs = args;

    const raced = findWorktreeForBranch(listWorktrees(projectRoot), branchName);
    if (raced && isAdoptableWorktree(raced, branchName)) {
      log.info(
        { taskId, branchName, worktreePath: raced.path },
        "Adopted existing worktree for branch",
      );
      copyProjectContextToWorktree(projectRoot, raced.path);
      return { action: "reused", branchName, worktreePath: raced.path };
    }

    if (attempt < WORKTREE_CREATE_MAX_ATTEMPTS) {
      log.warn(
        { taskId, branchName, attempt, status, stderr: truncateStderr(stderr) },
        "Task worktree provisioning failed; retrying",
      );
    }
  }

  log.error(
    {
      taskId,
      branchName,
      projectRoot,
      args: lastArgs,
      status: lastStatus,
      stderr: truncateStderr(lastStderr),
    },
    "Task worktree provisioning failed after retries",
  );
  throw new BranchIsolationError(
    "worktree_create_failed",
    `git ${lastArgs.join(" ")} failed after ${WORKTREE_CREATE_MAX_ATTEMPTS} attempts (last exit ${lastStatus}): ${
      lastStderr || "unknown error"
    }`,
    projectRoot,
    branchName,
  );
}

// Вывод git в сообщении об ошибке обрезается: полный stderr бывает объёмным, а в логе и в
// ответе нужен только фрагмент, достаточный для понимания причины.
function truncateStderr(value: string): string {
  return value.length > STDERR_LOG_MAX ? `${value.slice(0, STDERR_LOG_MAX)}…[truncated]` : value;
}

// Второй сценарий подготовки: работа в общей ветке проекта без отдельного worktree.
// Используется, когда включён режим общей изоляции.
export function ensureFeatureBranch(input: EnsureFeatureBranchInput): EnsureFeatureBranchResult {
  const { projectRoot, title, explicitBranchName, taskId, switchOnly } = input;
  const config = resolveGitConfig(projectRoot);

  if (!config.enabled) {
    return { action: "skipped", branchName: null, reason: "git.enabled=false" };
  }
  if (!isGitRepo(projectRoot)) {
    return { action: "skipped", branchName: null, reason: "not a git work tree" };
  }
  if (!config.create_branches && !switchOnly) {
    return { action: "skipped", branchName: null, reason: "git.create_branches=false" };
  }

  const branchName = explicitBranchName?.trim()
    ? explicitBranchName.trim()
    : buildBranchName(config.branch_prefix, title, taskId);

  validateBranchName(projectRoot, branchName);

  const current = getCurrentBranch(projectRoot);
  if (current === branchName) {
    return { action: "switched", branchName };
  }

  assertWorkingTreeClean(projectRoot, branchName);

  if (branchExists(projectRoot, branchName)) {
    const { status, stderr } = runGit(projectRoot, ["checkout", branchName], {
      ignoreExit: true,
    });
    if (status !== 0) {
      throw new BranchIsolationError(
        "checkout_failed",
        `git checkout ${branchName} failed: ${stderr || "unknown error"}`,
        projectRoot,
        branchName,
      );
    }
    log.info(
      { projectRoot, branchName, previous: current, taskId },
      "Switched to existing feature branch",
    );
    return { action: "switched", branchName };
  }

  if (switchOnly) {
    throw new BranchIsolationError(
      "branch_missing",
      `Expected feature branch ${branchName} is missing from ${projectRoot}. Planner did not prepare it, or it was deleted between stages.`,
      projectRoot,
      branchName,
    );
  }

  // Шаг 1: перевести HEAD на базовую ветку. Она нужна и как источник для
  // `git checkout -b`, и как цель политики обновления ниже.
  const resolvedBaseBranch = resolveBaseBranch(
    projectRoot,
    config.base_branch,
    hasProjectConfigFile(projectRoot),
  );
  const baseBranch = resolvedBaseBranch.branchName;
  if (current !== baseBranch) {
    if (!branchExists(projectRoot, baseBranch)) {
      if (!resolvedBaseBranch.createFromRemote) {
        throw new BranchIsolationError(
          "base_branch_unavailable",
          `Base branch ${config.base_branch} does not exist in ${projectRoot}. Cannot create ${branchName} from a known base.`,
          projectRoot,
          branchName,
        );
      }
      validateBranchName(projectRoot, baseBranch);
      const { status: trackStatus, stderr: trackErr } = runGit(
        projectRoot,
        ["checkout", "--track", "-b", baseBranch, `origin/${baseBranch}`],
        { ignoreExit: true },
      );
      if (trackStatus !== 0) {
        const { status: checkoutRemoteStatus, stderr: checkoutRemoteErr } = runGit(
          projectRoot,
          ["checkout", "-b", baseBranch, `origin/${baseBranch}`],
          { ignoreExit: true },
        );
        if (checkoutRemoteStatus !== 0) {
          throw new BranchIsolationError(
            "base_branch_unavailable",
            `Could not create local base branch ${baseBranch} from origin/${baseBranch}: ${trackErr || checkoutRemoteErr || "unknown error"}`,
            projectRoot,
            branchName,
          );
        }
      }
      log.info(
        { projectRoot, branchName: baseBranch, remoteBranch: `origin/${baseBranch}` },
        "Created local base branch from origin default branch",
      );
    } else {
      const { status: checkoutStatus, stderr: checkoutErr } = runGit(
        projectRoot,
        ["checkout", baseBranch],
        { ignoreExit: true },
      );
      if (checkoutStatus !== 0) {
        throw new BranchIsolationError(
          "base_branch_unavailable",
          `Could not checkout base branch ${baseBranch}: ${checkoutErr || "unknown error"}`,
          projectRoot,
          branchName,
        );
      }
    }
  }

  // Шаг 2: обновить базовую ветку через `git pull --ff-only origin <base>`.
  // Выполняется БЕЗУСЛОВНО, независимо от того, переключились мы только что или уже были
  // на базовой ветке: иначе `git.strict_base_update=true` обходился бы через HEAD, который
  // уже стоит на устаревшей локальной базе.
  //
  // Политика: по умолчанию неудача обновления считается необязательной (предупреждение и
  // продолжение от локальной базы). Проекты, которым нужна свежая база перед созданием
  // ветки, включают строгий режим через `git.strict_base_update: true` - тогда неудача
  // становится жёсткой BranchIsolationError("base_update_failed"), которую координатор
  // классифицирует как blocked_external.
  const pullResult = runGit(projectRoot, ["pull", "--ff-only", "origin", baseBranch], {
    ignoreExit: true,
  });
  handleBaseBranchRefreshResult({
    projectRoot,
    branchName,
    baseBranch,
    config,
    result: pullResult,
    operation: `git pull --ff-only origin ${baseBranch}`,
  });

  const { status, stderr } = runGit(projectRoot, ["checkout", "-b", branchName], {
    ignoreExit: true,
  });
  if (status !== 0) {
    throw new BranchIsolationError(
      "create_failed",
      `git checkout -b ${branchName} failed: ${stderr || "unknown error"}`,
      projectRoot,
      branchName,
    );
  }

  log.info({ projectRoot, branchName, previous: current, taskId }, "Created feature branch");
  return { action: "created", branchName };
}

export interface RestorePersistedBranchInput {
  projectRoot: string;
  taskId: string;
  persistedBranchName: string;
}

/**
 * Возвращает HEAD на ветку, которую предыдущий этап уже сохранил в задаче.
 *
 * В отличие от `ensureFeatureBranch`, `task.branchName` здесь считается контрактом: если
 * планировщик его сохранил, каждый следующий этап ОБЯЗАН оказаться на этой ветке или явно
 * упасть. Переключение `git.enabled=false` или `git.create_branches=false` после того, как
 * задача получила ветку, не освобождает этап от этого требования.
 *
 * При неудаче бросается `BranchIsolationError` с видом, который координатор
 * классифицирует как `blocked_external`:
 *  - `git_disabled_with_persisted_branch` - конфигурация выключена между этапами
 *  - `not_a_repo_with_persisted_branch`   - репозиторий удалён или перемещён
 *  - `invalid_branch_name`                - сохранённое значение не является допустимой ссылкой
 *  - `branch_missing`                     - ветка удалена между этапами
 *  - `dirty_worktree`                     - переключение затрёт незакоммиченные изменения
 *  - `checkout_failed`                    - git отказал в переключении
 */
export function restorePersistedBranch(input: RestorePersistedBranchInput): void {
  const { projectRoot, taskId, persistedBranchName } = input;
  const config = resolveGitConfig(projectRoot);

  if (!config.enabled) {
    throw new BranchIsolationError(
      "git_disabled_with_persisted_branch",
      `Task has persisted feature branch ${persistedBranchName} but git.enabled=false. Config drift between stages is not allowed — re-enable git or clear the branch binding before continuing.`,
      projectRoot,
      persistedBranchName,
    );
  }
  if (!isGitRepo(projectRoot)) {
    throw new BranchIsolationError(
      "not_a_repo_with_persisted_branch",
      `Task has persisted feature branch ${persistedBranchName} but ${projectRoot} is not a git work tree.`,
      projectRoot,
      persistedBranchName,
    );
  }

  validateBranchName(projectRoot, persistedBranchName);

  const current = getCurrentBranch(projectRoot);
  if (current === persistedBranchName) {
    return;
  }

  if (!branchExists(projectRoot, persistedBranchName)) {
    throw new BranchIsolationError(
      "branch_missing",
      `Expected feature branch ${persistedBranchName} is missing from ${projectRoot}. It was deleted between stages.`,
      projectRoot,
      persistedBranchName,
    );
  }

  assertWorkingTreeClean(projectRoot, persistedBranchName);

  const { status, stderr } = runGit(projectRoot, ["checkout", persistedBranchName], {
    ignoreExit: true,
  });
  if (status !== 0) {
    throw new BranchIsolationError(
      "checkout_failed",
      `git checkout ${persistedBranchName} failed: ${stderr || "unknown error"}`,
      projectRoot,
      persistedBranchName,
    );
  }

  log.info(
    { projectRoot, branchName: persistedBranchName, previous: current, taskId },
    "Restored persisted feature branch",
  );
}

/**
 * Прописывает git-идентичность бота (user.name, user.email) в глобальную конфигурацию,
 * чтобы коммиты субагентов были атрибутированы боту, а не пользователю, под учётной записью
 * которого запущен процесс.
 *
 * Если хотя бы одно значение не задано, ничего не делается. Ошибки не фатальны: о них
 * сообщает вызывающий код.
 */
export function applyGitIdentity(input: {
  botName?: string | null;
  botEmail?: string | null;
  logger?: { warn(message: string): void };
}): void {
  const { botName, botEmail } = input;
  const name = botName?.trim();
  const email = botEmail?.trim();
  if (!name || !email) return;

  const run = (args: string[]): void => {
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
  };
  try {
    run(["config", "--global", "user.name", name]);
    run(["config", "--global", "user.email", email]);
    log.info({ botName: name, botEmail: email }, "Applied bot git identity globally");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    input.logger?.warn?.(`Failed to apply bot git identity: ${message}`);
    log.warn({ botName: name, err: message }, "Failed to apply bot git identity");
  }
}
