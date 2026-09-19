import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import { RUNTIME_CORE_FILES } from "./eslint/runtimeCoreFiles.mjs";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/*SFConflict*", "data/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.es2022,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "prefer-const": "off",
    },
  },
  {
    files: [
      "packages/api/src/**/*.{ts,tsx}",
      "packages/agent/src/**/*.{ts,tsx}",
      "packages/mcp/src/**/*.{ts,tsx}",
      "packages/runtime/src/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@aif/shared",
              importNames: ["getDb", "createTestDb", "closeDb"],
              message: "Use centralized data access via @aif/data.",
            },
            {
              name: "@aif/data/db",
              message:
                "The SQLite driver is internal to @aif/data; use @aif/data repository functions.",
            },
            {
              name: "drizzle-orm",
              message: "SQL query construction is restricted to @aif/data.",
            },
            {
              name: "better-sqlite3",
              message: "Use centralized data access via @aif/data.",
            },
            {
              name: "drizzle-orm/better-sqlite3",
              message: "Use centralized data access via @aif/data.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/runtime/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@aif/shared",
              importNames: ["getDb", "createTestDb", "closeDb"],
              message: "Runtime must not access DB directly. Use @aif/data if needed.",
            },
            {
              name: "@aif/data",
              message: "Runtime layer must not depend on data-access layer.",
            },
            {
              name: "@aif/api",
              message: "Runtime layer must not depend on application packages.",
            },
            {
              name: "@aif/agent",
              message: "Runtime layer must not depend on agent package.",
            },
            {
              name: "@aif/web",
              message: "Runtime layer must not depend on web package.",
            },
            {
              name: "@aif/mcp",
              message: "Runtime layer must not depend on MCP package.",
            },
            {
              name: "drizzle-orm",
              message: "Runtime must not use SQL/ORM directly.",
            },
            {
              name: "better-sqlite3",
              message: "Runtime must not access SQLite directly.",
            },
          ],
        },
      ],
    },
  },
  // Runtime CORE (вне adapters/**) не должен знать про конкретные адаптеры:
  // адаптеры-порты подключаются через registry/bootstrap, а не импортом.
  // Список — единый источник в eslint/runtimeCoreFiles.mjs; его же проверяет
  // guard-тест runtimeCoreGuard.test.ts, чтобы новый core-файл не проскочил молча.
  {
    files: RUNTIME_CORE_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["\\.\\.?/adapters/.*"],
              message:
                "Runtime core must not import adapters directly; reach the port through the registry/bootstrap.",
            },
            {
              group: ["@aif/runtime/adapters.*"],
              message:
                "Runtime core must not import adapters directly; reach the port through the registry/bootstrap.",
            },
          ],
        },
      ],
    },
  },
  // ОРХЕСТРАЦИЯ (coordinator) — только порты: никаких прямых fs/child_process.
  {
    files: ["packages/agent/src/coordinator.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:fs", "node:fs/.*", "node:path", "node:child_process", "node:url"],
              message:
                "Orchestration must delegate fs/git/process work to port adapters (worktreeLifecycle, repositoryPrepare, planFileValidation, gitBranch), not touch the FS or spawn processes directly.",
            },
          ],
        },
      ],
    },
  },
  // Application use-case слой API: транспортно-нейтрален.
  // Никаких hono/http-фреймворков и никакого прямого работы с файлами/процессами.
  {
    files: ["packages/api/src/use-cases/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "hono", message: "Use cases must not depend on the HTTP framework." },
            { name: "@hono/node-server", message: "Use cases must not depend on the HTTP server." },
          ],
          patterns: [
            {
              group: ["node:child_process"],
              message: "Use cases must not spawn processes; delegate to the runtime/data layer.",
            },
            {
              group: ["node:fs", "node:fs/.*", "node:path"],
              message:
                "Use cases must not touch the filesystem directly (plan-file artifacts live in taskEvents/taskPlan which have a documented exception).",
            },
          ],
        },
      ],
    },
  },
  // Документированное исключение: операции с файлом плана (taskEvents/taskPlan)
  // обязаны читать/удалять канонический план-файл — это артефакт, а не HTTP.
  {
    files: ["packages/api/src/use-cases/taskEvents.ts", "packages/api/src/use-cases/taskPlan.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "hono", message: "Use cases must not depend on the HTTP framework." },
            { name: "@hono/node-server", message: "Use cases must not depend on the HTTP server." },
          ],
          patterns: [
            {
              group: ["node:child_process"],
              message: "Use cases must not spawn processes; delegate to the runtime/data layer.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/shared/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@aif/runtime",
              message: "Shared layer must not depend on runtime layer.",
            },
            {
              name: "@aif/data",
              message: "Shared layer must not depend on data-access layer.",
            },
            {
              name: "@aif/api",
              message: "Shared layer must not depend on application packages.",
            },
            {
              name: "@aif/agent",
              message: "Shared layer must not depend on application packages.",
            },
            {
              name: "@aif/web",
              message: "Shared layer must not depend on application packages.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/web/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@aif/shared",
              message: "Web must import shared contracts from @aif/shared/browser.",
            },
            {
              name: "@aif/data/db",
              message: "Web must not import the data-access layer or its driver.",
            },
            {
              name: "@aif/data",
              message: "Web must not import data-access layer modules.",
            },
            {
              name: "@aif/runtime",
              message:
                "Web must not import runtime directly. Use @aif/shared/browser for shared types.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/**/__tests__/**/*.{ts,tsx}", "packages/**/*.{test,spec}.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.vitest,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-imports": "off",
    },
  },
);
