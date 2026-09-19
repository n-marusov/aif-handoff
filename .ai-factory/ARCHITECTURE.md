# Architecture: Modular Monolith

## Overview

AIF Handoff uses a Modular Monolith architecture implemented via Turborepo workspaces. Each package (`shared`, `runtime`, `data`, `api`, `web`, `agent`, `mcp`) is an independent module with its own build, tests, and dependencies — but they deploy and run together as a single system.

This architecture was chosen because the project has clear domain boundaries (data layer, API, UI, agent orchestration) that benefit from strong module separation, while the small team and single-system deployment make microservices unnecessary overhead.

## Decision Rationale

- **Project type:** Autonomous task management system with Kanban UI and AI agent pipeline
- **Tech stack:** TypeScript monorepo (Turborepo), Hono API, React frontend, pluggable runtime adapters
- **Key factor:** Natural module boundaries already exist via Turborepo workspaces — formalizing the pattern prevents coupling drift

## Folder Structure

```
packages/
├── shared/              # @aif/shared — foundation contracts module (domain layer)
│   └── src/
│       ├── schema.ts        # Drizzle ORM table definitions (@aif/shared/schema subpath)
│       ├── types.ts         # Shared TypeScript types & interfaces
│       ├── stateMachine.ts  # Task stage transition rules
│       ├── taskLifecycle.ts # Single coordinator stage topology (from/inProgress/onSuccess)
│       ├── taskExecutionRoot.ts # worktree ?? project-root rule (single implementation)
│       ├── plannerDefaults.ts  # Mode-driven flag defaults (defaultsForMode)
│       ├── runtimeLimitGate.ts # Runtime-limit gate policy (pure, env-driven)
│       ├── constants.ts     # Application constants
│       ├── env.ts           # Environment config validation (zod)
│       ├── logger.ts        # Pino logger factory
│       ├── presenters.ts    # Row → view-model mappers (Node-only; delivery-side)
│       ├── index.ts         # Public API (Node.js)
│       └── browser.ts       # Public API (browser-safe subset)
│
├── runtime/             # @aif/runtime — runtime/provider abstraction + adapter services
│   └── src/
│       ├── types.ts         # Runtime contracts (adapter/input/output/session/capabilities)
│       ├── registry.ts      # Runtime registration + module loading
│       ├── bootstrap.ts     # Factory: registry with built-in adapters (single composition entry)
│       ├── module.ts        # registerRuntimeModule export resolver
│       ├── errors.ts        # Runtime domain errors (structured classification)
│       ├── resolution.ts    # Runtime profile merge + env/auth resolution
│       ├── capabilities.ts  # Capability gating helpers
│       ├── readiness.ts     # Health check across registered runtimes
│       ├── promptPolicy.ts  # Agent-definition fallback policy (port-based, no adapters imports)
│       ├── modelDiscovery.ts # Model listing + connection validation service
│       ├── cache.ts         # Shared runtime memory cache utility
│       ├── workflowSpec.ts  # Runtime-independent workflow contract
│       ├── trust.ts         # Opaque trust token for permission bypass
│       ├── adapters/
│       │   ├── claude/      # Claude adapter
│       │   ├── codex/       # Codex SDK/CLI/API/App Server adapter
│       │   ├── opencode/    # OpenCode adapter
│       │   └── openrouter/  # OpenRouter adapter (+ diagnostics.ts shared template)
│       └── index.ts         # Public runtime API
│
├── data/                # @aif/data — centralized data-access module (persistence layer)
│   └── src/
│       ├── db.ts            # SQLite driver + migrations (@aif/data/db subpath)
│       ├── taskPlan.ts      # Plan write to DB + canonical file (persistTaskPlan)
│       ├── participants.ts  # Participant lifecycle and admin invariants
│       ├── authSessions.ts  # Password/session/CSRF persistence
│       ├── taskOwnership.ts # Atomic handoff, assignment, executor history
│       ├── taskTransitions.ts # Actor-aware atomic task transitions
│       ├── audit.ts         # Immutable audit writes
│       ├── tasks.ts         # Task repository (CRUD, lists, sessions, heartbeat)
│       ├── comments.ts      # Task comment repository
│       ├── projects.ts      # Project repository (CRUD, overviews)
│       ├── settings.ts      # App settings singleton repository
│       ├── chat.ts          # Chat session/message repository
│       ├── runtimeProfiles.ts  # Runtime profile + warmup session repository
│       ├── runtimeLimits.ts    # Runtime-limit gate policy + profile resolution
│       ├── codexIndex.ts    # Codex session/limit index repository
│       ├── usage.ts         # Usage events, sinks, aggregate increments
│       ├── taskOperations.ts # Shared managed task ops (create/update/plan-field + profile rule)
│       ├── coordinatorClaims.ts # Coordinator claims, auto-queue, worktree/VCS sync
│       ├── internal.ts      # Shared private parsers (not re-exported)
│       └── index.ts         # Public re-export barrel (surface = topic repositories)
│
├── api/                 # @aif/api — HTTP + WebSocket server module (frameworks/adapters)
│   └── src/
│       ├── index.ts         # Server bootstrap (Hono + node-server)
│       ├── routes/          # Thin controllers: parse → use case → shape response
│       ├── use-cases/       # Application layer: transport-free business operations
│       │   ├── createTask.ts/updateTask.ts/handoffTask.ts/deleteTask.ts  # task CRUD ops
│       │   ├── taskEvents.ts  # applyTaskEvent (state machine orchestration)
│       │   ├── qaRun.ts       # startQaRun (CAS claim)
│       │   ├── taskPlan.ts    # plan file read/write/sync
│       │   ├── commitGeneration.ts # generateCommit
│       │   ├── runChatTurn.ts # chat turn orchestration (WS ports injected)
│       │   └── taskPolicy.ts  # shared canMutateTask authorization
│       ├── services/        # Thin HTTP adapters over use cases + runtime bridging
│       ├── middleware/      # Session, CSRF, CORS, RBAC, logging
│       ├── schemas.ts       # Request validation schemas (zod)
│       └── ws.ts            # WebSocket event handler
│
├── web/                 # @aif/web — React SPA module
│   └── src/
│       ├── App.tsx          # Root component
│       ├── components/
│       │   ├── auth/        # Login UI
│       │   ├── participants/ # Participant menu and administration
│       │   ├── kanban/      # Board, Column, TaskCard, AddTaskForm
│       │   ├── task/        # Detail, ownership/handoff, executor timeline
│       │   ├── layout/      # Header, CommandPalette
│       │   ├── project/     # ProjectSelector
│       │   └── ui/          # Reusable primitives (button, dialog, badge, etc.)
│       ├── hooks/           # React hooks (useTasks, useWebSocket, useTheme, etc.)
│       └── lib/             # Utilities (api.ts, notifications.ts, utils.ts)
│
├── agent/               # @aif/agent — Agent orchestration module
│   └── src/
│       ├── index.ts         # Composition root: builds + injects runtime registry
│       ├── runtimeRegistry.ts # Single registry holder (set/get/require)
│       ├── coordinator.ts   # Polling loop (node-cron), stage pipeline from shared lifecycle
│       ├── taskLifecycle.ts # (shared) stage topology — coordinator derives PIPELINE
│       ├── subagentQuery.ts # Runtime-aware execution bridge
│       ├── planFileValidation.ts # Infra adapter: plan-file gate (fs delegated)
│       ├── agentScopeRules.ts # Scope rules loaded from .claude/agents definitions
│       ├── hooks.ts         # Agent lifecycle hooks
│       ├── notifier.ts      # Notification dispatch
│       ├── githubWorkflow.ts/gitlabWorkflow.ts  # provider sync ports
│       ├── worktreeLifecycle.ts/repositoryPrepare.ts  # git/worktree port adapters
│       ├── gitBranch.ts     # Branch/git helpers (isolated git primitives)
│       └── subagents/       # Subagent launchers (planner, implementer, reviewer)
│
└── mcp/                 # @aif/mcp — MCP sync and ownership-aware read contracts
    └── src/
        ├── tools/           # Task read/write tools (delegate to shared taskOperations)
        ├── utils/           # Broadcast and compact response helpers
        ├── env.ts           # Transport + bearer auth config
        └── server.ts        # stdio/HTTP MCP server
```

