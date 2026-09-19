/**
 * Загрузчик scope-правил из agent definition файлов.
 *
 * По принципу «agent definitions — конфиг, а не код» длинные промпт-литералы
 * живут в проектах-определениях `.claude/agents/*.md`, а не в TS. Здесь они
 * читаются из `plan-coordinator.md` (секции «### Project scope rule» /
 * «### Review scope rule») и кэшируются на процесс.
 *
 * Источник файла: каталог определений задаётся через AIF_AGENT_DEFINITIONS_DIR
 * (производство/docker/тесты) — это highest-priority override. Без него каталог
 * резолвится от расположения модуля (packages/agent/src|dist → repo root/.claude/agents),
 * а process.cwd() остаётся последним фолбэком: cwd дрейфует в контейнерах/тестах.
 *
 * Правила опциональны: если файл или секция отсутствуют, возвращается пустая
 * строка — scope-правило является поведенческой рамкой, а не критичным
 * контрактом, ломающим запуск.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

/** Каталог определений, привязанный к расположению модуля (не к cwd). */
type DefinitionsSource = "env" | "module-anchor" | "cwd";

/**
 * Кандидаты каталога определений в порядке приоритета.
 *
 * Known issue: "agentScopeRules: определения резолвятся от process.cwd()". cwd
 * дрейфует (тесты, контейнеры, супервизоры), поэтому основной фолбэк — от
 * расположения модуля: `packages/agent/src|dist` → `../../../.claude/agents`.
 * Явный env-override остаётся единственным кандидатом и побеждает всегда.
 */
function definitionsCandidates(): Array<{ source: DefinitionsSource; dir: string }> {
  const override = getEnv().AIF_AGENT_DEFINITIONS_DIR?.trim();
  if (override) {
    return [{ source: "env", dir: override }];
  }
  return [
    {
      source: "module-anchor",
      dir: fileURLToPath(new URL("../../../.claude/agents", import.meta.url)),
    },
    { source: "cwd", dir: join(process.cwd(), ".claude", "agents") },
  ];
}

/** Читает scope-секции из файла определений с кэшем на процесс. */
export function getAgentScopeRules(): AgentScopeRules {
  if (cachedRules) return cachedRules;

  for (const candidate of definitionsCandidates()) {
    const filePath = join(candidate.dir, SCOPE_DEFINITION_FILE);
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, "utf8");
      cachedRules = {
        projectScope: extractSection(content, PROJECT_SCOPE_HEADING),
        reviewScope: extractSection(content, REVIEW_SCOPE_HEADING),
      };
      log.debug(
        {
          source: candidate.source,
          resolvedPath: filePath,
          projectScopeLength: cachedRules.projectScope.length,
          reviewScopeLength: cachedRules.reviewScope.length,
        },
        "Loaded agent scope rules from agent definitions",
      );
      return cachedRules;
    } catch (error) {
      log.warn(
        { error, source: candidate.source, resolvedPath: filePath },
        "Failed to read agent scope rules candidate",
      );
      // Пробуем следующий кандидат: один недоступный каталог не должен гасить правила.
    }
  }

  // WARN только когда исчерпаны все стратегии: это реальная деградация, а не шум.
  log.warn(
    { candidates: definitionsCandidates().map((candidate) => candidate.dir) },
    "Agent scope rules unavailable; falling back to empty scope rules",
  );
  cachedRules = { projectScope: "", reviewScope: "" };
  return cachedRules;
}

/** Сброс кэша (тесты, смена общего каталога). */
export function resetAgentScopeRulesCache(): void {
  cachedRules = null;
}
