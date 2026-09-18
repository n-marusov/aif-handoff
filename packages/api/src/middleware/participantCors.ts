/**
 * CORS для браузерной панели. Правила зависят от режима участников.
 *
 * Зачем две ветки: в одиночном режиме cookie не используются и хватает одного
 * origin из CORS_ORIGIN. В режиме участников запросы идут с cookie, а браузер
 * запрещает сочетать credentials с подстановочным "*": origin обязан быть
 * выбран из белого списка, иначе ответ будет отклонен на стороне клиента.
 */
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import { getEnv } from "@aif/shared";

export function participantCors(): MiddlewareHandler {
  const env = getEnv();
  // Одиночный режим: один известный origin, credentials не нужны.
  if (!env.PARTICIPANTS_MODE_ENABLED) {
    return cors({
      origin: process.env.CORS_ORIGIN || "http://localhost:5180",
    });
  }

  // Set ради O(1) проверки: колбэк вызывается на каждый CORS-запрос, включая preflight.
  const allowedOrigins = new Set(env.PARTICIPANT_ALLOWED_ORIGINS);
  return cors({
    // null означает "заголовок не выставлять": браузер сам отклонит ответ,
    // поэтому отдельной обработки отказа не требуется.
    origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
    // Cookie сессии передаются только при credentials и точном origin.
    credentials: true,
    // Без X-CSRF-Token в списке preflight заблокировал бы сам CSRF-заголовок.
    allowHeaders: ["Content-Type", "X-CSRF-Token"],
    allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
}
