/**
 * Единый граф жизненного цикла координатора (stage pipeline).
 *
 * Раньше топология конвейера жила в двух местах и могла разъехаться:
 *   - `PIPELINE` в `packages/agent/src/coordinator.ts` (порядок стадий +
 *     входные/рабочие/целевые статусы + runner'ы);
 *   - `coordinatorStageFilter` в `packages/data/src/coordinatorClaims.ts`
 *     (какие статусы какая стадия подбирает из БД).
 *
 * Теперь это один справочник: порядок стадий, входные статусы (from), рабочий
 * статус (inProgress) и целевой статус (onSuccess). Доставщики (agent, data)
 * выводят свою логику из него; runner'ы стадий и политика override
 * (skipReview / skills-mode флаги) остаются в agent — это поведение, а не
 * топология.
 *
 * Справочник живёт в shared, потому что его читают и data (фильтр кандидатов),
 * и agent (конвейер), и он не зависит от доставки.
 */
import type { TaskStatus } from "./types.js";

/** Стадии координатора в порядке конвейера. */
export type CoordinatorStage =
  | "planner"
  | "improver"
  | "plan-checker"
  | "plan-publisher"
  | "implementer"
  | "reviewer"
  | "verifier"
  | "done-checker";

/** Топология одной стадии: какие статусы поймать, в каком работать, куда выйти. */
export interface CoordinatorStageSpec {
  stage: CoordinatorStage;
  /** Статусы, из которых стадия может подхватить задачу. */
  from: readonly TaskStatus[];
  /** Статус, в котором задача удерживается во время работы стадии. */
  inProgress: TaskStatus;
  /** Базовый статус после успешного завершения стадии (без policy-override). */
  onSuccess: TaskStatus;
}

/** Порядок стадий конвейера — единственное место, где он определён. */
export const COORDINATOR_STAGE_ORDER: readonly CoordinatorStage[] = [
  "planner",
  "improver",
  "plan-checker",
  "plan-publisher",
  "implementer",
  "verifier",
  "reviewer",
  "done-checker",
];

/**
 * Топология стадий: from/inProgress/onSuccess по каждой стадии.
 * Self-loop'ы plan_review идут до implementer, чтобы реализация не стартовала
 * без решения Plan Review Gate.
 */
export const TASK_STAGE_LIFECYCLE: Readonly<Record<CoordinatorStage, CoordinatorStageSpec>> = {
  planner: {
    stage: "planner",
    from: ["planning"],
    inProgress: "planning",
    onSuccess: "plan_review",
  },
  improver: {
    stage: "improver",
    from: ["improve"],
    inProgress: "improve",
    onSuccess: "plan_review",
  },
  "plan-checker": {
    stage: "plan-checker",
    from: ["plan_review"],
    inProgress: "plan_review",
    onSuccess: "plan_review",
  },
  "plan-publisher": {
    stage: "plan-publisher",
    from: ["plan_review"],
    inProgress: "plan_review",
    onSuccess: "plan_review",
  },
  implementer: {
    stage: "implementer",
    from: ["plan_review", "implementing"],
    inProgress: "implementing",
    onSuccess: "verify",
  },
  verifier: {
    stage: "verifier",
    from: ["verify"],
    inProgress: "verify",
    onSuccess: "review",
  },
  reviewer: {
    stage: "reviewer",
    from: ["review"],
    inProgress: "review",
    onSuccess: "done",
  },
  "done-checker": {
    stage: "done-checker",
    from: ["done"],
    inProgress: "done",
    onSuccess: "accepted",
  },
};

/** Статус-постоянная стадии (inProgress) по имени стадии. */
export function stageInProgressStatus(stage: CoordinatorStage): TaskStatus {
  return TASK_STAGE_LIFECYCLE[stage].inProgress;
}