## Dependency Rules

Module dependency graph (arrows = "depends on"):

```
web ──→ shared (browser export)
data ──→ shared
api ──→ data
api ──→ runtime
agent ──→ data
agent ──→ runtime
mcp ──→ data
```

## Clean-Architecture Layers (within and across packages)

The monorepo follows a layered dependency rule. Source dependencies point
inward: frameworks → adapters → application → domain, never the reverse.

| Layer | Home | What lives there | Rules |
|-------|------|------------------|-------|
| **Domain (rules/contracts)** | `@aif/shared` | types, schema, state machine, stage lifecycle map, execution-root rule, mode defaults, runtime-limit gate, presenters, planner defaults | Pure: no HTTP, DB, or runtime. Node vs browser exports. |
| **Persistence** | `@aif/data` | SQLite driver (`db.ts`), topic repositories, managed task operations (`taskOperations.ts`: create/update/plan-field with shared rules) | Single DB boundary for api/agent/mcp; no framework imports. |
| **Application (use cases)** | `packages/api/src/use-cases/` + `@aif/data/taskOperations` | transport-free business operations (applyTaskEvent, createTask, chat turn, QA claim, commit gen). MCP and API both call the same `taskOperations` contract. | No `hono`, no `node:child_process`, and except the plan-file exceptions no `node:fs`/`node:path` (ESLint-enforced). |
| **Adaptors** | runtime adapters, agent port adapters (`githubWorkflow`, `gitlabWorkflow`, `worktreeLifecycle`, `repositoryPrepare`, `planFileValidation`, `runtimeRegistry`) | provider/git/worktree/file/process ports; the runtime registry is injected by the agent composition root. | No inner-layer imports; runtime core never imports `adapters/**` (ESLint-enforced). |
| **Frameworks** | Hono routes (thin controllers), ws.ts, React web, MCP server plumbing | parse → use case → shape response; WebSocket/HTTP deliver. | Routes stay thin; web only `@aif/shared/browser`. |

