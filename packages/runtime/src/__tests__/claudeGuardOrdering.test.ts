import { describe, expect, it, vi } from "vitest";
import type { RuntimeRunInput } from "../types.js";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";

/**
 * Герметичный регресс-тест порядка (ревью PR #162, P2): version guard обязан
 * выполняться ДО `query()` Agent SDK, чтобы несовместимый бинарник Claude Code
 * отклонялся с `CLAUDE_VERSION_UNSUPPORTED`, а не падал внутри SDK.
 * Полный smoke адаптера закрыт интеграционным флагом; этот тест мокнит guard
 * и точку входа потока и утверждает порядок вызовов через реальный
 * `adapter.run()` → `runClaudeRuntime`, без внешнего бинарника и без
 * интеграционного флага.
 */
const { guardSpy, streamSpy, order } = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    guardSpy: vi.fn(async () => {
      order.push("guard");
    }),
    streamSpy: vi.fn(async () => {
      order.push("query");
      return {
        outputText: "ok",
        sessionId: "sess-1",
        events: [{ type: "result:success" as const }],
        usage: null,
      };
    }),
  };
});

vi.mock("../adapters/claude/version.js", async (importActual) => ({
  ...(await importActual<typeof import("../adapters/claude/version.js")>()),
  assertClaudeExecutableCompatible: guardSpy,
}));

vi.mock("../adapters/claude/stream.js", () => ({
  runClaudeQueryAttempt: streamSpy,
}));

vi.mock("../adapters/claude/findPath.js", () => ({
  findClaudePath: () => undefined,
  resolveClaudeSdkExecutablePath: () => undefined,
}));

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const { createClaudeRuntimeAdapter } = await import("../adapters/claude/index.js");

describe("Claude adapter — version guard ordering", () => {
  it("runs the version guard before invoking the Agent SDK query", async () => {
    order.length = 0;
    guardSpy.mockClear();
    streamSpy.mockClear();

    const adapter = createClaudeRuntimeAdapter({ logger: silentLogger });
    const input: RuntimeRunInput = {
      runtimeId: "claude",
      providerId: "anthropic",
      prompt: "say OK",
      cwd: "/tmp/project",
      projectRoot: "/tmp/project",
      usageContext: TEST_USAGE_CONTEXT,
    };

    await adapter.run(input);

    expect(guardSpy).toHaveBeenCalledTimes(1);
    expect(streamSpy).toHaveBeenCalledTimes(1);
    expect(guardSpy).toHaveBeenCalledBefore(streamSpy);
    expect(order).toEqual(["guard", "query"]);
  });
});
