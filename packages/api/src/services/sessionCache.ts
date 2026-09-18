/**
 * TTL-кэш листингов сессий SDK: полный скан файловой системы дорогой, а UI
 * запрашивает список сессий заметно чаще, чем он реально меняется.
 *
 * Почему TTL, а не инвалидация по событиям: сессии создаёт внешний runtime
 * (CLI или агент), API не видит момент записи на диск, поэтому единственный
 * надёжный компромисс - короткое окно свежести (10 секунд) плюс явный сброс
 * там, где мутация известна самому API.
 *
 * Инварианты:
 * - Ключ обязан включать runtime, профиль и директорию проекта, иначе
 *   листинги разных проектов перепутаются и UI покажет чужие сессии.
 * - Для Codex кэш отключён: там листинг идёт из БД-индекса, а не со скана,
 *   и файловое окно свежести только вредило бы.
 */

/**
 * TTL-кэш списков SDK-сессий, чтобы не сканировать файловую систему повторно.
 * Для каждого каталога проекта — своя запись кэша.
 */

import { logger } from "@aif/shared";

const log = logger("session-cache");

interface CacheEntry<T> {
  // Храним абсолютное время истечения, а не момент записи: тогда чтение
  // сравнивает одно число с Date.now() и не делает арифметику на каждом гетте.
  data: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 10_000; // 10 секунд

// Один общий Map на процесс: ключ уже содержит runtime, профиль и директорию,
// поэтому вложенные структуры не нужны - иначе усложнился бы сброс.
const cache = new Map<string, CacheEntry<unknown>>();

function normalizeRuntimeId(runtimeId: string): string {
  // runtimeId приходит из URL-параметров и может отличаться регистром или
  // хвостовым пробелом; без нормализации один и тот же кэш давал бы промахи.
  return runtimeId.trim().toLowerCase();
}

export function shouldUseSessionCacheForRuntime(runtimeId: string): boolean {
  // Проверка вынесена в отдельную функцию, чтобы вызывающий код не дублировал
  // исключение Codex в каждом месте чтения листинга.
  // Чтения локальных сессий Codex обслуживаются из БД-индекса и не должны
  // использовать легаси-путь кэша сканирования.
  return normalizeRuntimeId(runtimeId) !== "codex";
}

export function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;

  // Истечение ленивое: таймера нет, поэтому просроченную запись убираем
  // при первом обращении - иначе Map рос бы бесконечно.
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    log.debug({ key }, "Session cache expired");
    return undefined;
  }

  log.debug({ key }, "Session cache hit");
  // Приведение к T безопасно: тип параметра задаёт вызывающий, а ключ включает
  // runtime и профиль, так что перепутать формы данных невозможно.
  return entry.data as T;
}

export function setCached<T>(key: string, data: T, ttlMs = DEFAULT_TTL_MS): void {
  // Перезапись без проверок: новое значение всегда свежее старого, а TTL
  // отсчитывается от момента установки, а не продлевается от прошлой записи.
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  log.debug({ key, ttlMs }, "Session cache set");
}

export function invalidateCache(key: string): void {
  // Точечный сброс вызывается там, где мутация списка известна точно
  // (создание или удаление сессии), чтобы не сбрасывать чужие записи.
  cache.delete(key);
}

export function invalidateAllSessionCaches(): void {
  // Полный сброс нужен при смене окружения или профилей, когда точный набор
  // ключей неизвестен и выборочное удаление было бы неполным.
  cache.clear();
}

/**
 * Ключ кэша для списков сессий runtime по runtime/профилю/каталогу проекта.
 * `dir` может быть пустым для runtime, не требующих области видимости корня проекта.
 */
export function sessionCacheKey(runtimeId: string, profileId: string | null, dir?: string): string {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  // Плейсхолдеры вместо пустых частей: null-профиль - это "профиль по
  // умолчанию", а не отсутствие ключа, и он не должен совпадать с другим.
  const normalizedProfileId = profileId?.trim() || "default";
  const normalizedDir = dir?.trim() || "none";
  // Результат - плоская строка: она читаема в логах и сравнима по значению,
  // а порядок частей фиксирован, чтобы ключи не пересекались.
  return `runtime-sessions:${normalizedRuntimeId}:${normalizedProfileId}:${normalizedDir}`;
}
