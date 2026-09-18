/**
 * Выбор стратегии выполнения подагентов под Codex.
 *
 * У Codex два принципиально разных способа запускать подагентов. native — через нативные
 * агентские определения (.codex/agents/*.toml), которые тянет сам Codex; isolated — через наши
 * изолированные агенты вне CLI. Какой режим доступен, зависит от того, положил ли в проект
 * файлы-ассеты ai-factory >=2.11.0, поэтому здесь есть и проверка готовности проекта.
 *
 * Функция resolve... намеренно не бросает исключений: любое невалидное значение опции
 * (опечатка, устаревшее имя) трактуется как откат к isolated, а причина возвращается текстом
 * в поле reason — её удобно логировать и показывать в диагностике.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeWorkflowKind } from "../../workflowSpec.js";
import { asRecord, readString } from "../../utils.js";

// Ключ опции в runtimeOptions: одна константа вместо строкового литерала во всех местах.
export const CODEX_SUBAGENT_STRATEGY_OPTION = "codexSubagentStrategy";

// Значения перечислены и как объект, и как union-тип ниже — так они доступны и в рантайме,
// и в системе типов без дублирования строк в двух местах.
export const CODEX_SUBAGENT_STRATEGIES = {
  native: "native",
  isolated: "isolated",
} as const;

export type CodexSubagentStrategy =
  (typeof CODEX_SUBAGENT_STRATEGIES)[keyof typeof CODEX_SUBAGENT_STRATEGIES];

// reason — машиночитаемое объяснение выбора. Он нужен, чтобы в логах было видно,
// почему включился тот или иной режим, не парся при этом текст сообщений.
export type CodexSubagentStrategyResolutionReason =
  | "non_codex"
  | "default_native"
  | "explicit_native"
  | "explicit_isolated"
  | "invalid_fallback"
  | "disabled_by_env";

export interface CodexSubagentStrategyResolution {
  // null означает "не применимо" (не Codex), а не ошибку: вызывающий отличает этот случай
  // от валидной стратегии и не считает его провалом.
  strategy: CodexSubagentStrategy | null;
  reason: CodexSubagentStrategyResolutionReason;
  configuredValue?: string;
  nativeSubagentsEnabled: boolean;
}

// Держите этот список синхронно с ассетами Codex, материализуемыми ai-factory >=2.11.0.
// Список жёстко зашит, потому что готовность native-режима — это наличие ровно этих файлов.
// При обновлении ассетов ai-factory список надо дополнять, иначе readiness даст ложное true.
const CODEX_NATIVE_AGENT_FILES = [
  "best-practices-sidecar.toml",
  "commit-preparer.toml",
  "docs-auditor.toml",
  "implement-coordinator.toml",
  "implement-worker.toml",
  "plan-coordinator.toml",
  "plan-polisher.toml",
  "review-sidecar.toml",
  "security-sidecar.toml",
] as const;

export interface CodexNativeSubagentReadiness {
  ready: boolean;
  missingPaths: string[];
}

// Разрешённая стратегия + причина. Приоритет источников — от самого явного к неявным:
// явная опция isolated, затем невалидное значение (откат), затем флаг доступности native,
// и только в конце — дефолт.
export function resolveCodexSubagentStrategy(
  runtimeId: string,
  runtimeOptions?: Record<string, unknown>,
  options?: { nativeSubagentsEnabled?: boolean },
): CodexSubagentStrategyResolution {
  // Ранний выход для других рантаймов: не навязываем им codex-специфичную опцию.
  if (runtimeId !== "codex") {
    return {
      strategy: null,
      reason: "non_codex",
      nativeSubagentsEnabled: false,
    };
  }

  // readString + asRecord вместо прямого доступа: runtimeOptions приходит из JSON
  // произвольной формы, и нестроковое значение должно трактоваться как "не задано".
  const configured = readString(asRecord(runtimeOptions)[CODEX_SUBAGENT_STRATEGY_OPTION]);
  if (configured === CODEX_SUBAGENT_STRATEGIES.isolated) {
    return {
      strategy: CODEX_SUBAGENT_STRATEGIES.isolated,
      reason: "explicit_isolated",
      configuredValue: configured,
      nativeSubagentsEnabled: Boolean(options?.nativeSubagentsEnabled),
    };
  }

  // Значение задано, но не равно ни одному известному: откатываемся на isolated,
  // потому что он не требует внешних ассетов и гарантированно работает.
  if (configured && configured !== CODEX_SUBAGENT_STRATEGIES.native) {
    return {
      strategy: CODEX_SUBAGENT_STRATEGIES.isolated,
      reason: "invalid_fallback",
      configuredValue: configured,
      nativeSubagentsEnabled: Boolean(options?.nativeSubagentsEnabled),
    };
  }

  // Пользователь хотел native (или не указал ничего), но фича выключена окружением:
  // reason disabled_by_env отделяет этот случай от явного выбора isolated.
  if (!options?.nativeSubagentsEnabled) {
    return {
      strategy: CODEX_SUBAGENT_STRATEGIES.isolated,
      reason: "disabled_by_env",
      // configured ?? undefined вместо null: поле опциональное, и undefined означает
      // "значение не задавалось", что семантически точнее явного null.
      configuredValue: configured ?? undefined,
      nativeSubagentsEnabled: false,
    };
  }

  return {
    strategy: CODEX_SUBAGENT_STRATEGIES.native,
    // Различаем явный выбор пользователя и дефолт: это важно для аналитики и отладки.
    reason: configured ? "explicit_native" : "default_native",
    configuredValue: configured ?? undefined,
    nativeSubagentsEnabled: true,
  };
}

// Проверка готовности проекта к native-режиму: есть ли на месте .codex/config.toml
// и все ожидаемые файлы агентов. Возвращаем список отсутствующего, а не просто false:
// по нему можно показать пользователю, что именно нужно доложить.
export function resolveCodexNativeSubagentReadiness(
  projectRoot?: string | null,
): CodexNativeSubagentReadiness {
  // projectRoot может быть null (проект ещё не выбран) — тогда готовности нет по
  // определению, и путь для проверки не с чем склеивать.
  if (!projectRoot) {
    return {
      ready: false,
      missingPaths: [".codex/config.toml", ".codex/agents/*.toml"],
    };
  }

  const missingPaths = [
    // filter + map вместо цикла: собираем отсутствующие файлы в человекочитаемые пути,
    // сразу в том виде, в котором их покажет диагностика.
    ...CODEX_NATIVE_AGENT_FILES.filter(
      (fileName) => !existsSync(join(projectRoot, ".codex", "agents", fileName)),
    ).map((fileName) => `.codex/agents/${fileName}`),
  ];

  // Путь не подошёл — добавляем config.toml в конец списка отдельно,
  // так как это не файл агента и в CODEX_NATIVE_AGENT_FILES его нет.
  if (!existsSync(join(projectRoot, ".codex", "config.toml"))) {
    missingPaths.push(".codex/config.toml");
  }

  return {
    // ready только при пустом списке пропаж: частичная готовность считается неготовностью.
    ready: missingPaths.length === 0,
    missingPaths,
  };
}

// Подсказки для промпта по видам workflow: Partial<Record<...>> допускает, что не для
// каждого вида есть специфичная инструкция — для остальных сработает дефолт ниже.
const NATIVE_SUBAGENT_WORKFLOW_GUIDANCE: Partial<Record<RuntimeWorkflowKind, string>> = {
  planner:
    'Use "plan-polisher" for bounded critique/refinement passes when helpful, then return the final implementation-ready plan in the parent thread.',
  implementer:
    'Let the coordinator agent decide when to spawn "implement-worker", "review-sidecar", "security-sidecar", "best-practices-sidecar", "docs-auditor", and "commit-preparer". Reconcile results in the parent thread.',
  reviewer: 'Return only the consolidated findings from the delegated "review-sidecar" run.',
  "review-security":
    'Return only the consolidated findings from the delegated "security-sidecar" run.',
};

// Вызывающий получает строку всегда: дефолт не даёт промпту остаться без инструкции,
// если для нового вида workflow подсказку забыли добавить.
export function getNativeSubagentWorkflowGuidance(workflowKind: RuntimeWorkflowKind): string {
  return (
    NATIVE_SUBAGENT_WORKFLOW_GUIDANCE[workflowKind] ??
    "Delegate work to the named custom agent and keep the final response in the parent thread."
  );
}
