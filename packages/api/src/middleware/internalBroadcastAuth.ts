/**
 * Аутентификация служебных broadcast-вызовов между процессами по общему секрету
 * INTERNAL_BROADCAST_TOKEN.
 *
 * Зачем отдельный механизм: эти вызовы идут без cookie пользователя, поэтому
 * обычная сессионная авторизация к ним неприменима. Секрет сверяется сравнением
 * постоянного времени, а незаполненная переменная окружения (кроме тестов)
 * означает отказ, иначе забытая настройка открыла бы служебные маршруты всем.
 */
import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getEnv, logger } from "@aif/shared";

const log = logger("internal-broadcast-auth");

// Основной способ - заголовок x-internal-broadcast-token, но принимается и
// стандартный Authorization: Bearer, чтобы вызывающей стороне было проще.
function extractBearerToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  // Схема сравнивается без учета регистра: HTTP-клиенты пишут ее по-разному.
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

// Сравнение постоянного времени: обычное === раскрывает по времени ответа
// длину совпавшего префикса и позволяет подбирать секрет побайтово.
function tokensMatch(candidate: string | null, configured: string): boolean {
  if (!candidate) return false;
  const candidateBuffer = Buffer.from(candidate, "utf8");
  const configuredBuffer = Buffer.from(configured, "utf8");
  return (
    // Длину проверяем заранее: timingSafeEqual выбрасывает исключение
    // при несовпадении размеров буферов.
    candidateBuffer.length === configuredBuffer.length &&
    timingSafeEqual(candidateBuffer, configuredBuffer)
  );
}

function resolveBroadcastAuthDecision(c: Context): {
  trusted: boolean;
  mode: "token" | "test_bypass" | "rejected";
  tokenConfigured: boolean;
} {
  // Пустая строка означает "секрет не настроен", а не "подходит любой" запрос.
  const configuredToken = getEnv().INTERNAL_BROADCAST_TOKEN?.trim() ?? "";
  const headerToken =
    c.req.header("x-internal-broadcast-token") ?? extractBearerToken(c.req.header("authorization"));

  if (configuredToken) {
    return {
      trusted: tokensMatch(headerToken, configuredToken),
      mode: "token",
      tokenConfigured: true,
    };
  }

  // В тестах секрет обычно не задают, поэтому разрешен явный обход; в любом
  // другом окружении отсутствие секрета приводит к отказу ниже.
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase() ?? "";
  if (nodeEnv === "test") {
    return {
      trusted: true,
      mode: "test_bypass",
      tokenConfigured: false,
    };
  }

  return {
    trusted: false,
    mode: "rejected",
    tokenConfigured: false,
  };
}

// Логируются и отказы, и успешные вызовы: по записи видно, ждали ли токен
// вообще, и это единственный способ отличить "не настроен" от "неверный".
export async function internalBroadcastAuth(c: Context, next: () => Promise<void>) {
  const decision = resolveBroadcastAuthDecision(c);
  if (!decision.trusted) {
    log.warn(
      {
        authMode: decision.mode,
        tokenConfigured: decision.tokenConfigured,
        nodeEnv: process.env.NODE_ENV ?? null,
        path: c.req.path,
      },
      "Rejected unauthorized internal broadcast request",
    );
    return c.json({ error: "Unauthorized broadcast caller" }, 401);
  }

  log.debug({ authMode: decision.mode, path: c.req.path }, "Authorized internal broadcast request");
  await next();
}
