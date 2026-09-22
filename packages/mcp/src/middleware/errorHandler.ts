import { logger } from "@aif/shared";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const log = logger("mcp:error");

/**
 * Соотносит ошибки с кодами MCP без парсинга текста сообщения.
 *
 * - McpError пропускается как есть.
 * - Любая иная Error-ошибка считается внутренней.
 * - Невалидные входные параметры должны выбрасываться через `validationError`,
 *   чтобы код InvalidParams был выставлен структурно на месте возникновения.
 */
export function toMcpError(error: unknown): McpError {
  if (error instanceof McpError) {
    return error;
  }

  if (error instanceof Error) {
    log.error({ error: error.message, stack: error.stack }, "Unhandled tool exception");
    return new McpError(ErrorCode.InternalError, error.message);
  }

  log.error({ error: String(error) }, "Unknown error type");
  return new McpError(ErrorCode.InternalError, String(error));
}

/**
 * Создаёт ошибку MCP для лимита частоты.
 */
export function rateLimitError(toolName: string): McpError {
  return new McpError(
    ErrorCode.InvalidRequest,
    `Rate limit exceeded for tool: ${toolName}. Please wait before retrying.`,
  );
}

/**
 * Создаёт ошибку MCP для сбоев валидации с деталями по полям.
 */
export function validationError(message: string, fieldErrors?: Record<string, string[]>): McpError {
  const detail = fieldErrors ? ` Fields: ${JSON.stringify(fieldErrors)}` : "";
  log.error({ message, fieldErrors }, "Validation failure");
  return new McpError(ErrorCode.InvalidParams, `${message}${detail}`);
}
