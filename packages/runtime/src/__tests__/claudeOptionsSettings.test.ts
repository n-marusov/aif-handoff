import { describe, expect, it } from "vitest";
import type { RuntimeRunInput } from "../types.js";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";
import {
  buildClaudeQueryOptions,
  type ClaudeRuntimeExecutionOptions,
} from "../adapters/claude/options.js";

const baseInput: RuntimeRunInput = {
  runtimeId: "claude",
  providerId: "anthropic",
  prompt: "say OK",
  projectRoot: "/tmp/project",
  cwd: "/tmp/project",
  usageContext: TEST_USAGE_CONTEXT,
};

describe("buildClaudeQueryOptions — settings forwarding", () => {
  it("defaults to attribution suppression when settings is undefined", () => {
    const options = buildClaudeQueryOptions(baseInput, {
      // settings намеренно опущены
    } satisfies ClaudeRuntimeExecutionOptions);

    // Пустые commit/pr — задокументированный механизм Claude Code скрывать
    // трейлеры Co-Authored-By; это и есть запрос подавления по умолчанию.
    expect(options.settings).toEqual({ attribution: { commit: "", pr: "" } });
  });

  it("forwards empty-string attribution unchanged (suppression contract)", () => {
    const options = buildClaudeQueryOptions(baseInput, {
      settings: { attribution: { commit: "", pr: "" } },
    } satisfies ClaudeRuntimeExecutionOptions);

    // Должно проходить дословно — схлопывание в {} вернуло бы дефолтный
    // attribution Claude Code (см. документацию ClaudeSdkSettings).
    expect(options.settings).toEqual({ attribution: { commit: "", pr: "" } });
  });

  it("forwards non-empty attribution unchanged", () => {
    const options = buildClaudeQueryOptions(baseInput, {
      settings: { attribution: { commit: "commit-trailer", pr: "pr-trailer" } },
    } satisfies ClaudeRuntimeExecutionOptions);

    expect(options.settings).toEqual({
      attribution: { commit: "commit-trailer", pr: "pr-trailer" },
    });
  });

  it("preserves unrelated Claude settings alongside attribution", () => {
    const options = buildClaudeQueryOptions(baseInput, {
      settings: {
        attribution: { commit: "", pr: "" },
        outputStyle: "technical",
      },
    } satisfies ClaudeRuntimeExecutionOptions);

    // Не-attribution ключи (outputStyle, sandbox, permissions, …) обязаны выживать —
    // `settings` это расширяемый мешок, а не объект только про attribution.
    expect(options.settings).toEqual({
      attribution: { commit: "", pr: "" },
      outputStyle: "technical",
    });
  });
});

describe("buildClaudeQueryOptions — executable selection (guard invariant)", () => {
  // Version guard обязан инспектировать тот же бинарник, что запускает `query()`
  // (probed === launched). Без явного override SDK исполняет свой встроенный
  // бинарник — опция должна отсутствовать, а guard читает манифест SDK;
  // при явном override тот же путь и зондируется, и пробрасывается.
  it("omits pathToClaudeCodeExecutable when none is configured (SDK uses bundled binary)", () => {
    const options = buildClaudeQueryOptions(baseInput, {
      pathToClaudeCodeExecutable: undefined,
    } satisfies ClaudeRuntimeExecutionOptions);

    expect(Object.prototype.hasOwnProperty.call(options, "pathToClaudeCodeExecutable")).toBe(false);
  });

  it("forwards an explicit pathToClaudeCodeExecutable so the guard and query() share it", () => {
    const options = buildClaudeQueryOptions(baseInput, {
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
    } satisfies ClaudeRuntimeExecutionOptions);

    expect(options.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
  });
});
