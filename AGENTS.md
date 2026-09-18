# AGENTS.md

> Project map for AI agents. Keep this file up-to-date as the project evolves.

## Project Overview

Autonomous task management system with Kanban board and AI subagents. Tasks flow through stages automatically (Backlog → Planning → Improve → Plan Review → Implementing → Verify → Review → Done → Accepted), each handled by runtime-resolved workflows (Claude adapter first). Skills-mode tasks (`useSubagents=false`) can optionally insert Improve after Planning and Verify before Review.

## Tech Stack

- **Language:** TypeScript (ES2022, ESNext modules)
- **Monorepo:** Turborepo (npm workspaces)
- **API:** Hono + WebSocket
- **Runtime Abstraction:** `@aif/runtime` workspace (runtime/provider contracts + registry)
- **Database:** SQLite (better-sqlite3 + drizzle-orm)
- **Frontend:** React 19 + Vite + TailwindCSS 4
- **Runtime:** Pluggable adapter system (`@aif/runtime`) — built-in Claude (Agent SDK) + Codex (SDK/CLI/API) + OpenRouter (API) adapters
- **Agent:** Runtime-neutral coordinator + node-cron
- **Testing:** Vitest

## Project Structure

```
packages/
├── shared/              # @aif/shared — contracts, schema, state machine, env, constants, logger
│   └── src/
│       ├── schema.ts        # Drizzle ORM schema (SQLite)
│       ├── types.ts         # Shared TypeScript types + RuntimeTransport enum
│       ├── stateMachine.ts  # Task stage transitions
│       ├── constants.ts     # App constants
│       ├── env.ts           # Environment validation
│       ├── logger.ts        # Pino logger setup
│       ├── index.ts         # Node exports
│       └── browser.ts       # Browser-safe exports
├── runtime/             # @aif/runtime — runtime/provider contracts, registry, validation/discovery services, adapters
│   └── src/
│       ├── index.ts         # Public API exports
│       ├── types.ts         # RuntimeAdapter interface, capabilities, execution intent
│       ├── registry.ts      # RuntimeRegistry — adapter registration and lookup
│       ├── bootstrap.ts     # Factory: create registry with built-in adapters
│       ├── resolution.ts    # Profile resolution (task → project → system → env fallback)
│       ├── readiness.ts     # Health check across all registered runtimes
│       ├── capabilities.ts  # Capability assertion before workflow execution
│       ├── promptPolicy.ts  # Agent definition vs slash-command fallback
│       ├── workflowSpec.ts  # Workflow kind, session reuse, required capabilities
│       ├── modelDiscovery.ts # Model listing + connection validation with cache
│       ├── cache.ts         # Generic in-memory TTL cache
│       ├── trust.ts         # Opaque Symbol-based trust token for permission bypass
│       ├── errors.ts        # Runtime error hierarchy
│       ├── module.ts        # Dynamic module loader for external adapters
│       └── adapters/
│           ├── TEMPLATE.ts      # Adapter development guide + skeleton
│           ├── claude/          # Claude adapter (Agent SDK transport)
│           ├── codex/           # Codex adapter (CLI + API transports)
│           └── openrouter/      # OpenRouter adapter (API transport)
├── data/                # @aif/data — centralized data-access layer
│   └── src/
│       ├── participants.ts  # Participant lifecycle and admin invariants
│       ├── authSessions.ts  # Password/session/CSRF persistence
│       ├── taskOwnership.ts # Atomic handoff, assignments, executor history
│       ├── taskTransitions.ts # Actor-aware atomic task transitions
│       ├── audit.ts         # Immutable audit persistence
│       └── index.ts         # Public repository API
├── api/                 # @aif/api — Hono REST + WebSocket server (port 3009)
│   └── src/
│       ├── index.ts         # Server entry point
│       ├── routes/          # tasks/projects/chat/runtime profiles plus auth/participants
│       ├── services/        # runtime.ts, codexIndex.ts, fastFix.ts, roadmapGeneration.ts
│       │                    # agentInternal.ts bridges API → agent internal HTTP (worktree cleanup)
│       │                    # github.ts + gitlab.ts provide the GitHub/GitLab REST clients
│       ├── middleware/      # logger.ts, rateLimit.ts, zodValidator.ts
│       ├── schemas.ts       # Zod request validation
│       └── ws.ts            # WebSocket handler
├── web/                 # @aif/web — React Kanban UI (port 5180)
│   └── src/
│       ├── App.tsx          # Root component
│       ├── components/
│       │   ├── auth/        # LoginPage
│       │   ├── participants/ # Participant menu and administration dialog
│       │   ├── kanban/      # Board, Column, TaskCard, AddTaskForm
│       │   ├── task/        # Detail, ownership/handoff, executor timeline
│       │   ├── layout/      # Header, CommandPalette
│       │   ├── project/     # ProjectSelector, ProjectRuntimeSettings
│       │   ├── settings/    # RuntimeProfileForm
│       │   └── ui/          # Reusable UI primitives (badge, button, dialog, etc.)
│       ├── hooks/           # useTasks, useProjects, useWebSocket, useTheme, useRuntimeProfiles
│       └── lib/             # api.ts, notifications.ts, utils.ts
└── agent/               # @aif/agent — Coordinator + runtime-driven subagent orchestration
    └── src/
        ├── index.ts         # Agent entry point
        ├── coordinator.ts   # Polling coordinator (node-cron)
        ├── autoQueueCommit.ts # Awaited Git commit gate before auto-queue terminal states
        ├── planReviewCommit.ts # Deterministic plan-only commit gate (plan review flow)
        ├── planReviewPublisher.ts # Commits + pushes plan and publishes plan PR/MR (plan_review gate)
        ├── gitConventions.ts   # Target-project branch/commit convention resolver
        ├── subagentQuery.ts # Universal runtime-backed query execution
        ├── reviewGate.ts    # Auto-review gate using adapter lightModel
        ├── hooks.ts         # Activity logging, project root
        ├── stderrCollector.ts # Generic stderr ring-buffer
        ├── notifier.ts      # Notification system
        ├── githubWorkflow.ts # GitHub sync, branch push, and PR publication
        ├── gitlabWorkflow.ts # GitLab sync, branch push, and MR publication
        ├── gitOperationLock.ts # Per-project git mutation lock (keyed async mutex)
        ├── internalApi.ts      # Always-on agent-internal HTTP API (git prepare, worktree cleanup)
        ├── worktreeLifecycle.ts # Stash-before-remove task worktree cleanup
        ├── worktreeReconcile.ts # DB ↔ filesystem worktree reconciliation sweep
        ├── codex/           # Codex login broker (OAuth-in-Docker bridge)
        └── subagents/       # planner.ts, implementer.ts, reviewer.ts

.claude/agents/          # Agent definitions (loaded by runtimes that support them)
.docker/                 # Dockerfile, entrypoint, Angie configs
data/                    # SQLite database files (gitignored)
.ai-factory/             # AI Factory context and references
```

