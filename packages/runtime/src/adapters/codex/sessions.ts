/**
 * История сессий Codex-рантайма: чтение rollout-*.jsonl файлов, которые Codex CLI
 * пишет в ~/.codex/sessions/YYYY/MM/DD/.
 *
 * Адаптер не может получить историю выполнений из API или SDK - но CLI сам
 * сохраняет каждый тред на диск, независимо от того, кто его запускал. Отсюда
 * задача модуля: разбирать эти файлы как источник истины о сессиях, моделях и
 * rate limit профиля (события token_count содержат снапшоты rate_limits).
 *
 * Формат JSONL - один JSON-объект на строку. Строки приходят из внешнего
 * процесса, поэтому структура объектов никогда не принимается на веру: каждое
 * поле проходит через безопасные приведения readString/readFiniteNumber/readBoolean
 * и asRecord, которые возвращают null вместо исключения. Битая строка, обрезанный
 * файл или отсутствующий каталог - ожидаемые ситуации: они дают пустой результат,
 * а не сбой (см. Nullable Cast Rule в AGENTS.md и комментарии к asRecord).
 *
 * Два конвейера определяют логику модуля:
 * - список сессий: ограниченное чтение префикса файла (session_meta лежит в
 *   начале) + TTL-кэши с mtime/size в ключе;
 * - rate limit: обратное чтение хвоста (readJsonlLinesNewestFirst), инкрементальный
 *   разбор дописанных байт (offset + pendingTail) и выборка снапшотов по limitId.
 *
 * Инварианты, соблюдаемые ниже:
 * - каждый nullable-cast сохраняет `| null` и немедленно проверяется;
 * - в кэши не попадает profileId: он срезается при записи и проставляется на
 *   выдаче, поэтому профили разделяют одни и те же записи;
 * - ни одна функция не бросает из-за "странного" файла: потребители - UI и
 *   опрашивающий координатор, которым нужны пустые данные, а не исключение.
 */

import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  RuntimeLimitSnapshot,
  RuntimeLimitStatus,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionEventsInput,
  RuntimeSessionGetInput,
  RuntimeSessionListInput,
} from "../../types.js";
import {
  RuntimeLimitPrecision,
  RuntimeLimitScope,
  RuntimeLimitSource,
  RuntimeLimitStatus as RuntimeLimitStatusEnum,
} from "../../types.js";
import { createRuntimeMemoryCache } from "../../cache.js";

/**
 * Codex SDK сохраняет треды в ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
 * Модуль читает персистентные метаданные сессий для session API RuntimeAdapter.
 */

// Пути ведут в домашний каталог CLI: сессии и авторизация лежат вне проекта и
// общие для всех репозиториев, поэтому привязка "сессия -> проект" выполняется
// позже по полю cwd внутри файла, а не по расположению на диске.
const SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const AUTH_FILE = join(homedir(), ".codex", "auth.json");
// Имя файла содержит UUID треда - надежный источник id даже когда тело JSONL
// пусто или повреждено. Захватываемая группа - сам id; флаг i и чередование
// [/\\] покрывают и windows-, и posix-вид пути.
const SESSION_FILE_PATTERN =
  /(?:^|[/\\])rollout-[^/\\]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface CodexSessionMeta {
  id: string;
  model?: string;
  prompt?: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  filePath?: string;
}

export interface CodexSessionFileInfo {
  filePath: string;
  birthtimeMs: number;
  mtimeMs: number;
  size: number;
}

export interface ListCodexSessionFileInfosInput {
  sessionsDir?: string;
  limitNewest?: number;
  modifiedAfterMs?: number;
}

export interface CodexIndexedFileState {
  sizeBytes: number;
  mtimeMs: number;
  importVersion: number;
}

// Классификация для инкрементального импортера: "appended" позволяет разобрать только
// дописанный хвост с сохраненного offset, "rewrite" означает, что файл переписан
// (или сменена версия парсера) и нужен полный импорт заново.
export type CodexSessionFileStatus = "new" | "unchanged" | "appended" | "rewrite" | "missing";

// Контракт инкрементального разбора: вызывающий код хранит пару
// (parsedOffset, pendingTail) между поллингами и передает ее обратно, чтобы
// каждый раз читать лишь новые байты файла, а не весь лог.
export interface CodexAppendLimitSnapshotsResult {
  snapshots: RuntimeLimitSnapshot[];
  parsedOffset: number;
  pendingTail: string;
}

// Эти интерфейсы описывают JSON из rollout-файла, а не внутренний контракт, поэтому
// все поля опциональны и имеют тип unknown: unknown заставляет каждый доступ
// проходить через readString/readFiniteNumber, где реальное значение проверяется по
// типу. Смена формата CLI ломает не чтение "по типизированному объекту", а
// конкретный helper, который честно вернет null.
interface CodexSessionRateLimitWindow {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
}

interface CodexSessionCredits {
  has_credits?: unknown;
  unlimited?: unknown;
  balance?: unknown;
}

interface CodexSessionRateLimits {
  limit_id?: unknown;
  limit_name?: unknown;
  primary?: unknown;
  secondary?: unknown;
  credits?: unknown;
  plan_type?: unknown;
}

// Поля объявлены как string | null явно, а не `?: string`,
// чтобы вызывающий код не мог перепутать "не прочиталось" с "ключа нет".
export interface CodexAuthIdentity {
  accountId: string | null;
  authMode: string | null;
  accountName: string | null;
  accountEmail: string | null;
  planType: string | null;
}

// DEFAULT_WARNING_THRESHOLD - порог в "процентах остатка": при <=10% статус
// снапшота становится WARNING. MAX_VALID_DATE_MS - граница диапазона Date в
// ECMAScript (±8.64e15 мс): мусорный epoch из JSONL отбраковывается до вызова
// new Date, который иначе дал бы Invalid Date. LIMIT_SNAPSHOT_SESSION_SCAN_LIMIT
// ограничивает скан 50 файлами: rate limit - точечное значение, свежих
// сессий достаточно, и обходить весь архив незачем.
const DEFAULT_WARNING_THRESHOLD = 10;
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;
const DEFAULT_CODEX_LIMIT_ID = "codex";
const SESSION_META_CACHE_TTL_MS = 30_000;
const SESSION_META_FILE_CACHE_TTL_MS = 300_000;
const SESSION_LIMIT_SNAPSHOT_CACHE_TTL_MS = 60_000;
const LIMIT_SNAPSHOT_SESSION_SCAN_LIMIT = 50;
const LIMIT_SNAPSHOT_TAIL_CHUNK_BYTES = 64 * 1024;

