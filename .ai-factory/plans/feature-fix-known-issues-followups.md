# Implementation Plan: Known Issues Stabilization Follow-ups

Branch: feature/fix-known-issues-followups
Created: 2026-09-19

## Settings
- Testing: yes (TDD — every behavior change starts with a reproducer/regression test)
- Logging: verbose
- Docs: yes

## Roadmap Linkage
Milestone: "none"
Rationale: This plan addresses stabilization and maintenance follow-ups; no open roadmap milestone directly maps to this scope.

## Research Context
Source: `.ai-factory/RESEARCH.md` (Active Summary) + `docs/known-issues.md`

Goal: Eliminate high-value operational and quality risks from known issues without reversing accepted architecture decisions.

Constraints:
- Keep the DB boundary via `@aif/data`.
- Preserve clean-architecture layer rules and ESLint boundaries.
- Migration numbering remains append-only.
- Keep every package coverage metric >= 70%.
- Do not change MCP/API external contracts.
- Blocking validation gate for this plan is the deterministic subset of `npm run ai:validate`: `format:check`, `lint`, `test`, `coverage`, `build`, `ai:protocol`. The `ai:perf` and `ai:load` stages are environment-gated and documented flaky on local Windows (`docs/known-issues.md`); they are reported separately and are not blocking evidence.
- Tests and implementation annotations carry the known-issues entry name for traceability (project RULES: requirements -> tests -> code).

Non-goals (accepted decisions — do not reverse in this plan):
- MCP `handoff_push_plan` writes the plan field while API `updateTaskPlan` writes the plan file — documented as two contracts.
- Shared managed task operations live in `@aif/data/taskOperations.ts` (MCP deploys independently of API).
- Moved parsers log with `component: "shared"` instead of `"data"`.
- Usage broadcasts are owned by the composition-root usage sink injected via `setRuntimeRegistry`.
- `schema.ts` shows 0% coverage in shared's own report while behavior is covered in `@aif/data`.
- `ai:perf` budget flakiness is environment-gated, not a product defect.

Verified evidence (branch state, 2026-09-19):
- `packages/agent/src/repositoryPrepare.ts:282,286,304` — repo-scope credential helper plus two `--global` writes (`credential.helper`, `--add safe.directory`); the global scope is deliberate (submodule clone inheritance, see comment at `:283-285`).
- `packages/agent/src/__tests__/gitTestUtils.ts` — existing `createGitTestRoot` helper using `mkdtempSync`; reusable for unique per-test roots.
- `packages/data/src/github.ts:454-457` and `packages/data/src/gitlab.ts:492-495` — `"[FIX] … sync skipped unchanged task row …"` DEBUG messages.
- `packages/agent/src/coordinator.ts:875-883` and `:1641-1644` — `[FIX]` / `[FIX:149]` messages.
- `packages/data/src/tasks.ts:48` — `export { parseTaskCurrentTool } from "@aif/shared"`; consumer at `packages/agent/src/notifier.ts:18` imports it from `@aif/data`; `packages/agent/src/__tests__/stageErrorHandler.test.ts:15-19` mocks it via `@aif/data`.
- `packages/shared/src/presenters.ts:73-114,116-150` vs `packages/data/src/tasks.ts:358-368,476-486` and `packages/data/src/usage.ts:212-215` — duplicated projection type definitions (`hasPlan` required on the list row; `assignees?` on the summary row).
- `packages/api/src/routes/tasks.ts:73-77,234` (env-derived `QA_LOCK_DURATION_MS`) vs `packages/api/src/use-cases/qaRun.ts:27` (`lockDurationMs = 60 * 1000` default).
- `packages/agent/src/agentScopeRules.ts:48-54` — `process.cwd()`-based definitions directory with `AIF_AGENT_DEFINITIONS_DIR` override and a process cache.
- `eslint.config.mjs:119-135` — explicit runtime-core file list (manual maintenance).
- No test currently pins the `[FIX]` message text (grep-verified), so the known-issues rationale "Task 8-сьюты закрепили их текст" is inaccurate; Task 11 corrects the record.

## Commit Plan
- **Commit 1** (after tasks 1-2): `test(agent): isolate git config and stabilize git test suite`
- **Commit 2** (after tasks 3-5): `chore(logging): remove fix prefixes and guard against log markers`
- **Commit 3** (after tasks 6-8): `refactor(api,data): remove transitive export and dedupe projection types`
- **Commit 4** (after tasks 9-10): `chore(runtime,agent): harden scope-rules resolution and lint guard`
- **Commit 5** (after tasks 11-12): `docs: refresh known-issues statuses and validation evidence`

## Tasks

### Phase 1: Agent test determinism

