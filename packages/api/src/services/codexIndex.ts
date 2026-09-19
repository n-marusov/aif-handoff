/**
 * Индекс сессий Codex: сканирует и разбирает rollout-файлы (JSONL) на диске в
 * индекс (сессии, файлы, лимиты, история), который читают API и UI.
 *
 * Почему сервис устроен именно так:
 * - Два режима обхода. "head" читает только самые свежие файлы в узком бюджете
 *   времени, чтобы после старта быстро прогреть актуальные лимиты; "backfill"
 *   догоняет остальное редкими срезами. Один общий режим давал бы либо
 *   медленный старт, либо голодный цикл на большом архиве.
 * - Пауза при нагрузке. Каждый потенциально долгий шаг проверяет isApiIdle и
 *   прерывается, возвращая частичный результат. Индексация не должна
 *   конкурировать с API за диск и базу.
 * - Инкрементальность по смещению. Для файла хранится parsedOffset и
 *   pendingTail: дочитывается только хвост, а неполная последняя строка
 *   переносится в следующий проход. Повторный проход потому и дешев.
 * - Идемпотентность. Записи идут через upsert по ключам, поэтому прерванный
 *   проход можно безопасно повторить; курсор последнего успешного прохода
 *   обновляется только если проход не был прерван.
 *
 * Грабли, о которых нужно помнить при правках:
 * - Файлы сессий и их JSONL-строки - недоверенный ввод. Разбор обязан держать
 *   явный `| null` и проверять значение перед доступом (Nullable Cast Rule):
 *   отсутствующее поле здесь норма, а не исключение.
 * - Удаление устаревших строк идет после вычисления stale-путей и до вставки
 *   новых, иначе можно снести только что записанное.
 * - Подписчики лимитов должны узнать и об удалении (headRowsDeleted), а не
 *   только о вставке, иначе в UI останутся висячие оверлеи.
 */
import {
  appendCodexLimitHistory,
  buildCodexLimitHeadKey,
  deleteCodexLimitHeadsByFilePaths,
  deleteCodexLimitHistoryByFilePaths,
  deleteCodexSessionFilesByFilePaths,
  deleteCodexSessionsByFilePaths,
  listCodexLimitHeadScopesByFilePaths,
  listCodexSessionFileStates,
  listCodexSessionFileStatesByPaths,
  listProjects,
  listRuntimeProfilesWithUsage,
  pruneCodexLimitHistoryByHead,
  pruneCodexLimitRowsBeforeObservedAt,
  pruneStaleCodexSessionIndexRows,
  upsertCodexIndexCursor,
  upsertCodexLimitHeads,
  upsertCodexSessionFiles,
  upsertCodexSessions,
  type AppendCodexLimitHistoryInput,
  type UpsertCodexLimitHeadInput,
  type UpsertCodexSessionFileInput,
  type UpsertCodexSessionInput,
  type CodexLimitHeadScopeRow,
} from "@aif/data";
import {
  buildCodexAuthFingerprint,
  classifyCodexSessionFileStatus,
  getCodexAuthIdentity,
  listCodexSessionFileInfos,
  normalizeCodexProjectPath,
  readCodexSessionLimitSnapshotsFromAppend,
  readCodexSessionMetaFromFile,
  readCodexSnapshotAccountFingerprint,
  type CodexSessionFileInfo,
  type RuntimeLimitSnapshot,
} from "@aif/runtime";
import { logger } from "@aif/shared";
import { isApiIdle } from "../middleware/apiLoad.js";
import { invalidateCodexOverlayCache } from "./codexOverlayCache.js";
import { notifyRuntimeLimitProjectUpdate } from "./runtime.js";

const log = logger("api-codex-index");

// Рантайм и провайдер по умолчанию: индекс привязан к Codex, но значения
// вынесены в опции, чтобы сервис поднимался для другого локального рантайма
// без правок кода.
const DEFAULT_RUNTIME_ID = "codex";
const DEFAULT_PROVIDER_ID = "openai";
// Интервал между проходами догоняющей индексации. Большой намеренно: backfill
// не срочный и не должен вытеснять рабочие проходы head.
const DEFAULT_BACKFILL_INTERVAL_MS = 10 * 60_000;
// Сколько последних снимков лимитов держать на одну голову (аккаунт + лимит +
// проект): история нужна графикам, но не должна расти бесконечно.
const DEFAULT_HISTORY_RETENTION_PER_HEAD = 20;
// Версия схемы импорта: при ее смене файлы считаются устаревшими и читаются
// заново целиком, даже если размер и mtime не изменились.
const DEFAULT_IMPORT_VERSION = 1;
// Потолки и бюджеты одного тика: они держат индексацию в фоне и не дают ей
// растянуться на секунды, заблокировав обработку запросов.
const DEFAULT_HEAD_FILE_LIMIT = 200;
const DEFAULT_HEAD_TIME_BUDGET_MS = 150;
const DEFAULT_BACKFILL_SLICE_MS = 30;
const DEFAULT_BACKFILL_FILES_PER_SLICE = 20;
// Пауза снимается только если API простаивает не меньше minIdleMs: короткий
// провал между запросами не повод запускать индексацию.
const DEFAULT_MIN_IDLE_MS = 1000;
// Задержка перед первым прогревом: сервер успевает подняться и не конкурирует
// с собственной начальной загрузкой.
const DEFAULT_HEAD_WARMUP_DELAY_MS = 0;
// Если проход прерван нагрузкой или уперся в бюджет, повторяем его заметно
// раньше основного интервала, чтобы индекс не отставал надолго.
const DEFAULT_IDLE_RETRY_MS = 250;
// Запись идет пачками с уступкой event loop: одна большая транзакция
// заблокировала бы отдачу HTTP-ответов.
const DEFAULT_DB_FLUSH_BATCH_SIZE = 20;
// Окно, за которым файлы считаются устаревшими. Ограничивает и скан, и чистку
// строк, поэтому стоимость прохода не зависит от всей истории.
const DEFAULT_USAGE_SCAN_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// Сужение неизвестного значения до объекта. Массивы исключены намеренно: в
// JSONL-полезной нагрузке массив может оказаться там, где ожидается объект, и
// обращение к полям такого значения дало бы мусор вместо предсказуемого null.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// Снимок приходит из недоверенного JSONL, поэтому providerMeta может
// отсутствовать или содержать нестроковый limitId. Возвращаем безопасный
// "codex", чтобы ключ головы никогда не был пустым.
function readSnapshotLimitId(snapshot: RuntimeLimitSnapshot): string {
  const providerMeta = isRecord(snapshot.providerMeta) ? snapshot.providerMeta : null;
  const value = providerMeta?.limitId;
  return typeof value === "string" && value.trim().length > 0 ? value : "codex";
}