// Четыре кэша с разными TTL: список сессий (30 с) опрашивается UI часто;
// мета отдельного файла живет дольше (5 мин), но ее ключ включает mtime и size,
// поэтому измененный файл сам выпадает из кэша без кода инвалидации. Снимки
// лимитов кэшируются на 60 с и в профиль-агностичном виде (profileId: null).
const sessionMetasCache = createRuntimeMemoryCache<CodexSessionMeta[]>({
  defaultTtlMs: SESSION_META_CACHE_TTL_MS,
  maxSize: 1,
});
const sessionMetaByFileCache = createRuntimeMemoryCache<CodexSessionMeta>({
  defaultTtlMs: SESSION_META_FILE_CACHE_TTL_MS,
  maxSize: 20_000,
});
const sessionLimitSnapshotsCache = createRuntimeMemoryCache<RuntimeLimitSnapshot[]>({
  defaultTtlMs: SESSION_LIMIT_SNAPSHOT_CACHE_TTL_MS,
  maxSize: 512,
});
const latestLimitSnapshotsCache = createRuntimeMemoryCache<RuntimeLimitSnapshot[]>({
  defaultTtlMs: SESSION_LIMIT_SNAPSHOT_CACHE_TTL_MS,
  maxSize: 64,
});

// Хелпер, который никогда не бросает и не возвращает null: потребителям событий и
// снапшотов нужна валидная ISO-строка, и "сейчас" лучше, чем Invalid Date из
// мусорного timestamp в файле. try/catch страхует от экзотических numeric-входов.
function toIso(value: string | number | undefined): string {
  try {
    if (typeof value === "string" || typeof value === "number") {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  } catch {
    // проваливаемся дальше
  }
  return new Date().toISOString();
}

// Основа всего защитного разбора. Вместо каста `as Record<string, unknown>`,
// который стёр бы nullability, отдаётся честный `| null`: вызывающий код обязан
// проверить результат, иначе type checker не увидит риск и `obj.field` упадёт на
// null в рантайме. Это и есть Nullable Cast Rule из AGENTS.md.
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

// Семейство безопасных приведений: проверка runtime-типа перед использованием
// значения. undefined/null означает "пригодного значения нет", и это позволяет
// строить ??-цепочки между альтернативными именами полей. Trim-проверка в
// readString отбраковывает пустые строки: в JSONL "" - это не данные, а заглушка.
function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

// Псевдонимы model/model_slug/modelId - следы разных версий Codex CLI, писавших
// одно понятие по-разному: вместо определения версии берется первое непустое.
function readModelIdentifier(
  value: Record<string, unknown> | null | undefined,
): string | undefined {
  return readString(value?.model) ?? readString(value?.model_slug) ?? readString(value?.modelId);
}

function readSnapshotLimitId(snapshot: RuntimeLimitSnapshot | null | undefined): string | null {
  const providerMeta = asRecord(snapshot?.providerMeta);
  return readString(providerMeta?.limitId) ?? null;
}

// Повторно проставляет profileId снапшотам, взятым из общего кэша: кэш хранит
// профиль-независимые данные, поэтому разные профили переиспользуют одну запись.
// При совпадении значения объект возвращается как есть - без копии на каждый
// поллинг UI.
function applySnapshotProfileId(
  snapshot: RuntimeLimitSnapshot,
  profileId: string | null | undefined,
): RuntimeLimitSnapshot {
  const nextProfileId = profileId ?? null;
  return snapshot.profileId === nextProfileId
    ? snapshot
    : { ...snapshot, profileId: nextProfileId };
}

// Обход пути (например, claims JWT под namespaced-ключом): каждый шаг может
// отсутствовать или быть не-объектом, и asRecord с optional chaining сводит всю
// цепочку к null, а не роняет процесс.
function readNestedString(
  value: Record<string, unknown> | null | undefined,
  ...path: string[]
): string | null {
  let current: unknown = value;
  for (const segment of path) {
    current = asRecord(current)?.[segment];
    if (current == null) {
      return null;
    }
  }

  return readString(current) ?? null;
}

// Одна строка JSONL: CLI не гарантирует, что строки дописываются целиком и по
// одной за раз, поэтому последняя строка снимка может быть разорвана посреди
// записи. SyntaxError здесь - будничная ситуация, а null даёт вызывающему коду
// право пропустить дефектную строку.
function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

// JWT декодируется без проверки подписи: это не авторизация, а отображение
// личности (имя, email, план) из уже локального auth.json. parts[1] - стандартная
// позиция payload в base64url-токене.
function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  const rawToken = readString(token);
  if (!rawToken) {
    return null;
  }

  const parts = rawToken.split(".");
  if (parts.length < 2 || !parts[1]) {
    return null;
  }

  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    return asRecord(JSON.parse(payload));
  } catch {
    return null;
  }
}

