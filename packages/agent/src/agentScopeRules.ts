/**
 * Загрузчик scope-правил из agent definition файлов.
 *
 * По принципу «agent definitions — конфиг, а не код» длинные промпт-литералы
 * живут в проектах-определениях `.claude/agents/*.md`, а не в TS. Здесь они
 * читаются из `plan-coordinator.md` (секции «### Project scope rule» /
 * «### Review scope rule») и кэшируются на процесс.
 *
 * Источник файла: каталог определений задаётся через AIF_AGENT_DEFINITIONS_DIR
 * (производство/docker/тесты), иначе по умолчанию ищется
 * `<cwd>/.claude/agents/plan-coordinator.md` (агент стартует из корня репозитория).
 *
 * Правила опциональны: если файл или секция отсутствуют, возвращается пустая
 * строка — scope-правило является поведенческой рамкой, а не критичным
 * контрактом, ломающим запуск.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getEnv, logger } from "@aif/shared";

const log = logger("agent-scope-rules");

const SCOPE_DEFINITION_FILE = "plan-coordinator.md";
const PROJECT_SCOPE_HEADING = "### Project scope rule";
const REVIEW_SCOPE_HEADING = "### Review scope rule";

/** Финальные scope-правила, читаемые субагентским слоем. */
export interface AgentScopeRules {
  /** Дефолтный systemPromptAppend: граница рабочего каталога. */
  projectScope: string;
  /** Дополнение для review-стадий: аудит только дельты текущей задачи. */
  reviewScope: string;
}

let cachedRules: AgentScopeRules | null = null;

/** Разделяет секцию по заголовку: возвращает текст до следующего `##`/`###` заголовка. */
function extractSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start === -1) return "";
  const bodyStart = start + heading.length;
  const nextHeadingMatch = /\n#{1,6} /.exec(markdown.slice(bodyStart));
  const bodyEnd = nextHeadingMatch ? bodyStart + nextHeadingMatch.index : markdown.length;
  return markdown.slice(bodyStart, bodyEnd).trim();
}

/** Каталог определений: env-переопределение или cwd/.claude/agents. */
function definitionsDir(): string {
  const override = getEnv().AIF_AGENT_DEFINITIONS_DIR;
  if (override !== undefined && override.trim().length > 0) {
    return override.trim();
  }
  return join(process.cwd(), ".claude", "agents");
}

/** Читает scope-секции из файла определений с кэшем на процесс. */
export function getAgentScopeRules(): AgentScopeRules {
  if (cachedRules) return cachedRules;

  const dir = definitionsDir();
  try {
    const filePath = join(dir, SCOPE_DEFINITION_FILE);
    const content = readFileSync(filePath, "utf8");
    cachedRules = {
      projectScope: extractSection(content, PROJECT_SCOPE_HEADING),
      reviewScope: extractSection(content, REVIEW_SCOPE_HEADING),
    };
    log.debug(
      {
        dir,
        projectScopeLength: cachedRules.projectScope.length,
        reviewScopeLength: cachedRules.reviewScope.length,
        source: "definitions",
      },
      "Loaded agent scope rules from agent definitions",
    );
  } catch (error) {
    log.warn({ error, dir }, "Agent scope rules unavailable; falling back to empty scope rules");
    cachedRules = { projectScope: "", reviewScope: "" };
  }
  return cachedRules;
}

/** Сброс кэша (тесты, смена общего каталога). */
export function resetAgentScopeRulesCache(): void {
  cachedRules = null;
}
