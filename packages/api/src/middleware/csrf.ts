/**
 * CSRF-защита участниковых запросов по схеме double-submit: браузер обязан
 * прислать Origin из белого списка и заголовок x-csrf-token, привязанный
 * к серверной сессии.
 *
 * Зачем два условия: проверка Origin отсекает чужие сайты, но ничего не
 * говорит о намерении клиента, а токен подтверждает, что действие инициировано
 * нашей страницей с живой сессией. Порядок тоже важен: сначала дешевая проверка
 * заголовка Origin, и только затем обращение к хранилищу сессий.
 */
import type { MiddlewareHandler } from "hono";
import { verifyParticipantSessionCsrf } from "@aif/data";
import { getEnv, logger } from "@aif/shared";
import { getParticipantAuth, type ParticipantApiEnv } from "./participantAuth.js";

const log = logger("participant-csrf");
// Идемпотентные методы не меняют состояние, поэтому CSRF их не касается.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Пропускаем только запись, целиком совпадающую с origin (допускается один
// завершающий слэш); значения с путем или учетными данными отбраковываются.
function normalizedOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.origin === value.replace(/\/$/, "") ? parsed.origin : null;
  } catch {
    return null;
  }
}

function hasAllowedOrigin(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  // Запрос без Origin - не браузерный сценарий, доверять ему нельзя.
  if (!origin) return false;
  const normalized = normalizedOrigin(origin);
  return normalized !== null && allowedOrigins.includes(normalized);
}

// Единственная точка проверки origin: другие модули не должны повторять
// это правило, иначе трактовки разойдутся.
export function participantRequestOriginIsAllowed(input: {
  origin: string | undefined;
  allowedOrigins: readonly string[];
}): boolean {
  return hasAllowedOrigin(input.origin, input.allowedOrigins);
}

// Решения принимаются на каждом запросе, а не при сборке приложения:
// режим и белый список читаются из окружения в момент вызова.
export function participantCsrf(): MiddlewareHandler<ParticipantApiEnv> {
  return async (c, next) => {
    const env = getEnv();
    const auth = getParticipantAuth(c);
    // Три случая пропуска: режим участников выключен, вызов доверенный
    // внутренний либо метод безопасный.
    if (
      !env.PARTICIPANTS_MODE_ENABLED ||
      auth.mode === "disabled" ||
      auth.mode === "internal" ||
      SAFE_METHODS.has(c.req.method)
    ) {
      await next();
      return;
    }

    // Origin проверяется до обращения к сессии: чужие сайты отсекаются
    // еще до похода в хранилище.
    const origin = c.req.header("origin");
    if (
      !participantRequestOriginIsAllowed({
        origin,
        allowedOrigins: env.PARTICIPANT_ALLOWED_ORIGINS,
      })
    ) {
      log.warn(
        { method: c.req.method, path: c.req.path, hasOrigin: Boolean(origin) },
        "Rejected participant request origin",
      );
      return c.json({ error: "Invalid request origin", code: "invalid_origin" }, 403);
    }

    // Логин - единственный небезопасный маршрут без сессии: токена еще нет,
    // и защитой служит только что проверенный Origin.
    if (c.req.path === "/auth/login") {
      await next();
      return;
    }

    // Дальше нужна живая сессия: без нее привязывать токен не к чему.
    if (!auth.session || !auth.sessionToken) {
      log.warn({ method: c.req.method, path: c.req.path }, "Rejected CSRF without session");
      return c.json({ error: "Authentication required", code: "authentication_required" }, 401);
    }

    // Токен приходит в кастомном заголовке: сторонний сайт не может его
    // добавить без успешного preflight, который уже отсек Origin.
    const csrfToken = c.req.header("x-csrf-token");
    // Итог хранится отдельно, потому что сбой хранилища и неверный токен
    // требуют разных ответов клиенту.
    let csrfIsValid = false;
    try {
      csrfIsValid = Boolean(
        csrfToken && verifyParticipantSessionCsrf(auth.sessionToken, csrfToken),
      );
    } catch (error) {
      // Сбой хранилища - это 500, а не 403: клиент не должен считать сессию
      // скомпрометированной из-за временной ошибки БД.
      log.error(
        {
          error,
          participantId: auth.session.participant.id,
          sessionId: auth.session.id,
          path: c.req.path,
        },
        "Participant CSRF store failed",
      );
      return c.json({ error: "Authentication service unavailable", code: "auth_store_error" }, 500);
    }
    // Сессия валидна, но подтверждение отсутствует: отвечаем 403, чтобы
    // клиент запросил новый токен, а не перелогинивался.
    if (!csrfIsValid) {
      log.warn(
        {
          participantId: auth.session.participant.id,
          sessionId: auth.session.id,
          method: c.req.method,
          path: c.req.path,
        },
        "Rejected participant CSRF token",
      );
      return c.json({ error: "Invalid CSRF token", code: "invalid_csrf" }, 403);
    }

    await next();
  };
}