// Отсутствие auth.json означает "на этой машине ещё не логинились в CLI" -
// штатное состояние свежего Codex, а не ошибка. Поэтому каждая ветка отказа
// молча возвращает null, а в конце не отдаётся пустая оболочка идентификации.
export async function getCodexAuthIdentity(): Promise<CodexAuthIdentity | null> {
  let raw: string;
  try {
    raw = await readFile(AUTH_FILE, "utf-8");
  } catch {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = asRecord(parsedJson);
  if (!parsed) {
    return null;
  }

  const tokens = asRecord(parsed.tokens);
  const idTokenPayload = decodeJwtPayload(tokens?.id_token);
  const accessTokenPayload = decodeJwtPayload(tokens?.access_token);
  const accountId = readString(tokens?.account_id) ?? null;
  const authMode = readString(parsed.auth_mode) ?? null;
  const accountName =
    readNestedString(idTokenPayload, "name") ??
    readNestedString(accessTokenPayload, "name") ??
    null;
  const accountEmail =
    readNestedString(accessTokenPayload, "https://api.openai.com/profile", "email") ??
    readNestedString(idTokenPayload, "email") ??
    null;
  const planType =
    readNestedString(accessTokenPayload, "https://api.openai.com/auth", "chatgpt_plan_type") ??
    readNestedString(idTokenPayload, "https://api.openai.com/auth", "chatgpt_plan_type") ??
    null;

  if (!accountId && !authMode && !accountName && !accountEmail && !planType) {
    return null;
  }

  return {
    accountId,
    authMode,
    accountName,
    accountEmail,
    planType,
  };
}

// Отпечаток - SHA-256 хэш: email и имя попадают в БД и логи через providerMeta
// по минимуму, а для сравнения "тот ли это аккаунт" хэша достаточно.
// Lowercase+trim стабилизуют значение независимо от написания в auth.json.
export function buildCodexAuthFingerprint(
  identity: CodexAuthIdentity | null | undefined,
): string | null {
  if (!identity) {
    return null;
  }

  const accountId = identity.accountId?.trim().toLowerCase() ?? "";
  const accountEmail = identity.accountEmail?.trim().toLowerCase() ?? "";
  const accountName = identity.accountName?.trim().toLowerCase() ?? "";
  const authMode = identity.authMode?.trim().toLowerCase() ?? "";
  const planType = identity.planType?.trim().toLowerCase() ?? "";
  const stableValue = `${accountId}|${accountEmail}|${accountName}|${authMode}|${planType}`;
  // Если отбросить разделители и ничего не останется - все поля пусты: хэш
  // из "||||" ничего не различает и создавал бы ложное совпадение аккаунтов.
  if (!stableValue.replace(/\|/g, "")) {
    return null;
  }

  return createHash("sha256").update(stableValue).digest("hex");
}

// Приоритет у отпечатка, уже встроенного в снапшот потоковой стороной;
// для старых записей он пересчитывается из полей providerMeta тем же алгоритмом.
export function readCodexSnapshotAccountFingerprint(
  snapshot: RuntimeLimitSnapshot | null | undefined,
): string | null {
  const providerMeta = asRecord(snapshot?.providerMeta);
  const embedded = readString(providerMeta?.accountFingerprint);
  if (embedded) {
    return embedded;
  }

  return buildCodexAuthFingerprint({
    accountId: readString(providerMeta?.accountId) ?? null,
    authMode: readString(providerMeta?.authMode) ?? null,
    accountName: readString(providerMeta?.accountName) ?? null,
    accountEmail: readString(providerMeta?.accountEmail) ?? null,
    planType: readString(providerMeta?.planType) ?? null,
  });
}

// Единственный источник id, не требующий чтения содержимого файла.
function sessionIdFromFilePath(filePath: string): string | null {
  const match = SESSION_FILE_PATTERN.exec(filePath);
  return match?.[1] ?? null;
}

// Поля fs ведут себя по-разному на разных платформах (birthtime нередко epoch 0
// или отсутствует), поэтому каждый timestamp берётся с fallback на уже
// проверенное значение.
function readDateMs(value: Date | number | undefined, fallbackMs: number): number {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : fallbackMs;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : fallbackMs;
}

// Сравнение "та ли это проектная папка" делается без учёта регистра и
// разделителей: Windows пишет обратные слеши, POSIX - прямые, а на macOS ФС
// регистронезависима. Без нормализации одна и та же папка давала бы два cwd.
export function normalizeCodexProjectPath(value: string | undefined | null): string | null {
  if (!value) return null;
  return value
    .replace(/[\\/]+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
}

function normalizePath(value: string | undefined): string | null {
  return normalizeCodexProjectPath(value);
}

// CLI шлёт resets_at то в секундах, то в миллисекундах в зависимости от версии:
// 1e12 - граница между "правдоподобные мс" и "точно секунды" (в мс это 2001 год).
// MAX_VALID_DATE_MS отбраковывает мусор, выходящий за диапазон Date.
function normalizeSessionResetAt(value: unknown): string | null {
  const raw = readFiniteNumber(value);
  if (raw == null) return null;

  const targetMs = raw >= 1_000_000_000_000 ? raw : raw * 1000;
  if (!Number.isFinite(targetMs) || Math.abs(targetMs) > MAX_VALID_DATE_MS) {
    return null;
  }

  const date = new Date(targetMs);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

// Провайдер может сообщить used_percent больше 100: "остаток" прижимается к
// 0..100, чтобы индикаторы UI не выходили за шкалу.
function toPercentRemaining(percentUsed: number | null): number | null {
  if (percentUsed == null) return null;
  return Math.max(0, Math.min(100, 100 - percentUsed));
}

// 300 и 10080 минут - канонические окна Codex ("5h" и "7d"); для остальных
// размер округляется к крупнейшей целой единице.
function formatWindowName(windowMinutes: number | null): string | null {
  if (windowMinutes == null) return null;
  if (windowMinutes === 300) return "5h";
  if (windowMinutes === 10080) return "7d";
  if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

// Образцовое применение Nullable Cast Rule из правил проекта: asRecord возвращает
// `Record | null`, каст сохраняет `| null`, и следующая же строка проверяет его.
// Тип здесь только документирует форму, а реальную проверку чисел делает
// readFiniteNumber.
function buildRateLimitWindow(rawWindow: unknown) {
  const window = asRecord(rawWindow) as CodexSessionRateLimitWindow | null;
  if (!window) {
    return null;
  }
  const percentUsed = readFiniteNumber(window.used_percent);
  const percentRemaining = toPercentRemaining(percentUsed);
  const windowMinutes = readFiniteNumber(window.window_minutes);
  const resetAt = normalizeSessionResetAt(window.resets_at);

  if (percentUsed == null && percentRemaining == null && windowMinutes == null && resetAt == null) {
    return null;
  }

  return {
    scope: RuntimeLimitScope.TIME,
    name: formatWindowName(windowMinutes),
    unit: windowMinutes != null ? "minutes" : null,
    percentUsed,
    percentRemaining,
    resetAt,
    warningThreshold: DEFAULT_WARNING_THRESHOLD,
  };
}

// Статус - худшее из двух окон: исчерпанный secondary блокирует CLI так же,
// как исчерпанный primary. Поэтому порядок проверок BLOCKED -> WARNING -> OK
// образует приоритет цепочкой условий, а не сортировкой.
function resolveSnapshotStatus(
  windows: Array<{ percentRemaining?: number | null }>,
): RuntimeLimitStatus {
  if (
    windows.some(
      (window) =>
        typeof window.percentRemaining === "number" &&
        Number.isFinite(window.percentRemaining) &&
        window.percentRemaining <= 0,
    )
  ) {
    return RuntimeLimitStatusEnum.BLOCKED;
  }

  if (
    windows.some(
      (window) =>
        typeof window.percentRemaining === "number" &&
        Number.isFinite(window.percentRemaining) &&
        window.percentRemaining <= DEFAULT_WARNING_THRESHOLD,
    )
  ) {
    return RuntimeLimitStatusEnum.WARNING;
  }

  if (windows.length > 0) {
    return RuntimeLimitStatusEnum.OK;
  }

  return RuntimeLimitStatusEnum.UNKNOWN;
}

// Превращает rate_limits JSON из события token_count в типизированный
// RuntimeLimitSnapshot. Ещё одно место каста с `| null` и обязательной проверкой
// (см. buildRateLimitWindow); отсутствие окон означает не ошибку, а "нет данных".
function buildCodexLimitSnapshot(
  rateLimitsRaw: unknown,
  input: {
    runtimeId: string;
    providerId: string;
    profileId?: string | null;
    checkedAt: string;
    authIdentity?: CodexAuthIdentity | null;
  },
): RuntimeLimitSnapshot | null {
  const rateLimits = asRecord(rateLimitsRaw) as CodexSessionRateLimits | null;
  if (!rateLimits) {
    return null;
  }
  const windows = [
    buildRateLimitWindow(rateLimits.primary),
    buildRateLimitWindow(rateLimits.secondary),
  ].filter((window) => window != null);

  if (windows.length === 0) {
    return null;
  }

  const status = resolveSnapshotStatus(windows);
  // Тип-предикат в find сужает `string | null` до string без всякого каста.
  const resetAt = windows
    .map((window) => window.resetAt)
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const credits = asRecord(rateLimits.credits) as CodexSessionCredits | null;
  const accountFingerprint = buildCodexAuthFingerprint(input.authIdentity);

  return {
    source: RuntimeLimitSource.SDK_EVENT,
    status,
    precision: RuntimeLimitPrecision.EXACT,
    checkedAt: input.checkedAt,
    providerId: input.providerId,
    runtimeId: input.runtimeId,
    profileId: input.profileId ?? null,
    primaryScope: RuntimeLimitScope.TIME,
    resetAt: resetAt ?? null,
    retryAfterSeconds: null,
    warningThreshold: DEFAULT_WARNING_THRESHOLD,
    windows,
    providerMeta: {
      limitId: readString(rateLimits.limit_id) ?? null,
      limitName: readString(rateLimits.limit_name) ?? null,
      planType: input.authIdentity?.planType ?? readString(rateLimits.plan_type) ?? null,
      accountId: input.authIdentity?.accountId ?? null,
      authMode: input.authIdentity?.authMode ?? null,
      accountName: input.authIdentity?.accountName ?? null,
      accountEmail: input.authIdentity?.accountEmail ?? null,
      accountFingerprint,
      credits: {
        hasCredits: readBoolean(credits?.has_credits),
        unlimited: readBoolean(credits?.unlimited),
        balance: readFiniteNumber(credits?.balance),
      },
    },
  };
}

// Первые 80 символов пользовательского промпта служат заголовком, а сырая meta
// кладётся в metadata.raw: деталям UI не нужен повторный разбор файла.
function mapToRuntimeSession(
  meta: CodexSessionMeta,
  profileId: string | null | undefined,
): RuntimeSession {
  return {
    id: meta.id,
    runtimeId: "codex",
    providerId: "openai",
    profileId: profileId ?? null,
    model: meta.model ?? null,
    title: meta.prompt?.slice(0, 80) ?? null,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    metadata: { raw: meta },
  };
}

// Сессии разложены по каталогам YYYY/MM/DD, поэтому дату видно из самого пути
// без stat. Конец дня = начало + 24ч - 1мс: если весь день старше порога,
// в поддереве не могло появиться новых файлов.
function readSessionDayDirectoryEndMs(dir: string): number | null {
  const normalized = dir.replace(/[\\/]+/g, "/");
  const match = /(?:^|\/)(\d{4})\/(\d{2})\/(\d{2})$/.exec(normalized);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const startMs = Date.UTC(year, monthIndex, day);
  if (!Number.isFinite(startMs)) {
    return null;
  }
  return startMs + 24 * 60 * 60 * 1000 - 1;
}

function shouldSkipSessionDirectory(dir: string, modifiedAfterMs: number | null): boolean {
  if (modifiedAfterMs == null) {
    return false;
  }
  const dayEndMs = readSessionDayDirectoryEndMs(dir);
  return dayEndMs != null && dayEndMs < modifiedAfterMs;
}

// Рекурсивный обход дерева год/месяц/день; modifiedAfterMs отсекает целые
// поддеревья по имени каталога (см. shouldSkipSessionDirectory).
async function collectSessionFileInfos(
  dir: string,
  input: {
    modifiedAfterMs: number | null;
  },
): Promise<CodexSessionFileInfo[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Каталога может не быть вовсе (Codex никогда не запускали) или он исчезает
    // во время скана: отдаём [] и листание завершается без исключения.
    return [];
  }

  const files: CodexSessionFileInfo[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipSessionDirectory(fullPath, input.modifiedAfterMs)) {
        files.push(...(await collectSessionFileInfos(fullPath, input)));
      }
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    try {
      const info = await stat(fullPath);
      const mtimeMs = readDateMs(info.mtime, Date.now());
      if (input.modifiedAfterMs != null && mtimeMs < input.modifiedAfterMs) {
        continue;
      }
      files.push({
        filePath: fullPath,
        birthtimeMs: readDateMs(info.birthtime, mtimeMs),
        mtimeMs,
        size: typeof info.size === "number" && Number.isFinite(info.size) ? info.size : 0,
      });
    } catch {
      // Файлы сессий могут исчезнуть, пока Codex ротирует или очищает их.
    }
  }

  return files;
}

// Контракт "сначала новые": сортировка по убыванию mtime и усечение limitNewest.
// Почти все потребители хотят самые свежие сессии, а не весь архив.
async function listSessionFileInfos(
  dir: string,
  input: {
    limitNewest?: number;
    modifiedAfterMs?: number;
  } = {},
): Promise<CodexSessionFileInfo[]> {
  const modifiedAfterMs =
    typeof input.modifiedAfterMs === "number" && Number.isFinite(input.modifiedAfterMs)
      ? Math.max(0, input.modifiedAfterMs)
      : null;
  const files = await collectSessionFileInfos(dir, { modifiedAfterMs });
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const limitNewest =
    typeof input.limitNewest === "number" && Number.isFinite(input.limitNewest)
      ? Math.max(0, Math.trunc(input.limitNewest))
      : null;
  return limitNewest == null ? files : files.slice(0, limitNewest);
}

export async function listCodexSessionFileInfos(
  input?: ListCodexSessionFileInfosInput,
): Promise<CodexSessionFileInfo[]> {
  return await listSessionFileInfos(input?.sessionsDir ?? SESSIONS_DIR, input);
}

// Ограничиваем чтение streamed-меты: session_meta/turn_context сидят в первых
// строках, а первый user_message обычно следует в пределах нескольких КБ. Читаем
// дальше только когда нашли нужное метам — иначе большие сессии
// вынули бы мегабайты лишнего I/O просто при рендере списка сессий.
const SESSION_META_MAX_BYTES = 64 * 1024;

// Читает только то, что нужно списку: id/model/prompt/cwd стоят в начале файла,
// поэтому чтение ограничено префиксом и есть ранний break. Принимает либо путь,
// либо готовый stat - листалка уже собрала его, повторный syscall был бы лишней тратой.
async function readSessionMetaFromFile(
  fileInfoOrPath: CodexSessionFileInfo | string,
): Promise<CodexSessionMeta | null> {
  let fileInfo: CodexSessionFileInfo;
  if (typeof fileInfoOrPath === "string") {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(fileInfoOrPath);
    } catch {
      return null;
    }
    const mtimeMs = readDateMs(info.mtime, Date.now());
    fileInfo = {
      filePath: fileInfoOrPath,
      birthtimeMs: readDateMs(info.birthtime, mtimeMs),
      mtimeMs,
      size: typeof info.size === "number" && Number.isFinite(info.size) ? info.size : 0,
    };
  } else {
    fileInfo = fileInfoOrPath;
  }

  // Имя файла не соответствует паттерну - это не rollout, читать нечего.
  const fallbackId = sessionIdFromFilePath(fileInfo.filePath);
  if (!fallbackId) return null;

  // mtime и size в ключе дают авто-инвалидацию: изменённый файл просто
  // не попадает в кэш, код очистки кэша не нужен.
  const cacheKey = `${fileInfo.filePath}|${fileInfo.mtimeMs}|${fileInfo.size}`;
  const cached = sessionMetaByFileCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let resolvedId = fallbackId;
  let createdAt = new Date(fileInfo.birthtimeMs).toISOString();
  let model: string | undefined;
  let prompt: string | undefined;
  let cwd: string | undefined;

  let stream: ReturnType<typeof createReadStream> | null = null;
  try {
    // end ограничивает чтение первыми 64 КиБ (end включителен, отсюда -1).
    stream = createReadStream(fileInfo.filePath, {
      encoding: "utf-8",
      end: SESSION_META_MAX_BYTES - 1,
    });
    // crlfDelay: Infinity трактует \r\n как один разделитель: CLI на Windows
    // пишет строки именно так, иначе \r остался бы внутри JSON.
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        const entry = parseJsonLine(line);
        if (!entry) continue;

        // Разбор по типу строки: каждая ветка извлекает своё, а цепочки `?? prev`
        // сохраняют уже найденное: поздняя пустая строка его не перетирает.
        if (readString(entry.type) === "session_meta") {
          const payload = asRecord(entry.payload);
          resolvedId = readString(payload?.id) ?? resolvedId;
          createdAt = toIso(
            (payload?.timestamp as string | number | undefined) ??
              (entry.timestamp as string | number | undefined),
          );
          cwd = readString(payload?.cwd) ?? cwd;
          model = readModelIdentifier(payload) ?? model;
          continue;
        }

        if (readString(entry.type) === "turn_context") {
          const payload = asRecord(entry.payload);
          model = readModelIdentifier(payload) ?? model;
          continue;
        }

        if (readString(entry.type) === "event_msg") {
          const payload = asRecord(entry.payload);
          if (readString(payload?.type) === "user_message") {
            prompt = readString(payload?.message) ?? prompt;
            // Все нужные списку поля собраны - дальше в файл идти незачем.
            if (prompt && model) break;
          }
        }
      }
    } finally {
      reader.close();
    }
  } catch {
    // Файл не читается (исчез при ротации, права) - отдаём meta из имени и stat,
    // чтобы строка не пропала из списка: id и даты уже достоверны.
    return {
      id: fallbackId,
      createdAt,
      updatedAt: new Date(fileInfo.mtimeMs).toISOString(),
      filePath: fileInfo.filePath,
    };
  } finally {
    // destroy() в finally обязателен: break из for-await не закрывает поток сам,
    // и файловый дескриптор держался бы до сборщика мусора.
    stream?.destroy();
  }

  const meta = {
    id: resolvedId,
    model,
    prompt,
    cwd,
    createdAt,
    updatedAt: new Date(fileInfo.mtimeMs).toISOString(),
    filePath: fileInfo.filePath,
  };
  sessionMetaByFileCache.set(cacheKey, meta);
  return meta;
}