## Key Entry Points

| File                                    | Purpose                                |
| --------------------------------------- | -------------------------------------- |
| `packages/api/src/index.ts`             | API server entry (Hono, port 3009)     |
| `packages/web/src/main.tsx`             | Web app entry (React, port 5180)       |
| `packages/agent/src/index.ts`           | Agent coordinator entry                |
| `packages/agent/src/autoQueueCommit.ts` | Auto-queue completion commit gate      |
| `packages/agent/src/subagentQuery.ts`   | Runtime-aware subagent execution path  |
| `packages/runtime/src/index.ts`         | Shared runtime/provider contracts      |
| `packages/data/src/index.ts`            | Centralized data-access API            |
| `packages/shared/src/schema.ts`         | Database schema (drizzle-orm)          |
| `packages/shared/src/stateMachine.ts`   | Task state transitions                 |
| `Makefile`                              | Build automation (Linux/macOS/Windows) |
| `turbo.json`                            | Turborepo task definitions             |

## Documentation

| Document            | Path                          | Description                                                     |
| ------------------- | ----------------------------- | --------------------------------------------------------------- |
| README              | README.md                     | Project landing page                                            |
| Getting Started     | docs/getting-started.md       | Installation, setup, first steps                                |
| Architecture        | docs/architecture.md          | Agent pipeline, state machine, data flow                        |
| ADR                 | docs/adr/README.md            | Architecture Decision Records (13 as-is decisions)              |
| C4 Diagrams         | docs/c4/README.md             | C4 model: context, containers, components, deployment           |
| API Reference       | docs/api.md                   | REST endpoints, WebSocket events                                |
| Configuration       | docs/configuration.md         | Environment variables, logging, auth                            |
| Providers           | docs/providers.md             | Runtime profiles and adapter capabilities                       |
| MCP Sync            | docs/mcp-sync.md              | MCP tools, transports, and authentication                       |
| GitHub Demo         | docs/github-demo.md           | GitHub.com + router.ai runbook (Plan Review PR Gate)            |
| GitLab Demo         | docs/gitlab-demo.md           | End-to-end GitLab.com + router.ai demo runbook                  |
| Dev GUI Demo        | docs/dev-gui-demo.md          | Local dev + Web UI GitLab/router.ai runbook                     |
| Use Cases           | docs/use-cases/README.md      | Use case index with 42 UC files mapped to HF1–HF12              |
| Functional Reqs     | docs/fun-req/README.md        | 42 FR files generated from 42 UC, mapped to HF1–HF12            |
| Non-Functional Reqs | docs/nonfun-req/README.md     | NFR specification: areas, quality criteria, project constraints |
| Contracts           | docs/contracts/README.md      | Inter-package contracts, API, WebSocket, and adapter interfaces |
| Business Rules      | docs/business-rules/README.md | Task lifecycle, authorization, and automation policies          |
| Vision & Scope      | docs/vision.md                | Product vision, scope, and business context                     |

