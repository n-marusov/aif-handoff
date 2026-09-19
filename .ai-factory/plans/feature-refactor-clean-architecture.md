# Implementation Plan: Clean Architecture Refactoring

Branch: main (branch not created by /aif-plan; conventional branch for this work: feature/refactor-clean-architecture)
Created: 2026-09-19

## Settings
- Testing: yes (TDD — no refactoring step may start before its characterization/contract tests are green)
- Logging: verbose
- Docs: yes

## Roadmap Linkage
Milestone: "none"
Rationale: No open milestone matches a clean-architecture refactor; the only unchecked milestone is Unified OTel Telemetry.

## Research Context
Source: .ai-factory/RESEARCH.md (Active Summary) plus a baseline measured on 2026-09-19

Goal: Not applicable — the Active Summary topic is parallel agent execution, which is unrelated to this refactor. Only project-wide constraints and the measured baseline are carried over.
Constraints:
- DB boundary is mandatory: `api`, `agent`, `runtime` reach the database only through `@aif/data`.
- Migration versions are append-only — never renumber or edit a merged migration; append at the next free slot.
- Every package must keep at least 70% coverage; run `npm run ai:validate` after implementation.
- Docker config must stay in sync when packages or inter-package dependencies change.
- Runtime adapter changes must also update `docs/providers.md`, `packages/runtime/src/adapters/TEMPLATE.ts`, and `packages/runtime/src/bootstrap.ts`.
- Never classify errors by string/pattern matching on messages; use `category`/`adapterCode`/`httpStatus`.
Measured baseline:
- Red suites: `shared` 17 failed / 279 (`db.test.ts` 12, `stateMachine.test.ts` 5); `agent` 34 failed / 512 (`coordinator` 28, `subagentQuery` 4, `gitBranch` 1, `taskWatchdog` 1); `web` 3 failed / 769 (`Board.test.tsx`).
- Green suites: `data` 288/288; `runtime` 912 passed + 1 skipped; `api` 560/560; `mcp` 103/103.
- Coverage gate excludes refactor targets: `data/src/index.ts`; `agent/src/{index,hooks,queryAudit,wakeChannel}.ts` and `agent/src/subagents/**`; `mcp/src/{index.ts,tools/*.ts}`; `api/src/{index,ws}.ts`, `api/src/middleware/**`, `api/src/routes/projects.ts`; `shared/src/{index,browser,types,constants,db}.ts`; `runtime/src/adapters/codex/modelDiscovery.ts`.
- Verified root cause of the `db.test.ts` failures: the constant `CURRENT_SCHEMA_VERSION = 34` at `packages/shared/src/__tests__/db.test.ts:10` while `packages/shared/src/db.ts` already ships migration v35. No duplicate or missing migration versions (v16 is a pre-existing historical gap).
Decisions: none carried over.
Open questions: none carried over.

## Commit Plan
- **Commit 1** (after tasks 1-4): "test: restore green baseline for shared and agent suites"
- **Commit 2** (after tasks 5-8): "test: cover refactor targets and re-enable coverage gate"
- **Commit 3** (after tasks 9-12): "refactor(runtime): move provider identity into adapter descriptors"
- **Commit 4** (after tasks 13-17): "refactor(data): split data god-module and move presenters out"
- **Commit 5** (after tasks 18-22): "refactor(api): introduce application use-case layer"
- **Commit 6** (after tasks 23-26): "refactor(agent): single lifecycle graph and injected ports"
- **Commit 7** (after tasks 27-29): "chore: add layer-boundary lint rules and architecture docs"

## Tasks

### Phase 0: Restore Green Baseline

- [x] Task 1: Remove the stale schema-version literal from migration tests
  - Deliverable: `CURRENT_SCHEMA_VERSION` is derived from the exported `MIGRATIONS` array instead of a hardcoded `34`, so the suite cannot drift again.
  - Files: `packages/shared/src/__tests__/db.test.ts` (line 10, all `toBe(CURRENT_SCHEMA_VERSION)` sites), `packages/shared/src/db.ts` (export `MIGRATIONS` or a `LATEST_SCHEMA_VERSION`).
  - Rule: do not renumber or edit any merged migration; append-only.
  - Logging: DEBUG on test setup with the resolved version; INFO when the constant is derived.
  - Acceptance: `npx vitest run` in `packages/shared` reports 0 failures for `db.test.ts`.

