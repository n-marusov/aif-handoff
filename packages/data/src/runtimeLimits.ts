/**
 * Политика runtime-limit gate и разрешение эффективного runtime-профиля
 * (чистые решения поверх строк БД; гейт-решения читают getEnv()).
 */
import { inArray } from "drizzle-orm";
import {
  buildRuntimeLimitSignature,
  getEnv,
  logger as createLogger,
  projects,
  resolveRuntimeLimitFutureHint,
  runtimeProfiles,
  selectViolatedWindowForExactThreshold,
  type EffectiveRuntimeProfileSelection,
  type RuntimeLimitFutureHint,
  type RuntimeLimitSnapshot,
  type RuntimeLimitWindow,
  type RuntimeProfile,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";
import { findTaskById, type TaskRow } from "./tasks.js";
import { findProjectById, type ProjectRow } from "./projects.js";
import { findRuntimeProfileById } from "./runtimeProfiles.js";
import { toRuntimeProfileResponse } from "@aif/shared";
import { findLatestRuntimeProfileUsageByIds } from "./usage.js";

const log = createLogger("data");

export interface RuntimeLimitGateDecision {
  blocked: boolean;
  reason: "none" | "provider_blocked" | "exact_threshold";
  runtimeProfileId: string | null;
  snapshot: RuntimeLimitSnapshot | null;
  futureHint: RuntimeLimitFutureHint;
  violatedWindow: RuntimeLimitWindow | null;
  signature: string | null;
}

export function evaluateRuntimeLimitGate(
  profile: RuntimeProfile | null | undefined,
  nowMs = Date.now(),
): RuntimeLimitGateDecision {
  const runtimeProfileId = profile?.id ?? null;
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) {
    return {
      blocked: false,
      reason: "none",
      runtimeProfileId,
      snapshot: null,
      futureHint: resolveRuntimeLimitFutureHint(null, { nowMs }),
      violatedWindow: null,
      signature: null,
    };
  }

  const snapshot = profile?.runtimeLimitSnapshot ?? null;
  if (!snapshot) {
    return {
      blocked: false,
      reason: "none",
      runtimeProfileId,
      snapshot: null,
      futureHint: resolveRuntimeLimitFutureHint(null, { nowMs }),
      violatedWindow: null,
      signature: null,
    };
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
    return {
      blocked: true,
      reason: "provider_blocked",
      runtimeProfileId,
      snapshot,
      futureHint: providerBlockedHint,
      violatedWindow: null,
      signature,
    };
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
    return {
      blocked: true,
      reason: "exact_threshold",
      runtimeProfileId,
      snapshot,
      futureHint: exactThresholdHint,
      violatedWindow,
      signature,
    };
  }

  return {
    blocked: false,
    reason: "none",
    runtimeProfileId,
    snapshot,
    futureHint: providerBlockedHint,
    violatedWindow: violatedWindow ?? null,
    signature,
  };
}

export function resolveEffectiveRuntimeProfile(input: {
  taskId?: string;
  projectId?: string;
  mode?: "task" | "plan" | "review" | "chat";
  systemDefaultRuntimeProfileId?: string | null;
}): EffectiveRuntimeProfileSelection {
  const mode = input.mode ?? "task";
  const task = input.taskId ? findTaskById(input.taskId) : undefined;
  const projectId = input.projectId ?? task?.projectId;
  const project = projectId ? findProjectById(projectId) : undefined;

  // Переопределение рантайма на уровне задачи действует на все этапы: если оно задано,
  // весь конвейер (планирование, реализация, ревью, чат) идёт на указанном рантайме.
  const taskRuntimeProfileId = task?.runtimeProfileId ?? null;

  const projectRuntimeProfileId = getProjectRuntimeProfileId(project, mode);
  const systemRuntimeProfileId = input.systemDefaultRuntimeProfileId ?? null;

  const candidates: Array<{
    source: EffectiveRuntimeProfileSelection["source"];
    profileId: string | null;
  }> = [
    { source: "task_override", profileId: taskRuntimeProfileId },
    { source: "project_default", profileId: projectRuntimeProfileId },
    { source: "system_default", profileId: systemRuntimeProfileId },
  ];

  // Накопленный список отказников нужен только для диагностики: он позволяет
  // объяснить в логе, почему задача уехала на профиль более низкого приоритета.
  // На выбор профиля он не влияет.
  const unavailableIds: string[] = [];

  // Первый же валидный кандидат побеждает и сразу возвращается: цепочка не
  // смотрит дальше, даже если следующий профиль "лучше". Отсев делается по
  // enabled, потому что отключённый профиль остаётся в БД для истории, но
  // запускать на нём задачи нельзя. Переопределение на задаче считается
  // принудительным и поэтому не логируется как вынужденный откат.
  for (const candidate of candidates) {
    if (!candidate.profileId) continue;
    const profile = findRuntimeProfileById(candidate.profileId);
    if (!profile || !profile.enabled) {
      unavailableIds.push(candidate.profileId);
      continue;
    }

    if (candidate.source !== "task_override" && unavailableIds.length > 0) {
      log.info(
        {
          source: candidate.source,
          taskRuntimeProfileId,
          projectRuntimeProfileId,
          systemRuntimeProfileId,
          unavailableCount: unavailableIds.length,
        },
        "Effective runtime profile fell back from higher-priority source",
      );
    }

    // Событие расходов подтягивается только для выбранного профиля — одним
    // запросом на один id. Массовая версия (resolveEffectiveRuntimeProfilesForTasks)
    // нужна там, где профилей сразу много.
    return {
      source: candidate.source,
      profile: toRuntimeProfileResponse(
        profile,
        findLatestRuntimeProfileUsageByIds([profile.id]).get(profile.id) ?? null,
      ),
      taskRuntimeProfileId,
      projectRuntimeProfileId,
      systemRuntimeProfileId,
    };
  }

  return {
    source: "none",
    profile: null,
    taskRuntimeProfileId,
    projectRuntimeProfileId,
    systemRuntimeProfileId,
  };
}

