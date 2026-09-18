/**
 * Нормализация разрешений Codex (approval policy и sandbox mode).
 *
 * Значения приходят из пользовательских настроек и hooks, то есть из недоверенного ввода,
 * поэтому каждое проходит через whitelist-множество и приводится к union-типу либо к null.
 * Здесь сознательно не бросаем ошибку: неверный override просто игнорируется с предупреждением,
 * чтобы не ломать запуск задачи из-за опечатки в конфиге.
 */

interface CodexPermissionLogger {
  warn?(context: Record<string, unknown>, message: string): void;
}

// Whitelist допустимых политик; Set даёт O(1)-проверку вместо цепочки сравнений.
const CODEX_APPROVAL_POLICIES = new Set([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
] as const);

export type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

// Возвращает null (а не throw) — null здесь означает "значение непригодно, используем дефолт".
export function normalizeCodexApprovalPolicy(value: unknown): CodexApprovalPolicy | null {
  // typeof-проверка обязательна: вызывающий код может передать значение из JSON/Toml любого типа.
  if (typeof value !== "string") return null;
  // trim() убирает случайные пробелы вокруг значения из ручной правки конфига.
  const trimmed = value.trim();
  return CODEX_APPROVAL_POLICIES.has(trimmed as CodexApprovalPolicy)
    ? (trimmed as CodexApprovalPolicy)
    : null;
}

// Режимы песочницы Codex: от полностью изолированного до опасного полного доступа.
const CODEX_SANDBOX_MODES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const);

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export function normalizeCodexSandboxMode(value: unknown): CodexSandboxMode | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CODEX_SANDBOX_MODES.has(trimmed as CodexSandboxMode)
    ? (trimmed as CodexSandboxMode)
    : null;
}

// Единая точка предупреждения: логируем причину игнорирования, чтобы пользователь
// мог найти опечатку в настройках, но выполнение при этом не прерывалось.
export function warnOnInvalidCodexPermissionOverride(input: {
  logger?: CodexPermissionLogger;
  runtimeId: string;
  transport: "cli" | "sdk" | "app-server";
  field: "approvalPolicy" | "sandboxMode";
  rawValue: string | null;
  normalizedValue: string | null;
  source?: "options" | "hooks";
}): void {
  // Предупреждаем только когда значение реально было задано и не прошло нормализацию:
  // пустой rawValue и успешно распознанный normalizedValue — не повод для шума в логах.
  if (!input.rawValue || input.normalizedValue) {
    return;
  }

  input.logger?.warn?.(
    {
      runtimeId: input.runtimeId,
      transport: input.transport,
      field: input.field,
      invalidValue: input.rawValue,
      // source добавляется условно, чтобы в логах не появлялось поле со значением undefined.
      ...(input.source ? { source: input.source } : {}),
    },
    `Ignoring invalid Codex ${input.field} override`,
  );
}
