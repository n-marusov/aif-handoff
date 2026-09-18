/**
 * Аутентификация участников: превращает cookie сессии во внутренний контекст
 * запроса (ParticipantAuthContext) для guard-ов и обработчиков ниже по цепочке.
 *
 * Зачем три режима: при выключенном PARTICIPANTS_MODE_ENABLED сервер работает
 * как локальный инструмент без входа; доверенные внутренние вызовы агента
 * опознаются по секрету вместо cookie; все остальные запросы обязаны иметь
 * валидную сессию, кроме короткого белого списка публичных путей.
 * Middleware выставляет контекст в любом случае: читатели ниже не проверяют его
 * на undefined, и этот инвариант держится только здесь.
 */
import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { resolveParticipantSession, type ResolvedParticipantSession } from "@aif/data";
import { getEnv, logger } from "@aif/shared";

const log = logger("participant-auth");

// Контекст фиксируется даже для анонимного запроса: пустые session и
// sessionToken означают "не аутентифицирован", а не "проверка не выполнялась".
export interface ParticipantAuthContext {
  mode: "disabled" | "participant" | "internal";
  session: ResolvedParticipantSession | null;
  sessionToken: string | null;
}

export interface ParticipantApiEnv {
  Variables: {
    participantAuth: ParticipantAuthContext;
  };
}

// Сравнение постоянного времени - то же правило, что и в internalBroadcastAuth,
// чтобы секрет нельзя было подобрать по времени ответа.
function tokensMatch(candidate: string | null, configured: string): boolean {
  if (!candidate) return false;
  const candidateBuffer = Buffer.from(candidate, "utf8");
  const configuredBuffer = Buffer.from(configured, "utf8");
  return (
    candidateBuffer.length === configuredBuffer.length &&
    timingSafeEqual(candidateBuffer, configuredBuffer)
  );
}

// Принимается только схема Bearer: голый токен в Authorization не поддерживается.
function bearerToken(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}

// Закрытый список служебных маршрутов, куда ходит агент. Путь ограничен
// намеренно: иначе утечка секрета открывала бы весь API, включая правку данных.
function isTrustedInternalPath(method: string, path: string): boolean {
  // Только POST: внутренний обход нужен для изменений, для чтения он лишний.
  if (method !== "POST") return false;
  return (
    /^\/tasks\/[^/]+\/broadcast$/.test(path) ||
    /^\/projects\/[^/]+\/broadcast$/.test(path) ||
    /^\/projects\/[^/]+\/github\/sync$/.test(path) ||
    /^\/projects\/[^/]+\/github\/tasks\/[^/]+\/publish$/.test(path) ||
    /^\/projects\/[^/]+\/gitlab\/sync$/.test(path) ||
    /^\/projects\/[^/]+\/gitlab\/tasks\/[^/]+\/publish$/.test(path)
  );
}

// Минимальный белый список: проверка живости, чтение текущей сессии и вход.
// Все остальное без сессии получает 401.
function isPublicParticipantPath(method: string, path: string): boolean {
  return (
    method === "OPTIONS" ||
    (method === "GET" && path === "/health") ||
    (method === "GET" && path === "/auth/session") ||
    (method === "POST" && path === "/auth/login")
  );
}

// Незаполненный секрет выключает обход целиком: так забытая переменная
// окружения не открывает служебные маршруты.
function hasTrustedInternalToken(c: Context): boolean {
  const configured = getEnv().INTERNAL_BROADCAST_TOKEN?.trim() ?? "";
  if (!configured) return false;
  const candidate =
    c.req.header("x-internal-broadcast-token") ?? bearerToken(c.req.header("authorization"));
  return tokensMatch(candidate, configured);
}

// Читатель без проверки на undefined: контекст обязан быть выставлен
// middleware выше, и он выполняется до любого обработчика.
export function getParticipantAuth(c: Context<ParticipantApiEnv>): ParticipantAuthContext {
  return c.get("participantAuth");
}

export function createParticipantAuthMiddleware(): MiddlewareHandler<ParticipantApiEnv> {
  return async (c, next) => {
    const env = getEnv();
    // Одиночный режим: сервер для одного человека, вход не требуется.
    if (!env.PARTICIPANTS_MODE_ENABLED) {
      c.set("participantAuth", {
        mode: "disabled",
        session: null,
        sessionToken: null,
      });
      await next();
      return;
    }

    // Нужны оба условия: подходящий путь и валидный секрет. Одного совпадения
    // пути мало, иначе любой клиент выдал бы себя за агента.
    if (isTrustedInternalPath(c.req.method, c.req.path) && hasTrustedInternalToken(c)) {
      c.set("participantAuth", {
        mode: "internal",
        session: null,
        sessionToken: null,
      });
      log.debug({ path: c.req.path }, "Authorized participant middleware internal bypass");
      await next();
      return;
    }

    // Сессия лежит в HttpOnly cookie, поэтому JS на странице ее не видит.
    // Отсутствие cookie - штатная ситуация анонимного запроса, а не ошибка.
    const token = getCookie(c, env.PARTICIPANT_SESSION_COOKIE_NAME) ?? null;
    if (token) {
      try {
        // Мог вернуться null: сессия протухла или отозвана. Тогда запрос
        // пойдет дальше как анонимный и получит 401.
        const session = resolveParticipantSession(token);
        if (session) {
          c.set("participantAuth", {
            mode: "participant",
            session,
            sessionToken: token,
          });
          log.debug(
            {
              participantId: session.participant.id,
              sessionId: session.id,
              path: c.req.path,
            },
            "Resolved participant request session",
          );
          await next();
          return;
        }
      } catch (error) {
        // Ошибка хранилища - это 500, а не 401: иначе временный сбой БД
        // массово выкидывал бы пользователей из сессии.
        log.error({ error, path: c.req.path }, "Participant auth store failed");
        return c.json(
          { error: "Authentication service unavailable", code: "auth_store_error" },
          500,
        );
      }
    }

    // Контекст анонимного участника: решение о допуске принимают guard-ы ниже.
    c.set("participantAuth", {
      mode: "participant",
      session: null,
      sessionToken: null,
    });
    // Публичные пути получают тот же контекст, что и защищенные: обработчики
    // не должны различать "middleware не вызывался" и "сессии нет".
    if (isPublicParticipantPath(c.req.method, c.req.path)) {
      await next();
      return;
    }

    log.warn({ method: c.req.method, path: c.req.path }, "Rejected unauthenticated request");
    return c.json({ error: "Authentication required", code: "authentication_required" }, 401);
  };
}

export const participantAuth = createParticipantAuthMiddleware();
