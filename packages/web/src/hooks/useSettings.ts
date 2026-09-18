import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
    staleTime: 60_000,
  });
}

export function useProjectDefaults(projectId: string | null) {
  return useQuery({
    queryKey: ["projectDefaults", projectId],
    queryFn: () => api.getProjectDefaults(projectId!),
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

// Кэш уровня модуля для флага функции лимитов использования. Флаг задается
// переменной окружения и не меняется в течение сессии, поэтому одна загрузка
// вне кэша React Query избавляет от необходимости QueryClientProvider в каждом
// изолированном компоненте (тесты рендерят компоненты без провайдера).
let cachedUsageLimitsEnabled: boolean | null = null;
let inFlightUsageLimitsFetch: Promise<void> | null = null;
const usageLimitsListeners = new Set<(value: boolean) => void>();

async function loadUsageLimitsFlag(): Promise<void> {
  if (cachedUsageLimitsEnabled !== null) return;
  if (inFlightUsageLimitsFetch) return inFlightUsageLimitsFetch;
  inFlightUsageLimitsFetch = (async () => {
    try {
      const settings = await api.getSettings();
      cachedUsageLimitsEnabled = settings.usageLimitsEnabled ?? true;
    } catch {
      // Сбой сети/API: остаёмся оптимистичными, чтобы временная ошибка
      // не скрыла молча весь интерфейс использования. UI скорректируется сам,
      // когда реальный ответ `/settings` резолвится при повторе.
      cachedUsageLimitsEnabled = true;
    }
    const value = cachedUsageLimitsEnabled ?? true;
    usageLimitsListeners.forEach((listener) => listener(value));
  })();
  return inFlightUsageLimitsFetch;
}

/**
 * True, когда на бэкенде включена функция лимитов использования. Возвращает
 * `true` оптимистично на первом рендере (чтобы UI использования не скрывался
 * на мгновение до ответа `/settings`) и переключается в `false`, если на
 * бэкенде действительно отключён `AIF_USAGE_LIMITS_ENABLED`. Компонентам,
 * рендерящим поверхности лимитов использования, стоит гейтиться по этому
 * флагу, чтобы отключённые развёртывания не показывали устаревшие данные.
 */
export function useUsageLimitsEnabled(): boolean {
  const [value, setValue] = useState<boolean>(() => cachedUsageLimitsEnabled ?? true);
  // Правило `react-hooks/set-state-in-effect` обычно флагует setState внутри
  // эффекта. Здесь эффект синхронизирует внешний store уровня модуля с
  // состоянием компонента: начальная ветка копирует уже разрешённый кэш
  // в локальное состояние, а ветка слушателя реагирует на асинхронное
  // завершение загрузки. Ни один вызов не даёт каскада рендеров, потому что
  // оба возвращают одно и то же значение при повторных рендерах. Здесь
  // пробовали `useSyncExternalStore` — это вызвало шторм рендеров в рантайме
  // с подписчиками React Query, поэтому оставляем useState и глушим правило.
  useEffect(() => {
    if (cachedUsageLimitsEnabled !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValue(cachedUsageLimitsEnabled);
      return;
    }
    const listener = (next: boolean) => setValue(next);
    usageLimitsListeners.add(listener);
    void loadUsageLimitsFlag();
    return () => {
      usageLimitsListeners.delete(listener);
    };
  }, []);
  return value;
}

export function useWarmupEnabled(): boolean {
  const { data } = useSettings();
  return data?.warmupEnabled ?? false;
}

// Кэш уровня модуля для флага QA-конвейера. Повторяет кэш лимитов использования,
// чтобы QA-гейтированные компоненты (TaskDetailHeader, TaskSettings, TaskDetail)
// читали флаг без QueryClientProvider — в тестах они рендерятся изолированно.
// В отличие от лимитов использования, значение по умолчанию пессимистично
// (`false`): отключённая функция должна оставаться скрытой, а не мелькать.
let cachedQaPipelineEnabled: boolean | null = null;
let inFlightQaPipelineFetch: Promise<void> | null = null;
const qaPipelineListeners = new Set<(value: boolean) => void>();

async function loadQaPipelineFlag(): Promise<void> {
  if (cachedQaPipelineEnabled !== null) return;
  if (inFlightQaPipelineFetch) return inFlightQaPipelineFetch;
  inFlightQaPipelineFetch = (async () => {
    try {
      const settings = await api.getSettings();
      cachedQaPipelineEnabled = settings.qaPipelineEnabled ?? false;
    } catch {
      // Сбой сети/API: остаёмся скрытыми. Мелькающая функция за 403
      // хуже кратковременного скрытия; UI скорректируется сам, когда реальный
      // ответ `/settings` резолвится при повторе.
      cachedQaPipelineEnabled = false;
    }
    const value = cachedQaPipelineEnabled ?? false;
    qaPipelineListeners.forEach((listener) => listener(value));
  })();
  return inFlightQaPipelineFetch;
}

/**
 * True, когда на бэкенде включён QA-конвейер (`AIF_QA_PIPELINE_ENABLED`).
 * Возвращает `false`, пока `/settings` не резолвится, чтобы отключённое
 * развёртывание никогда не показывало QA-поверхности, затем переключается на
 * реальное значение. См. примечание `useUsageLimitsEnabled` о причинах
 * использования store уровня модуля вместо `useSyncExternalStore`.
 */
export function useQaPipelineEnabled(): boolean {
  const [value, setValue] = useState<boolean>(() => cachedQaPipelineEnabled ?? false);
  useEffect(() => {
    if (cachedQaPipelineEnabled !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValue(cachedQaPipelineEnabled);
      return;
    }
    const listener = (next: boolean) => setValue(next);
    qaPipelineListeners.add(listener);
    void loadQaPipelineFlag();
    return () => {
      qaPipelineListeners.delete(listener);
    };
  }, []);
  return value;
}

/** Только для тестов: сбрасывает кэш QA-конвейера уровня модуля между кейсами. */
export function __resetQaPipelineFlagCacheForTests(): void {
  cachedQaPipelineEnabled = null;
  inFlightQaPipelineFetch = null;
  qaPipelineListeners.clear();
}

/** Только для тестов: сбрасывает кэш лимитов использования уровня модуля между кейсами. */
export function __resetUsageLimitsFlagCacheForTests(): void {
  cachedUsageLimitsEnabled = null;
  inFlightUsageLimitsFetch = null;
  usageLimitsListeners.clear();
}

/**
 * Только для тестов: синхронно заполняет кэш лимитов использования, чтобы
 * компоненты с поверхностями лимитов оставались видимыми без мока `/settings`.
 */
export function __setUsageLimitsFlagForTests(value: boolean): void {
  cachedUsageLimitsEnabled = value;
  inFlightUsageLimitsFetch = null;
  usageLimitsListeners.forEach((listener) => listener(value));
}
