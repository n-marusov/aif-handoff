/**
 * Интеграционный тест-страж: проверяет, что все транспорты встроенных
 * runtime-адаптеров покрыты таймаутами. Если новый адаптер добавят без
 * поддержки таймаутов, этот тест упадёт.
 *
 * Тест ищет паттерны использования timeout-утилит в исходниках адаптеров,
 * а не делает реальные сетевые вызовы.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ADAPTERS_DIR = resolve(import.meta.dirname, "../adapters");

/** Читает исходник относительно каталога adapters. */
function readAdapterSource(relativePath: string): string {
  return readFileSync(resolve(ADAPTERS_DIR, relativePath), "utf-8");
}

/**
 * Паттерны таймаутов, показывающие, что файл адаптера их обрабатывает.
 * Хотя бы один обязан встречаться в каждой реализации транспорта.
 */
const STREAM_TIMEOUT_PATTERNS = ["withStreamTimeouts", "startTimeoutMs", "startTimer"];

const PROCESS_TIMEOUT_PATTERNS = ["withProcessTimeouts"];

const HTTP_TIMEOUT_PATTERNS = ["AbortSignal.timeout", "runTimeoutMs", "resolveRequestTimeoutMs"];

function hasAnyPattern(source: string, patterns: string[]): boolean {
  return patterns.some((pattern) => source.includes(pattern));
}

describe("Timeout coverage guard", () => {
  describe("Stream transports must use withStreamTimeouts or manual start timeout", () => {
    it("Claude SDK (run.ts + stream.ts)", () => {
      const stream = readAdapterSource("claude/stream.ts");
      expect(hasAnyPattern(stream, STREAM_TIMEOUT_PATTERNS)).toBe(true);
    });

    it("Codex SDK (sdk.ts)", () => {
      const sdk = readAdapterSource("codex/sdk.ts");
      expect(hasAnyPattern(sdk, STREAM_TIMEOUT_PATTERNS)).toBe(true);
    });

    it("Codex API streaming (api.ts)", () => {
      const api = readAdapterSource("codex/api.ts");
      expect(hasAnyPattern(api, STREAM_TIMEOUT_PATTERNS)).toBe(true);
    });

    it("OpenRouter API streaming (api.ts)", () => {
      const api = readAdapterSource("openrouter/api.ts");
      expect(hasAnyPattern(api, STREAM_TIMEOUT_PATTERNS)).toBe(true);
    });
  });

  describe("CLI transports must use withProcessTimeouts", () => {
    it("Claude CLI (cli.ts)", () => {
      const cli = readAdapterSource("claude/cli.ts");
      expect(hasAnyPattern(cli, PROCESS_TIMEOUT_PATTERNS)).toBe(true);
    });

    it("Codex CLI (cli.ts)", () => {
      const cli = readAdapterSource("codex/cli.ts");
      expect(hasAnyPattern(cli, PROCESS_TIMEOUT_PATTERNS)).toBe(true);
    });

    it("Codex app-server (appServer/run.ts)", () => {
      const appServerRun = readAdapterSource("codex/appServer/run.ts");
      expect(hasAnyPattern(appServerRun, PROCESS_TIMEOUT_PATTERNS)).toBe(true);
    });
  });

  describe("HTTP transports must support runTimeoutMs", () => {
    it("Codex API non-streaming (api.ts)", () => {
      const api = readAdapterSource("codex/api.ts");
      expect(hasAnyPattern(api, HTTP_TIMEOUT_PATTERNS)).toBe(true);
    });

    it("OpenCode API (api.ts)", () => {
      const api = readAdapterSource("opencode/api.ts");
      expect(hasAnyPattern(api, HTTP_TIMEOUT_PATTERNS)).toBe(true);
    });

    it("OpenRouter API non-streaming (api.ts)", () => {
      const api = readAdapterSource("openrouter/api.ts");
      expect(hasAnyPattern(api, HTTP_TIMEOUT_PATTERNS)).toBe(true);
    });
  });

  describe("All adapters import from shared timeouts or have equivalent", () => {
    const TIMEOUT_IMPORT_PATTERNS = [
      'from "../../timeouts.js"',
      'from "../../../timeouts.js"',
      "resolveRequestTimeoutMs", // OpenCode has its own equivalent
    ];

    for (const [name, files] of Object.entries({
      "Claude SDK": ["claude/stream.ts"],
      "Claude CLI": ["claude/cli.ts"],
      "Codex SDK": ["codex/sdk.ts"],
      "Codex CLI": ["codex/cli.ts"],
      "Codex app-server": ["codex/appServer/run.ts"],
      "Codex API": ["codex/api.ts"],
      "OpenRouter API": ["openrouter/api.ts"],
    })) {
      it(`${name} imports shared timeout utilities`, () => {
        const sources = files.map((f) => readAdapterSource(f));
        const hasImport = sources.some((source) =>
          TIMEOUT_IMPORT_PATTERNS.some((pattern) => source.includes(pattern)),
        );
        expect(hasImport).toBe(true);
      });
    }

    it("OpenCode API has its own timeout mechanism (resolveRequestTimeoutMs)", () => {
      const source = readAdapterSource("opencode/api.ts");
      expect(source.includes("resolveRequestTimeoutMs")).toBe(true);
    });
  });
});