- [x] Task 1: Isolate global git-config writes in agent prepare tests
  - Deliverable: `prepareRepository` tests no longer write to the developer's real global git config; a shared test helper points git at a per-test temp config.
  - Files: `packages/agent/src/__tests__/gitTestUtils.ts`, `packages/agent/src/__tests__/gitlabPrepare.test.ts`, `packages/agent/src/repositoryPrepare.ts` (only if a resilient global write is introduced).
  - Constraint: production global scope stays (`--global` is deliberate for submodule clone inheritance, `repositoryPrepare.ts:283-285`); isolation is test-side via `GIT_CONFIG_GLOBAL`/`HOME` pointed at a temp dir. If the global write is made resilient, it must be opt-in via env, never a silent default.
  - Logging: WARN when a global write is skipped/failed and execution continues; DEBUG `{ projectId, provider, configScope: "repo"|"global", testMode }`.
  - Acceptance: reproducer test first — the `gitlabPrepare.test.ts` case `does not duplicate origin when already present` passes 5/5 consecutive runs with the sandboxed config; `~/.gitconfig` mtime is unchanged after the suite.

- [x] Task 2: Eliminate shared temp-dir and git races in agent git tests
  - Deliverable: git-heavy agent suites use unique per-test roots through the existing helper, removing cross-file races.
  - Files: `packages/agent/src/__tests__/gitTestUtils.ts`, `packages/agent/src/__tests__/gitlabPrepare.test.ts`, `packages/agent/src/__tests__/gitBranch.test.ts`, `packages/agent/src/__tests__/gitConventions.test.ts`, `packages/agent/src/__tests__/planReviewPublisher.test.ts`, `packages/agent/src/__tests__/implementer.test.ts`, `packages/agent/src/__tests__/improver.test.ts`.
  - Constraint: reuse `createGitTestRoot` instead of ad-hoc `mkdtempSync`; if a race persists, scope `fileParallelism` to git-heavy files in `packages/agent/vitest.config.ts` rather than disabling it globally.
  - Logging: DEBUG `{ testFile, tempDir, gitRoot }` per sandbox at `LOG_LEVEL=debug`.
  - Acceptance: `npm run test --workspace=@aif/agent` green on 3 consecutive full runs; each test asserts it operates only inside its own temp root.

### Phase 2: Logging hygiene and regression guard

- [x] Task 3: Remove `[FIX]`/`[FIX:*]` markers from coordinator production logs
  - Deliverable: coordinator log messages use neutral, stable event wording; severity and structured fields unchanged.
  - Files: `packages/agent/src/coordinator.ts` (lines ~875-883, ~1641-1644), `packages/agent/src/__tests__/coordinator.test.ts` (if it asserts text).
  - Logging: keep the pino `err` key for errors; messages become e.g. `"Approved plan was not implemented; scheduling another implementation attempt"`, `"Implementation produced no files after corrective retry; keeping task in implementing"`, `"Failed to release coordinator task claim"`.
  - Acceptance: grep for `\[FIX` in `packages/agent/src` excluding tests = 0 matches; a regression test asserts the neutral message with `{ taskId, stage }` fields.

- [x] Task 4: Remove `[FIX]` markers from GitHub/GitLab sync logs
  - Deliverable: data-layer sync debug messages use neutral wording.
  - Files: `packages/data/src/github.ts:454-457`, `packages/data/src/gitlab.ts:492-495`, dependent tests if any.
  - Logging: preserve `{ projectId, issueNumber|iid, taskId }`; message becomes `"Sync skipped unchanged task row to avoid masking stale-claim recovery"`.
  - Acceptance: grep for `\[FIX` in `packages/data/src` = 0 matches; DEBUG output is unchanged apart from the message text.

- [x] Task 5: Add a repository guard against ticket-style log markers
  - Deliverable: an automated check fails when `[FIX]`/`[FIX:*]`-style markers appear in production source strings.
  - Files: `scripts/check-log-markers.mjs` (new), `package.json` (`ai:validate` chain).
  - Constraint: scan non-test TS sources under `packages/*/src/**`, skipping `__tests__`; allow an explicit inline opt-out comment for justified cases.
  - Logging: not applicable; the script prints offending `file:line` and exits non-zero.
  - Acceptance: the script fails on a temp fixture containing a marker and passes after Tasks 3-4; wired into the `ai:validate` chain.

### Phase 3: Contract cleanup and boundary tightening

- [x] Task 6: Remove the transitive `parseTaskCurrentTool` re-export from `@aif/data`
  - Deliverable: the agent imports the parser from `@aif/shared`; the data-layer re-export is gone.
  - Files: `packages/agent/src/notifier.ts:18`, `packages/data/src/tasks.ts:48`, `packages/agent/src/__tests__/stageErrorHandler.test.ts:15-19`.
  - Constraint: `stageErrorHandler.test.ts` mocks `parseTaskCurrentTool` through `@aif/data`; after the move, either move that key to a `@aif/shared` partial mock or drop it, while keeping the `findTaskById`/`appendTaskActivityLog` stubs.
  - Logging: unchanged.
  - Acceptance: reproducer test first (parser resolves from `@aif/shared`; `@aif/data` no longer exports it); production imports of `parseTaskCurrentTool` from `@aif/data` = 0.