type RuntimeResolvableTask = Pick<TaskRow, "id" | "projectId" | "runtimeProfileId">;

export function resolveEffectiveRuntimeProfilesForTasks(
  taskRows: RuntimeResolvableTask[],
  input: {
    mode?: "task" | "plan" | "review" | "chat";
    systemDefaultRuntimeProfileId?: string | null;
  } = {},
): Map<string, EffectiveRuntimeProfileSelection> {
  const mode = input.mode ?? "task";
  const systemRuntimeProfileId = input.systemDefaultRuntimeProfileId ?? null;
  const results = new Map<string, EffectiveRuntimeProfileSelection>();
  if (taskRows.length === 0) {
    return results;
  }

  // Проекты и профили читаются пакетно до цикла, чтобы разрешение для сотни
  // задач не превратилось в сотни запросов. Списки id дедуплицируются: одна и та же
  // пара (профиль, проект) обычно повторяется у многих задач доски.
  const db = getDb();
  const projectIds = Array.from(new Set(taskRows.map((task) => task.projectId)));
  const projectRows =
    projectIds.length > 0
      ? db.select().from(projects).where(inArray(projects.id, projectIds)).all()
      : [];
  const projectById = new Map(projectRows.map((project) => [project.id, project]));

  // Кандидаты считаются один раз и запоминаются по задаче: второй цикл ниже
  // повторяет ту же цепочку приоритетов, но уже по загруженным в память
  // строкам профилей, поэтому заново дергать getProjectRuntimeProfileId
  // и пересобирать массив не нужно.
  const candidatesByTaskId = new Map<
    string,
    Array<{
      source: EffectiveRuntimeProfileSelection["source"];
      profileId: string | null;
    }>
  >();
  const profileIds = new Set<string>();

  for (const task of taskRows) {
    const project = projectById.get(task.projectId);
    const taskRuntimeProfileId = task.runtimeProfileId ?? null;
    const projectRuntimeProfileId = getProjectRuntimeProfileId(project, mode);
    const candidates: Array<{
      source: EffectiveRuntimeProfileSelection["source"];
      profileId: string | null;
    }> = [
      { source: "task_override", profileId: taskRuntimeProfileId },
      { source: "project_default", profileId: projectRuntimeProfileId },
      { source: "system_default", profileId: systemRuntimeProfileId },
    ];
    candidatesByTaskId.set(task.id, candidates);

    for (const candidate of candidates) {
      if (candidate.profileId) {
        profileIds.add(candidate.profileId);
      }
    }
  }

  const uniqueProfileIds = Array.from(profileIds);
  const profileRows =
    uniqueProfileIds.length > 0
      ? db.select().from(runtimeProfiles).where(inArray(runtimeProfiles.id, uniqueProfileIds)).all()
      : [];
  const profileById = new Map(profileRows.map((profile) => [profile.id, profile]));
  // Последние события расходов собираются одним CTE-запросом на весь список
  // профилей — именно для этого написана пакетная версия выше.
  const usageByProfileId = findLatestRuntimeProfileUsageByIds(uniqueProfileIds);

  // Счётчик откатов нужен для итогового debug-лога: по нему видно, сколько
  // задач уехало на профиль более низкого приоритета из-за недоступных
  // кандидатов. Сами сообщения об откате пишутся по одному на задачу.
  let fallbackLogCount = 0;
  for (const task of taskRows) {
    const project = projectById.get(task.projectId);
    const taskRuntimeProfileId = task.runtimeProfileId ?? null;
    const projectRuntimeProfileId = getProjectRuntimeProfileId(project, mode);
    const candidates = candidatesByTaskId.get(task.id) ?? [];
    const unavailableIds: string[] = [];

    for (const candidate of candidates) {
      if (!candidate.profileId) continue;
      const profile = profileById.get(candidate.profileId);
      if (!profile || !profile.enabled) {
        unavailableIds.push(candidate.profileId);
        continue;
      }

      if (candidate.source !== "task_override" && unavailableIds.length > 0) {
        fallbackLogCount += 1;
        log.info(
          {
            source: candidate.source,
            taskRuntimeProfileId,
            projectRuntimeProfileId,
            systemRuntimeProfileId,
            unavailableCount: unavailableIds.length,
          },
          "Effective runtime profile fell back from higher-priority source",
        );
      }

      results.set(task.id, {
        source: candidate.source,
        profile: toRuntimeProfileResponse(
          profile,
          usageByProfileId.get(profile.id) ?? null,
        ),
        taskRuntimeProfileId,
        projectRuntimeProfileId,
        systemRuntimeProfileId,
      });
      break;
    }

    // Заполнитель для задач, у которых не нашлось ни одного валидного
    // кандидата: карта обязана содержать запись на каждую входную задачу,
    // чтобы вызывающий код не различал "нет в карте" и "нет профиля".
    if (!results.has(task.id)) {
      results.set(task.id, {
        source: "none",
        profile: null,
        taskRuntimeProfileId,
        projectRuntimeProfileId,
        systemRuntimeProfileId,
      });
    }
  }

  log.debug(
    {
      taskCount: taskRows.length,
      projectCount: projectById.size,
      candidateProfileCount: profileById.size,
      fallbackLogCount,
    },
    "Resolved effective runtime profiles for task list",
  );

  return results;
}

function getProjectRuntimeProfileId(
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
