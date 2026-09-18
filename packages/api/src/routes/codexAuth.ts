/**
 * Маршруты аутентификации Codex - тонкий прокси к брокеру входа в агенте.
 *
 * Почему именно так:
 * - Процесс входа (OAuth device flow) живет в процессе агента: только он владеет файловой
 *   системой рантайма и хранилищем токенов. API не хранит состояние входа и не пишет токены,
 *   поэтому здесь нет ни обращений к БД, ни кэша - только пересылка запросов.
 * - При сетевом сбое тело ответа брокера недоступно, поэтому возвращается синтетический 502
 *   с кодом broker_unreachable. Клиент обязан отличать "брокер недоступен" от "вход
 *   отклонен", иначе UI предлагал бы повторный вход при просто недоступном агенте.
 * - HTTP-статусы брокера транслируются без подмены (в том числе 409 "вход уже запущен"):
 *   на них опирается UI, чтобы не плодить параллельные попытки входа.
 */
import { Hono } from "hono";
import { getEnv, logger } from "@aif/shared";

// Префикс в имени логгера позволяет отфильтровать сообщения маршрута в общем потоке API.
const log = logger("api:codex-auth");

// Роутер подключается в общем API под префиксом /codex (см. routes/index.ts).
export const codexAuthRouter = new Hono();

/**
 * Базовый адрес внутреннего HTTP-API агента.
 * Хвостовой слэш срезается намеренно: склейка с путем вида "/codex/..." дала бы двойной
 * слэш, а его нормализация у разных HTTP-клиентов и прокси ведет себя непредсказуемо.
 */
function brokerBaseUrl(): string {
  const env = getEnv();
  return env.AGENT_INTERNAL_URL.replace(/\/$/, "");
}

/**
 * Универсальная пересылка запроса в брокер входа агента.
 * Сетевые ошибки не выбрасываются наружу, а превращаются в пару status/body: вызывающие
 * обработчики в любом случае возвращают JSON клиенту и не различают исключения транспорта.
 */
async function proxy(
  method: "GET" | "POST",
  path: string,
): Promise<{ status: number; body: unknown }> {
  const target = `${brokerBaseUrl()}${path}`;
  // Debug, а не info: статус входа опрашивается UI регулярно и засорил бы журнал.
  log.debug({ method, target }, "[CodexAuth.proxy] forwarding");
  try {
    // Тело запроса не передается: брокеру достаточно метода, все параметры входа уже у него.
    const res = await fetch(target, { method });
    // Пустое или не-JSON тело - нормальный случай для части ответов брокера. Подстановка {}
    // сохраняет форму ответа и не превращает корректный статус в исключение парсинга.
    const data: unknown = await res.json().catch(() => ({}));
    log.debug({ status: res.status, target }, "[CodexAuth.proxy] response");
    return { status: res.status, body: data };
  } catch (err) {
    // 502, а не 500: сбой на стороне вышестоящего сервиса (агента), API лишь шлюз.
    log.error({ err, target }, "[CodexAuth.proxy] broker unreachable");
    return {
      status: 502,
      body: { error: "broker_unreachable", message: String(err) },
    };
  }
}

// GET /codex/login/status - опрос состояния входа; UI вызывает его периодически.
codexAuthRouter.get("/login/status", async (c) => {
  log.debug("[CodexAuth.status] enter");
  const { status, body } = await proxy("GET", "/codex/login/status");
  // Приведение сужает типы до фактически возможных ответов прокси (иначе TS не пропустит
  // динамический статус в c.json), логика ветвления остается на стороне брокера.
  return c.json(body as object, status as 200 | 502);
});

// POST /codex/login/start - инициирует device flow и возвращает данные для входа.
codexAuthRouter.post("/login/start", async (c) => {
  log.debug("[CodexAuth.start] enter");
  const { status, body } = await proxy("POST", "/codex/login/start");
  // 409 - вход уже запущен, 500 - ошибка брокера: клиенту важно различать эти случаи,
  // чтобы не начинать второй параллельный вход и не показывать ложную ошибку.
  return c.json(body as object, status as 200 | 409 | 500 | 502);
});

// POST /codex/login/cancel - отмена незавершенного входа.
codexAuthRouter.post("/login/cancel", async (c) => {
  log.debug("[CodexAuth.cancel] enter");
  const { status, body } = await proxy("POST", "/codex/login/cancel");
  return c.json(body as object, status as 200 | 502);
});

// GET /codex/capabilities - сообщает UI, включен ли прокси входа, чтобы он не показывал
// кнопку входа там, где фича выключена флагом AIF_ENABLE_CODEX_LOGIN_PROXY.
codexAuthRouter.get("/capabilities", (c) => {
  const env = getEnv();
  return c.json({ loginProxyEnabled: env.AIF_ENABLE_CODEX_LOGIN_PROXY });
});
