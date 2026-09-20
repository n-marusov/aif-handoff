// FG-MUTATION — политика мутационного тестирования.
//
// Проверяет конфигурацию мутационного тестирования на соответствие политике
// (gates.md §6.4 / §9.6): для критичных пакетов (автомат стадий, переходы и
// владение задачей, аудит, auth/CSRF, runtime-лимиты, резолюция профилей,
// изоляция worktree) mutation score >= 80%; порог должен быть выражен в
// конфигурации Stryker.
//
// Этот гейт проверяет *задекларированность* порога и покрытие критичных
// пакетов в `stryker.conf.mjs` (glob-скоупы mutate). Сам прогон мутаций
// остаётся локальным и дорогим (не входит в быстрый гейт). Нарушение политики
// (порог ниже цели, отсутствие критичного пакета в конфиге) — `warn`:
// целевое состояние требует фактических score, которые калибруются с
// QA-инженером (gates.md §9.6).

import { join } from "node:path";

import { readText } from "../lib/fs-tools.mjs";
import { log } from "../lib/logger.mjs";

export const GATE = { id: "FG-MUTATION", name: "Мутационное тестирование", group: "FG" };

const STRYKER_CONFIG = "stryker.conf.mjs";

// Критичные пакеты (gates.md §9.6: автомат стадий, переходы/handoff, аудит,
// auth/CSRF, runtime-лимиты, резолюция профилей, изоляция worktree живут в
// @aif/shared и @aif/data).
const CRITICAL_PACKAGES = [
  { name: "shared", label: "@aif/shared (stateMachine, taskLifecycle, env)" },
  { name: "data", label: "@aif/data (taskTransitions, taskOwnership, audit, authSessions)" },
];

export async function run({ repoRoot }) {
  const checks = [];
  const config = readText(join(repoRoot, STRYKER_CONFIG));

  if (config === null) {
    return {
      checks: [
        { scope: STRYKER_CONFIG, status: "fail", message: "конфигурация Stryker не найдена" },
      ],
      summary: "stryker config missing",
    };
  }

  // 1. Объявлены ли thresholds в конфиге.
  const thresholds = config.match(/thresholds\s*:\s*\{[^}]+\}/s);
  if (thresholds === null) {
    checks.push({
      scope: STRYKER_CONFIG,
      status: "fail",
      message: "в конфигурации не объявлены `thresholds`",
    });
  } else {
    const breakMatch = thresholds[0].match(/(?:break|low)\s*:\s*(\d+)/);
    if (breakMatch !== null && Number(breakMatch[1]) < 80) {
      checks.push({
        scope: STRYKER_CONFIG,
        status: "warn",
        message: `порог прерывания mutation score = ${breakMatch[1]}%, целевое состояние — ≥ 80% для критичных пакетов (gates.md §9.6)`,
      });
    }
  }

  // 2. Критичные пакеты присутствуют в PACKAGE_CONFIGS с непустым mutate-скоупом.
  for (const pkg of CRITICAL_PACKAGES) {
    const block = config.match(
      new RegExp(`${pkg.name}\\s*:\\s*\\{[^}]*mutate\\s*:\\s*\\[[^\\]]*\\]`),
    );
    const hasScope = block !== null && /mutate\s*:\s*\[[^\]]*packages\//.test(block[0]);
    if (hasScope) continue;
    checks.push({
      scope: STRYKER_CONFIG,
      status: "warn",
      message: `критичный пакет ${pkg.label} не входит в mutate-скоуп (проверьте конфигурацию)`,
    });
  }

  log.info(`FG-MUTATION: проверка политики завершена (${checks.length} замечаний)`);
  return {
    checks,
    summary: `mutation policy check (${CRITICAL_PACKAGES.length} critical packages)`,
  };
}