export async function readCodexSessionMetaFromFile(
  fileInfoOrPath: CodexSessionFileInfo | string,
): Promise<CodexSessionMeta | null> {
  return await readSessionMetaFromFile(fileInfoOrPath);
}

// Полный скан для случая без фильтров: Promise.all читает префиксы всех файлов
// параллельно, а результат держится в кэше списка.
async function readSessionMetas(): Promise<CodexSessionMeta[]> {
  const cached = sessionMetasCache.get("all");
  if (cached) {
    return cached;
  }

  const sessionFiles = await listSessionFileInfos(SESSIONS_DIR);
  // Тип-предикат снимает null с типа элементов после фильтра - без каста.
  const sessions = (
    await Promise.all(sessionFiles.map((fileInfo) => readSessionMetaFromFile(fileInfo)))
  ).filter((session): session is CodexSessionMeta => Boolean(session));

  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  sessionMetasCache.set("all", sessions);
  return sessions;
}

// Без фильтров - быстрый путь через кэшированный общий скан. С фильтрами цикл
// идёт последовательно, а не через Promise.all: чтобы встать на limit, надо
// заранее знать, сколько сессий уже собрано.
async function readSessionMetasLazy(input: {
  projectRoot?: string | null;
  limit?: number | null;
}): Promise<CodexSessionMeta[]> {
  if (!input.projectRoot && !input.limit) {
    return await readSessionMetas();
  }

  const normalizedProjectRoot = normalizePath(input.projectRoot ?? undefined);
  const fileInfos = await listSessionFileInfos(SESSIONS_DIR);
  const sessions: CodexSessionMeta[] = [];

  for (const fileInfo of fileInfos) {
    const session = await readSessionMetaFromFile(fileInfo);
    if (!session) {
      continue;
    }
    if (normalizedProjectRoot && normalizePath(session.cwd) !== normalizedProjectRoot) {
      continue;
    }

    sessions.push(session);
    if (input.limit && sessions.length >= input.limit) {
      break;
    }
  }

  return sessions;
}

