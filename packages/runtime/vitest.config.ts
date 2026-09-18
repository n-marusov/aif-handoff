import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: {
      deps: {
        inline: ["@aif/shared", "@anthropic-ai/claude-agent-sdk"],
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
        "src/adapters/TEMPLATE.ts",
        // Тяжёлая интеграционная проверка транспорта покрыта unit-тестами адаптера
        // вокруг публичного API.
        "src/adapters/codex/modelDiscovery.ts",
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