// Начальное состояние файла для БД. sessionId намеренно null: он заполнится
// после чтения меты, но строка должна существовать уже сейчас, иначе файл без
// меты будет перечитываться целиком каждый проход.
function toFileState(
  fileInfo: CodexSessionFileInfo,
  parsedOffset: number,
  pendingTail = "",
): UpsertCodexSessionFileInput {
  return {
    filePath: fileInfo.filePath,
    sessionId: null,
    sizeBytes: fileInfo.size,
    mtimeMs: fileInfo.mtimeMs,
    parsedOffset,
    pendingTail,
    missing: false,
    importVersion: DEFAULT_IMPORT_VERSION,
  };
}

// Единая точка нормализации пути проекта: запись и сопоставление проектов из
// БД должны приводить пути одинаково, иначе проект по строке не найдется.
function normalizeProjectRoot(projectRoot: string | null | undefined): string | null {
  return normalizeCodexProjectPath(projectRoot);
}

// Локальные транспорты (sdk/cli) пишут rollout-файлы на эту же машину, поэтому
// обновлять оверлеи лимитов из локального индекса имеет смысл только для них.
function isLocalCodexRuntimeProfile(profile: {
  runtimeId: string;
  transport?: string | null;
}): boolean {
  return (
    profile.runtimeId === "codex" && (profile.transport === "sdk" || profile.transport === "cli")
  );
}

// NEGATIVE_INFINITY как маркер "времени нет": некорректная или пустая метка
// проигрывает любой валидной при сравнении и не превращается в 0 (эпоху).
function parseTimestampMs(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

// Настройки приходят из опций и окружения, поэтому приводим их к
// положительному целому: отрицательные, дробные и NaN не должны ломать
// бюджеты проходов.
function readPositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(value));
}

// Итог одного прохода. Счетчики нужны для диагностики и для уведомления UI,
// а флаги skippedForLoad и truncated говорят планировщику, что проход надо
// повторить раньше обычного.
export interface CodexIndexReconcileSummary {
  reason: string;
  scannedFiles: number;
  changedFiles: number;
  missingFiles: number;
  sessionRowsUpserted: number;
  fileRowsUpserted: number;
  headRowsUpserted: number;
  historyRowsAppended: number;
  headRowsDeleted: number;
  historyRowsDeleted: number;
  skippedForLoad?: boolean;
  truncated?: boolean;
}

// "head" - быстрый прогрев свежих файлов, "backfill" - редкое догоняние
// остального архива.
export type CodexIndexReconcileMode = "head" | "backfill";

// Публичный контракт сервиса: жизненный цикл плюс ручной запуск прохода для
// тестов и административных эндпоинтов.
export interface CodexIndexService {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  runReconcileOnce(
    reason?: string,
    mode?: CodexIndexReconcileMode,
  ): Promise<CodexIndexReconcileSummary>;
}

// Все параметры цикла опциональны: значения по умолчанию подобраны так, чтобы
// сервис был безопасен на слабой машине, а тесты могли ужать тайминги.
export interface CreateCodexIndexServiceOptions {
  runtimeId?: string;
  providerId?: string;
  reconcileIntervalMs?: number;
  backfillIntervalMs?: number;
  headFileLimit?: number;
  headTimeBudgetMs?: number;
  backfillSliceMs?: number;
  backfillFilesPerSlice?: number;
  minIdleMs?: number;
  headWarmupDelayMs?: number;
  idleRetryMs?: number;
  dbFlushBatchSize?: number;
  historyRetentionPerHead?: number;
  importVersion?: number;
  usageScanWindowDays?: number;
}