// Две стратегии: дешёвое совпадение UUID из имени файла; глубоким сканом meta
// идут только когда id внутри файла отличается от указанного в имени.
async function findSessionFileInfoById(sessionId: string): Promise<CodexSessionFileInfo | null> {
  const sessionFiles = await listSessionFileInfos(SESSIONS_DIR);
  const filenameMatch = sessionFiles.find(
    (fileInfo) => sessionIdFromFilePath(fileInfo.filePath) === sessionId,
  );
  if (filenameMatch) {
    return filenameMatch;
  }

  for (const fileInfo of sessionFiles) {
    const session = await readSessionMetaFromFile(fileInfo);
    if (session?.id === sessionId) {
      return fileInfo;
    }
  }

  return null;
}

export async function findCodexSessionFileInfoById(
  sessionId: string,
): Promise<CodexSessionFileInfo | null> {
  return await findSessionFileInfoById(sessionId);
}

// Чистый классификатор инкрементального импортера: по прежнему индексированному
// состоянию и текущему stat решает, что делать с одним файлом. Пара mtime+size -
// дешёвый отпечаток, отличающий дописку от полной перезаписи.
export function classifyCodexSessionFileStatus(input: {
  previous: CodexIndexedFileState | null;
  current: CodexSessionFileInfo | null;
  importVersion: number;
}): CodexSessionFileStatus {
  if (!input.current) {
    return "missing";
  }
  if (!input.previous) {
    return "new";
  }
  // Сменилась версия парсера - изменилась семантика разбора: файлы импортятся
  // заново независимо от их содержимого.
  if (input.previous.importVersion !== input.importVersion) {
    return "rewrite";
  }
  if (
    input.previous.mtimeMs === input.current.mtimeMs &&
    input.previous.sizeBytes === input.current.size
  ) {
    return "unchanged";
  }
  // Файл вырос при свежем mtime: это дописка хвоста, импортёр прочитает его с
  // сохранённого offset вместо перебора всего лога.
  if (
    input.current.size > input.previous.sizeBytes &&
    input.current.mtimeMs >= input.previous.mtimeMs
  ) {
    return "appended";
  }
  return "rewrite";
}

// Публичные методы session-API адаптера: тонкая обёртка над внутренними читалками,
// переносящая CodexSessionMeta в форму RuntimeSession.
export async function listCodexSdkSessions(
  input: RuntimeSessionListInput,
): Promise<RuntimeSession[]> {
  const sessions = await readSessionMetasLazy({
    projectRoot: input.projectRoot,
    limit: input.limit ?? null,
  });
  return sessions.map((session) => mapToRuntimeSession(session, input.profileId));
}

