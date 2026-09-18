import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeRunInput } from "../types.js";
import { getCliSpawnInvocation } from "./helpers/cliSpawn.js";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";

// vi.hoisted гарантирует, что mock-фикстуры инициализируются до запуска
// поднятой фабрики vi.mock. Без этого фабрика ниже ловит TDZ-ошибку, читая
// `mockChild`, — vi.mock всплывает выше обычного кода верхнего уровня.
const { mockStdout, mockStderr, mockStdin, mockChild } = vi.hoisted(() => {
  const stdout = { on: vi.fn() };
  const stderr = { on: vi.fn() };
  const stdin = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
  return {
    mockStdout: stdout,
    mockStderr: stderr,
    mockStdin: stdin,
    mockChild: {
      stdout,
      stderr,
      stdin,
      on: vi.fn(),
      kill: vi.fn(),
    },
  };
});

vi.mock("node:child_process", () => ({
  spawn: vi.fn().mockReturnValue(mockChild),
}));

const { spawn } = await import("node:child_process");
const { runClaudeCli } = await import("../adapters/claude/cli.js");

function createInput(overrides: Partial<RuntimeRunInput> = {}): RuntimeRunInput {
  return {
    runtimeId: "claude",
    providerId: "anthropic",
    prompt: "Implement the feature",
    options: {},
    projectRoot: "/tmp/project",
    usageContext: TEST_USAGE_CONTEXT,
    ...overrides,
  };
}

/**
 * Симулирует stdout-поток CLI: каждая JSONL-строка прилетает отдельным
 * `data`-чанком, затем приходит `close` с указанным кодом выхода.
 * Опционально передаёт текст в stderr.
 */
function simulateStreamAndClose(code: number, jsonlLines: unknown[] = [], stderr = "") {
  const stdoutHandler = mockStdout.on.mock.calls.find((c: unknown[]) => c[0] === "data")?.[1] as
    | ((chunk: string) => void)
    | undefined;
  for (const line of jsonlLines) {
    const text = typeof line === "string" ? line : JSON.stringify(line);
    stdoutHandler?.(text + "\n");
  }

  if (stderr) {
    const stderrHandler = mockStderr.on.mock.calls.find((c: unknown[]) => c[0] === "data")?.[1] as
      | ((chunk: string) => void)
      | undefined;
    stderrHandler?.(stderr);
  }

  const closeHandler = mockChild.on.mock.calls.find((c: unknown[]) => c[0] === "close")?.[1] as
    | ((code: number) => void)
    | undefined;
  closeHandler?.(code);
}

/** Строит типичный успешный transcript stream-json. */
function successfulStream(options: {
  sessionId: string;
  text: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  totalCostUsd?: number;
}) {
  const { sessionId, text, usage, totalCostUsd } = options;
  return [
    { type: "system", subtype: "init", session_id: sessionId, model: "claude-haiku" },
    {
      type: "assistant",
      session_id: sessionId,
      message: { content: [{ type: "text", text }] },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      result: text,
      usage,
      total_cost_usd: totalCostUsd,
      num_turns: 1,
      duration_ms: 500,
    },
  ];
}

function getSpawnInvocation() {
  return getCliSpawnInvocation(spawn as ReturnType<typeof vi.fn>);
}