// Фабрика сервиса. Создает замыкание на один экземпляр индексатора: опции
// разрешаются здесь один раз, а таймеры и состояние прохода живут в замыкании,
// чтобы их нельзя было случайно разделить между проектами.
export function createCodexIndexService(
  options: CreateCodexIndexServiceOptions = {},
): CodexIndexService {
  const runtimeId = options.runtimeId ?? DEFAULT_RUNTIME_ID;
  const providerId = options.providerId ?? DEFAULT_PROVIDER_ID;
  const backfillIntervalMs = readPositiveInteger(
    options.backfillIntervalMs ?? options.reconcileIntervalMs,
    DEFAULT_BACKFILL_INTERVAL_MS,
  );
  const headFileLimit = readPositiveInteger(options.headFileLimit, DEFAULT_HEAD_FILE_LIMIT);
  const headTimeBudgetMs = readPositiveInteger(
    options.headTimeBudgetMs,
    DEFAULT_HEAD_TIME_BUDGET_MS,
  );
  const backfillSliceMs = readPositiveInteger(options.backfillSliceMs, DEFAULT_BACKFILL_SLICE_MS);
  const backfillFilesPerSlice = readPositiveInteger(
    options.backfillFilesPerSlice,
    DEFAULT_BACKFILL_FILES_PER_SLICE,
  );
  const minIdleMs = readPositiveInteger(options.minIdleMs, DEFAULT_MIN_IDLE_MS);
  const headWarmupDelayMs = Math.max(
    0,
    Math.trunc(options.headWarmupDelayMs ?? DEFAULT_HEAD_WARMUP_DELAY_MS),
  );
  const idleRetryMs = readPositiveInteger(options.idleRetryMs, DEFAULT_IDLE_RETRY_MS);
  const dbFlushBatchSize = readPositiveInteger(
    options.dbFlushBatchSize,
    DEFAULT_DB_FLUSH_BATCH_SIZE,
  );
  const usageScanWindowDays = readPositiveInteger(
    options.usageScanWindowDays,
    DEFAULT_USAGE_SCAN_WINDOW_DAYS,
  );
  // Окно в миллисекундах считается один раз: абсолютные метки времени внутри
  // одного прохода должны быть согласованы, иначе граница устаревания
  // поедет между проверками.
  const usageScanWindowMs = usageScanWindowDays * DAY_MS;
  const historyRetentionPerHead =
    options.historyRetentionPerHead ?? DEFAULT_HISTORY_RETENTION_PER_HEAD;
  const importVersion = options.importVersion ?? DEFAULT_IMPORT_VERSION;

  // Состояние цикла. inFlight хранится как промис, чтобы одновременные вызовы
  // ручного и планового прохода присоединялись к уже идущему, а не запускали
  // второй параллельный скан файлов.
  let running = false;
  let headWarmupTimer: ReturnType<typeof setTimeout> | null = null;
  let backfillTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<CodexIndexReconcileSummary> | null = null;

  // Прогрев лимитов по свежим файлам. Таймер переустанавливается, а не
  // дублируется, и при skippedForLoad или truncated переносится на idleRetryMs
  // вперед: один проход должен закончиться, прежде чем начнется следующий.
  const scheduleHeadWarmupSoon = (delayMs = headWarmupDelayMs) => {
    if (!running) {
      return;
    }
    if (headWarmupTimer) {
      clearTimeout(headWarmupTimer);
    }
    headWarmupTimer = setTimeout(() => {
      headWarmupTimer = null;
      void runReconcileOnce("head-warmup", "head")
        .then((summary) => {
          if (running && (summary.skippedForLoad || summary.truncated)) {
            scheduleHeadWarmupSoon(idleRetryMs);
          }
        })
        .catch((error) => {
          log.warn({ err: error, runtimeId, providerId }, "Codex head warm-up failed");
          if (running) {
            scheduleHeadWarmupSoon(idleRetryMs);
          }
        });
    }, delayMs);
  };

  // Догоняющий проход. В отличие от прогрева, после успеха он не исчезает, а
  // переносится на полный интервал: архив продолжает расти, и его нужно
  // периодически просматривать, а не только один раз при старте.
  const scheduleIdleBackfillLater = (delayMs = backfillIntervalMs) => {
    if (!running) {
      return;
    }
    if (backfillTimer) {
      clearTimeout(backfillTimer);
    }
    backfillTimer = setTimeout(() => {
      backfillTimer = null;
      void runReconcileOnce("idle-backfill", "backfill")
        .then((summary) => {
          scheduleIdleBackfillLater(
            summary.skippedForLoad || summary.truncated ? idleRetryMs : backfillIntervalMs,
          );
        })
        .catch((error) => {
          log.warn({ err: error, runtimeId, providerId }, "Codex idle backfill failed");
          scheduleIdleBackfillLater(idleRetryMs);
        });
    }, delayMs);
  };

  // Уведомление UI об изменении лимитов. Сервис не знает, какие проекты
  // сейчас открыты у клиентов, поэтому отправляет обновление всем проектам,
  // которых коснулись вставленные или удаленные головы.
  const notifyVisibleProjectsWithCodexLimitUpdate = (input: {
    headRows: UpsertCodexLimitHeadInput[];
    deletedScopes: CodexLimitHeadScopeRow[];
    summary: CodexIndexReconcileSummary;
    cursorTimestamp: string;
  }): void => {
    // Без изменений уведомлять нечего: пустой сигнал только заставил бы
    // клиентов перезапросить то же самое.
    const hasUpsertedHeads = input.summary.headRowsUpserted > 0 && input.headRows.length > 0;
    const hasDeletedHeads = input.summary.headRowsDeleted > 0 && input.deletedScopes.length > 0;
    if (!hasUpsertedHeads && !hasDeletedHeads) {
      return;
    }

    const allProjects = listProjects();
    if (allProjects.length === 0) {
      return;
    }

    const projectIds = new Set<string>();
    const touchedRoots = new Set<string>();
    let includesGlobalScope = false;

    // Голова без projectRoot - это глобальный (машинный) лимит аккаунта, а не
    // лимит конкретного проекта. В этом случае затронуты все проекты; цикл
    // прерывается, потому что дальше собирать корни уже бессмысленно.
    for (const row of input.headRows) {
      const projectRoot = normalizeProjectRoot(row.projectRoot);
      if (!projectRoot) {
        includesGlobalScope = true;
        break;
      }
      touchedRoots.add(projectRoot);
    }
    for (const scope of input.deletedScopes) {
      const projectRoot = normalizeProjectRoot(scope.projectRoot);
      if (!projectRoot) {
        includesGlobalScope = true;
        break;
      }
      touchedRoots.add(projectRoot);
    }

    if (includesGlobalScope) {
      for (const project of allProjects) {
        projectIds.add(project.id);
      }
    } else if (touchedRoots.size > 0) {
      for (const project of allProjects) {
        if (touchedRoots.has(project.rootPath)) {
          projectIds.add(project.id);
        }
      }
    }

    if (projectIds.size === 0) {
      return;
    }

    const observedAtValues = [
      ...input.headRows.map((row) => row.observedAt),
      ...input.deletedScopes.map((scope) => scope.observedAt),
    ];
    const latestObservedAt = observedAtValues.reduce<string | null>((latest, observedAt) => {
      if (!latest) return observedAt;
      return parseTimestampMs(observedAt) > parseTimestampMs(latest) ? observedAt : latest;
    }, null);
    // latestObservedAt берется из самих снимков, а не из времени прохода:
    // иначе сигнал менялся бы на каждом тике и клиенты обновлялись без причины.
    const signature = [
      "codex-index",
      runtimeId,
      providerId,
      latestObservedAt ?? input.cursorTimestamp,
      String(input.summary.headRowsUpserted),
      String(input.summary.headRowsDeleted),
      String(input.summary.historyRowsDeleted),
    ].join(":");

    // Вещаем только в профили локальных codex-транспортов: удаленные профили
    // этот индекс не описывает.
    let profileBroadcastCount = 0;
    for (const projectId of projectIds) {
      const visibleProfiles = listRuntimeProfilesWithUsage({
        projectId,
        includeGlobal: true,
        enabledOnly: true,
      }).filter((entry) => isLocalCodexRuntimeProfile(entry.row));

      for (const profile of visibleProfiles) {
        notifyRuntimeLimitProjectUpdate({
          projectId,
          runtimeProfileId: profile.row.id,
          signature,
        });
        profileBroadcastCount += 1;
      }
    }

    log.debug(
      {
        runtimeId,
        providerId,
        affectedProjectCount: projectIds.size,
        profileBroadcastCount,
        headRowsUpserted: input.summary.headRowsUpserted,
        headRowsDeleted: input.summary.headRowsDeleted,
      },
      "Codex index reconcile notified project runtime-limit overlays",
    );
  };

  // Шаблон пустого итога: единая точка для прерванных и пропущенных
  // проходов, чтобы счетчики всегда были полными и не приходилось ловить
  // undefined у потребителей.
  const emptySummary = (
    reason: string,
    extra: Pick<CodexIndexReconcileSummary, "skippedForLoad" | "truncated"> = {},
  ): CodexIndexReconcileSummary => ({
    reason,
    scannedFiles: 0,
    changedFiles: 0,
    missingFiles: 0,
    sessionRowsUpserted: 0,
    fileRowsUpserted: 0,
    headRowsUpserted: 0,
    historyRowsAppended: 0,
    headRowsDeleted: 0,
    historyRowsDeleted: 0,
    ...extra,
  });

  // Явная уступка event loop вместо просто await: длинный синхронный цикл
  // разбора файлов иначе задержал бы обработку входящих запросов.
  const yieldToEventLoop = async (): Promise<void> => {
    await Promise.resolve();
  };

  // Проверка простоя вынесена в предикат с обратным смыслом имени: так в коде
  // прохода видно не условие "idle", а причину остановки - нагрузку.
  const shouldPauseForLoad = (): boolean => !isApiIdle(minIdleMs);

  // Батчевая запись с контрактом прерывания: interrupted значит, что часть
  // пачек уже применена и БД осталась в промежуточном (но валидном) состоянии.
  // Это допустимо, потому что смещения по файлам фиксируются отдельными
  // upsert-ами и незавершенные файлы будут перечитаны с прежней позиции.
  const writeRowsInBatches = async <T>(
    rows: T[],
    writer: (chunk: T[]) => number,
  ): Promise<{ written: number; interrupted: boolean }> => {
    let written = 0;
    for (let i = 0; i < rows.length; i += dbFlushBatchSize) {
      if (shouldPauseForLoad()) {
        return { written, interrupted: true };
      }
      written += writer(rows.slice(i, i + dbFlushBatchSize));
      await yieldToEventLoop();
    }
    return { written, interrupted: false };
  };

  // Один проход индексации. Функция намеренно длинная и линейная: проход
  // состоит из упорядоченных фаз (скан -> разбор -> удаление устаревшего ->
  // запись -> уведомление), и разбиение на мелкие функции усложнило бы
  // отслеживание общего бюджета времени и уступок event loop.
  const reconcile = async (
    reason: string,
    mode: CodexIndexReconcileMode,
  ): Promise<CodexIndexReconcileSummary> => {
    const startedAt = Date.now();
    // Ранний выход до любых чтений: если API занят, дешевле не сделать ничего,
    // чем прочитать, а потом выбросить результат.
    if (shouldPauseForLoad()) {
      log.debug({ reason, mode, minIdleMs }, "Codex index reconcile skipped due API load");
      return emptySummary(reason, { skippedForLoad: true });
    }

    // nowIso фиксируется один раз и используется и как время индексации в
    // строках, и как значение курсора: внутри одного прохода эти метки должны
    // совпадать, иначе сравнивать состояние проходов станет нечем.
    const nowIso = new Date().toISOString();
    const usageScanCutoffMs = Math.max(0, Date.now() - usageScanWindowMs);
    const usageScanCutoffIso = new Date(usageScanCutoffMs).toISOString();
    // Личность аккаунта нужна как запасной отпечаток: снимок лимита может не
    // нести свой отпечаток, и тогда строку нужно к чему-то привязать.
    const authIdentity = await getCodexAuthIdentity();
    const fallbackAccountFingerprint = buildCodexAuthFingerprint(authIdentity);

    // Повторная проверка после асинхронного чтения личности: за это время
    // могла начаться нагрузка, и скан файлов лучше не запускать вовсе.
    if (shouldPauseForLoad()) {
      log.debug({ reason, mode, minIdleMs }, "Codex index reconcile paused before file scan");
      return emptySummary(reason, { skippedForLoad: true });
    }

    // Выборка файлов различается по режиму: head ограничен самыми новыми
    // файлами, backfill обрабатывает все в окне сканирования. Окно по mtime
    // общее, потому что более старые файлы все равно не попадут в индекс.
    const files = await listCodexSessionFileInfos(
      mode === "head"
        ? { limitNewest: headFileLimit, modifiedAfterMs: usageScanCutoffMs }
        : { modifiedAfterMs: usageScanCutoffMs },
    );
    // В режиме head достаточно состояний по сканированным путям: остальные
    // файлы этот проход не трогает. В backfill нужны все строки, потому что
    // по ним же вычисляются пропавшие файлы.
    const previousStates =
      mode === "head"
        ? listCodexSessionFileStatesByPaths(files.map((file) => file.filePath))
        : listCodexSessionFileStates();
    const previousByPath = new Map(previousStates.map((row) => [row.filePath, row]));
    const currentPathSet = new Set(files.map((file) => file.filePath));

    // Накопители одного прохода. Строки копятся в памяти и пишутся пачками в
    // конце: так разбор не держит транзакцию открытой на все время скана.
    const sessionRows: UpsertCodexSessionInput[] = [];
    const fileRows: UpsertCodexSessionFileInput[] = [];
    const headRows: UpsertCodexLimitHeadInput[] = [];
    const historyRows: AppendCodexLimitHistoryInput[] = [];
    const staleLimitFilePaths: string[] = [];

    // Счетчик измененных файлов заодно служит бюджетом среза в режиме backfill:
    // именно по нему ограничивается, сколько файлов обработать за один тик.
    let changedFiles = 0;
    let truncated = false;
    let skippedForLoad = false;

    for (const fileInfo of files) {
      // Проверки бюджета стоят первыми и до любого чтения: прерываться нужно
      // до того, как проход потратил время на файл, который все равно не
      // успеет записать.
      if (shouldPauseForLoad()) {
        skippedForLoad = true;
        break;
      }
      if (mode === "head" && Date.now() - startedAt >= headTimeBudgetMs) {
        truncated = true;
        break;
      }
      if (
        mode === "backfill" &&
        (changedFiles >= backfillFilesPerSlice || Date.now() - startedAt >= backfillSliceMs)
      ) {
        truncated = true;
        break;
      }

      // Классификация опирается на размер, mtime и версию импорта, а не на
      // содержимое файла: решение "читать или нет" должно быть дешевым и не
      // требовать открытия файла.
      const previous = previousByPath.get(fileInfo.filePath);
      const status = classifyCodexSessionFileStatus({
        previous: previous
          ? {
              sizeBytes: previous.sizeBytes,
              mtimeMs: previous.mtimeMs,
              importVersion: previous.importVersion,
            }
          : null,
        current: fileInfo,
        importVersion,
      });

      // unchanged без признака missing пропускается целиком; missing всегда
      // перечитывается, потому что файл мог быть восстановлен с тем же
      // размером и mtime.
      if (status === "unchanged" && !previous?.missing) {
        continue;
      }
      // Любой статус кроме appended означает, что содержимое изменилось
      // недописыванием (замена, усечение, смена версии импорта). Старые строки
      // этого файла устарели и подлежат удалению, иначе лимиты продублируются.
      changedFiles += 1;
      if (status !== "appended" && previous && !previous.missing) {
        staleLimitFilePaths.push(fileInfo.filePath);
      }

      // Мета может отсутствовать (обрывок файла, чужая версия формата), поэтому
      // проверка на null обязательна и все поля читаются только под ней.
      const sessionMeta = await readCodexSessionMetaFromFile(fileInfo);
      if (sessionMeta) {
        sessionRows.push({
          sessionId: sessionMeta.id,
          filePath: fileInfo.filePath,
          title: sessionMeta.prompt ?? null,
          projectRoot: sessionMeta.cwd ?? null,
          accountFingerprint: fallbackAccountFingerprint,
          sourceCreatedAt: sessionMeta.createdAt,
          sourceUpdatedAt: sessionMeta.updatedAt,
          messageCount: 0,
          previewText: sessionMeta.prompt ?? null,
          sizeBytes: fileInfo.size,
          mtimeMs: fileInfo.mtimeMs,
          lastIndexedAt: nowIso,
        });
      }

      // Возобновление с прежнего смещения только для appended: при любом
      // другом статусе файл читается с нуля, иначе хвост старого содержимого
      // смешался бы с новым. pendingTail переносится вместе со смещением, так
      // как это незавершенная строка из предыдущего чтения.
      const appendStartOffset =
        status === "appended" ? (previous?.parsedOffset ?? previous?.sizeBytes ?? 0) : 0;
      const appendPendingTail = status === "appended" ? (previous?.pendingTail ?? "") : "";
      const snapshotParseResult = await readCodexSessionLimitSnapshotsFromAppend({
        fileInfo,
        startOffset: appendStartOffset,
        pendingTail: appendPendingTail,
        runtimeId,
        providerId,
        profileId: null,
        authIdentity,
      });
      // Смещение и хвост берутся из результата разбора, а не из fileInfo:
      // парсер знает, сколько байт действительно разобрано и что осталось
      // неполным, и именно на эти значения должен опираться следующий проход.
      const nextParsedOffset = snapshotParseResult.parsedOffset;
      const nextPendingTail = snapshotParseResult.pendingTail;
      const snapshots = snapshotParseResult.snapshots;
      log.debug(
        {
          reason,
          status,
          parsedBytes: Math.max(0, snapshotParseResult.parsedOffset - appendStartOffset),
          pendingTailBytes: snapshotParseResult.pendingTail.length,
          snapshotCount: snapshotParseResult.snapshots.length,
        },
        status === "appended"
          ? "Parsed Codex appended session range"
          : "Parsed Codex full session range with cursor state",
      );

      for (const snapshot of snapshots) {
        // Отпечаток снимка в приоритете: он точнее описывает, чей это лимит.
        // Запасной отпечаток из auth identity может быть пустым, тогда строку
        // писать нельзя - пропускаем, чтобы не создать "ничей" лимит.
        const accountFingerprint =
          readCodexSnapshotAccountFingerprint(snapshot) ?? fallbackAccountFingerprint;
        if (!accountFingerprint) {
          continue;
        }

        // Голова и история пишутся парой из одной строки: голова хранит
        // последнее состояние, история - точку для графиков. Ключ головы
        // служит их общей связью.
        const limitId = readSnapshotLimitId(snapshot);
        const upsertRow: UpsertCodexLimitHeadInput = {
          accountFingerprint,
          projectRoot: sessionMeta?.cwd ?? null,
          limitId,
          model: sessionMeta?.model ?? null,
          source: "codex",
          snapshot,
          observedAt: snapshot.checkedAt,
          sessionId: sessionMeta?.id ?? null,
          filePath: fileInfo.filePath,
        };
        headRows.push(upsertRow);
        historyRows.push({
          ...upsertRow,
          headKey: buildCodexLimitHeadKey(upsertRow),
        });
      }

      // Состояние файла формируется из уже разобранных значений: sessionId
      // может отсутствовать в мете, поэтому падаем на предыдущее значение,
      // чтобы не потерять уже установленную связь.
      const nextFileState = toFileState(fileInfo, nextParsedOffset, nextPendingTail);
      nextFileState.sessionId = sessionMeta?.id ?? previous?.sessionId ?? null;
      nextFileState.missing = false;
      nextFileState.importVersion = importVersion;
      nextFileState.lastSeenAt = nowIso;
      fileRows.push(nextFileState);
    }

    // Пропавшие файлы ищутся только в backfill и только в пределах остатка
    // бюджета среза: head не должен тратить тик на вычистку архива. Фильтр по
    // mtime отсекает строки, которые и так выпадают из окна сканирования.
    const remainingBackfillFileBudget = Math.max(0, backfillFilesPerSlice - changedFiles);
    const missingPaths =
      mode === "backfill" && remainingBackfillFileBudget > 0
        ? previousStates
            .filter(
              (row) =>
                !row.missing &&
                row.mtimeMs >= usageScanCutoffMs &&
                !currentPathSet.has(row.filePath),
            )
            .slice(0, remainingBackfillFileBudget)
            .map((row) => row.filePath)
        : [];
    if (missingPaths.length > 0) {
      changedFiles += missingPaths.length;
      staleLimitFilePaths.push(...missingPaths);
    }

    const uniqueStaleLimitFilePaths = [...new Set(staleLimitFilePaths)];
    // Прерванный проход не доходит до изменений БД и возвращает частичный итог:
    // смещения по уже прочитанным файлам при этом не записаны, значит следующий
    // проход их просто перечитает. Это цена за то, что индекс никогда не
    // останавливает API.
    if (skippedForLoad || shouldPauseForLoad()) {
      return {
        ...emptySummary(reason, { skippedForLoad: true, truncated }),
        scannedFiles: files.length,
        changedFiles,
        missingFiles: missingPaths.length,
      };
    }

    // Скоупы удаляемых голов собираются до удаления: после удаления строк
    // узнать, какие аккаунты и проекты они затрагивали, будет уже нельзя.
    const deletedLimitScopes =
      uniqueStaleLimitFilePaths.length > 0
        ? listCodexLimitHeadScopesByFilePaths(uniqueStaleLimitFilePaths)
        : [];
    if (uniqueStaleLimitFilePaths.length > 0) {
      await yieldToEventLoop();
    }
    // Порядок удаления фиксирован: сначала сессии, затем файлы, затем головы и
    // история. Уступка event loop между шагами оставляет шанс прервать длинную
    // чистку, не блокируя API на одном большом запросе.
    const sessionRowsDeleted =
      uniqueStaleLimitFilePaths.length > 0
        ? deleteCodexSessionsByFilePaths(uniqueStaleLimitFilePaths)
        : 0;
    if (sessionRowsDeleted > 0) {
      await yieldToEventLoop();
    }
    const sessionFileRowsDeleted =
      uniqueStaleLimitFilePaths.length > 0
        ? deleteCodexSessionFilesByFilePaths(uniqueStaleLimitFilePaths)
        : 0;
    if (sessionFileRowsDeleted > 0) {
      await yieldToEventLoop();
    }
    const headRowsDeleted =
      uniqueStaleLimitFilePaths.length > 0
        ? deleteCodexLimitHeadsByFilePaths(uniqueStaleLimitFilePaths)
        : 0;
    if (headRowsDeleted > 0) {
      await yieldToEventLoop();
    }
    const staleHistoryRowsDeleted =
      uniqueStaleLimitFilePaths.length > 0
        ? deleteCodexLimitHistoryByFilePaths(uniqueStaleLimitFilePaths)
        : 0;
    if (staleHistoryRowsDeleted > 0) {
      await yieldToEventLoop();
    }
    // Тяжелая чистка старых строк выполняется только в backfill: в head она
    // повторялась бы на каждом прогреве, не находя ничего нового.
    const oldLimitPrune =
      mode === "backfill"
        ? pruneCodexLimitRowsBeforeObservedAt(usageScanCutoffIso)
        : { deletedScopes: [], headRowsDeleted: 0, historyRowsDeleted: 0 };
    if (oldLimitPrune.deletedScopes.length > 0) {
      deletedLimitScopes.push(...oldLimitPrune.deletedScopes);
    }
    const oldSessionPrune =
      mode === "backfill"
        ? pruneStaleCodexSessionIndexRows({ mtimeBeforeMs: usageScanCutoffMs })
        : { sessionRowsDeleted: 0, fileRowsDeleted: 0, linkedRowsRetained: 0 };
    if (
      oldLimitPrune.headRowsDeleted > 0 ||
      oldLimitPrune.historyRowsDeleted > 0 ||
      oldSessionPrune.sessionRowsDeleted > 0 ||
      oldSessionPrune.fileRowsDeleted > 0
    ) {
      await yieldToEventLoop();
    }
    if (uniqueStaleLimitFilePaths.length > 0) {
      log.debug(
        {
          reason,
          staleFileCount: uniqueStaleLimitFilePaths.length,
          deletedScopeCount: deletedLimitScopes.length,
          sessionFileRowsDeleted,
          headRowsDeleted,
          historyRowsDeleted: staleHistoryRowsDeleted,
        },
        "Deleted stale Codex limit rows for changed files",
      );
    }

    // Запись пачками идет в фиксированном порядке: сначала сущности, потом их
    // производные. Прерывание любой пачки не отменяет уже записанного, поэтому
    // проход завершается с признаком skippedForLoad и повторится позже.
    const sessionWrite = await writeRowsInBatches(sessionRows, upsertCodexSessions);
    const fileWrite = await writeRowsInBatches(fileRows, upsertCodexSessionFiles);
    const headWrite = await writeRowsInBatches(headRows, upsertCodexLimitHeads);
    const historyWrite = await writeRowsInBatches(historyRows, appendCodexLimitHistory);
    const interrupted =
      sessionWrite.interrupted ||
      fileWrite.interrupted ||
      headWrite.interrupted ||
      historyWrite.interrupted;
    const sessionRowsUpserted = sessionWrite.written;
    const fileRowsUpserted = fileWrite.written;
    const headRowsUpserted = headWrite.written;
    const historyRowsAppended = historyWrite.written;
    // Обрезка истории делается только на затронутых головах и только после
    // успешной записи: без новых строк резать нечего, а при прерывании
    // неполный набор ключей дал бы неравномерную глубину истории.
    let retainedHistoryRowsDeleted = 0;
    if (!interrupted && historyRetentionPerHead > 0) {
      const touchedHeadKeys = new Set(
        historyRows
          .map((row) => row.headKey)
          .filter((headKey): headKey is string => Boolean(headKey)),
      );
      for (const headKey of touchedHeadKeys) {
        if (shouldPauseForLoad()) {
          skippedForLoad = true;
          break;
        }
        retainedHistoryRowsDeleted += pruneCodexLimitHistoryByHead({
          headKey,
          keepLatest: historyRetentionPerHead,
        });
        await yieldToEventLoop();
      }
    }
    const totalHeadRowsDeleted = headRowsDeleted + oldLimitPrune.headRowsDeleted;
    const historyRowsDeleted =
      staleHistoryRowsDeleted + oldLimitPrune.historyRowsDeleted + retainedHistoryRowsDeleted;

    // skippedForLoad и truncated попадают в итог только при фактическом
    // срабатывании: потребители различают "проход прошел полностью" и "проход
    // надо повторить", и подстановка флагов по умолчанию это различие стерла бы.
    const summary: CodexIndexReconcileSummary = {
      reason,
      scannedFiles: files.length,
      changedFiles,
      missingFiles: missingPaths.length,
      sessionRowsUpserted,
      fileRowsUpserted,
      headRowsUpserted,
      historyRowsAppended,
      headRowsDeleted: totalHeadRowsDeleted,
      historyRowsDeleted,
      ...(skippedForLoad || interrupted ? { skippedForLoad: true } : {}),
      ...(truncated ? { truncated: true } : {}),
    };

    // Курсор двигается только за полностью успешный проход. Прерванный или
    // частичный проход не должен выглядеть как завершенный, иначе следующий
    // старт сервиса решит, что индекс уже актуален.
    if (!summary.skippedForLoad && !interrupted) {
      upsertCodexIndexCursor({
        cursorKey: "codex:index:last_reconcile",
        cursorValue: nowIso,
        cursorJson: {
          runtimeId,
          providerId,
          importVersion,
          durationMs: Date.now() - startedAt,
          mode,
          ...summary,
        },
        updatedAt: nowIso,
      });
    }
    // Оверлей лимитов кэшируется отдельно, поэтому его нужно сбросить и при
    // вставке, и при удалении голов: иначе UI покажет устаревший лимит.
    if (summary.headRowsUpserted > 0 || summary.headRowsDeleted > 0) {
      invalidateCodexOverlayCache();
    }
    notifyVisibleProjectsWithCodexLimitUpdate({
      headRows,
      deletedScopes: deletedLimitScopes,
      summary,
      cursorTimestamp: nowIso,
    });

    // Итоговый лог намеренно содержит и счетчики устаревших сессий, которых нет
    // в итоговой структуре: это единственное место, где видно, сколько строк
    // снесла чистка по окну сканирования.
    log.debug(
      {
        reason,
        runtimeId,
        providerId,
        durationMs: Date.now() - startedAt,
        scannedFiles: summary.scannedFiles,
        changedFiles: summary.changedFiles,
        missingFiles: summary.missingFiles,
        sessionRowsUpserted: summary.sessionRowsUpserted,
        fileRowsUpserted: summary.fileRowsUpserted,
        headRowsUpserted: summary.headRowsUpserted,
        historyRowsAppended: summary.historyRowsAppended,
        headRowsDeleted: summary.headRowsDeleted,
        historyRowsDeleted: summary.historyRowsDeleted,
        staleSessionRowsDeleted: oldSessionPrune.sessionRowsDeleted,
        staleSessionFileRowsDeleted: oldSessionPrune.fileRowsDeleted,
        staleLinkedSessionRowsRetained: oldSessionPrune.linkedRowsRetained,
      },
      "Codex index reconcile finished",
    );

    return summary;
  };

  // Единая точка входа для плановых и ручных проходов. Уже идущий проход
  // возвращается вызывающему как есть: параллельный скан тех же файлов только
  // удвоил бы нагрузку на диск и БД.
  const runReconcileOnce = async (
    reason = "manual",
    mode: CodexIndexReconcileMode = "backfill",
  ): Promise<CodexIndexReconcileSummary> => {
    if (inFlight) {
      log.debug({ reason, mode }, "Codex index reconcile skipped because another pass is running");
      return inFlight;
    }
    inFlight = reconcile(reason, mode).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const start = async (): Promise<void> => {
    // Повторный start не ошибка: сервис может подниматься дважды при
    // перезагрузке конфигурации, и второй запуск таймеров дал бы два цикла
    // индексации на один процесс.
    if (running) {
      log.info({ runtimeId, providerId }, "Codex indexer already started");
      return;
    }

    running = true;
    log.info({ runtimeId, providerId }, "Codex indexer start");
    scheduleHeadWarmupSoon();
    scheduleIdleBackfillLater();
    log.info(
      { runtimeId, providerId, headFileLimit, backfillIntervalMs, minIdleMs, usageScanWindowDays },
      "Codex indexer idle reconcile loop started",
    );
  };

  const stop = async (): Promise<void> => {
    if (!running) {
      log.info({ runtimeId, providerId }, "Codex indexer already stopped");
      return;
    }

    // Останавливаем таймеры до ожидания inFlight: иначе запланированный тик
    // успеет запустить новый проход прямо во время остановки.
    running = false;
    if (headWarmupTimer) {
      clearTimeout(headWarmupTimer);
      headWarmupTimer = null;
    }
    if (backfillTimer) {
      clearTimeout(backfillTimer);
      backfillTimer = null;
    }
    log.info({ runtimeId, providerId }, "Codex indexer stop requested");
    // Ожидание текущего прохода обязательно, иначе остановка сервиса оставит
    // незавершенные записи в БД. Ошибку прохода глушим: она уже залогирована
    // внутри reconcile, а stop обязан довести процесс до конца.
    try {
      await inFlight;
    } catch (error) {
      log.warn(
        { err: error, runtimeId, providerId },
        "Codex indexer stopped after reconcile error",
      );
    } finally {
      log.info({ runtimeId, providerId }, "Codex indexer stopped");
    }
  };

  return {
    start,
    stop,
    isRunning: () => running,
    runReconcileOnce,
  };
}
