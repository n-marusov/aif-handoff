/**
 * Защита стадии от бесконечного цикла вызовов инструментов.
 *
 * Главный вопрос модуля - как отличить полезную работу от "бега на месте", не
 * разбирая смысл вызовов. Ответ: считать их общее количество и отдельно следить
 * за серией только читающих операций без единой записи. Оба признака проверяются
 * независимо, и любой из них прерывает стадию структурированной ошибкой
 * AiLoopDetectedError, чтобы координатор обработал сбой программно.
 */

import { isReadOnlyToolCall } from "@aif/shared";

export type LoopDetectedReason = "tool_call_cap" | "read_only_burst";

/**
 * Бросается защитой от циклов, когда стадия застряла в бесконтрольном
 * цикле вызовов инструментов. Поля только структурные: потребителям
 * ветвиться по `code`/`reason`, никогда по тексту `message`.
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
 * Защита от бесконтрольных циклов вызовов инструментов на каждый запуск.
 * Подавайте каждое завершение инструмента в `onToolUse`; защита бросает
 * `AiLoopDetectedError`, когда превышен общий лимит вызовов или серия идущих
 * подряд только читающих операций (без единой записи между ними). Работает со
 * всеми транспортами, так как нужны только события завершения инструментов,
 * которые `onToolUse` и так предоставляет.
 */
export class LoopGuard {
  private readonly maxToolCalls: number;
  private readonly readOnlyBurst: number;
  // Счётчики живут в пределах одного запуска стадии: экземпляр создаётся заново
  // на каждый прогон, поэтому состояние между стадиями не переносится.
  private toolCallCount = 0;
  private consecutiveReads = 0;

  constructor(options: LoopGuardOptions) {
    this.maxToolCalls = options.maxToolCalls;
    this.readOnlyBurst = options.readOnlyBurst;
  }

  onToolUse(toolName: string, detail: string | undefined): void {
    // Инкремент до сравнения и строгое ">": ровно maxToolCalls вызовов проходят,
    // а падает только следующий за ними.
    this.toolCallCount += 1;
    if (this.toolCallCount > this.maxToolCalls) {
      this.trip("tool_call_cap", this.toolCallCount, this.maxToolCalls);
    }

    // Любой пишущий инструмент сбрасывает серию: цикл определяется как чтение
    // подряд без промежуточного изменения состояния.
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

  // Возвращаемый тип never: компилятор знает, что после вызова выполнение не
  // продолжается, и не требует проверок после trip.
  private trip(reason: LoopDetectedReason, count: number, limit: number): never {
    throw new AiLoopDetectedError(reason, count, limit);
  }
}