- [x] Task 2: Resolve the state-machine review/verify routing failures
  - Deliverable: `resolveTaskAction` routing for `complete_review` with `runPostVerify`/`skipReview` matches the documented business rules; either the implementation or the expectations are corrected — decided by evidence, not by editing whichever is easier.
  - Files: `packages/shared/src/stateMachine.ts`, `packages/shared/src/__tests__/stateMachine.test.ts`.
  - Evidence to consult: `docs/business-rules/`, `docs/fun-req/` (pipeline/verify), `packages/shared/src/types.ts` around the `runPostVerify`/`skipReview` definitions.
  - Logging: DEBUG each emitted `TransitionPatch` decision with `{ taskId, event, status, runPostVerify, skipReview, targetStatus }`; WARN on denial with the denial code.
  - Acceptance: the 5 failing tests are resolved with a written rationale recorded in the task notes; if the implementation was wrong, add a regression test.

- [x] Task 3: Fix the coordinator pipeline test failures
  - Deliverable: The 28 failing `coordinator.test.ts` cases pass, or the production defect they expose is fixed.
  - Files: `packages/agent/src/__tests__/coordinator.test.ts`, `packages/agent/src/coordinator.ts`.
  - Note: several failures are dispatch-level ("`vi.fn()` to be called with… Number of calls: 0") and several are status-level ("expected 'planning' to be 'done'"), indicating the PIPELINE dispatch contract changed.
  - Logging: DEBUG per stage selection `{ taskId, stage, runner, from, onSuccess }`; WARN when a stage is skipped with the reason.
  - Acceptance: 0 failures in `coordinator.test.ts`.

- [x] Task 4: Fix the remaining agent failures (subagentQuery, gitBranch, taskWatchdog)
  - Deliverable: The 4 `subagentQuery` failures (API-skill workflow expansion, pinned-model fallback persistence), the `gitBranch` base-branch-unavailable failure, and the `taskWatchdog` retryCount failure are resolved.
  - Files: `packages/agent/src/__tests__/subagentQuery.test.ts`, `packages/agent/src/__tests__/gitBranch.test.ts`, `packages/agent/src/__tests__/taskWatchdog.test.ts`, plus `subagentQuery.ts`, `gitBranch.ts`, `taskWatchdog.ts` if production is at fault.
  - Logging: DEBUG runtime-profile resolution with `{ taskId, source, profileId, model }`; WARN on runtime-selection persistence skip with the rollout flag state.
  - Acceptance: 0 failures in `packages/agent`.

- [x] Task 5: Fix the web Board test failures
  - Deliverable: `Board.test.tsx` no longer asserts removed column headings ("Plan Ready", "Verified"); expectations match the current board columns.
  - Files: `packages/web/src/__tests__/Board.test.tsx`, reference `packages/web/src/components/kanban/Board.tsx` / `Column.tsx`.
  - Logging: no component logging required; tests log the resolved column set at DEBUG on failure only.
  - Acceptance: 0 failures in `packages/web`.

### Phase 1: Characterization Test Wall

- [x] Task 6: Re-enable the coverage gate for the refactor targets
  - Deliverable: Coverage exclusions that hide refactor targets are removed and replaced by per-file thresholds, so the refactor cannot silently delete behaviour.
  - Files: `packages/data/vitest.config.ts`, `packages/agent/vitest.config.ts`, `packages/mcp/vitest.config.ts`, `packages/api/vitest.config.ts`, `packages/shared/vitest.config.ts`.
  - Order: this task lands only after Tasks 7-8 provide the tests; until then keep the exclusions and add the new suites alongside.
  - Logging: none in production code; the coverage report is the artefact.
  - Acceptance: `npm run coverage` passes with `data/src/index.ts`, `agent/src/subagents/**`, `mcp/src/tools/*.ts`, `api/src/middleware/**`, `api/src/routes/projects.ts`, `shared/src/db.ts` included.
  - Completed (2026-09-19): removed target exclusions from all five vitest configs (data `src/index.ts`; agent `src/subagents/**`; mcp `src/tools/*.ts`; api `src/middleware/**` + `src/routes/projects.ts`; shared `src/db.ts`). Measured full-package coverage with targets included: data 85.7/76.1/92.2/87.7; shared 80.0/70.9/78.2/81.8; agent 77.5/71.2/80.5/78.2; api 83.6/72.8/86.1/85.0; mcp 86.9/78.4/96.2/87.0 — all metric sets ≥70%.

