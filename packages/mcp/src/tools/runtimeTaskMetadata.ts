import { resolveEffectiveRuntimeProfile } from "@aif/data";

export interface TaskEffectiveRuntimeMetadata {
  source: string;
  profileId: string | null;
  runtimeId: string | null;
  providerId: string | null;
  profileName: string | null;
}

export function buildEffectiveTaskRuntimeMetadata(
  taskId: string,
  projectId: string,
): TaskEffectiveRuntimeMetadata {
  const effective = resolveEffectiveRuntimeProfile({
    taskId,
    projectId,
    mode: "task",
    systemDefaultRuntimeProfileId: null,
  });

  return {
    source: effective.source,
    profileId: effective.profile?.id ?? null,
    runtimeId: effective.profile?.runtimeId ?? null,
    providerId: effective.profile?.providerId ?? null,
    profileName: effective.profile?.name ?? null,
  };
}
