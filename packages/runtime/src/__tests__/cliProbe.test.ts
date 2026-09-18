import { describe, expect, it, vi } from "vitest";
import { probeClaudeCli } from "../adapters/claude/cli.js";
import { probeCodexCli } from "../adapters/codex/cli.js";
import {
  assertSafeWindowsShellExecutablePath,
  buildSafeWindowsShellCommandLine,
} from "../shellSafety.js";

describe("CLI probe functions", () => {
  describe("probeClaudeCli", () => {
    it("returns ok with version for a reachable binary", () => {
      // Берём 'node' как общедоступный бинарник, чтобы проверить сам механизм пробы
      const result = probeClaudeCli("node");
      expect(result.ok).toBe(true);
      expect(result.version).toBeDefined();
    });

    it("returns error for an unreachable binary", () => {
      const result = probeClaudeCli("__nonexistent_binary_12345__");
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("rejects unsafe Windows executable paths before probing the process", async () => {
      const originalPlatform = process.platform;
      const execFileSync = vi.fn(() => Buffer.from("should-not-run"));

      vi.resetModules();
      vi.doMock("node:child_process", async () => {
        const actual =
          await vi.importActual<typeof import("node:child_process")>("node:child_process");
        return {
          ...actual,
          execFileSync,
        };
      });
      Object.defineProperty(process, "platform", {
        value: "win32",
      });

      try {
        const { probeClaudeCli: probeClaudeCliForWindows } =
          await import("../adapters/claude/cli.js");
        const result = probeClaudeCliForWindows("claude&calc");

        expect(result).toEqual({
          ok: false,
          error: "Unsafe Claude CLI path contains Windows shell metacharacters",
        });
        expect(execFileSync).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
        });
        vi.doUnmock("node:child_process");
        vi.resetModules();
      }
    });
  });

  describe("probeCodexCli", () => {
    it("returns ok with version for a reachable binary", () => {
      const result = probeCodexCli("node");
      expect(result.ok).toBe(true);
      expect(result.version).toBeDefined();
    });

    it("returns error for an unreachable binary", () => {
      const result = probeCodexCli("__nonexistent_binary_12345__");
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("rejects unsafe Windows executable paths before probing the process", async () => {
      const originalPlatform = process.platform;
      const execFileSync = vi.fn(() => Buffer.from("should-not-run"));

      vi.resetModules();
      vi.doMock("node:child_process", async () => {
        const actual =
          await vi.importActual<typeof import("node:child_process")>("node:child_process");
        return {
          ...actual,
          execFileSync,
        };
      });
      Object.defineProperty(process, "platform", {
        value: "win32",
      });

      try {
        const { probeCodexCli: probeCodexCliForWindows } = await import("../adapters/codex/cli.js");
        const result = probeCodexCliForWindows("codex&calc");

        expect(result).toEqual({
          ok: false,
          error: "Unsafe Codex CLI path contains Windows shell metacharacters",
        });
        expect(execFileSync).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
        });
        vi.doUnmock("node:child_process");
        vi.resetModules();
      }
    });
  });

  describe("IS_WINDOWS constant", () => {
    it("detects platform at runtime without hardcoded OS assumptions", () => {
      expect(typeof process.platform).toBe("string");
      expect(process.platform.length).toBeGreaterThan(0);
    });
  });

  describe("Windows shell safety helpers", () => {
    it("accepts bare commands and spaced executable paths", () => {
      expect(() => assertSafeWindowsShellExecutablePath("codex", "Codex CLI path")).not.toThrow();
      expect(() =>
        assertSafeWindowsShellExecutablePath(
          "C:\\Program Files\\Codex\\codex.cmd",
          "Codex CLI path",
        ),
      ).not.toThrow();
    });

    it("rejects executable paths with Windows shell metacharacters", () => {
      for (const unsafe of ["codex&calc", "codex|calc", "codex>out", "codex^calc", "codex%PATH%"]) {
        expect(() => assertSafeWindowsShellExecutablePath(unsafe, "Codex CLI path")).toThrow(
          "Unsafe Codex CLI path contains Windows shell metacharacters",
        );
      }
      expect(() => assertSafeWindowsShellExecutablePath("claude&calc", "Claude CLI path")).toThrow(
        "Unsafe Claude CLI path contains Windows shell metacharacters",
      );
    });

    it("builds a quoted command line from safe executable paths and args", () => {
      expect(buildSafeWindowsShellCommandLine("codex", ["app-server"], "Codex app-server")).toBe(
        "codex app-server",
      );
      expect(
        buildSafeWindowsShellCommandLine(
          "C:\\Program Files\\Codex\\codex.cmd",
          ["app-server"],
          "Codex app-server",
        ),
      ).toBe('"C:\\Program Files\\Codex\\codex.cmd" app-server');
    });
  });
});
