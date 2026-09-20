// Logging helper shared by all gate validators.
//
// Levels: DEBUG < INFO < WARN < ERROR. The active level comes from the
// LOG_LEVEL environment variable (default INFO). All output goes to stderr so
// that stdout stays reserved for the machine-readable gates report when the
// runner streams it.

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

const activeLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.INFO;

function emit(level, prefix, message) {
  if (LEVELS[level] < activeLevel) return;
  const line = message === undefined ? String(prefix) : `${prefix} ${message}`;
  process.stderr.write(`${level} ${line}\n`);
}

export const log = {
  debug(message) {
    emit("DEBUG", "[gate]", message);
  },
  info(message) {
    emit("INFO", "[gate]", message);
  },
  warn(message) {
    emit("WARN", "[gate]", message);
  },
  error(message) {
    emit("ERROR", "[gate]", message);
  },
};
