import { isReadOnlyToolCall } from "@aif/shared";

export type LoopDetectedReason = "tool_call_cap" | "read_only_burst";

/**
 * Thrown by the loop guard when a stage appears to be stuck in a runaway
 * tool-call loop. Structured fields only — consumers must branch on
 * `code`/`reason`, never on `message` text.
 */
export class AiLoopDetectedError extends Error {
  readonly code = "possible_loop" as const;
  readonly reason: LoopDetectedReason;
  readonly count: number;
  readonly limit: number;

  constructor(reason: LoopDetectedReason, count: number, limit: number) {
    super(`Possible agent loop: ${reason} (${count}/${limit})`);
    this.name = "AiLoopDetectedError";
    this.reason = reason;
    this.count = count;
    this.limit = limit;
  }
}

interface LoopGuardOptions {
  maxToolCalls: number;
  readOnlyBurst: number;
}

/**
 * Per-run guard against runaway tool-call loops. Feed every tool completion
 * into `onToolUse`; the guard throws `AiLoopDetectedError` when either the
 * total tool-call cap or a consecutive read-only burst (with no intervening
 * write) is exceeded. Works for all transports because it only needs the
 * tool-completion events that `onToolUse` already provides.
 */
export class LoopGuard {
  private readonly maxToolCalls: number;
  private readonly readOnlyBurst: number;
  private toolCallCount = 0;
  private consecutiveReads = 0;

  constructor(options: LoopGuardOptions) {
    this.maxToolCalls = options.maxToolCalls;
    this.readOnlyBurst = options.readOnlyBurst;
  }

  onToolUse(toolName: string, detail: string | undefined): void {
    this.toolCallCount += 1;
    if (this.toolCallCount > this.maxToolCalls) {
      this.trip("tool_call_cap", this.toolCallCount, this.maxToolCalls);
    }

    if (isReadOnlyToolCall(toolName, detail)) {
      this.consecutiveReads += 1;
      if (this.consecutiveReads >= this.readOnlyBurst) {
        this.trip("read_only_burst", this.consecutiveReads, this.readOnlyBurst);
      }
    } else {
      this.consecutiveReads = 0;
    }
  }

  getStats(): { toolCallCount: number; consecutiveReads: number } {
    return { toolCallCount: this.toolCallCount, consecutiveReads: this.consecutiveReads };
  }

  private trip(reason: LoopDetectedReason, count: number, limit: number): never {
    throw new AiLoopDetectedError(reason, count, limit);
  }
}
