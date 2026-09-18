/**
 * Спецификация runtime-воркфлоу.
 *
 * createRuntimeWorkflowSpec нормализует вход, применяет дефолты и проверяет
 * инварианты до фактического запуска. Это предотвращает недопустимые комбинации
 * параметров в конвейере задач.
 */

import type { RuntimeCapabilityName } from "./capabilities.js";

// Известные виды workflow документируют текущие сценарии,
// а объединение с string оставляет канал расширения без релиза пакета.
export type RuntimeWorkflowKind =
  | "planner"
  | "implementer"
  | "reviewer"
  | "review-security"
  | "review-gate"
  | "chat"
  | "oneshot"
  | string;

// Резервная стратегия, когда runtime не поддерживает определение агента.
export type RuntimeWorkflowFallbackStrategy = "none" | "slash_command";

// Политика повторного использования runtime-сессии: сохранить контекст,
// начать заново или запретить повторное использование.
export type RuntimeSessionReusePolicy = "resume_if_available" | "new_session" | "never";
// Режим запуска: стандартный, изолированная skills-сессия
// или нативные подагенты runtime.
export type RuntimeWorkflowExecutionMode =
  | "standard"
  | "isolated_skill_session"
  | "native_subagents";

// PromptInput объединяет основной запрос и резервную команду для одной задачи.
export interface RuntimeWorkflowPromptInput {
  prompt: string;
  fallbackSlashCommand?: string;
  systemPromptAppend?: string;
}

// Выходной контракт фабрики: нормализованные поля и metadata для специфики конвейера.
export interface RuntimeWorkflowSpec {
  workflowKind: RuntimeWorkflowKind;
  promptInput: RuntimeWorkflowPromptInput;
  requiredCapabilities: RuntimeCapabilityName[];
  agentDefinitionName?: string;
  fallbackStrategy: RuntimeWorkflowFallbackStrategy;
  sessionReusePolicy: RuntimeSessionReusePolicy;
  executionMode: RuntimeWorkflowExecutionMode;
  metadata?: Record<string, unknown>;
}

// Вход фабрики: плоская форма для вызывающего кода.
export interface RuntimeWorkflowSpecInput {
  workflowKind: RuntimeWorkflowKind;
  prompt: string;
  requiredCapabilities?: RuntimeCapabilityName[];
  agentDefinitionName?: string;
  fallbackSlashCommand?: string;
  fallbackStrategy?: RuntimeWorkflowFallbackStrategy;
  sessionReusePolicy?: RuntimeSessionReusePolicy;
  executionMode?: RuntimeWorkflowExecutionMode;
  systemPromptAppend?: string;
  metadata?: Record<string, unknown>;
}

// Фабрика выполняет: нормализацию -> проверку инвариантов -> согласование зависимых полей.
export function createRuntimeWorkflowSpec(input: RuntimeWorkflowSpecInput): RuntimeWorkflowSpec {
  // Убираем дубли capability-полей для детерминированной проверки требований.
  const requiredCapabilities = [...new Set(input.requiredCapabilities ?? [])];
  // Значение по умолчанию для fallbackStrategy выводится из наличия fallbackSlashCommand.
  const rawFallbackStrategy =
    input.fallbackStrategy ?? (input.fallbackSlashCommand ? "slash_command" : "none");
  const requestedExecutionMode = input.executionMode ?? "standard";
  // Инвариант: isolated_skill_session требует fallbackSlashCommand.
  if (requestedExecutionMode === "isolated_skill_session" && !input.fallbackSlashCommand) {
    throw new Error(
      `Workflow ${input.workflowKind} requested isolated_skill_session without fallbackSlashCommand`,
    );
  }
  // Инвариант: native_subagents требует agentDefinitionName.
  if (requestedExecutionMode === "native_subagents" && !input.agentDefinitionName) {
    throw new Error(
      `Workflow ${input.workflowKind} requested native_subagents without agentDefinitionName`,
    );
  }
  // Нормализация executionMode защищает от невалидных значений из внешних данных.
  const executionMode: RuntimeWorkflowExecutionMode =
    requestedExecutionMode === "isolated_skill_session"
      ? "isolated_skill_session"
      : requestedExecutionMode === "native_subagents"
        ? "native_subagents"
        : "standard";
  // В isolated_skill_session стратегия none недопустима и принудительно
  // нормализуется в slash_command.
  const fallbackStrategy =
    executionMode === "isolated_skill_session" && rawFallbackStrategy === "none"
      ? "slash_command"
      : rawFallbackStrategy;

  return {
    workflowKind: input.workflowKind,
    promptInput: {
      // Сборка вложенного promptInput фиксирует единый контракт передачи промпта.
      prompt: input.prompt,
      fallbackSlashCommand: input.fallbackSlashCommand,
      systemPromptAppend: input.systemPromptAppend,
    },
    requiredCapabilities,
    agentDefinitionName: input.agentDefinitionName,
    fallbackStrategy,
    // По умолчанию сохраняем контекст сессии; строгая изоляция задаётся явно.
    sessionReusePolicy: input.sessionReusePolicy ?? "resume_if_available",
    executionMode,
    metadata: input.metadata,
  };
}