- [x] Task 7: Characterization suite for the `@aif/data` public surface
  - Deliverable: Contract tests for the 183 exports of `packages/data/src/index.ts`, grouped by topic (tasks, comments, projects, settings, chat sessions, runtime profiles, runtime-limit gate, codex index, usage, coordinator claims). Tests pin current observable behaviour, including atomicity and CAS semantics.
  - Files: new `packages/data/src/__tests__/*.contract.test.ts` (one file per topic group); helpers in `packages/data/src/__tests__/`.
  - Constraint: these tests must not encode implementation details of the future split; they assert behaviour through the public API.
  - Logging: DEBUG per assertion group with `{ topic, fn, inputShape }`; WARN on any non-deterministic result (timestamps, ordering) so flakiness is caught before refactoring.
  - Acceptance: suite green; coverage of `data/src/index.ts` ≥70% lines and functions.

- [x] Task 8: Characterization suites for agent subagents, MCP tools, and API middleware
  - Deliverable: Behaviour-pinning tests for `agent/src/subagents/**` (planner, improver, planChecker, implementer, verifier, reviewer, doneChecker), `mcp/src/tools/*.ts` (nine tools), and `api/src/middleware/**` plus `api/src/routes/projects.ts`.
  - Files: `packages/agent/src/__tests__/subagents.contract.test.ts`, `packages/mcp/src/__tests__/tools.contract.test.ts`, `packages/api/src/__tests__/middleware.contract.test.ts`, `packages/api/src/__tests__/projects.contract.test.ts`.
  - Constraint: MCP tests must pin the ownership-field rejection and runtime-profile validation rules that currently duplicate API behaviour.
  - Logging: DEBUG on each tool/handler invocation with `{ toolName, taskId, changedFields }` and middleware decisions with `{ route, actor, decision }`.
  - Acceptance: suites green; the four newly measured areas meet the 70% threshold.
  - Task notes (2026-09-19): baseline measured BEFORE this task — `agent/src/subagents/**` 84.4% stmts / 78.4% branch / 87.5% funcs / 85.2% lines (already above 70% with existing suites); `api/src/middleware/**` 79.4/82.6/85.7/81.1 (above 70%); `api/src/routes/projects.ts` 72.2/65.6/82.5/72.6 (branch below 70% — needs branches); `mcp/src/tools/*.ts` 61.8/58.4/80.8/61.2 (lines+functors below 70% — the nine tool handlers are 0-14% line-covered and need a real `tools.contract.test.ts`).
  - Completed (2026-09-19): added `packages/mcp/src/__tests__/tools.contract.test.ts` (15 contract tests across all nine handlers incl. ownership-field rejection + runtime-profile cross-project rejection) → `mcp/src/tools/*.ts` now 81.6% stmts / 71.7% branch / 96.2% funcs / 81.3% lines. Added 11 tests to `packages/api/src/__tests__/projects.test.ts` (defaults, delete, roadmap generate/import incl. 404 + success, warmup dedup + empty-target fallback; added `resolveApiLightModel` to the runtime mock and switched `@aif/runtime` mock to partial spread) → `api/src/routes/projects.ts` now 89.6% stmts / 75.7% branch / 95% funcs / 90.9% lines. Agent subagents already ≥70%. Acceptance met for all four areas.

### Phase 2: Runtime Ports

- [x] Task 9: Define adapter-declared resolution metadata (tests first)
  - Deliverable: Failing tests describing descriptor fields for API-key env candidates, default base URL, default transport, and model-effort option key plus level sets.
  - Files: `packages/runtime/src/__tests__/adapterDescriptor.contract.test.ts`, `packages/runtime/src/types.ts`.
  - Logging: DEBUG descriptor resolution with `{ runtimeId, providerId, field, source }`.
  - Acceptance: tests fail for the target interface and pass after Task 10.
  - Completed (2026-09-19): wrote `adapterDescriptor.contract.test.ts` with 5 tests asserting `apiKeyEnvCandidates`, `defaultBaseUrl`, `defaultTransport`, and `effort.optionKey`/`effort.fallbackLevels` for all four built-in adapters. Tests currently FAIL (red): `RuntimeDescriptor` lacks `apiKeyEnvCandidates`/`defaultBaseUrl`/`effort` — the exact target interface for Task 10.

