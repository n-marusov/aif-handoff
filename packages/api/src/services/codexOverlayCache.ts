/**
 * Кэш overlay-снапшотов лимитов Codex: отдаёт в UI те лимиты, которые надо
 * показать поверх данных аккаунта, не обращаясь к БД на каждый запрос.
 *
 * Почему кроме TTL есть ещё и поколение (generation): TTL закрывает только
 * устаревание, но не гонку записи во время чтения. Счётчик-поколение делает
 * инвалидацию мгновенной - записи старого поколения считаются мёртвыми сразу,
 * даже если их expiresAt ещё в будущем.
 *
 * Инварианты:
 * - Отсутствие снапшота кэшируется как null: "лимитов нет" - тоже результат,
 *   и повторный запрос не должен заново идти в БД.
 * - Ключ включает аккаунт, нормализованный путь проекта, лимит и модель: без
 *   этого снапшоты разных проектов и моделей перепутались бы.
 */

import { listCodexLimitHeadsForOverlay } from "@aif/data";
import { normalizeCodexProjectPath, selectPreferredCodexLimitSnapshot } from "@aif/runtime";
import type { RuntimeLimitSnapshot } from "@aif/shared";

// Короткий TTL (5 секунд): UI может опрашивать лимиты часто, но данные
// о расходе быстро устаревают, поэтому длинное окно показывало бы неправду.
const DEFAULT_OVERLAY_CACHE_TTL_MS = 5_000;
// Нужен только лучший снапшот, поэтому в БД не тянем всю историю записей.
const OVERLAY_QUERY_LIMIT = 50;

interface CodexOverlayCacheEntry {
  // value допускает null намеренно: отрицательный результат тоже кэшируется,
  // иначе отсутствие лимитов каждый раз означало бы новый запрос в БД.
  value: RuntimeLimitSnapshot | null;
  // Номер поколения запоминаем в самой записи: при инвалидации все старые
  // записи становятся невидимыми без обхода и удаления ключей Map.
  generation: number;
  expiresAt: number;
}

const codexOverlayCache = new Map<string, CodexOverlayCacheEntry>();
// Монотонно растущий счётчик: сравнение по нему дешевле, чем массовое удаление
// ключей, и оно атомарно с точки зрения одного процесса Node.
let currentGeneration = 0;

function cacheKey(input: {
  accountFingerprint: string;
  projectRoot?: string | null;
  limitId?: string | null;
  model?: string | null;
}): string {
  return [
    input.accountFingerprint,
    // Общий нормализатор пути, чтобы один и тот же корень в разном регистре или
    // форме записи давал один и тот же ключ кэша.
    normalizeCodexProjectPath(input.projectRoot) ?? "__global__",
    // Плейсхолдеры вместо пустых строк: иначе "лимит не указан" и "лимит с
    // пустым id" склеились бы в один ключ и подменяли друг друга.
    input.limitId?.trim() || "__any_limit__",
    input.model?.trim() || "__any_model__",
  ].join(":");
}

export function resolveCachedCodexOverlaySnapshot(
  input: {
    accountFingerprint: string;
    projectRoot?: string | null;
    preferredLimitId?: string | null;
    model?: string | null;
  },
  options: { ttlMs?: number } = {},
): RuntimeLimitSnapshot | null {
  const key = cacheKey({
    accountFingerprint: input.accountFingerprint,
    projectRoot: input.projectRoot,
    limitId: input.preferredLimitId ?? null,
    model: input.model ?? null,
  });
  const now = Date.now();
  const cached = codexOverlayCache.get(key);
  // Три условия сразу: запись есть, она из текущего поколения и не просрочена.
  // Просроченную запись не удаляем - её всё равно перезапишет set ниже.
  if (cached && cached.generation === currentGeneration && cached.expiresAt > now) {
    return cached.value;
  }

  // includeGlobalFallback: глобальные лимиты аккаунта служат запасным вариантом,
  // когда по конкретному проекту записей нет.
  const rows = listCodexLimitHeadsForOverlay({
    accountFingerprint: input.accountFingerprint,
    projectRoot: input.projectRoot ?? null,
    includeGlobalFallback: true,
    limit: OVERLAY_QUERY_LIMIT,
  });
  const snapshots = rows
    .map((row) => row.snapshot)
    // snapshot в строке может быть null (битая или частичная запись), поэтому
    // фильтр по Boolean плюс предикат-гард, сужающий тип для дальнейшего кода.
    .filter((snapshot): snapshot is RuntimeLimitSnapshot => Boolean(snapshot));
  // Правила приоритета живут в runtime-пакете и переиспользуются здесь, чтобы
  // не дублировать логику выбора между проектом, глобальными лимитами и моделью.
  const value = selectPreferredCodexLimitSnapshot({
    model: input.model ?? null,
    snapshots,
    preferredLimitId: input.preferredLimitId ?? null,
  });

  codexOverlayCache.set(key, {
    value,
    // TTL берём из опций с дефолтом: тесты подставляют короткое окно, а в работе
    // используется общее значение 5 секунд.
    generation: currentGeneration,
    expiresAt: now + (options.ttlMs ?? DEFAULT_OVERLAY_CACHE_TTL_MS),
  });
  return value;
}

export function invalidateCodexOverlayCache(): number {
  // Возвращаем новое поколение: вызывающий код может сравнить его со старым и
  // понять, что видел данные "до" инвалидации.
  currentGeneration += 1;
  codexOverlayCache.clear();
  return currentGeneration;
}

export function clearCodexOverlayCache(): void {
  // Поколение сбрасывается в ноль именно здесь, а не в invalidate: это путь для
  // тестов, где нужно детерминированное начальное состояние.
  currentGeneration = 0;
  codexOverlayCache.clear();
}