export async function getCodexSdkSession(
  input: RuntimeSessionGetInput,
): Promise<RuntimeSession | null> {
  const fileInfo = await findSessionFileInfoById(input.sessionId);
  const session = fileInfo ? await readSessionMetaFromFile(fileInfo) : null;
  return session ? mapToRuntimeSession(session, input.profileId) : null;
}

export async function listCodexSdkSessionEvents(
  input: RuntimeSessionEventsInput,
): Promise<RuntimeEvent[]> {
  const fileInfo = await findSessionFileInfoById(input.sessionId);
  if (!fileInfo) return [];
  return await readSessionEventsFromFile(fileInfo, { limit: input.limit ?? undefined });
}

// В отличие от meta, файл читается целиком: историю открывают по действию
// пользователя, а не опрашивают каждые несколько секунд списком.
async function readSessionEventsFromFile(
  fileInfoOrPath: CodexSessionFileInfo | string,
  input: { limit?: number } = {},
): Promise<RuntimeEvent[]> {
  const filePath = typeof fileInfoOrPath === "string" ? fileInfoOrPath : fileInfoOrPath.filePath;

  let lines: string[];
  try {
    const raw = await readFile(filePath, "utf-8");
    lines = raw.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }

  const events: RuntimeEvent[] = [];
  for (const line of lines) {
    // Текст чата несут только event_msg; прочие строки - служебные записи CLI.
    const entry = parseJsonLine(line);
    if (!entry || readString(entry.type) !== "event_msg") continue;

    const payload = asRecord(entry.payload);
    const payloadType = readString(payload?.type);
    const text = readString(payload?.message);
    // Любое недостающее поле - строка пропускается, а не бросает исключение.
    if (!payloadType || !text) continue;

    if (payloadType === "agent_message") {
      const phase = readString(payload?.phase);
      // agent_message приходит в нескольких фазах; в ленту попадает финальный
      // ответ, промежуточные "недосказанные" фазы отфильтрованы.
      if (phase && phase !== "final_answer") {
        continue;
      }
    }

    if (payloadType !== "user_message" && payloadType !== "agent_message") {
      continue;
    }

    // RuntimeEvent - размеченное объединение по полю type: потребители ленты
    // ветвятся по нему, здесь собирается ровно один вариант.
    events.push({
      type: "session-message",
      timestamp: toIso(entry.timestamp as string | number | undefined),
      level: "info",
      message: text,
      data: {
        role: payloadType === "user_message" ? "user" : "assistant",
        id: readString(payload?.turn_id) ?? readString(payload?.id),
      },
    });
  }

  // Хвост срезается с конца: вызывающему коду нужны последние события, а не первые.
  return input.limit ? events.slice(-input.limit) : events;
}

export async function readCodexSessionEventsFromFile(
  fileInfoOrPath: CodexSessionFileInfo | string,
  input: { limit?: number } = {},
): Promise<RuntimeEvent[]> {
  return await readSessionEventsFromFile(fileInfoOrPath, input);
}

export async function getCodexSessionLimitSnapshot(input: {
  sessionId: string;
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
}): Promise<RuntimeLimitSnapshot | null> {
  const snapshots = await getCodexSessionLimitSnapshots(input);
  return snapshots[0] ?? null;
}

// Модель сравнивается по "скелету": lowercase без пунктуации и пробелов, чтобы
// "GPT-5-Codex" и "gpt_5 codex" считались одной моделью.
function normalizeModelIdentifier(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return normalized.length > 0 ? normalized : null;
}

// Сентинел -Infinity: элемент без даты уходит в конец сортировки по убыванию,
// и при этом его не спутать с настоящим epoch 1970-го, как это было бы с нулём.
function parseTimestampMs(value: string | null | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function isSparkCodexModel(model: string | null | undefined): boolean {
  const normalized = normalizeModelIdentifier(model);
  return normalized?.includes("spark") ?? false;
}

// Читает ровно указанный байтовый диапазон, не поднимая весь файл в память:
// лимиты стоят в хвосте, а rollout дорастает до сотен мегабайт.
async function readFileRange(input: {
  filePath: string;
  start: number;
  end: number;
}): Promise<string> {
  let raw = "";
  const stream = createReadStream(input.filePath, {
    encoding: "utf-8",
    start: input.start,
    end: input.end,
  });

  try {
    for await (const chunk of stream) {
      raw += typeof chunk === "string" ? chunk : String(chunk);
    }
  } finally {
    stream.destroy();
  }

  return raw;
}

// Обратный читатель JSONL: кусками с конца, отдаёт строки начиная со свежих.
// Generator ленив: вызывающий код вправе остановиться на первой находке
// (fast mode), не вынуждая читать весь файл.
async function* readJsonlLinesNewestFirst(fileInfo: CodexSessionFileInfo): AsyncGenerator<string> {
  // Если stat сообщил нулевой размер, байтовые диапазоны бессмысленны -
  // маленький файл читается целиком.
  if (fileInfo.size <= 0) {
    const raw = await readFile(fileInfo.filePath, "utf-8");
    const lines = raw.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      yield lines[index]!;
    }
    return;
  }

  let position = fileInfo.size;
  // Граница куска режет строку пополам: подозрителен только первый фрагмент -
  // его начало лежит выше и будет дочитано следующим (верхним) куском.
  let leadingPartial = "";

  while (position > 0) {
    const start = Math.max(0, position - LIMIT_SNAPSHOT_TAIL_CHUNK_BYTES);
    const end = position - 1;
    const chunk = await readFileRange({ filePath: fileInfo.filePath, start, end });
    position = start;

    const parts = `${chunk}${leadingPartial}`.split(/\r?\n/);
    // Верхний фрагмент не выбрасывается: он склеится со следующим, более высоким куском.
    leadingPartial = parts.shift() ?? "";
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      yield parts[index]!;
    }
  }

  if (leadingPartial) {
    yield leadingPartial;
  }
}

// Контракт инкрементального разбора: всё до последнего перевода строки - целые
// строки, а хвост после него - pendingTail: недописанная или оборванная часть.
// Её не парсят, а хранят до следующего поллинга, где она доклеится к новым байтам.
function splitAppendedJsonlLines(raw: string): {
  lines: string[];
  pendingTail: string;
} {
  const lines = raw.split(/\r?\n/);
  const pendingTail = lines.pop() ?? "";
  return { lines, pendingTail };
}

