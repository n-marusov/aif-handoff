import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Часть тестов агента выполняет реальные git-операции во временных worktree
    // (init, checkout, commit). При параллельном запуске стандартный таймаут 5с
    // даёт нестабильные падения, поэтому глобально увеличен до 20с.
    // Быстрые неблокирующие тесты без git по-прежнему завершаются существенно быстрее.
    testTimeout: 20_000,
    server: {
      deps: {
        inline: ["@aif/runtime", "@anthropic-ai/claude-agent-sdk"],
      },
    },
    exclude: ["dist/**", "**/node_modules/**", "**/.git/**", "**/*SFConflict*"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/hooks.ts",
        "src/subagents/**",
        "src/queryAudit.ts",
        "src/wakeChannel.ts",
        "src/**/*SFConflict*",
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