- [x] Task 7: Consolidate duplicated projection type definitions
  - Deliverable: `TaskListItemRow`, `TaskSummaryRow`, and `RuntimeProfileUsageState` have a single definition in `@aif/shared`; `@aif/data` imports them.
  - Files: `packages/shared/src/presenters.ts:73-114,116-150`, `packages/data/src/tasks.ts:358-368,476-486`, `packages/data/src/usage.ts:212-215`, `docs/contracts/data/data-layer.md`.
  - Constraint: preserve the recorded Task 16 decision — the types stay *exported* by `@aif/data` as result shapes; only the *definition* moves. Verify shape requirements: the list row requires `hasPlan: boolean | number`, the summary row carries `assignees?: TaskAssigneeSummary[]`, and `TASK_LIST_COLUMNS` must still satisfy the imported type.
  - Logging: not applicable.
  - Acceptance: reproducer test first (compile-time assertion that data's exported types match the shared definitions); zero duplicate `Pick<TaskRow, ...>` declarations remain; data/shared/api/mcp suites green; contract doc updated.

- [x] Task 8: Canonicalize the QA lock duration in `startQaRun`
  - Deliverable: one source of truth for the QA lock duration; no hidden default divergence.
  - Files: `packages/api/src/use-cases/qaRun.ts:27`, `packages/api/src/routes/tasks.ts:73-77,234`, `packages/api/src/__tests__/useCases.contract.test.ts`.
  - Constraint: chosen approach — the use case derives the duration from `getEnv()` using the existing formula and the route stops passing it. The alternative (mandatory parameter with no default) is acceptable only if the derivation stays in exactly one place.
  - Logging: DEBUG `{ useCase: "startQaRun", taskId, lockDurationMs, source: "env" }`.
  - Acceptance: reproducer test first (resolved duration equals the env-derived formula; no caller-supplied default can diverge); the route no longer holds a second copy of the formula.

### Phase 4: Robustness of config/rules plumbing

- [x] Task 9: Harden `agentScopeRules` resolution against cwd drift
  - Deliverable: scope rules resolve deterministically regardless of process cwd.
  - Files: `packages/agent/src/agentScopeRules.ts:48-54`, `packages/agent/src/__tests__/agentScopeRules.test.ts`, `docs/configuration.md`.
  - Constraint: keep `AIF_AGENT_DEFINITIONS_DIR` as the highest-priority override; add a module-anchored fallback (resolve from the module location upward to the repo root) instead of relying on `process.cwd()`; keep the process cache and its reset helper.
  - Logging: DEBUG `{ source: "env"|"module-anchor"|"cwd", resolvedPath }`; WARN only when every strategy fails.
  - Acceptance: reproducer test first (load rules with cwd set to a temp dir and `AIF_AGENT_DEFINITIONS_DIR` unset; assert non-empty rules via the module anchor); env override still wins; cache reset honored.

- [x] Task 10: Make the runtime-core ESLint guard resilient to new core files
  - Deliverable: adding a new runtime-core file cannot silently bypass the adapter-import ban.
  - Files: `eslint.config.mjs:119-135`, new shared list module (e.g. `eslint/runtimeCoreFiles.mjs`), new guard test under `packages/runtime/src/__tests__/`.
  - Constraint: keep ban semantics and messages unchanged; the file list becomes a single imported source consumed by both the ESLint config and the guard test.
  - Logging: not applicable.
  - Acceptance: reproducer test first (a temp core file absent from the list is reported by the guard test); `npm run lint` still passes; the guard test fails when a core file is missing from the list.

### Phase 5: Documentation and verification

- [x] Task 11: Refresh known-issues statuses and correct inaccuracies
  - Deliverable: `docs/known-issues.md` reflects the branch state, and incorrect rationale is corrected.
  - Files: `docs/known-issues.md`.
  - Constraint: correct the `[FIX]`-prefixes entry — no test currently pins the `[FIX]` message text (grep-verified), so the "Task 8-сьюты закрепили их текст" rationale is inaccurate; record the actual verification command.
  - Logging: not applicable.
  - Acceptance: every targeted entry is marked resolved or mitigated with a date, evidence command, and outcome; no stale "open" status remains for completed fixes.

- [x] Task 12: Final validation with the deterministic gate
  - Deliverable: validation evidence for the branch under the deterministic subset, plus separate reporting of environment-gated stages.
  - Files: none (verification task).
  - Constraint: blocking acceptance is `format:check`, `lint`, `test`, `coverage`, `build`, `ai:protocol`; `ai:perf` and `ai:load` are reported separately with the known-issues reference.
  - Logging: keep existing validation output; summarize any failure with the exact command and root cause.
  - Acceptance: deterministic subset green; coverage >= 70% for every touched package; environment-gated stage results reported with known-issues references.