// Общий редьюсер снапшотов для обоих направлений скана: строки приходят либо
// от самых новых к старым, либо в порядке файла.
function collectCodexLimitSnapshotsFromLines(
  lines: Iterable<string>,
  input: {
    runtimeId: string;
    providerId: string;
    profileId?: string | null;
    authIdentity?: CodexAuthIdentity | null;
    keepLatestPerLimit: boolean;
  },
): RuntimeLimitSnapshot[] {
  // По одному снапшоту на бакет: token_count повторяют одни и те же rate_limits,
  // Map дедуплицирует по limitId.
  const snapshotsByLimitId = new Map<string, RuntimeLimitSnapshot>();
  let latestUnknownSnapshot: RuntimeLimitSnapshot | null = null;

  for (const line of lines) {
    const entry = parseJsonLine(line);
    if (!entry || readString(entry.type) !== "event_msg") continue;

    const payload = asRecord(entry.payload);
    if (!payload) continue;
    if (readString(payload.type) !== "token_count") continue;

    const snapshot = buildCodexLimitSnapshot(payload.rate_limits, {
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      profileId: input.profileId ?? null,
      checkedAt: toIso(entry.timestamp as string | number | undefined),
      authIdentity: input.authIdentity,
    });
    if (!snapshot) {
      continue;
    }

    // Снапшот без limitId откладывается отдельно: "неизвестный" бакет тоже
    // показываем, но только самый свежий из него.
    const limitId = readSnapshotLimitId(snapshot);
    if (!limitId) {
      latestUnknownSnapshot = input.keepLatestPerLimit
        ? snapshot
        : (latestUnknownSnapshot ?? snapshot);
      // keepLatestPerLimit компенсирует направление потока строк: при обратном
      // скане первым идёт свежее и его не перетирают, при прямом разборе дописки - перетирают.
    } else if (input.keepLatestPerLimit || !snapshotsByLimitId.has(limitId)) {
      snapshotsByLimitId.set(limitId, snapshot);
    }
  }

  const snapshots = [...snapshotsByLimitId.values()];
  if (latestUnknownSnapshot) {
    snapshots.push(latestUnknownSnapshot);
  }
  snapshots.sort(
    (left, right) => parseTimestampMs(right.checkedAt) - parseTimestampMs(left.checkedAt),
  );
  return snapshots;
}

// Метод инкрементального импортёра: вызывающий код хранит пару
// (parsedOffset, pendingTail) с прошлого раза и передаёт её сюда - разбираются
// только дописанные байты, а не весь лог заново.
export async function readCodexSessionLimitSnapshotsFromAppend(input: {
  fileInfo: CodexSessionFileInfo;
  startOffset: number;
  pendingTail?: string | null;
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
  authIdentity?: CodexAuthIdentity | null;
}): Promise<CodexAppendLimitSnapshotsResult> {
  const previousTail = input.pendingTail ?? "";
  const startOffset =
    typeof input.startOffset === "number" && Number.isFinite(input.startOffset)
      ? Math.max(0, Math.trunc(input.startOffset))
      : 0;
  // Новых байт нет (или файл уменьшился при ротации): разбора ноль, offset
  // выравнивается на текущий размер, чтобы следующий заход стартовал корректно.
  if (input.fileInfo.size <= startOffset) {
    return {
      snapshots: [],
      parsedOffset: input.fileInfo.size,
      pendingTail: previousTail,
    };
  }

  try {
    const appended = await readFileRange({
      filePath: input.fileInfo.filePath,
      start: startOffset,
      end: input.fileInfo.size - 1,
    });
    const { lines, pendingTail } = splitAppendedJsonlLines(`${previousTail}${appended}`);
    const authIdentity = input.authIdentity ?? (await getCodexAuthIdentity());
    return {
      snapshots: collectCodexLimitSnapshotsFromLines(lines, {
        runtimeId: input.runtimeId,
        providerId: input.providerId,
        profileId: input.profileId ?? null,
        authIdentity,
        keepLatestPerLimit: true,
      }),
      parsedOffset: input.fileInfo.size,
      pendingTail,
    };
  } catch {
    // Сбой чтения: отдаём прежние offset и хвост. Данные не потеряны - следующий
    // поллинг перечитает тот же диапазон (at-least-once, а не at-most-once).
    return {
      snapshots: [],
      parsedOffset: startOffset,
      pendingTail: previousTail,
    };
  }
}

// Основной читатель снапшотов по всему файлу. Режим скана входит в ключ кэша:
// fast и complete дают разную глубину, и один не должен затенять другой.
export async function readCodexSessionLimitSnapshotsFromFile(
  fileInfo: CodexSessionFileInfo,
  input: {
    runtimeId: string;
    providerId: string;
    profileId?: string | null;
    authIdentity?: CodexAuthIdentity | null;
    fast?: boolean;
  },
): Promise<RuntimeLimitSnapshot[]> {
  const mode = input.fast ? "fast" : "complete";
  const cacheKey = `${mode}|${fileInfo.filePath}|${fileInfo.mtimeMs}|${fileInfo.size}|${input.runtimeId}|${input.providerId}`;
  const cached = sessionLimitSnapshotsCache.get(cacheKey);
  if (cached) {
    return cached.map((snapshot) => applySnapshotProfileId(snapshot, input.profileId));
  }

  const authIdentity = input.authIdentity ?? (await getCodexAuthIdentity());
  const lines: string[] = [];

  try {
    for await (const line of readJsonlLinesNewestFirst(fileInfo)) {
      lines.push(line);

      const entry = parseJsonLine(line);
      const payload =
        entry && readString(entry.type) === "event_msg" ? asRecord(entry.payload) : null;
      const snapshot =
        payload && readString(payload.type) === "token_count"
          ? buildCodexLimitSnapshot(payload.rate_limits, {
              runtimeId: input.runtimeId,
              providerId: input.providerId,
              profileId: input.profileId ?? null,
              checkedAt: toIso(entry?.timestamp as string | number | undefined),
              authIdentity,
            })
          : null;
      // fast mode: генератор отдаёт строки от свежих, поэтому первый найденный
      // token_count и есть ответ - чтение файла прекращается.
      if (input.fast && snapshot) {
        break;
      }
    }
  } catch {
    return [];
  }

  const snapshots = collectCodexLimitSnapshotsFromLines(lines, {
    runtimeId: input.runtimeId,
    providerId: input.providerId,
    profileId: input.profileId ?? null,
    authIdentity,
    keepLatestPerLimit: false,
  });
  // В кэш кладём profileId: null: смысл снапшота от профиля не зависит, а
  // profileId проставляется на выдаче - так профили разделяют одну запись.
  const normalizedSnapshots = snapshots.map((snapshot) => ({ ...snapshot, profileId: null }));
  sessionLimitSnapshotsCache.set(cacheKey, normalizedSnapshots);
  return normalizedSnapshots.map((snapshot) => applySnapshotProfileId(snapshot, input.profileId));
}

export async function readLatestCodexSessionLimitSnapshotFromFile(input: {
  fileInfo: CodexSessionFileInfo;
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
  authIdentity?: CodexAuthIdentity | null;
}): Promise<RuntimeLimitSnapshot | null> {
  const snapshots = await readCodexSessionLimitSnapshotsFromFile(input.fileInfo, {
    runtimeId: input.runtimeId,
    providerId: input.providerId,
    profileId: input.profileId ?? null,
    authIdentity: input.authIdentity ?? null,
    fast: true,
  });
  return snapshots[0] ?? null;
}

