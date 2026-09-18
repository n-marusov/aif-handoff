/**
 * Разрешение правил именования git-веток и коммитов для целевого проекта.
 *
 * Зачем модуль существует: имя ветки и subject коммита нужны детерминированно, без
 * участия LLM. Иначе повторный прогон той же задачи дал бы другое имя ветки и породил
 * вторую ветку для одной и той же задачи.
 *
 * Инвариант приоритета: правила проекта (RULES/AI-factory RULES/AGENTS/CLAUDE) >
 * .ai-factory/config.yaml > встроенные значения Handoff. Побеждает первое найденное
 * объявление; нижестоящие источники не читаются даже для добивки отдельных полей.
 *
 * Логирование намеренно ограничено производными значениями и источником: содержимое
 * файлов правил в лог не попадает - там могут быть данные проекта.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectConfig, logger } from "@aif/shared";

const log = logger("plan-review:git-conventions");

/** Откуда взялись разрешённые git-конвенции. */
export type GitConventionsSource = "rules" | "config" | "default";

/**
 * Детерминированные, машиночитаемые git-конвенции целевого проекта.
 * Маркеры в файлах правил сильнее конфига ai-factory, а тот сильнее
 * значений по умолчанию Handoff. Значения выводятся — никогда не произвольный текст.
 */
export interface TargetProjectGitConventions {
  /** Префикс ветки, нормализован до завершения "/" (например "feature/" или "fix/"). */
  branchPrefix: string;
  /**
   * Префикс subject в стиле conventional-commits для коммитов только с планом,
   * например "docs(plan):". При null вызывающий код откатывается к "docs(plan):".
   */
  commitSubjectPrefix: string | null;
  source: GitConventionsSource;
  /** Файл, объявивший конвенцию (если объявлен). */
  sourceDetail: string | null;
}

export const DEFAULT_BRANCH_PREFIX = "feature/";
export const DEFAULT_COMMIT_SUBJECT_PREFIX = "docs(plan):";

/** VCS-провайдер, которому принадлежит issue, по номеру которой названа ветка. */
export type IssueProvider = "github" | "gitlab";

// Порядок массива задает приоритет: побеждает первый файл, который что-то объявил,
// поэтому специфичный для проекта .ai-factory/RULES.md стоит раньше корневых файлов.
const RULE_CANDIDATES = [".ai-factory/RULES.md", "RULES.md", "AGENTS.md", "CLAUDE.md"] as const;

// Раздел ищется только на уровнях 2-3: уровень 1 - это заголовок самого документа,
// а не секция конвенций.
const SECTION_HEADING = /^#{2,3}\s+git conventions\s*$/i;

// Любой следующий заголовок закрывает секцию: ключи из соседних разделов не подхватятся.
const NEXT_HEADING = /^#{1,6}\s/;
const KEY_VALUE_LINE = /^\s*([a-zA-Z0-9_]+)\s*:\s*(.+?)\s*$/;

// Читается только начало файла: конвенции - короткие декларации, а сам файл правил
// может быть раздут сгенерированным содержимым.
const MAX_RULES_BYTES = 64 * 1024;

interface RuleFieldValues {
  branchPrefix: string | null;
  commitSubjectPrefix: string | null;
}

/** Разбирает секцию "Git conventions" markdown-файла правил. */
function readGitConventionsSection(filePath: string): RuleFieldValues | null {
  if (!existsSync(filePath)) return null;
  let content: string;
  try {
    content = readFileSync(filePath, "utf8").slice(0, MAX_RULES_BYTES);
  } catch {
    return null;
  }

  // Разбиение по /\r?\n/, а не по "\n": файлы правил часто приходят с CRLF из Windows.
  const lines = content.split(/\r?\n/);

  // Флаг вместо диапазона строк: конец секции определяется заголовком, а не позицией.
  let inSection = false;
  const fields: RuleFieldValues = { branchPrefix: null, commitSubjectPrefix: null };

  for (const rawLine of lines) {
    if (!inSection) {
      // До начала секции строки игнорируются целиком, иначе ключ с тем же именем,
      // объявленный выше по документу, считался бы конвенцией.
      if (SECTION_HEADING.test(rawLine.trim())) {
        inSection = true;
        continue;
      }
      continue;
    }
    if (NEXT_HEADING.test(rawLine)) {
      break;
    }
    // Пустые строки, подзаголовки и пункты списка пропускаются: объявлением считается
    // только строка вида "ключ: значение".
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
    const match = KEY_VALUE_LINE.exec(trimmed);
    if (!match) continue;
    // Дефисы приводятся к подчеркиваниям: в markdown естественно писать branch-prefix,
    // а сравнивать нужно один канонический вид ключа.
    const key = match[1].toLowerCase().replace(/-/g, "_");
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (!value) continue;
    if (key === "branch_prefix") {
      fields.branchPrefix = value;
    } else if (key === "commit_subject_prefix" || key === "commit_prefix") {
      fields.commitSubjectPrefix = value;
    }
    // Ранний выход: остальная часть секции уже не изменит результат.
    if (fields.branchPrefix && fields.commitSubjectPrefix) break;
  }

  // null означает "секция ничего не объявила". Возврат пустого объекта здесь перебил бы
  // нижестоящий источник конвенций (config.yaml), хотя объявления не было.
  return fields.branchPrefix || fields.commitSubjectPrefix ? fields : null;
}

