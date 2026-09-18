// MCP stdio-транспорт резервирует stdout для JSON-RPC — направляем логи в stderr.
// Этот модуль обязан импортироваться раньше любых модулей, инициализирующих логгер.
if (!process.env.LOG_DESTINATION) {
  process.env.LOG_DESTINATION = "stderr";
}