async function getCodexSessionLimitSnapshots(input: {
  sessionId: string;
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
}): Promise<RuntimeLimitSnapshot[]> {
  const fileInfo = await findSessionFileInfoById(input.sessionId);
  if (!fileInfo) {
    return [];
  }

  return await readCodexSessionLimitSnapshotsFromFile(fileInfo, input);
}

export async function listLatestCodexLimitSnapshots(input: {
  runtimeId: string;
  providerId: string;
  projectRoot?: string | null;
  profileId?: string | null;
}): Promise<RuntimeLimitSnapshot[]> {
  const normalizedProjectRoot = normalizePath(input.projectRoot ?? undefined);
  // Кэш на уровне результата: базовый скан обходит до N файлов сессий на каждый
  // вызов; хранение агрегированного результата бережёт диск от повторных поллов API.
  // Ключ кэша намеренно без profileId, чтобы параллельные профили делили его;
  // profileId применяется ниже через applySnapshotProfileId.
  const cacheKey = `${input.runtimeId}|${input.providerId}|${normalizedProjectRoot ?? "__global__"}`;
  const cached = latestLimitSnapshotsCache.get(cacheKey);
  if (cached) {
    return cached.map((snapshot) => applySnapshotProfileId(snapshot, input.profileId));
  }
  const sessionFiles = await listSessionFileInfos(SESSIONS_DIR);
  // Файлы уже отсортированы "сначала новые", поэтому для актуального лимита
  // достаточно первых LIMIT_SNAPSHOT_SESSION_SCAN_LIMIT подходящих.
  const candidates: CodexSessionFileInfo[] = [];
  for (const fileInfo of sessionFiles) {
    if (normalizedProjectRoot) {
      const session = await readSessionMetaFromFile(fileInfo);
      if (!session || normalizePath(session.cwd) !== normalizedProjectRoot) {
        continue;
      }
    }
    candidates.push(fileInfo);
    if (candidates.length >= LIMIT_SNAPSHOT_SESSION_SCAN_LIMIT) {
      break;
    }
  }
  // Rate limits — point-in-time данные в свежих событиях token_count, поэтому сканируем
  // только самые новые подходящие файлы вместо гидратации всех метаданных сессий.
  const latestSnapshotsByLimitId = new Map<string, RuntimeLimitSnapshot>();
  let latestUnknownSnapshot: RuntimeLimitSnapshot | null = null;
  const authIdentity = await getCodexAuthIdentity();

  for (const fileInfo of candidates) {
    const snapshots = await readCodexSessionLimitSnapshotsFromFile(fileInfo, {
      runtimeId: input.runtimeId,
      providerId: input.providerId,
      profileId: input.profileId ?? null,
      authIdentity,
      fast: true,
    });
    for (const snapshot of snapshots) {
      const limitId = readSnapshotLimitId(snapshot);
      if (!limitId) {
        latestUnknownSnapshot ??= snapshot;
        continue;
      }
      if (!latestSnapshotsByLimitId.has(limitId)) {
        latestSnapshotsByLimitId.set(limitId, snapshot);
      }
    }
  }

  const latestSnapshots = [...latestSnapshotsByLimitId.values()];
  if (latestUnknownSnapshot) {
    latestSnapshots.push(latestUnknownSnapshot);
  }
  latestSnapshots.sort(
    (left, right) => parseTimestampMs(right.checkedAt) - parseTimestampMs(left.checkedAt),
  );
  const normalizedSnapshots = latestSnapshots.map((snapshot) => ({ ...snapshot, profileId: null }));
  latestLimitSnapshotsCache.set(cacheKey, normalizedSnapshots);
  return normalizedSnapshots.map((snapshot) => applySnapshotProfileId(snapshot, input.profileId));
}

// Выбор одного бакета из нескольких: явные варианты (со своим limitId) ценнее
// "неизвестных", а ??-цепочки ниже и есть документированный список приоритетов.
export function selectPreferredCodexLimitSnapshot(input: {
  model?: string | null;
  snapshots: RuntimeLimitSnapshot[];
  preferredLimitId?: string | null;
}): RuntimeLimitSnapshot | null {
  if (input.snapshots.length === 0) {
    return null;
  }

  const orderedSnapshots = [...input.snapshots].sort(
    (left, right) => parseTimestampMs(right.checkedAt) - parseTimestampMs(left.checkedAt),
  );
  const explicitSnapshots = orderedSnapshots.filter(
    (snapshot) => readSnapshotLimitId(snapshot) != null,
  );
  const preferredLimitId = input.preferredLimitId?.trim() || null;
  const defaultSnapshot =
    explicitSnapshots.find(
      (snapshot) => readSnapshotLimitId(snapshot) === DEFAULT_CODEX_LIMIT_ID,
    ) ?? null;
  const preferredSnapshot =
    explicitSnapshots.find((snapshot) => readSnapshotLimitId(snapshot) === preferredLimitId) ??
    null;
  const alternateSnapshot =
    explicitSnapshots.find(
      (snapshot) => readSnapshotLimitId(snapshot) !== DEFAULT_CODEX_LIMIT_ID,
    ) ?? null;

  // Spark обслуживается отдельным бакетом rate limit, поэтому для него приоритет
  // отдан снапшотам не из дефолтного бакета; для обычных моделей наоборот -
  // дефолтный надёжнее прочих.
  if (isSparkCodexModel(input.model)) {
    return alternateSnapshot ?? preferredSnapshot ?? defaultSnapshot ?? orderedSnapshots[0] ?? null;
  }

  return (
    defaultSnapshot ?? preferredSnapshot ?? explicitSnapshots[0] ?? orderedSnapshots[0] ?? null
  );
}

// Обход идёт по файлам от новых к старым, поэтому первая сессия с нужной моделью
// и её самым свежим снапшотом закрывает поиск.
export async function getLatestCodexModelLimitSnapshot(input: {
  runtimeId: string;
  providerId: string;
  model?: string | null;
  projectRoot?: string | null;
  profileId?: string | null;
}): Promise<RuntimeLimitSnapshot | null> {
  const targetModel = normalizeModelIdentifier(input.model ?? null);
  if (!targetModel) {
    return null;
  }

  const normalizedProjectRoot = normalizePath(input.projectRoot ?? undefined);
  const sessionFiles = await listSessionFileInfos(SESSIONS_DIR);

  for (const fileInfo of sessionFiles) {
    const session = await readSessionMetaFromFile(fileInfo);
    if (!session) {
      continue;
    }
    if (normalizedProjectRoot && normalizePath(session.cwd) !== normalizedProjectRoot) {
      continue;
    }
    if (normalizeModelIdentifier(session.model ?? null) !== targetModel) {
      continue;
    }

    // Индексный доступ к массиву на пустом массиве даёт undefined, поэтому
    // проверка if (snapshot) ниже обязательна по смыслу, а не только для типов.
    const snapshot = (
      await readCodexSessionLimitSnapshotsFromFile(fileInfo, {
        runtimeId: input.runtimeId,
        providerId: input.providerId,
        profileId: input.profileId ?? null,
        fast: true,
      })
    )[0];
    if (snapshot) {
      return snapshot;
    }
  }

  return null;
}