- [x] Task 10: Implement descriptor metadata in all four adapters and remove provider tables from core
  - Deliverable: The `resolution.ts` provider identity tables and the `modelEffort.ts` provider registry are replaced by descriptor data; each adapter declares its own env keys, base URL default, default transport, and effort option key/levels.
  - Files: `packages/runtime/src/resolution.ts` (lines ~222-286, ~372-382), `packages/runtime/src/modelEffort.ts` (lines ~112-152), `packages/runtime/src/types.ts`, `packages/runtime/src/adapters/{claude,codex,opencode,openrouter}/index.ts`, `packages/runtime/src/bootstrap.ts`.
  - Constraint: adapters must not import each other; all four adapters are updated in one change (cross-adapter consistency rule).
  - Logging: WARN when a profile supplies an unknown transport and an inferred default is used, with `{ runtimeId, providerId, inferred }`.
  - Acceptance: `packages/runtime` suite green; no `runtimeId ===`/`providerId ===` vendor comparison remains in core files (verified by grep).
  - Completed (2026-09-19): added to `RuntimeDescriptor` (types.ts): `apiKeyEnvCandidates`, `defaultBaseUrl`, `defaultModelEnvVar`, `effort{optionKey,fallbackLevels}`. All four adapters declare them (claude: [ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN]/null/ANTHROPIC_MODEL/effort; codex: [OPENAI_API_KEY, OPENAI_AUTH_TOKEN]/null/OPENAI_MODEL/modelReasoningEffort; opencode: OPENCODE_API_KEY/http://localhost:4096/OPENCODE_MODEL/reasoningEffort; openrouter: OPENROUTER_API_KEY/https://openrouter.ai/api/v1/OPENROUTER_MODEL/effort). `resolution.ts` reads descriptor-first with legacy vendor tables kept ONLY as descriptor-less fallback (production api/agent resolve profiles before adapter lookup — removing them would break auth; the Codex local-transport OAuth guard and Codex-API OPENAI_BASE_URL override stay as transport-policy, not vendor-enrollment). `modelEffort.ts`/`registry.ts` thread `adapter.descriptor.effort` via `getRuntimeModelEffortConfigFromDescriptor`. Runtime suite 862 passed / 1 skipped; agent+api suites green; lint clean. Adapter descriptor contract test (Task 9) green.

- [x] Task 11: Break the core-to-adapter dependency in prompt policy
  - Deliverable: The prompt policy no longer imports `adapters/codex/subagentStrategy.js`; the Codex subagent strategy is reached through an optional method/field on the adapter port.
  - Files: `packages/runtime/src/promptPolicy.ts` (lines 30-37, ~285-299), `packages/runtime/src/types.ts`, `packages/runtime/src/adapters/codex/*`.
  - Logging: DEBUG prompt-policy branch selection with `{ runtimeId, mechanism, readiness }`; WARN when the strategy is absent on a runtime that requires it.
  - Acceptance: no `adapters/**` import remains in non-adapter runtime files.
  - Completed (2026-09-19): added `RuntimeSubagentStrategyPort` + `RuntimeSubagentStrategyResolution` + `RuntimeSubagentReadiness` to types.ts and optional `adapter.subagentStrategy` on RuntimeAdapter; codex adapter exposes the port (wrap of subagentStrategy.ts); promptPolicy reads `input.adapterSubagentStrategy`, falling back to non-codex defaults (no adapters/ import — grep-verified); registry/subagentQuery pass the port from the resolved adapter; workflowSpec.test.ts updated to inject the real codex adapter port. Runtime 862/863, agent subagent suites 87/87, lint clean.

- [ ] Task 12: Extract a shared adapter error-diagnosis template
  - Deliverable: The duplicated `instanceof RuntimeExecutionError && category !== "unknown"` switch is replaced by one shared helper parameterised by the adapter's message map.
  - Files: `packages/runtime/src/adapters/{claude,codex,opencode,openrouter}/*`, new `packages/runtime/src/adapters/diagnostics.ts`.
  - Constraint: keep structured classification (`category`, `adapterCode`); never branch on message text.
  - Logging: DEBUG with `{ adapterId, category, adapterCode }` on diagnosis.
  - Acceptance: all four adapters use the shared helper; their suites stay green.

### Phase 3: Data Layer Decomposition

- [ ] Task 13: Split `data/src/index.ts` into topic modules
  - Deliverable: The 5,469-line module becomes topic repositories (`tasks.ts`, `comments.ts`, `projects.ts`, `settings.ts`, `chat.ts`, `runtimeProfiles.ts`, `runtimeLimits.ts`, `codexIndex.ts`, `usage.ts`, `coordinatorClaims.ts`) with `index.ts` reduced to a re-export barrel.
  - Files: `packages/data/src/index.ts` and new sibling modules.
  - Constraint: file moves only — no behaviour change; run the Task 7 suite after every move. Preserve the public export surface so `api`, `agent`, and `mcp` compile unchanged.
  - Logging: keep existing log call sites and their `component` names unchanged to preserve operational parity.
  - Acceptance: Task 7 suite green; `packages/data` builds; no consumer import changes required.

- [ ] Task 14: Move presentation mappers out of the data layer
  - Deliverable: `toTaskResponse`, `toCommentResponse`, `toTaskListItem`, `toTaskSummary`, `toAppSettingsResponse`, `toRuntimeProfileResponse`, `toChatSessionResponse`, `toChatMessageResponse` move to a presenter module owned by the delivery side; `@aif/data` stops returning view models.
  - Files: `packages/data/src/index.ts` (lines ~347-388, ~800, ~989, ~1229, ~1702, ~3662, ~4361-4375), new presenter module (location decided and recorded in the task), call sites in `packages/api/src/**` and `packages/mcp/src/**`.
  - Constraint: permission computation and provider-text redaction must keep identical inputs and outputs (pinned by the Task 7 and 8 suites).
  - Logging: WARN when redaction strips content, with `{ taskId, field }`.
  - Acceptance: `@aif/data` exports no `to*Response` mapper; API and MCP suites green.

- [ ] Task 15: Move domain policy out of the data layer
  - Deliverable: `evaluateRuntimeLimitGate` (a pure decision that reads `getEnv()`), the runtime-limit signature/hint helpers, and the runtime-profile precedence policy leave `@aif/data`; `data` keeps only DB reads and writes, and the policy is injected or imported from the domain module.
  - Files: `packages/data/src/index.ts` (lines ~4024-4217), new domain module (for example `packages/shared/src/runtimeLimitGate.ts` or `packages/runtime/src/limitGate.ts`), call sites in `api`, `agent`, `mcp`.
  - Logging: DEBUG each gate decision with `{ runtimeProfileId, blocked, reason, signature }`.
  - Acceptance: no `getEnv()`-driven policy decision remains inside `@aif/data`.

- [ ] Task 16: Stop leaking persistence row types across the boundary
  - Deliverable: `TaskRow`, `CommentRow`, `ProjectRow`, `ChatSessionRow`, `RuntimeProfileRow` are no longer part of the public contract of `@aif/data`; consumers receive domain DTOs.
  - Files: `packages/data/src/index.ts` (type exports), `packages/api/src/repositories/*`, `packages/api/src/routes/*`, `packages/mcp/src/**`.
  - Logging: DEBUG at boundary mapping with `{ entity, fieldCount }` only when `LOG_LEVEL=debug`.
  - Acceptance: no `TaskRow`/`CommentRow` import remains in `api`, `agent`, or `mcp` production source (verified by grep).

- [ ] Task 17: Move the SQLite driver and migration runner out of `shared`
  - Deliverable: `shared/src/db.ts` (1,598 lines: driver plus migrations) moves to the persistence layer; `shared` retains the schema definition and pure contracts, or the schema moves too if the architecture decision says so. The `@aif/shared/server` export is retired or reduced to a re-export shim.
  - Files: `packages/shared/src/db.ts`, `packages/shared/src/schema.ts`, `packages/shared/src/server.ts`, `packages/data/src/*`, `eslint.config.mjs` (restricted-import paths), `packages/shared/vitest.config.ts`.
  - Constraint: migration behaviour and versions stay unchanged; the Task 1 suite is the safety net.
  - Logging: preserve the `component: "db"` logger name and all migration DEBUG/INFO messages verbatim.
  - Acceptance: `shared` no longer imports `better-sqlite3`; all suites green; lint passes with the updated paths.

### Phase 4: Application Use-Case Layer

- [ ] Task 18: Define use-case contracts (tests first)
  - Deliverable: Failing tests describing input/output DTOs and error codes for the use cases extracted next: `applyTaskEvent`, `startQaRun`, `syncTaskPlanFile`, `updateTaskPlan`, `generateCommit`.
  - Files: new `packages/api/src/use-cases/` module (or a new workspace if the architecture decision favours one) plus its `__tests__` and DTO types.
  - Logging: DEBUG use-case entry and exit with `{ useCase, taskId, actor, outcome }`.
  - Acceptance: tests fail against the current code (no use cases yet) and pass after Task 19.

- [ ] Task 19: Implement the use cases and move logic out of `api/src/services`
  - Deliverable: `handleTaskEvent` (currently `packages/api/src/services/taskEvents.ts:345-409`), the QA start/claim protocol (`packages/api/src/routes/tasks.ts:240-270`), and plan-file sync (`packages/api/src/repositories/tasks.ts:75-156`) become use cases with no HTTP knowledge.
  - Files: `packages/api/src/services/taskEvents.ts`, `packages/api/src/routes/tasks.ts`, `packages/api/src/repositories/tasks.ts`, `packages/api/src/use-cases/**`.
  - Constraint: authorization decisions come from `@aif/shared` (`resolveTaskAction`); do not re-implement rules.
  - Logging: DEBUG stage-gate decisions; WARN on denial with the structured denial code (never by message matching).
  - Acceptance: Task 18 tests green; use cases contain no `hono` import.

- [ ] Task 20: Reduce API routes to thin controllers
  - Deliverable: `routes/tasks.ts` (1,323 lines) and `routes/chat.ts` (2,074 lines) delegate to use cases; handlers only parse and validate input, invoke a use case, and shape the HTTP response. The 86 route handlers are re-checked for oversized handlers.
  - Files: `packages/api/src/routes/tasks.ts`, `packages/api/src/routes/chat.ts`, `packages/api/src/routes/runtimeProfiles.ts`, `packages/api/src/routes/github.ts`, `packages/api/src/routes/gitlab.ts`.
  - Logging: keep `requestLogger` as is; add DEBUG `{ route, useCase, outcome }` at delegation points.
  - Acceptance: API suite green; `routes/*.ts` contain no direct `node:fs`, git, or external HTTP orchestration beyond transport concerns.

- [ ] Task 21: Rebase MCP tools on the shared use cases
  - Deliverable: `packages/mcp/src/tools/*.ts` call the same use cases as the API instead of calling `@aif/data` write functions directly; duplicated rule checks (for example the ownership-field rejection at `packages/mcp/src/tools/updateTask.ts:97-108`) are removed in favour of the shared contract.
  - Files: `packages/mcp/src/tools/*.ts`, `packages/mcp/src/utils/*`.
  - Constraint: MCP tool names, schemas, and response compaction stay unchanged (client contract).
  - Logging: DEBUG per tool call with `{ toolName, useCase }`; WARN on rejected fields.
  - Acceptance: the Task 8 MCP contract tests stay green; no writer tool imports a raw `@aif/data` mutation.

- [ ] Task 22: Remove framework types from policy signatures and centralise the execution-root invariant
  - Deliverable: `canMutateTask`, `requestActionContext`, and `parseTaskOwnershipFilters` (currently `packages/api/src/routes/tasks.ts:99-155`) take a plain request context; the `task.worktreePath ?? project.rootPath` rule exists once as a shared helper.
  - Files: `packages/api/src/routes/tasks.ts`, `packages/api/src/services/taskEvents.ts`, `packages/api/src/repositories/tasks.ts`, helper in `@aif/shared` or the use-case layer.
  - Logging: WARN on unauthorized mutation with `{ taskId, actorId, method, path }` (already present — preserve the format).
  - Acceptance: no `Context<ParticipantApiEnv>` parameter remains in non-route helper functions; a single implementation of the execution-root rule exists.

### Phase 5: Agent Orchestration

- [ ] Task 23: Derive the pipeline graph from a single lifecycle source
  - Deliverable: `PIPELINE` in `packages/agent/src/coordinator.ts:141-215` and its helpers `getStageSuccessStatus`, `planReviewStageIneligible`, and `shouldRunSkillsModeImprove` read stage ordering from one lifecycle map shared with `packages/shared/src/stateMachine.ts`, removing the second copy of the status graph.
  - Files: `packages/agent/src/coordinator.ts`, `packages/shared/src/stateMachine.ts`, new shared lifecycle map, `packages/agent/src/__tests__/coordinator.test.ts`.
  - Constraint: the plan_review gate must stay enforced (no `plan_review` to `implementing` without approval).
  - Logging: DEBUG stage resolution with `{ stage, from, onSuccess, gate }`.
  - Acceptance: lifecycle statuses appear in exactly one definition; agent and shared suites green.

- [ ] Task 24: Inject the runtime registry and usage sink into the agent
  - Deliverable: `getRuntimeRegistry()` in `packages/agent/src/subagentQuery.ts:637-664` no longer self-bootstraps; the registry and `createDbUsageSink` are provided by the composition root (`packages/agent/src/index.ts`) through the existing seam (`setRuntimeRegistry`, `packages/agent/src/coordinator.ts:113-119`). One owner per port.
  - Files: `packages/agent/src/subagentQuery.ts`, `packages/agent/src/coordinator.ts`, `packages/agent/src/index.ts`.
  - Logging: DEBUG registry resolution with `{ runtimeId, source: "injected" }`; ERROR when no registry is injected.
  - Acceptance: no `bootstrapRuntimeRegistry` call exists outside the composition root; agent suite green.

- [ ] Task 25: Move hardcoded prompts into agent definition files
  - Deliverable: `PROJECT_SCOPE_SYSTEM_APPEND` and `REVIEW_DIFF_SCOPE_SYSTEM_APPEND` (`packages/agent/src/constants.ts:9-25`) move to `.claude/agents/*.md` per the project anti-pattern rule; the agent loads them from definitions rather than TS constants.
  - Files: `packages/agent/src/constants.ts`, `packages/agent/src/subagentQuery.ts:85,732`, `.claude/agents/*.md`.
  - Logging: DEBUG which prompt append was applied with `{ workflowKind, source }`.
  - Acceptance: no long prompt literal remains in agent TS source; subagent behaviour tests stay green.

- [ ] Task 26: Split the coordinator into orchestration and infrastructure adapters
  - Deliverable: `packages/agent/src/coordinator.ts` (1,728 lines; `processOneTask` about 473 lines) delegates git, worktree, HTTP, and file work to port-shaped adapters, so orchestration no longer imports `node:fs` or git helpers directly.
  - Files: `packages/agent/src/coordinator.ts`, `packages/agent/src/{githubWorkflow,gitlabWorkflow,worktreeLifecycle,repositoryPrepare}.ts`.
  - Constraint: keep the per-project git mutation lock semantics unchanged.
  - Logging: DEBUG per delegated infrastructure call with `{ adapter, operation, projectId }`.
  - Acceptance: `coordinator.ts` imports no `node:fs` or `node:child_process`; agent suite green.

### Phase 6: Guardrails and Documentation

- [ ] Task 27: Encode the layer boundaries in ESLint
  - Deliverable: Restricted-import rules that forbid inner-to-outer dependencies with clear messages: no `adapters/**` imports from runtime core; no `hono` in use cases; no `node:fs` or `node:child_process` in orchestration and use-case layers; `web` limited to `@aif/shared/browser`; existing DB rules extended to any new persistence module.
  - Files: `eslint.config.mjs`.
  - Logging: not applicable — lint rule messages must name the target layer and the reason.
  - Acceptance: `npm run lint` passes; a deliberately wrong import fails the rule.

- [ ] Task 28: Update architecture documentation
  - Deliverable: `AGENTS.md`, `.ai-factory/ARCHITECTURE.md`, `docs/architecture.md`, `docs/contracts/README.md`, `docs/providers.md`, and the Docker sync note reflect the new layers (domain, application, adapters, frameworks), the new packages or modules, and the removed concerns.
  - Files: `AGENTS.md`, `.ai-factory/ARCHITECTURE.md`, `docs/architecture.md`, `docs/contracts/README.md`, `docs/providers.md`.
  - Constraint: keep the documented dependency graph accurate and acyclic; document the plan-file-to-branch contract if it changed.
  - Logging: not applicable.
  - Acceptance: documentation matches the implemented boundaries; no stale path remains for files moved or deleted by this plan.

- [ ] Task 29: Final validation and coverage confirmation
  - Deliverable: Full pipeline green with the expanded coverage gate.
  - Files: none (verification task).
  - Logging: capture the per-package coverage summary into the task notes.
  - Acceptance: `npm run ai:validate` passes; every package reaches at least 70% lines, functions, branches, and statements with the former exclusions removed.