## AI Context Files

| File                        | Purpose                               |
| --------------------------- | ------------------------------------- |
| CLAUDE.md                   | Project instructions for Claude Code  |
| AGENTS.md                   | This file — project structure map     |
| .ai-factory/DESCRIPTION.md  | Project specification and tech stack  |
| .ai-factory/ARCHITECTURE.md | Architecture decisions and guidelines |
| .ai-factory/RULES.md        | Project rules and conventions         |
| .ai-factory/references/     | AI provider SDK reference docs        |

## MCP Connection

The `handoff` MCP server (`@aif/mcp`) exposes nine `handoff_*` task tools over the Model Context Protocol. Full reference: `docs/mcp-sync.md`.

| Transport         | When                                     | Endpoint                            |
| ----------------- | ---------------------------------------- | ----------------------------------- |
| `stdio` (default) | Local client on the same machine         | `npx tsx packages/mcp/src/index.ts` |
| `http`            | Docker stack (`make docker-dev`), remote | `http://localhost:3100/mcp`         |

### HTTP — Docker and remote clients

`docker compose up` starts the `mcp` service with `MCP_TRANSPORT=http` and publishes host port `3100` (`MCP_PORT`). Every `/mcp` request must send `Authorization: Bearer <MCP_AUTH_TOKEN>`; `/health` is unauthenticated and returns `{"status":"ok"}`. Missing or wrong credentials return `401` with `code: "mcp_authentication_required"`.

Set `MCP_AUTH_TOKEN` in `.env`. When unset, compose falls back to the dev-only `charlie-mcp-dev-token` — replace it with a long random value outside local development.