describe("runClaudeCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: vi.fn().mockResolvedValue({}),
      }),
    );
    mockChild.on.mockReset();
    mockStdout.on.mockReset();
    mockStderr.on.mockReset();
    mockStdin.on.mockReset();
    mockStdin.write.mockReset();
    mockStdin.end.mockReset();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("spawns claude CLI with stream-json args and streams the prompt via stdin", async () => {
    const input = createInput();
    const promise = runClaudeCli(input);

    simulateStreamAndClose(
      0,
      successfulStream({
        sessionId: "sess-1",
        text: "Done",
        usage: { input_tokens: 100, output_tokens: 50 },
        totalCostUsd: 0.01,
      }),
    );

    const result = await promise;
    expect(result.outputText).toBe("Done");
    expect(result.sessionId).toBe("sess-1");
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(50);
    expect(result.usage?.costUsd).toBe(0.01);

    const { cliPath, cliArgs, spawnOptions } = getSpawnInvocation();
    expect(cliPath).toBe("claude");
    expect(cliArgs).toEqual(
      expect.arrayContaining([
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        "-p",
      ]),
    );
    // Промпт больше не в argv — он стримится через stdin
    expect(cliArgs).not.toContain("Implement the feature");
    expect(mockStdin.write).toHaveBeenCalledWith("Implement the feature");
    expect(mockStdin.end).toHaveBeenCalled();
    expect(spawnOptions).toEqual(expect.objectContaining({ cwd: "/tmp/project" }));
  });

  it("fails fast when Claude CLI reports a blocked rate limit event", async () => {
    const resetAt = new Date(1_800_000_000 * 1000).toISOString();
    const input = createInput({ profileId: "profile-1" });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(1, [
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          overageStatus: "rejected",
          overageResetsAt: 1_800_000_000,
          rateLimitType: "overage",
          isUsingOverage: true,
        },
      },
    ]);

    await expect(promise).rejects.toMatchObject({
      name: "ClaudeRuntimeAdapterError",
      category: "rate_limit",
      adapterCode: "CLAUDE_USAGE_LIMIT",
      resetAt,
    });
    expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("emits a tool:question event alongside tool:use for AskUserQuestion", async () => {
    const onEvent = vi.fn();
    const input = createInput({ execution: { onEvent } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, [
      { type: "system", subtype: "init", session_id: "sess-q", model: "claude-haiku" },
      {
        type: "assistant",
        session_id: "sess-q",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-abc",
              name: "AskUserQuestion",
              input: {
                questions: [
                  {
                    question: "Choose mode",
                    options: [{ label: "Fast" }, { label: "Full" }],
                  },
                ],
              },
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-q",
        result: "",
        num_turns: 1,
        duration_ms: 10,
      },
    ]);

    await promise;

    const questionEvents = onEvent.mock.calls
      .map(
        (call) => call[0] as { type: string; data?: { toolUseId?: string; questions?: unknown[] } },
      )
      .filter((event) => event.type === "tool:question");
    expect(questionEvents.length).toBe(1);
    expect(questionEvents[0].data?.toolUseId).toBe("tool-abc");
    expect(questionEvents[0].data?.questions).toHaveLength(1);
  });

  it("passes very large prompts via stdin without putting them on argv", async () => {
    // 2 МБ промпт — далеко за пределами macOS ARG_MAX (1 МиБ) и Windows cmd.exe (~8 КБ).
    const largePrompt = "x".repeat(2_000_000);
    const input = createInput({ prompt: largePrompt });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-large", text: "ok" }));
    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).not.toContain(largePrompt);
    // argv остаётся маленьким — суммарно несколько сотен байт флагов
    const argvSize = cliArgs.reduce((sum, arg) => sum + arg.length, 0);
    expect(argvSize).toBeLessThan(1_000);
    expect(mockStdin.write).toHaveBeenCalledWith(largePrompt);
  });

  it("emits stream:text events as assistant text chunks arrive and accumulates outputText", async () => {
    const onEvent = vi.fn();
    const input = createInput({ execution: { onEvent } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, [
      { type: "system", subtype: "init", session_id: "sess-multi" },
      {
        type: "assistant",
        session_id: "sess-multi",
        message: { content: [{ type: "text", text: "Hello " }] },
      },
      {
        type: "assistant",
        session_id: "sess-multi",
        message: { content: [{ type: "text", text: "world" }] },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-multi",
        result: "Hello world",
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    ]);

    const result = await promise;
    expect(result.outputText).toBe("Hello world");

    const textEvents = onEvent.mock.calls
      .map((c) => c[0] as { type: string; message?: string })
      .filter((e) => e.type === "stream:text");
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0]?.message).toBe("Hello ");
    expect(textEvents[1]?.message).toBe("world");

    const initEvents = onEvent.mock.calls
      .map((c) => c[0] as { type: string })
      .filter((e) => e.type === "system:init");
    expect(initEvents).toHaveLength(1);

    const resultEvents = onEvent.mock.calls
      .map((c) => c[0] as { type: string })
      .filter((e) => e.type === "result:success");
    expect(resultEvents).toHaveLength(1);
  });

  it("calls onToolUse and emits tool:use event for tool_use content blocks", async () => {
    const onToolUse = vi.fn();
    const onEvent = vi.fn();
    const input = createInput({ execution: { onToolUse, onEvent } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, [
      { type: "system", subtype: "init", session_id: "sess-tool" },
      {
        type: "assistant",
        session_id: "sess-tool",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "Edit",
              input: { file_path: "/a.ts", old: "x", new: "y" },
            },
          ],
        },
      },
      {
        type: "assistant",
        session_id: "sess-tool",
        message: { content: [{ type: "text", text: "Applied the edit." }] },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-tool",
        result: "Applied the edit.",
      },
    ]);

    const result = await promise;
    expect(result.outputText).toBe("Applied the edit.");

    expect(onToolUse).toHaveBeenCalledTimes(1);
    const [toolName, detail] = onToolUse.mock.calls[0];
    expect(toolName).toBe("Edit");
    expect(detail).toContain("file_path");

    const toolEvents = onEvent.mock.calls
      .map((c) => c[0] as { type: string; data?: { name?: string } })
      .filter((e) => e.type === "tool:use");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.data?.name).toBe("Edit");
  });

  it("includes --agent flag when agentDefinitionName is set", async () => {
    const input = createInput({
      execution: { agentDefinitionName: "plan-coordinator" },
    });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-agent", text: "Planned" }));

    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).toContain("--agent");
    expect(cliArgs[cliArgs.indexOf("--agent") + 1]).toBe("plan-coordinator");
  });

  it("includes --model flag when model is set", async () => {
    const input = createInput({ model: "claude-opus-4-1" });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-model", text: "Done" }));

    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).toContain("--model");
    expect(cliArgs).toContain("claude-opus-4-1");
  });

  it("includes --effort for a fallback level", async () => {
    const input = createInput({ options: { effort: " High " } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-effort", text: "Done" }));

    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).toContain("--effort");
    expect(cliArgs[cliArgs.indexOf("--effort") + 1]).toBe("high");
  });

  it("normalizes numeric effort values to named levels on the CLI", async () => {
    const input = createInput({ options: { effort: 4 } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-effort-num", text: "Done" }));

    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).toContain("--effort");
    expect(cliArgs[cliArgs.indexOf("--effort") + 1]).toBe("max");
  });

  it("omits --effort when options.effort is not provided or invalid", async () => {
    const input = createInput({ options: { effort: "bogus" } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-no-effort", text: "Done" }));

    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).not.toContain("--effort");
  });

  it("includes --resume flag for session continuation", async () => {
    const input = createInput({ resume: true, sessionId: "sess-existing" });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-existing", text: "Resumed" }));

    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).toContain("--resume");
    expect(cliArgs).toContain("sess-existing");
  });

  it("includes --fork-session with source session id for forked runs", async () => {
    const input = createInput({ sourceSessionId: "sess-warm-source" } as Partial<RuntimeRunInput>);
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-child", text: "Forked" }));

    const result = await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).toContain("--resume");
    expect(cliArgs[cliArgs.indexOf("--resume") + 1]).toBe("sess-warm-source");
    expect(cliArgs).toContain("--fork-session");
    expect(result.sessionId).toBe("sess-child");
  });

  it("does not fall back to the source session id when fork output has no child session id", async () => {
    const input = createInput({ sourceSessionId: "sess-warm-source" } as Partial<RuntimeRunInput>);
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, [{ type: "result", subtype: "success", result: "Forked" }]);

    const result = await promise;

    expect(result.sessionId).toBeNull();
  });

  it("includes --include-partial-messages when execution.includePartialMessages is true", async () => {
    const input = createInput({ execution: { includePartialMessages: true } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-partial", text: "Done" }));

    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).toContain("--include-partial-messages");
  });

  it("accumulates text deltas from stream_event content_block_delta (partial messages)", async () => {
    const input = createInput({ execution: { includePartialMessages: true } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, [
      { type: "system", subtype: "init", session_id: "sess-delta" },
      {
        type: "stream_event",
        session_id: "sess-delta",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "par" },
        },
      },
      {
        type: "stream_event",
        session_id: "sess-delta",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "tial" },
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-delta",
        result: "partial",
      },
    ]);

    const result = await promise;
    expect(result.outputText).toBe("partial");
  });

  it("does NOT double-emit stream:text when include-partial-messages is on (deltas + assistant block together)", async () => {
    // При включённом --include-partial-messages Claude выдаёт И stream_event
    // дельты, И готовый assistant-блок контента для того же
    // текста. Адаптер обязан полагаться только на дельты, чтобы маршрут
    // чата не склеивал полный текст дважды в fullAssistantResponse.
    const onEvent = vi.fn();
    const input = createInput({
      prompt: "say hi",
      execution: { includePartialMessages: true, onEvent },
    });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, [
      { type: "system", subtype: "init", session_id: "sess-dedup" },
      {
        type: "stream_event",
        session_id: "sess-dedup",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "hi" },
        },
      },
      // Готовый assistant-блок приходит после дельты с тем же текстом
      {
        type: "assistant",
        session_id: "sess-dedup",
        message: {
          model: "claude-haiku",
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-dedup",
        result: "hi",
      },
    ]);

    const result = await promise;
    // Финальный output text должен быть "hi", а не "hihi"
    expect(result.outputText).toBe("hi");

    const streamTextEvents = onEvent.mock.calls
      .map((c) => c[0] as { type: string; message?: string })
      .filter((e) => e.type === "stream:text");
    // Ровно ОДНО событие stream:text — из дельты, а не из assistant-блока
    expect(streamTextEvents).toHaveLength(1);
    expect(streamTextEvents[0]?.message).toBe("hi");
  });

  it("still emits tool:use from assistant blocks even when partial messages is on", async () => {
    // Tool use блоки контента НЕ стримятся дельтами — только готовый
    // assistant-блок их несёт. Режим partial-messages не должен
    // подавлять выдачу tool:use.
    const onToolUse = vi.fn();
    const onEvent = vi.fn();
    const input = createInput({
      execution: { includePartialMessages: true, onToolUse, onEvent },
    });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, [
      { type: "system", subtype: "init", session_id: "sess-tool-partial" },
      {
        type: "assistant",
        session_id: "sess-tool-partial",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-tool-partial",
        result: "",
      },
    ]);

    await promise;

    expect(onToolUse).toHaveBeenCalledTimes(1);
    const toolEvents = onEvent.mock.calls
      .map((c) => c[0] as { type: string; data?: { name?: string } })
      .filter((e) => e.type === "tool:use");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.data?.name).toBe("Bash");
  });

  it("uses --dangerously-skip-permissions when bypassPermissions is true", async () => {
    const input = createInput({ execution: { bypassPermissions: true } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-bypass", text: "Done" }));

    await promise;

    const { cliArgs } = getSpawnInvocation();
    expect(cliArgs).toContain("--dangerously-skip-permissions");
    expect(cliArgs).not.toContain("acceptEdits");
  });

  it("throws classified error on non-zero exit code", async () => {
    const input = createInput();
    const promise = runClaudeCli(input);

    simulateStreamAndClose(1, [], "Authentication failed");

    await expect(promise).rejects.toThrow();
  });

  it("throws classified error when result message has is_error: true", async () => {
    const input = createInput();
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, [
      { type: "system", subtype: "init", session_id: "sess-err" },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "sess-err",
        result: "Permission denied",
      },
    ]);

    await expect(promise).rejects.toThrow();
  });

  it("falls back to plain text when stdout is not JSONL", async () => {
    const input = createInput();
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, ["plain text output"]);

    const result = await promise;
    expect(result.outputText).toBe("plain text output");
  });

  it("uses custom CLI path from options", async () => {
    const input = createInput({
      options: { claudeCliPath: "/custom/bin/claude" },
    });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-custom", text: "Done" }));

    await promise;

    const { cliPath } = getSpawnInvocation();
    expect(cliPath).toBe("/custom/bin/claude");
  });

  it("calls onStderr callback for stderr output", async () => {
    const onStderr = vi.fn();
    const input = createInput({ execution: { onStderr } });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(
      0,
      successfulStream({ sessionId: "sess-stderr", text: "Done" }),
      "some warning",
    );

    await promise;

    expect(onStderr).toHaveBeenCalledWith("some warning");
  });

  it("injects profile.options.environment into the spawned subprocess env", async () => {
    const input = createInput({
      options: {
        environment: { CLAUDE_CONFIG_DIR: "/tmp/test-claude-personal" },
      },
    });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-profile-env", text: "Done" }));

    await promise;

    const { spawnOptions } = getSpawnInvocation();
    const env = spawnOptions.env as Record<string, string>;
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/test-claude-personal");
  });

  it("forwards proxy env vars into the spawned subprocess env", async () => {
    vi.stubEnv("ALL_PROXY", "socks5://proxy.example:1080");
    vi.stubEnv("NO_PROXY", "localhost,.internal");

    const promise = runClaudeCli(createInput());

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-proxy-env", text: "Done" }));

    await promise;

    const { spawnOptions } = getSpawnInvocation();
    const env = spawnOptions.env as Record<string, string>;
    expect(env.ALL_PROXY).toBe("socks5://proxy.example:1080");
    expect(env.NO_PROXY).toBe("localhost,.internal");
  });

  it("lets execution.environment override profile.options.environment", async () => {
    const input = createInput({
      options: {
        environment: { CLAUDE_CONFIG_DIR: "/tmp/profile-default" },
      },
      execution: {
        environment: { CLAUDE_CONFIG_DIR: "/tmp/per-call-override" },
      },
    });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-env-override", text: "Done" }));

    await promise;

    const { spawnOptions } = getSpawnInvocation();
    const env = spawnOptions.env as Record<string, string>;
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/per-call-override");
  });

  it("ignores non-string values in profile.options.environment", async () => {
    const input = createInput({
      options: {
        environment: {
          CLAUDE_CONFIG_DIR: "/tmp/valid",
          INVALID_NUMBER: 42 as unknown as string,
          INVALID_NULL: null as unknown as string,
        },
      },
    });
    const promise = runClaudeCli(input);

    simulateStreamAndClose(0, successfulStream({ sessionId: "sess-env-filter", text: "Done" }));

    await promise;

    const { spawnOptions } = getSpawnInvocation();
    const env = spawnOptions.env as Record<string, string>;
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/valid");
    expect(env).not.toHaveProperty("INVALID_NUMBER");
    expect(env).not.toHaveProperty("INVALID_NULL");
  });
});