Key consequences of this plan's refactor:
- API routes delegate to `packages/api/src/use-cases/`; handlers only parse/validate, invoke a use case, and shape the HTTP/WS response.
- Shared task operations live in `@aif/data/taskOperations.ts` because `@aif/mcp` deploys independently of `@aif/api` (docker copies data/runtime/mcp only) — both delivery surfaces consume one contract.
- Agent composition root (`packages/agent/src/index.ts`) owns registry + usage sink creation; `subagentQuery` reads the injected registry (single owner per port).
- The coordinator's stage topology is defined once in `@aif/shared/taskLifecycle.ts`; data filters and agent PIPELINE derive from it.

### Allowed

- ✅ `data` → import from `@aif/shared`
- ✅ `runtime` → standalone abstraction package used by `api` and `agent`
- ✅ `api`, `agent` → import from `@aif/data` for DB operations
- ✅ `api`, `agent` → import runtime contracts and registry from `@aif/runtime`
- ✅ `api`, `agent`, `web` → import shared contracts/types from `@aif/shared` as needed
- ✅ `web` → import from `@aif/shared/browser` (browser-safe subset)
- ✅ `web` → call `api` via HTTP/WebSocket at runtime (not import)
- ✅ `agent` → call `api` via HTTP at runtime for broadcasts

### Forbidden

- ❌ `shared` → import from `api`, `web`, or `agent` (shared is the foundation, no upward deps)
- ❌ `data` → import from `api`, `web`, or `agent`
- ❌ `runtime` → import from `api`, `agent`, or `web` (runtime is shared infra, no upward deps)
- ❌ `api` → import from `web` or `agent` (API is independent)
- ❌ `web` → import from `api` or `agent` (UI communicates via HTTP/WS only)
- ❌ `agent` → import from `api` or `web` (agent runtime integration is via HTTP, not code imports)
- ❌ Cross-package deep imports (e.g., `@aif/data/db` — use the public barrel API only)
- ❌ DB access from `api`/`agent` outside `@aif/data` (enforced by lint guards)

## Module Communication

- **web ↔ api:** HTTP REST calls + WebSocket for real-time updates
- **api/agent → data:** DB operations through centralized repository layer
- **api/agent → runtime:** Runtime/provider selection and adapter execution via shared registry APIs
- **data → shared:** Uses shared schema and data contracts (driver itself is internal to data)
- **agent → api:** HTTP REST calls for WebSocket broadcasts (best-effort via notifier.ts)
- **runtime adapters → provider SDKs:** Each adapter (Claude, Codex, custom) wraps its provider SDK while agent/api stay provider-agnostic
- **Shared types:** All modules import types and schemas from `@aif/shared`

## Key Principles

1. **Public API via exports** — Each package exposes its API through `exports` in `package.json`. Never import internal files directly. `shared` has two entry points: `index.ts` (Node) and `browser.ts` (browser-safe).

2. **Shared is pure foundation** — The `shared` package contains only types, schemas, validation, and utilities. It has zero knowledge of HTTP, React, or agent logic. If code needs framework-specific features, it belongs in the consuming module.

3. **Runtime communication over imports** — Modules that need to interact at runtime (web→api, agent→api) do so via HTTP/WebSocket, never via direct imports.

4. **Single source of truth for data access** — Database schema and low-level primitives live in `shared`, but all reads/writes outside `shared` go through `@aif/data`. This keeps query construction and repository logic centralized. `web` always goes through the API via HTTP/WebSocket.