// Идемпотентно: "feature" и "feature/" дают один результат, поэтому нормализацию можно
// вызывать на каждом шаге, не проверяя, нормализован ли префикс ранее.
function normalizeBranchPrefix(prefix: string): string {
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

/**
 * Ищет явно объявленный `branch_prefix` внутри секции `git:` файла
 * `.ai-factory/config.yaml`. Проверка по сырому тексту, поэтому и
 * дефолтное значение, вписанное пользователем, считается «объявленным».
 */
function declaredConfigBranchPrefix(projectRoot: string): string | null {
  const configPath = join(projectRoot, ".ai-factory", "config.yaml");
  if (!existsSync(configPath)) return null;
  let content: string;
  try {
    content = readFileSync(configPath, "utf8").slice(0, MAX_RULES_BYTES);
  } catch {
    return null;
  }
  // Секция git: захватывается вместе с отступленными строками и обрывается на первой
  // строке без отступа - это граница следующего ключа верхнего уровня.
  const gitSection = /^git:\s*\n(?:[ \t][^\n]*\n)*/m.exec(content)?.[0];
  if (!gitSection) return null;
  const branchLine = /[ \t]+branch_prefix:\s*["']?([^"'\n#]+)["']?\s*$/.exec(
    gitSection.split("\n").slice(1).join("\n"),
  );
  if (!branchLine) return null;
  // Пустое значение (branch_prefix:) равносильно отсутствию объявления.
  const value = branchLine[1].trim();
  return value.length > 0 ? value : null;
}

/**
 * Разрешает конвенции именования веток и сообщений коммитов из целевого
 * проекта с корнем `projectRoot`. Приоритет:
 *
 * 1. Секция `## Git conventions` в `RULES.md` / `AGENTS.md` / `CLAUDE.md`,
 *    объявляющая ключи `branch_prefix:` и/или `commit_subject_prefix:`.
 * 2. `git.branch_prefix`, объявленный в `.ai-factory/config.yaml`.
 * 3. Значения по умолчанию Handoff (ветки `feature/`, префикс `docs(plan):`).
 *
 * Логируются только производные значения и источник конвенции — не содержимое файлов.
 */
export function resolveTargetProjectGitConventions(
  projectRoot: string,
): TargetProjectGitConventions {
  // Обход кандидатов останавливается на первом файле, который что-то объявил: смешивать
  // поля из разных файлов нельзя, иначе получится конвенция, которой никто не задавал.
  for (const candidate of RULE_CANDIDATES) {
    const fields = readGitConventionsSection(join(projectRoot, candidate));
    if (!fields) continue;
    // Отсутствующий branch_prefix добивается значением по умолчанию, а
    // commitSubjectPrefix остаётся null: признак "не объявлено" нужен для своего резерва.
    const result: TargetProjectGitConventions = {
      branchPrefix: normalizeBranchPrefix(fields.branchPrefix ?? DEFAULT_BRANCH_PREFIX),
      commitSubjectPrefix: fields.commitSubjectPrefix,
      source: "rules",
      sourceDetail: candidate,
    };
    log.debug(
      {
        projectRoot,
        source: result.source,
        sourceDetail: result.sourceDetail,
        branchPrefix: result.branchPrefix,
        hasCommitSubjectPrefix: Boolean(result.commitSubjectPrefix),
      },
      "Resolved target-project git conventions from rules",
    );
    return result;
  }

  // Признак объявления берется из сырого текста файла, а значение - из типизированного
  // конфига: пользователь, вписавший значение, равное дефолту, все равно получает
  // источник "config", а не "default".
  const configBranchPrefix = declaredConfigBranchPrefix(projectRoot);
  if (configBranchPrefix) {
    const config = getProjectConfig(projectRoot);
    const prefix = config.git.branch_prefix.trim();
    const result: TargetProjectGitConventions = {
      branchPrefix: normalizeBranchPrefix(prefix || DEFAULT_BRANCH_PREFIX),
      commitSubjectPrefix: null,
      source: "config",
      sourceDetail: ".ai-factory/config.yaml",
    };
    log.debug(
      {
        projectRoot,
        source: result.source,
        sourceDetail: result.sourceDetail,
        branchPrefix: result.branchPrefix,
      },
      "Resolved target-project git conventions from project config",
    );
    return result;
  }

  // sourceDetail пуст: файла-источника нет, и это отличает дефолт от конвенции проекта.
  const fallback: TargetProjectGitConventions = {
    branchPrefix: DEFAULT_BRANCH_PREFIX,
    commitSubjectPrefix: null,
    source: "default",
    sourceDetail: null,
  };
  log.debug(
    { projectRoot, source: fallback.source, branchPrefix: fallback.branchPrefix },
    "Resolved target-project git conventions from defaults",
  );
  return fallback;
}

/**
 * Детерминированный, non-LLM subject коммита только с планом, уважающий
 * явный префикс целевого проекта, когда он задан.
 */
export function buildPlanCommitSubject(
  title: string,
  conventions: Pick<TargetProjectGitConventions, "commitSubjectPrefix">,
): string {
  const prefix = (conventions.commitSubjectPrefix ?? DEFAULT_COMMIT_SUBJECT_PREFIX).trim();
  // Переносы строк и двойные пробелы в заголовке ломают разбор subject, поэтому
  // заголовок схлопывается в одну строку до подстановки в шаблон.
  const normalizedTitle = title.replace(/\s+/g, " ").trim();

  // Разделитель не дублирует двоеточие: префикс вида "docs(plan):" уже содержит его.
  const separator = prefix.endsWith(":") ? " " : ": ";
  const subject = `${prefix}${separator}${normalizedTitle}`.trim();
  // Subject в стиле conventional-commits ограничивают примерно 72 символами.
  return subject.length > 72 ? `${subject.slice(0, 69).replace(/\s+$/, "")}...` : subject;
}

/**
 * Имя ветки для VCS-issue: `<prefix><provider>-issue-<number>`. Это ЕДИНЫЙ
 * источник истины для обоих путей создания — путь рабочего дерева и
 * путь `ensureFeatureBranch` внутри дерева должны давать одну ветку для
 * того же issue, иначе повторный запуск задачи молча создаст вторую ветку.
 */
export function resolveBranchName(
  prefix: string,
  provider: IssueProvider,
  issueNumber: number,
): string {
  // Провайдер входит в имя ветки: issue #5 в GitHub и в GitLab - разные сущности,
  // и общая ветка на оба провайдера привела бы к смешению коммитов.
  return `${normalizeBranchPrefix(prefix)}${provider}-issue-${issueNumber}`;
}

export interface ResolvedIssueBranch {
  branchName: string;
  /** Откуда взялся префикс ветки. */
  source: GitConventionsSource;
  sourceDetail: string | null;
}

/**
 * Разрешает имя ветки для issue вместе с источником её префикса.
 * Цепочка отката: RULES `## Git conventions` → `.ai-factory/config.yaml` →
 * провайдерский дефолт (`feature/`). При дефолте пишется WARN, чтобы
 * оператор видел, почему ветка не следует конвенции проекта.
 */
export function resolveIssueBranchName(input: {
  projectRoot: string;
  provider: IssueProvider;
  issueNumber: number;
}): ResolvedIssueBranch {
  const conventions = resolveTargetProjectGitConventions(input.projectRoot);
  const branchName = resolveBranchName(conventions.branchPrefix, input.provider, input.issueNumber);
  // Предупреждение только для дефолта: источники rules/config означают осознанное
  // решение проекта, и шуметь на них не нужно.
  if (conventions.source === "default") {
    log.warn(
      {
        projectRoot: input.projectRoot,
        provider: input.provider,
        issueNumber: input.issueNumber,
        branchName,
        source: conventions.source,
      },
      "No branch convention declared; using provider default prefix for issue branch",
    );
  }
  return {
    branchName,
    source: conventions.source,
    sourceDetail: conventions.sourceDetail,
  };
}