Claude Code (`.mcp.json` at the project root or the client's own config):

```json
{
  "mcpServers": {
    "handoff": {
      "type": "http",
      "url": "http://localhost:3100/mcp",
      "headers": { "Authorization": "Bearer charlie-mcp-dev-token" }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.handoff]
url = "http://localhost:3100/mcp"
bearer_token_env_var = "MCP_AUTH_TOKEN"
```

The HTTP transport is single-session by default: only the first client can `initialize`, and a second concurrent client gets `-32600 "Server already initialized"`. Set `AIF_MCP_HTTP_MULTI_SESSION_ENABLED=true` to let several clients (multiple editor windows) connect concurrently.

### stdio — local clients

The repository does not ship `.mcp.json`; create it at the project root (or let the Web UI installer write the client config). Absolute paths are required — the MCP process cwd is not guaranteed to be the project root.

```json
{
  "mcpServers": {
    "handoff": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "packages/mcp/src/index.ts"],
      "cwd": "/absolute/path/to/aif-handoff",
      "env": {
        "MCP_TRANSPORT": "stdio",
        "DATABASE_URL": "/absolute/path/to/aif-handoff/data/aif.sqlite",
        "PROJECTS_DIR": "/absolute/path/to/aif-handoff/.projects",
        "LOG_LEVEL": "info",
        "LOG_DESTINATION": "stderr"
      }
    }
  }
}
```

`LOG_DESTINATION=stderr` is mandatory for stdio: `stdout` carries the JSON-RPC stream, and application logs on it break the handshake. stdio is trusted and requires no token.

### Install and verify

- Web UI → Global Settings → MCP → Install calls `POST /settings/mcp/install`, which writes the entry into each registered runtime's client config (Claude `~/.claude.json`, Codex `~/.codex/config.toml`). `GET /settings/mcp` reports status; `DELETE /settings/mcp` removes it.
- The installer picks the HTTP URL form when `MCP_PORT` is a valid integer port, otherwise it falls back to the `npx tsx …` stdio entry. The auto-written HTTP entry carries the URL only — add the `Authorization: Bearer` header yourself when the server runs with `MCP_TRANSPORT=http`.
- Rate limits: reads `120`/min (burst `10`), writes `30`/min (burst `5`) — tunable via `MCP_RATE_LIMIT_*`.

## Agent Rules

- Never combine shell commands with `&&`, `||`, or `;` — execute each command as a separate Bash tool call. This applies even when a skill, plan, or instruction provides a combined command — always decompose it into individual calls.
  - Wrong: `git checkout main && git pull`
  - Right: Two separate Bash tool calls — first `git checkout main`, then `git pull`

- DB boundary is mandatory: `api`, `agent`, and `runtime` access database only through `@aif/data`. Direct imports of DB helpers from `@aif/shared/server` and direct SQL construction imports are blocked by ESLint.

## Package Checklist Rule

**CRITICAL:** Check the `CHECKLIST.md` file and ensure all items are completed.

## UI Component Rules

- **Reuse existing components first.** Before creating a new UI component, check `packages/web/src/components/ui/` for an existing primitive that fits the need. Compose existing primitives (e.g. `Dialog` + `Button`) instead of writing new wrappers.
- **Pencil sync required for new components.** If a new UI component is genuinely needed, its design must be synced with the Pencil design system (`.pen` files) using the `pencil` MCP tools (`batch_design`, `get_guidelines`). Never add a visual component to the codebase without a corresponding Pencil representation.
- **UI primitives live in `packages/web/src/components/ui/`.** Domain-specific compositions belong in their feature folder (e.g. `components/task/`, `components/kanban/`).
- **No expensive CSS properties.** Never use `box-shadow`, `backdrop-filter`, `filter: blur()`, `text-shadow`, or other GPU/paint-heavy CSS in components. These trigger costly compositing and repaint cycles, especially on low-end devices and during scroll/animation. Use `border`, `outline`, `opacity`, or solid `background-color` as lightweight alternatives.
- **Theme color pairing → see [`docs/ui-theme-colors.md`](docs/ui-theme-colors.md).** Pairing rules between semantic tokens and fixed-color backgrounds, the verification checklist (light + dark), and known cases live there. Read it before touching color classes on any UI.
- **If you fix a theme-readability bug, append to `docs/ui-theme-colors.md` → "Learnings".** Whenever a change adjusts colors to fix contrast/legibility in a theme (light or dark), add a one- or two-line dated entry with the symptom, cause, and fix. This keeps the doc the single living memory of theme-pairing pitfalls so the same class of bug does not recur.

## Docker Sync Rule

- **Docker config must stay in sync with packages.** When adding a new package under `packages/` or introducing new inter-package dependencies, update the Docker configuration accordingly:
  - `.docker/Dockerfile` — add build stages, `COPY` directives, and build steps for the new package.
  - `docker-compose.yml` / `docker-compose.production.yml` — add or update services, volumes, and dependency links as needed.
  - Verify the Docker build still succeeds after changes: `docker compose build`.

## Runtime Adapter Sync Rule

- **Docs must stay in sync when adding or modifying runtime adapters.** When a new adapter is added to `packages/runtime/src/adapters/` or an existing adapter's capabilities change:
  - `docs/providers.md` — update the "Supported Runtimes" table (including the `Usage Reporting` column).
  - `packages/runtime/src/adapters/TEMPLATE.ts` — verify the template still reflects current conventions.
  - `packages/runtime/src/bootstrap.ts` — register the new built-in adapter.
  - `.docker/Dockerfile` — add any new system-level dependencies.
  - **Usage reporting contract** — declare `capabilities.usageReporting` (`FULL` / `PARTIAL` / `NONE`) and return `RuntimeRunResult.usage` as `RuntimeUsage` or explicit `null`. The discovery test in `bootstrap.test.ts` fails the build if the field is missing.
- **Cross-adapter consistency on shared changes.** When modifying shared runtime infrastructure (`errors.ts`, `types.ts`, `timeouts.ts`, `capabilities.ts`) or refactoring a pattern that exists across multiple adapters — enumerate ALL adapter directories under `packages/runtime/src/adapters/` and verify each is updated. Do not rely on the issue description or plan to list affected adapters — scan the directory.

## Migration Version Rule

- **Migration versions are append-only — never renumber or edit a merged migration.** In `packages/shared/src/db.ts` `MIGRATIONS` array, never change the `version` number or `sql` body of a migration that has already landed on `main`. If a feature branch collides on a version with `main` during merge, append the new migration at the next free slot — do NOT reuse or reorder existing version numbers.
  - **Why:** user databases store progress via `PRAGMA user_version`. If version N is already applied and the SQL behind N is later swapped for different content, `runMigrations` filters `m.version > currentVersion` and silently skips the new content on those DBs. Result: schema drift between code and DB — missing columns, crashes at query time (see v13 runtime_limit snapshot incident).
  - **When resolving merge conflicts in `MIGRATIONS`:** keep the first-merged entry at its original version; move the conflicting second entry to a new trailing version. Do not "reconcile" by editing either slot.
  - **Writing a recovery migration:** `ALTER TABLE ADD COLUMN` statements are idempotent via `isIgnorableMigrationError` (duplicate column → swallowed). Safe to re-issue the same DDL in a later version to backfill DBs that skipped it.

## Nullable Cast Rule

- **Never use `as T` to strip a nullable return.** Helpers like `asRecord(x)`, `JSON.parse` wrappers, and other `unknown → T | null` narrowing functions can legitimately return `null`. Writing `const r = asRecord(x) as T` silently drops `| null` from the type, the TypeScript checker goes quiet, and subsequent `r.foo` access crashes at runtime on real-world nullable inputs.
  - **Always declare the union explicitly:** `as T | null` (or skip the cast entirely).
  - **Always guard before access:** `if (!r) return null` immediately after the cast.
  - **Applies to all adapter parsers** that walk untrusted payloads (Codex session JSONL, Claude stream events, OpenRouter responses) — a missing/null field is normal, not exceptional.

## Structured Error Classification Rule

- **Never use string/pattern matching on error messages to branch logic.** All error classification must go through structured fields: `category` (enum from `RuntimeErrorCategory`), `adapterCode`, or `httpStatus`. Message text is for logging and diagnostics only — never use `.includes()`, regex, or substring checks on `error.message` to make control-flow decisions.
  - Classifiers (`classifyBy*` in `packages/runtime/src/errors.ts`) are the single entry point for mapping raw errors to structured categories.
  - Each adapter's `errors.ts` must preserve structured context (HTTP status, adapter code) on the error object so consumers can branch on it without re-parsing the message.
  - When adding a new error condition, extend the `RuntimeErrorCategory` enum or add a new `adapterCode` — do not add a new message pattern check.

## Project Rules

- Every package must maintain at least 70% test coverage (measured by @vitest/coverage-v8)
- Write code following SOLID and DRY principles
- Always run after implementation: `npm run ai:validate`