5. **Agent definitions are config, not code** — Subagent behavior is defined in `.claude/agents/*.md` files, loaded by the Agent SDK via `settingSources: ["project"]`. The `agent` package orchestrates when to invoke them, not what they do.

6. **Code quality principles are mandatory** — All modules must follow SOLID and DRY principles to keep responsibilities clear, reduce duplication, and preserve maintainability as the monorepo grows.

## Code Examples

### Importing from shared (correct)

```typescript
// In packages/api/src/routes/tasks.ts
import { toTaskResponse } from "@aif/shared";
import { TaskStatus } from "@aif/shared";
import { listTasks } from "@aif/data";

// In packages/web/src/hooks/useTasks.ts
import { TaskStatus, type Task } from "@aif/shared/browser";
```

### Adding a new API route

```typescript
// packages/api/src/use-cases/myOperation.ts  (application layer — transport-free)
import { someDataOp } from "@aif/data";

export type MyOperationResult =
  | { ok: true; id: string }
  | { ok: false; code: "not_found"; error: string };

export function myOperation(input: { id: string }): MyOperationResult {
  const row = someDataOp(input.id);
  return row
    ? { ok: true, id: row.id }
    : { ok: false, code: "not_found", error: "Row not found" };
}
```

```typescript
// packages/api/src/routes/myFeature.ts  (thin controller — parse → use case → response)
import { Hono } from "hono";
import { jsonValidator } from "../middleware/zodValidator.js";
import { myOperation } from "../use-cases/myOperation.js";
import { myFeatureSchema } from "../schemas.js";

const app = new Hono();
app.post("/", jsonValidator(myFeatureSchema), (c) => {
  const body = c.req.valid("json");
  const result = myOperation({ id: body.id });
  if (!result.ok) {
    return c.json({ error: result.error, code: result.code }, 404);
  }
  return c.json(result, 201);
});
export default app;
```

A use case must not import `hono`; if the operation needs the same rule from MCP,
put it in `@aif/data/taskOperations.ts` instead and call it from both surfaces.

### Agent runtime execution pattern

```typescript
// packages/agent/src/index.ts (composition root — single owner of the registry)
import { bootstrapRuntimeRegistry } from "@aif/runtime";
import { createDbUsageSink } from "@aif/data";
import { setRuntimeRegistry } from "./runtimeRegistry.js";

bootstrapRuntimeRegistry({
  runtimeModules: env.AIF_RUNTIME_MODULES,
  modelEffortDiscoveryEnabled: env.AIF_RUNTIME_MODEL_EFFORT_DISCOVERY_ENABLED,
  usageSink: createDbUsageSink({ onRecorded: /* notifier hook */ }),
}).then((registry) => {
  setRuntimeRegistry(registry); // injected; subagentQuery/coordinator read it via getRuntimeRegistrySync
});
```

```typescript
// packages/agent/src/subagentQuery.ts (consumer — never creates the registry)
import { requireRuntimeRegistry } from "./runtimeRegistry.js";

function getRuntimeRegistry() {
  return requireRuntimeRegistry(); // injected by the composition root
}
```

### Web calling API (correct runtime communication)

```typescript
// packages/web/src/lib/api.ts
const API_BASE = "http://localhost:3009";

export async function fetchTasks(projectId: string) {
  const res = await fetch(`${API_BASE}/api/tasks?projectId=${projectId}`);
  return res.json();
}
```

## Anti-Patterns

- ❌ **Importing across sibling packages** — Never `import { something } from "@aif/api"` inside `@aif/web`. Use HTTP calls instead.
- ❌ **Putting DB queries in api/agent directly** — Keep data access in `@aif/data`. Routes/coordinator should stay thin.
- ❌ **Hono/types in use cases** — Application layer must stay transport-free (no `hono` imports — ESLint-enforced).
- ❌ **Filesystem/process work in orchestration** — `coordinator.ts` must not import `node:fs`/`node:child_process`; delegate to port adapters (`planFileValidation`, `worktreeLifecycle`, `repositoryPrepare`). Use cases must not spawn processes or touch fs except the documented plan-file modules — ESLint-enforced.
- ❌ **Runtime core importing adapters** — `@aif/runtime` core (outside `adapters/`) reaches adapters only through the registry/bootstrap — ESLint-enforced.
- ❌ **Shared depending on Node-only APIs without a browser guard** — `shared/browser.ts` must remain browser-safe. Node-only code stays in `shared/index.ts`.
- ❌ **Hardcoding agent prompts in TypeScript** — Agent behavior belongs in `.claude/agents/*.md` files, not in the `agent` package source code.
- ❌ **Introducing new external clients with direct DB writes** — `web` and any third-party integrations must go through API endpoints.
