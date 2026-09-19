// Доменная политика runtime-limit gate и приоритетов runtime-профиля.
//
// Вынесены из @aif/data (Task 15 clean-architecture рефакторинга): это чистые
// решения, которые не читают и не пишут БД. Слой данных оставляет за собой
// только чтение/запись строк и гидратацию; применение правил из этого модуля
// происходит на стороне вызывающего кода либо в data через импорт отсюда.
//
// Модуль серверный (читает getEnv(), пишет DEBUG-логи решений) и не входит в
// браузерный вход @aif/shared/browser.

import { getEnv } from "./env.js";
import { logger as createLogger } from "./logger.js";
import {
  buildRuntimeLimitSignature,
  resolveRuntimeLimitFutureHint,
  selectViolatedWindowForExactThreshold,
  type RuntimeLimitFutureHint,
} from "./runtimeLimitUtils.js";
import type { ProjectRow } from "./schema.js";
import type {
  EffectiveRuntimeProfileSelection,
  RuntimeLimitSnapshot,
  RuntimeLimitWindow,
  RuntimeProfile,
} from "./types.js";

const log = createLogger("shared");

// Политика включения записи снимков лимитов: гейт-решения и персист снимков
// активны только при включённом флаге. Вынесено отдельной функцией, чтобы
// data-слой не вызывал getEnv() напрямую, а применял решение из домена.
export function isRuntimeLimitAwarenessEnabled(): boolean {
  return getEnv().AIF_USAGE_LIMITS_ENABLED;
}

export interface RuntimeLimitGateDecision {
  blocked: boolean;
  reason: "none" | "provider_blocked" | "exact_threshold";
  runtimeProfileId: string | null;
  snapshot: RuntimeLimitSnapshot | null;
  futureHint: RuntimeLimitFutureHint;
  violatedWindow: RuntimeLimitWindow | null;
  signature: string | null;
}

function debugGateDecision(decision: RuntimeLimitGateDecision): void {
  log.debug(
    {
      runtimeProfileId: decision.runtimeProfileId,
      blocked: decision.blocked,
      reason: decision.reason,
      signature: decision.signature,
    },
    "Evaluated runtime limit gate",
  );
}

export function evaluateRuntimeLimitGate(
  profile: RuntimeProfile | null | undefined,
  nowMs = Date.now(),
): RuntimeLimitGateDecision {
  const runtimeProfileId = profile?.id ?? null;
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) {
    const decision: RuntimeLimitGateDecision = {
      blocked: false,
      reason: "none",
      runtimeProfileId,
      snapshot: null,
      futureHint: resolveRuntimeLimitFutureHint(null, { nowMs }),
      violatedWindow: null,
      signature: null,
    };
    debugGateDecision(decision);
    return decision;
  }

  const snapshot = profile?.runtimeLimitSnapshot ?? null;
  if (!snapshot) {
    const decision: RuntimeLimitGateDecision = {
      blocked: false,
      reason: "none",
      runtimeProfileId,
      snapshot: null,
      futureHint: resolveRuntimeLimitFutureHint(null, { nowMs }),
      violatedWindow: null,
      signature: null,
    };
    debugGateDecision(decision);
    return decision;
  }

  const signature = buildRuntimeLimitSignature(snapshot);
  const providerBlockedHint = resolveRuntimeLimitFutureHint(snapshot, { nowMs });

  if (snapshot.status === "blocked" && providerBlockedHint.source === "none") {
    log.debug(
      {
        runtimeProfileId,
        status: snapshot.status,
        precision: snapshot.precision,
        checkedAt: snapshot.checkedAt,
        signature,
      },
      "Skipping proactive runtime gate because the persisted snapshot has no reset hint",
    );
  }
  if (snapshot.status === "blocked" && providerBlockedHint.isFuture) {
    const decision: RuntimeLimitGateDecision = {
      blocked: true,
      reason: "provider_blocked",
      runtimeProfileId,
      snapshot,
      futureHint: providerBlockedHint,
      violatedWindow: null,
      signature,
    };
    debugGateDecision(decision);
    return decision;
  }

  const violatedWindow = selectViolatedWindowForExactThreshold(snapshot, null, nowMs);
  const exactThresholdReached =
    snapshot.precision === "exact" && snapshot.status === "warning" && violatedWindow != null;
  const exactThresholdHint = resolveRuntimeLimitFutureHint(snapshot, {
    nowMs,
    preferredWindow: violatedWindow,
    windowFirst: true,
  });

  if (exactThresholdReached && exactThresholdHint.source === "none") {
    log.debug(
      {
        runtimeProfileId,
        status: snapshot.status,
        precision: snapshot.precision,
        checkedAt: snapshot.checkedAt,
        signature,
      },
      "Skipping proactive exact-threshold gate because the violated window has no reset hint",
    );
  }

  if (exactThresholdReached && exactThresholdHint.isFuture) {
    const decision: RuntimeLimitGateDecision = {
      blocked: true,
      reason: "exact_threshold",
      runtimeProfileId,
      snapshot,
      futureHint: exactThresholdHint,
      violatedWindow,
      signature,
    };
    debugGateDecision(decision);
    return decision;
  }

  const decision: RuntimeLimitGateDecision = {
    blocked: false,
    reason: "none",
    runtimeProfileId,
    snapshot,
    futureHint: providerBlockedHint,
    violatedWindow: violatedWindow ?? null,
    signature,
  };
  debugGateDecision(decision);
  return decision;
}

// Приоритеты дефолтных профилей проекта по режиму конвейера: чат всегда берёт
// только свой слот, планирование/ревью каскадом падают на задачный слот.
export function getProjectRuntimeProfileId(
  project: ProjectRow | undefined,
  mode: "task" | "plan" | "review" | "chat",
): string | null {
  if (mode === "chat") {
    return project?.defaultChatRuntimeProfileId ?? null;
  }
  if (mode === "plan") {
    return project?.defaultPlanRuntimeProfileId ?? project?.defaultTaskRuntimeProfileId ?? null;
  }
  if (mode === "review") {
    return project?.defaultReviewRuntimeProfileId ?? project?.defaultTaskRuntimeProfileId ?? null;
  }
  return project?.defaultTaskRuntimeProfileId ?? null;
}

export type { EffectiveRuntimeProfileSelection };
