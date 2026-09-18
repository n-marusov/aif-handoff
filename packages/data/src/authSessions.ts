/**
 * Пароли, сессии и CSRF-защита участников.
 *
 * Модуль изолирует всю криптографию в одном месте и отдаёт остальным пакетам только
 * готовые примитивы: захешировать пароль, проверить его, выпустить или погасить
 * сессию, убедиться в подлинности CSRF-токена.
 *
 * В базу никогда не пишутся сами токены - только их SHA-256-дайджесты. Поэтому утечка
 * содержимого таблицы не позволяет выдать себя за пользователя: предъявить нужно
 * исходный токен, которого в базе нет.
 *
 * Импорт node:crypto намеренно локальный: криптографические операции не должны
 * выполняться вне этого слоя, иначе появятся альтернативные реализации проверки
 * пароля или подписи сессии.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import {
  logger,
  participantSessions,
  participants,
  type ParticipantSummary,
} from "@aif/shared";
import { getDb } from "@aif/shared/server";

const log = logger("data:auth-sessions");
// Идентификатор схемы хранения хеша. Вынесен в отдельное поле формата, чтобы в
// будущем можно было добавить новую схему и различать записи без миграции данных.
const PASSWORD_HASH_SCHEME = "aif-scrypt";
// Версия формата хеша. Старые хеши с другой версией считаются невалидными и
// требуют перевыпуска пароля.
const PASSWORD_HASH_VERSION = 1;
// Длина производного ключа и соли. Соль длиннее 16 байт излишня для scrypt,
// но 16 достаточно, чтобы исключить совпадение солей у разных пользователей.
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_SALT_LENGTH = 16;
// Параметры scrypt. N=16384 даёт заметное замедление перебора, оставаясь
// приемлемым по задержке входа. maxmem поднят до 64 МиБ: узел node по умолчанию
// считает лимит как 128 * N * r, и без явного значения scrypt падал бы с ошибкой.
// Параметры хранятся вместе с хешем, поэтому их изменение не ломает старые записи.
const SCRYPT_PARAMETERS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;
// Контекст вывода CSRF-токена. Служит разделителем предметных областей: если в
// коде появится второй вывод из того же секрета, разные контексты гарантируют,
// что токены одного назначения нельзя использовать вместо другого.
const CSRF_DERIVATION_CONTEXT = "aif-participant-csrf-v1";

// Разобранный хеш пароля. Параметры scrypt хранятся рядом с солью и дайджестом,
// чтобы проверка работала даже после изменения констант выше.
interface ParsedPasswordHash {
  version: number;
  salt: Buffer;
  digest: Buffer;
  N: number;
  r: number;
  p: number;
}

// Полное описание только что выпущенной сессии. Поля token и csrfToken
// отдаются наружу ровно один раз - в момент создания; в БД сохраняются только
// их дайджесты, восстановить из хранилища исходные значения невозможно.
export interface CreatedParticipantSession {
  id: string;
  participant: ParticipantSummary;
  token: string;
  csrfToken: string;
  expiresAt: string;
}

// Сессия, восстановленная по предъявленному токену. CSRF-токен вычисляется
// заново из sessionToken (HMAC с ним в роли ключа), поэтому его не нужно
// хранить в открытом виде нигде, кроме клиента.
export interface ResolvedParticipantSession {
  id: string;
  participant: ParticipantSummary;
  csrfToken: string;
  expiresAt: string;
}

// Результат аутентификации. Единственный код ошибки на все случаи (нет такого
// пользователя, неверный пароль, отключённый аккаунт) выбран осознанно: иначе
// наружу утекало бы существование учётной записи.
export type AuthenticateParticipantResult =
  | { ok: true; session: CreatedParticipantSession }
  | { ok: false; code: "invalid_credentials" };

// base64url без padding удобен для токенов в cookie и заголовках: он не требует
// процентного кодирования и не содержит символов, значимых для URL.
function encodeBase64Url(value: Buffer): string {
  return value.toString("base64url");
}

// Разбор base64url возвращает null вместо исключения: значение приходит из
// недоверенного источника (заголовок cookie), и вызывающий код ожидает проверку
// на null, а не обработку брошенного исключения.
function decodeBase64Url(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

// Фиктивный, но структурно валидный хеш пароля. Нужен, чтобы
// проверка пароля всегда тратила сопоставимое время (см.
// verifyParticipantPasswordOrDummy): без него запрос к несуществующему
// пользователю отвечал бы заметно быстрее и выдавал существование аккаунта.
// Значения соли и дайджеста фиксированы и не совпадают ни с одним реальным.
function createDummyPasswordHash(): string {
  const salt = encodeBase64Url(Buffer.alloc(PASSWORD_SALT_LENGTH, 0xa5));
  const digest = encodeBase64Url(Buffer.alloc(PASSWORD_KEY_LENGTH, 0x5a));
  return `${PASSWORD_HASH_SCHEME}$v=${PASSWORD_HASH_VERSION}$N=${SCRYPT_PARAMETERS.N},r=${SCRYPT_PARAMETERS.r},p=${SCRYPT_PARAMETERS.p}$${salt}$${digest}`;
}

// Вычисляется один раз при загрузке модуля: создание буферов на каждый запрос
// было бы лишней работой на горячем пути входа.
const DUMMY_PASSWORD_HASH = createDummyPasswordHash();

// Асинхронная обёртка над scrypt. Callback-версия выбрана намеренно: она
// подчиняется пулу libuv и не блокирует event loop, в отличие от
// scryptSync, который остановил бы весь сервер на время вычисления.
// maxmem берётся из глобальных параметров, а не из разобранного хеша:
// проверять пользовательский maxmem на безопасность бессмысленно и опасно.
function derivePasswordKey(
  password: string,
  salt: Buffer,
  parameters: Pick<ParsedPasswordHash, "N" | "r" | "p">,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      PASSWORD_KEY_LENGTH,
      {
        N: parameters.N,
        r: parameters.r,
        p: parameters.p,
        maxmem: SCRYPT_PARAMETERS.maxmem,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

// Разбор строки формата scheme$v=..$N=..,r=..,p=..$salt$digest. Функция
// строгая: любое отклонение (неизвестная схема, неподдерживаемая версия,
// некорректные параметры, короткая соль, неправильная длина дайджеста)
// приводит к null. Это защищает от подмены хеша в БД более слабыми
// параметрами scrypt.
function parsePasswordHash(encoded: string): ParsedPasswordHash | null {
  const parts = encoded.split("$");
  if (parts.length !== 5 || parts[0] !== PASSWORD_HASH_SCHEME) return null;
  const version = Number(parts[1]?.replace(/^v=/, ""));
  const parameterEntries = parts[2]?.split(",").map((entry) => entry.split("=")) ?? [];
  const parameterMap = new Map(parameterEntries.map(([key, value]) => [key, Number(value)]));
  // Number("") и Number("abc") дают NaN, поэтому Number.isInteger ниже отсекает
  // и пустые, и нечисловые значения без отдельной проверки.
  const N = parameterMap.get("N");
  const r = parameterMap.get("r");
  const p = parameterMap.get("p");
  const salt = decodeBase64Url(parts[3] ?? "");
  const digest = decodeBase64Url(parts[4] ?? "");
  const parametersAreValid =
    Number.isInteger(N) &&
    Number.isInteger(r) &&
    Number.isInteger(p) &&
    // N > 1 - требование самого scrypt: при N <= 1 он бросает исключение.
    (N ?? 0) > 1 &&
    (r ?? 0) > 0 &&
    (p ?? 0) > 0;

  if (
    version !== PASSWORD_HASH_VERSION ||
    !parametersAreValid ||
    !salt ||
    salt.length < PASSWORD_SALT_LENGTH ||
    !digest ||
    digest.length !== PASSWORD_KEY_LENGTH
  ) {
    return null;
  }

  return {
    version,
    salt,
    digest,
    // Приведения безопасны: parametersAreValid гарантировал, что значения - целые числа.
    N: N as number,
    r: r as number,
    p: p as number,
  };
}

// Дайджест непрозрачного токена для хранения в БД. Обычный SHA-256 без соли тут
// уместен: токен - это 256 бит случайности, а не низкоэнтропийный пароль, так
// что перебор и радужные таблицы к нему неприменимы. Хеш нужен лишь для того,
// чтобы утечка строки таблицы не давала готовый ключ доступа.
function digestOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// CSRF-токен выводится из токена сессии через HMAC (sessionToken здесь - ключ).
// Детерминированность позволяет не хранить CSRF-токен отдельно: сервер всегда
// может пересчитать ожидаемое значение. Привязка к сессии означает, что токен
// одного пользователя бесполезен для другого.
function deriveCsrfToken(sessionToken: string): string {
  return createHmac("sha256", sessionToken)
    .update(CSRF_DERIVATION_CONTEXT, "utf8")
    .digest("base64url");
}

// Явное преобразование строки БД в публичный тип: наружу отдаётся только
// безопасный набор полей, без хеша пароля и служебных колонок.
function participantSummary(
  participant: typeof participants.$inferSelect,
): ParticipantSummary {
  return {
    id: participant.id,
    displayName: participant.displayName,
    role: participant.role,
    active: participant.active,
  };
}

// Нормализация имени до сравнения с колонкой normalizedUsername. Это ключ поиска,
// поэтому правила стабильны и консервативны: NFKC приводит визуально похожие
// юникод-формы к одной (защита от омоглифов), trim убирает случайные пробелы,
// а фиксированная локаль en-US исключает разное поведение toLowerCase на
// разных машинах и локалях сервера.
export function normalizeParticipantUsername(username: string): string {
  return username.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

// Создание нового хеша при смене или задании пароля. Соль генерируется
// криптографическим randomBytes на каждый вызов, поэтому одинаковые пароли
// разных пользователей дают разные хеши.
// В сохранённую строку попадают и параметры scrypt: это позволяет позже
// усилить параметры, не теряя способности проверять старые хеши.
export async function hashParticipantPassword(password: string): Promise<string> {
  log.debug(
    { version: PASSWORD_HASH_VERSION, scheme: PASSWORD_HASH_SCHEME },
    "Hashing participant password",
  );
  const salt = randomBytes(PASSWORD_SALT_LENGTH);

  try {
    const digest = await derivePasswordKey(password, salt, SCRYPT_PARAMETERS);
    log.debug(
      { version: PASSWORD_HASH_VERSION, scheme: PASSWORD_HASH_SCHEME },
      "Participant password hashed",
    );
    return `${PASSWORD_HASH_SCHEME}$v=${PASSWORD_HASH_VERSION}$N=${SCRYPT_PARAMETERS.N},r=${SCRYPT_PARAMETERS.r},p=${SCRYPT_PARAMETERS.p}$${encodeBase64Url(salt)}$${encodeBase64Url(digest)}`;
  } catch (error) {
    log.error(
      { error, version: PASSWORD_HASH_VERSION, scheme: PASSWORD_HASH_SCHEME },
      "Participant password hashing failed",
    );
    throw error;
  }
}

// Проверка пароля по сохранённому хешу. Сравнение дайджестов выполняется
// timingSafeEqual: обычное !== завершилось бы на первом различившемся байте и
// дало бы атакующему тайминг-канал для побайтового подбора.
// Проверка длин перед timingSafeEqual обязательна: функция бросает исключение
// на буферах разного размера.
// Неподдерживаемый или битый хеш даёт false без исключения: такие учётные
// записи считаются невходимыми, а не падающими.
export async function verifyParticipantPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) {
    log.warn(
      { scheme: PASSWORD_HASH_SCHEME },
      "Rejected unsupported participant password hash",
    );
    return false;
  }

  try {
    const candidate = await derivePasswordKey(password, parsed.salt, parsed);
    return candidate.length === parsed.digest.length && timingSafeEqual(candidate, parsed.digest);
  } catch (error) {
    log.error(
      { error, version: parsed.version, scheme: PASSWORD_HASH_SCHEME },
      "Participant password verification failed",
    );
    throw error;
  }
}

// Ключевая защита от перечисления пользователей. Если хеша нет (аккаунт не
// найден), всё равно выполняется полноценный scrypt по фиктивному хешу - время
// ответа для существующего и несуществующего логина совпадает. Возврат всегда
// false при isDummy: фиктивный хеш никогда не должен дать успешную проверку,
// даже если пароль случайно совпал с его содержимым.
export async function verifyParticipantPasswordOrDummy(
  password: string,
  encodedHash: string | null,
): Promise<boolean> {
  const isDummy = encodedHash === null;
  const verified = await verifyParticipantPassword(password, encodedHash ?? DUMMY_PASSWORD_HASH);
  return !isDummy && verified;
}

// Выпуск сессии. Порядок шагов важен: сначала валидируются параметры, потом
// проверяется существование и активность участника, и только затем генерируются
// токены. Так отклонённый запрос не создаёт ничего в базе и не тратит энтропию.
// Токен - 32 случайных байта: этого с запасом хватает против подбора, а в БД
// ложится только его дайджест.
// TTL проверяется на конечность и положительность: отрицательное или NaN
// значение дало бы просроченную или невалидную дату истечения.
export function createParticipantSession(
  participantId: string,
  options: { ttlMs: number; now?: Date },
): CreatedParticipantSession | null {
  const db = getDb();
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + options.ttlMs);
  log.debug({ participantId, ttlMs: options.ttlMs }, "Creating participant session");

  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
    log.warn({ participantId, ttlMs: options.ttlMs }, "Rejected invalid participant session TTL");
    return null;
  }

  const participant = db.select().from(participants).where(eq(participants.id, participantId)).get();
  // Проверка active здесь, а не только при входе: аккаунт могли отключить между
  // аутентификацией и выпуском сессии (или при продлении), и выпускать сессию
  // отключённому участнику нельзя.
  if (!participant?.active) {
    log.warn({ participantId }, "Rejected participant session for missing or inactive account");
    return null;
  }

  const token = randomBytes(32).toString("base64url");
  const csrfToken = deriveCsrfToken(token);
  const id = crypto.randomUUID();

  try {
    db.insert(participantSessions)
      .values({
        id,
        participantId,
        tokenDigest: digestOpaqueToken(token),
        csrfTokenDigest: digestOpaqueToken(csrfToken),
        expiresAt: expiresAt.toISOString(),
        createdAt: now.toISOString(),
      })
      .run();
    log.info({ sessionId: id, participantId }, "Participant session created");
    return {
      id,
      participant: participantSummary(participant),
      token,
      csrfToken,
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    log.error({ error, participantId, sessionId: id }, "Failed to create participant session");
    throw error;
  }
}

// Восстановление сессии по токену. Все проверки собраны в одном SQL-запросе с
// innerJoin к participants: это исключает ситуацию, когда сессия активна, а
// аккаунт уже отключён. Отзыв, истечение срока и активность участника
// проверяются в WHERE, поэтому неактивная сессия неотличима от несуществующей.
// Обновление lastSeenAt - вспомогательная телеметрия: оно намеренно не влияет
// на результат, поэтому не обёрнуто в дополнительную обработку ошибок.
export function resolveParticipantSession(
  token: string,
  now = new Date(),
): ResolvedParticipantSession | null {
  const db = getDb();
  const tokenDigest = digestOpaqueToken(token);
  log.debug({ checkedAt: now.toISOString() }, "Resolving participant session");

  try {
    const result = db
      .select({ session: participantSessions, participant: participants })
      .from(participantSessions)
      .innerJoin(participants, eq(participantSessions.participantId, participants.id))
      .where(
        and(
          eq(participantSessions.tokenDigest, tokenDigest),
          isNull(participantSessions.revokedAt),
          gt(participantSessions.expiresAt, now.toISOString()),
          eq(participants.active, true),
        ),
      )
      .get();

    if (!result) {
      // Уровень debug, а не warn: истёкшие и отозванные токены - нормальный
      // поток (например, вкладка, оставленная открытой на ночь).
      log.debug("Participant session was not active");
      return null;
    }

    db.update(participantSessions)
      .set({ lastSeenAt: now.toISOString() })
      .where(eq(participantSessions.id, result.session.id))
      .run();
    log.debug(
      { sessionId: result.session.id, participantId: result.participant.id },
      "Participant session resolved",
    );
    return {
      id: result.session.id,
      participant: participantSummary(result.participant),
      csrfToken: deriveCsrfToken(token),
      expiresAt: result.session.expiresAt,
    };
  } catch (error) {
    log.error({ error }, "Participant session resolution failed");
    throw error;
  }
}

// Проверка активности по id сессии без предъявления токена. Нужна там, где
// токен уже был проверен раньше (например, при работе через WebSocket):
// позволяет убедиться, что сессию не отозвали с тех пор.
export function isParticipantSessionActive(
  sessionId: string,
  now = new Date(),
): boolean {
  try {
    const session = getDb()
      .select({ id: participantSessions.id })
      .from(participantSessions)
      .innerJoin(participants, eq(participantSessions.participantId, participants.id))
      .where(
        and(
          eq(participantSessions.id, sessionId),
          isNull(participantSessions.revokedAt),
          gt(participantSessions.expiresAt, now.toISOString()),
          eq(participants.active, true),
        ),
      )
      .get();
    return Boolean(session);
  } catch (error) {
    log.error({ error, sessionId }, "Participant session activity check failed");
    throw error;
  }
}

// Проверка CSRF-токена для изменяющих запросов. Сессия ищется по дайджесту
// токена, то есть отозванные и истёкшие сессии автоматически не проходят.
// Сравнение идёт по буферам из hex-строк, а не по строкам: timingSafeEqual
// работает только с бинарными данными, и это же исключает утечку по времени.
// Внешний participant-join здесь не нужен: активность аккаунта уже проверена
// при открытии сессии, а её отключение отзовёт все сессии.
export function verifyParticipantSessionCsrf(
  sessionToken: string,
  csrfToken: string,
  now = new Date(),
): boolean {
  const tokenDigest = digestOpaqueToken(sessionToken);
  const session = getDb()
    .select({
      csrfTokenDigest: participantSessions.csrfTokenDigest,
      expiresAt: participantSessions.expiresAt,
    })
    .from(participantSessions)
    .where(
      and(
        eq(participantSessions.tokenDigest, tokenDigest),
        isNull(participantSessions.revokedAt),
        gt(participantSessions.expiresAt, now.toISOString()),
      ),
    )
    .get();
  if (!session) return false;

  const expectedDigest = Buffer.from(session.csrfTokenDigest, "hex");
  const candidateDigest = Buffer.from(digestOpaqueToken(csrfToken), "hex");
  return (
    expectedDigest.length === candidateDigest.length &&
    timingSafeEqual(expectedDigest, candidateDigest)
  );
}

// Отзыв одной сессии по токену. Условие isNull(revokedAt) делает операцию
// идемпотентной: повторный выход не меняет метку времени первого отзыва, а
// returning() позволяет отличить реальный отзыв от повторного.
export function revokeParticipantSession(token: string, now = new Date()): boolean {
  const revoked = getDb()
    .update(participantSessions)
    .set({ revokedAt: now.toISOString() })
    .where(
      and(
        eq(participantSessions.tokenDigest, digestOpaqueToken(token)),
        isNull(participantSessions.revokedAt),
      ),
    )
    .returning({ id: participantSessions.id, participantId: participantSessions.participantId })
    .get();

  if (!revoked) {
    log.debug("Participant session revoke found no active session");
    return false;
  }
  log.info(
    { sessionId: revoked.id, participantId: revoked.participantId },
    "Participant session revoked",
  );
  return true;
}

// Массовый отзыв всех сессий участника. Используется при смене пароля,
// отключении аккаунта или смене роли: все действующие токены должны стать
// недействительны немедленно, иначе старые клиенты сохранят доступ.
// Одиночный UPDATE вместо выборки и цикла - атомарно и без гонок.
// Возвращается число реально отозванных сессий (result.changes).
export function revokeAllParticipantSessions(
  participantId: string,
  now = new Date(),
): number {
  const result = getDb()
    .update(participantSessions)
    .set({ revokedAt: now.toISOString() })
    .where(
      and(
        eq(participantSessions.participantId, participantId),
        isNull(participantSessions.revokedAt),
      ),
    )
    .run();
  log.info({ participantId, revokedCount: result.changes }, "Participant sessions revoked");
  return result.changes;
}

// Плановая уборка просроченных сессий. Физического удаления нет: revokedAt
// проставляется истёкшим записям, чтобы они были отличимы от отозванных
// вручную, а таблица оставалась неизменяемой по смыслу (аудит).
// Условие lte(expiresAt, now) - сравнение строк ISO-8601, которое корректно
// работает лексикографически для UTC-времени с одинаковым форматом.
export function expireParticipantSessions(now = new Date()): number {
  const result = getDb()
    .update(participantSessions)
    .set({ revokedAt: now.toISOString() })
    .where(
      and(
        isNull(participantSessions.revokedAt),
        lte(participantSessions.expiresAt, now.toISOString()),
      ),
    )
    .run();
  log.info({ expiredCount: result.changes }, "Expired participant sessions");
  return result.changes;
}

// Полный цикл входа: поиск аккаунта по нормализованному имени, проверка пароля
// и выпуск сессии.
// Проверка пароля всегда выполняется до вердикта (даже без найденного
// пользователя) - это постоянное по времени поведение против перечисления
// логинов. Итоговое решение isEligible требует одновременно active и verified,
// но вычисляется оно после проверки, чтобы не создавать ранний выход.
// Наружу в любом случае уходит один и тот же invalid_credentials, без указания,
// что именно не совпало.
export async function authenticateParticipant(
  username: string,
  password: string,
  options: { sessionTtlMs: number; now?: Date },
): Promise<AuthenticateParticipantResult> {
  const normalizedUsername = normalizeParticipantUsername(username);
  const participant = getDb()
    .select()
    .from(participants)
    .where(eq(participants.normalizedUsername, normalizedUsername))
    .get();
  const verified = await verifyParticipantPasswordOrDummy(
    password,
    participant?.passwordHash ?? null,
  );
  const isEligible = Boolean(participant?.active && verified);

  if (!participant || !isEligible) {
    // В логе сохраняется только факт наличия аккаунта, но не причина отказа:
    // лог внутренний и помогает разбирать инциденты, а клиент информации не получает.
    log.warn(
      { participantId: participant?.id ?? null, accountFound: Boolean(participant) },
      "Participant authentication rejected",
    );
    return { ok: false, code: "invalid_credentials" };
  }

  const session = createParticipantSession(participant.id, {
    ttlMs: options.sessionTtlMs,
    now: options.now,
  });
  // Сессия может не создаться (например, аккаунт отключили в момент входа).
  // Для клиента это тот же invalid_credentials: детали не раскрываются.
  if (!session) {
    log.warn({ participantId: participant.id }, "Participant authentication session rejected");
    return { ok: false, code: "invalid_credentials" };
  }

  log.info({ participantId: participant.id, sessionId: session.id }, "Participant authenticated");
  return { ok: true, session };
}
