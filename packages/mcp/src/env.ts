import { logger, getEnv, parseMcpPortSetting } from "@aif/shared";

const log = logger("mcp:env");

export interface McpEnv {
  /** URL API-сервера для WebSocket-рассылки (из общего окружения) */
  apiUrl: string;
  /** Режим транспорта: "stdio" (по умолчанию) или "http" (для Docker / удалённого доступа) */
  transport: "stdio" | "http";
  /** HTTP-порт, когда транспорт "http" */
  httpPort: number;
  /** Лимит частоты: запросов в минуту для инструментов чтения */
  rateLimitReadRpm: number;
  /** Лимит частоты: запросов в минуту для инструментов записи */
  rateLimitWriteRpm: number;
  /** Лимит частоты: размер всплеска для инструментов чтения */
  rateLimitReadBurst: number;
  /** Лимит частоты: размер всплеска для инструментов записи */
  rateLimitWriteBurst: number;
  /**
   * Opt-in флаг stateless-мультисессионного HTTP-транспорта. По умолчанию
   * `false` (legacy односессионное поведение). Установите
   * `AIF_MCP_HTTP_MULTI_SESSION_ENABLED` в 1/true/yes/on, чтобы несколько
   * клиентов (например, несколько окон Claude Code) подключались одновременно
   * к одному `/mcp`-эндпоинту. Актуально только при `transport` = `http`.
   */
  httpMultiSession: boolean;
  /** Включён ли режим участников в приложении. */
  participantsModeEnabled: boolean;
  /** Выделенный bearer-токен для HTTP MCP. Никогда не используется для сессий участников. */
  authToken: string | null;
}

const BOOLEAN_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Разбирает opt-in булев флаг окружения. По умолчанию `false`, если значение не
 * одно из 1/true/yes/on (без учёта регистра) — совпадает с булевой семантикой
 * `@aif/shared`, чтобы поведение было согласованным между пакетами.
 */
function parseBooleanFlag(value: string | undefined): boolean {
  if (!value) return false;
  return BOOLEAN_TRUE_VALUES.has(value.trim().toLowerCase());
}

function resolveMcpPort(value: string | undefined, transport: McpEnv["transport"]): number {
  const parsed = parseMcpPortSetting(value);
  if (parsed.status === "unset") {
    return 3100;
  }

  if (parsed.status === "valid") {
    return parsed.port;
  }

  if (transport === "stdio") {
    log.warn(
      {
        transport,
        invalidValue: parsed.value,
        fallbackPort: 3100,
      },
      "Ignoring invalid MCP_PORT because MCP transport is stdio",
    );
    return 3100;
  }

  throw new Error(`Invalid MCP_PORT: ${parsed.value}. Must be an integer between 1 and 65535.`);
}

/**
 * Загружает конфигурацию окружения MCP.
 * Соединение с БД использует общий getDb() из @aif/shared/server (как у api/agent).
 * API_BASE_URL берётся из общего окружения.
 */
export function loadMcpEnv(): McpEnv {
  const sharedEnv = getEnv();

  const transport = (process.env.MCP_TRANSPORT || "stdio") as "stdio" | "http";
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`Invalid MCP_TRANSPORT: ${transport}. Must be "stdio" or "http".`);
  }

  const env: McpEnv = {
    apiUrl: sharedEnv.API_BASE_URL,
    transport,
    httpPort: resolveMcpPort(process.env.MCP_PORT, transport),
    rateLimitReadRpm: parseInt(process.env.MCP_RATE_LIMIT_READ_RPM || "120", 10),
    rateLimitWriteRpm: parseInt(process.env.MCP_RATE_LIMIT_WRITE_RPM || "30", 10),
    rateLimitReadBurst: parseInt(process.env.MCP_RATE_LIMIT_READ_BURST || "10", 10),
    rateLimitWriteBurst: parseInt(process.env.MCP_RATE_LIMIT_WRITE_BURST || "5", 10),
    httpMultiSession: parseBooleanFlag(process.env.AIF_MCP_HTTP_MULTI_SESSION_ENABLED),
    participantsModeEnabled: Boolean(sharedEnv.PARTICIPANTS_MODE_ENABLED),
    authToken: process.env.MCP_AUTH_TOKEN?.trim() || null,
  };

  if (env.transport === "http" && !env.authToken) {
    log.error({ transport: env.transport }, "MCP HTTP authentication token is required");
    throw new Error("MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http.");
  }

  log.info(
    {
      transport: env.transport,
      httpPort: env.httpPort,
      httpMultiSession: env.httpMultiSession,
      participantsModeEnabled: env.participantsModeEnabled,
      httpAuthRequired: env.transport === "http",
    },
    "MCP environment loaded",
  );

  return env;
}
