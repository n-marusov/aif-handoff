/**
 * Авторизация по ролям для участникового режима: проверка наличия сессии,
 * проверка роли admin и централизованная таблица "админских" маршрутов.
 *
 * Зачем таблица в одном месте: проверки, размазанные по роутам, легко забыть
 * при добавлении нового маршрута. Здесь решение принимается по методу и пути
 * в единственной функции isAdminOnlyRoute.
 * В одиночном режиме и для доверенных внутренних вызовов роли не проверяются:
 * там нет пользователя, чью роль можно было бы сопоставить.
 */
import type { MiddlewareHandler } from "hono";
import { logger, type ParticipantRole } from "@aif/shared";
import { getParticipantAuth, type ParticipantApiEnv } from "./participantAuth.js";

const log = logger("participant-authorization");

// Минимальный guard: достаточно любой живой сессии, роль не важна.
export function requireParticipant(): MiddlewareHandler<ParticipantApiEnv> {
  return async (c, next) => {
    const auth = getParticipantAuth(c);
    // В одиночном режиме и для доверенных внутренних вызовов Guard не применяется.
    if (auth.mode === "disabled" || auth.mode === "internal") {
      await next();
      return;
    }
    // Контекст без сессии - это анонимный запрос: отвечаем 401 без деталей.
    if (!auth.session) {
      log.warn({ method: c.req.method, path: c.req.path }, "Participant session required");
      return c.json({ error: "Authentication required", code: "authentication_required" }, 401);
    }
    await next();
  };
}

// Админский guard. Сравнение строгое: иерархии ролей здесь нет, поэтому
// участник с ролью member проверку на admin не проходит.
export function requireRole(role: ParticipantRole): MiddlewareHandler<ParticipantApiEnv> {
  return async (c, next) => {
    const auth = getParticipantAuth(c);
    // Роль проверяется только там, где есть субъект: одиночный режим
    // и внутренние вызовы агента проходят мимо.
    if (auth.mode === "disabled" || auth.mode === "internal") {
      await next();
      return;
    }
    // Сначала наличие сессии, затем роль: без субъекта сравнивать нечего.
    if (!auth.session) {
      log.warn({ method: c.req.method, path: c.req.path }, "Participant session required");
      return c.json({ error: "Authentication required", code: "authentication_required" }, 401);
    }
    if (auth.session.participant.role !== role) {
      log.warn(
        {
          participantId: auth.session.participant.id,
          requiredRole: role,
          actualRole: auth.session.participant.role,
          method: c.req.method,
          path: c.req.path,
        },
        "Rejected participant authorization",
      );
      return c.json({ error: "Insufficient permissions", code: "forbidden" }, 403);
    }
    await next();
  };
}

// Единая точка правды о том, какие маршруты доступны только администратору.
// Решение здесь, а не в разметке роутов, читается целиком и не дублируется.
export function isAdminOnlyRoute(method: string, path: string): boolean {
  // Чтение состояния открыто любому участнику, изменение - только админу,
  // поэтому метод влияет на решение для части путей ниже.
  const unsafe = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  // Управление участниками - админская область при любом методе.
  if (path.startsWith("/participants")) return true;
  // Вход в Codex требует прав администратора, кроме безобидного чтения возможностей.
  if (path.startsWith("/auth/codex") && path !== "/auth/codex/capabilities") return true;
  if (unsafe && path.startsWith("/projects")) {
    // Исключение для broadcast: его инициирует агент от имени системы,
    // а не человек, поэтому маршрут остается доступен обычному участнику.
    return !/^\/projects\/[^/]+\/broadcast$/.test(path);
  }
  if (unsafe && path.startsWith("/settings")) return true;
  if (unsafe && path.startsWith("/runtime-profiles")) return true;
  // Удаление задач и сообщений необратимо, поэтому ограничено администратором.
  if (method === "DELETE" && (path.startsWith("/tasks/") || path.startsWith("/chat/"))) {
    return true;
  }
  return false;
}

// Составной guard: выбирает между member и admin проверкой до обработчика,
// чтобы сами роуты оставались без разметки прав.
export function participantRouteAuthorization(): MiddlewareHandler<ParticipantApiEnv> {
  // Guard-ы создаются один раз при сборке middleware, а не на каждый запрос.
  const memberGuard = requireParticipant();
  const adminGuard = requireRole("admin");
  return async (c, next) => {
    // Публичные и preflight-запросы пропускаются здесь, иначе белый список
    // пришлось бы дублировать в каждом вложенном guard-е.
    if (
      c.req.method === "OPTIONS" ||
      (c.req.method === "GET" && (c.req.path === "/health" || c.req.path === "/auth/session")) ||
      (c.req.method === "POST" && c.req.path === "/auth/login")
    ) {
      await next();
      return;
    }
    // Админская проверка заменяет участниковую, а не дополняет ее.
    if (isAdminOnlyRoute(c.req.method, c.req.path)) {
      return adminGuard(c, next);
    }
    return memberGuard(c, next);
  };
}
