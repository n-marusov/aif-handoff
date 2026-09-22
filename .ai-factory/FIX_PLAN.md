# Fix Plan: Known issues remediation with BR/FR/NFR-traceable regressions

**Problem:** `docs/known-issues.md` contains open and accepted gaps between requirements, implementation, and test coverage; remediation requires deterministic fixes and full regression-test traceability to BR/FR/NFR.
**Created:** 2026-09-22 05:28

## Analysis

- Root-cause clusters:
  - Requirement/implementation drift in dashboard GUI (comments composer, kanban column semantics, reorder UX expectations).
  - Environment-coupled E2E scenarios (participants mode disabled on dev stand, infra health checks without user-story trace).
  - Contract drift after architectural refactors (task operations in `@aif/data`, `pushPlan` contract, runtime-profile validation wording, usage-broadcast ownership).
  - Agent orchestration gaps (done-rework path not routed to `$aif-fix`, missing `$aif-evolve` trigger after fix-patch accumulation).
  - Observability noise and race behavior in GitLab/QA lanes (legacy project fetch noise, broadcast 404 after deletion).
- Impact scope:
  - `packages/web` (task details/comments, board rendering and E2E).
  - `packages/api` + `packages/mcp` (plan persistence and validation contract paths).
  - `packages/agent` (coordinator/notifier/subagent orchestration and runtime usage propagation).
  - `packages/shared`/`packages/data` tests for schema/contracts/coverage.
  - `docs/known-issues.md` and requirements trace artifacts.
- Quality constraints:
  - Regression tests must include explicit requirement IDs (BR/FR/NFR) in test metadata/comments.
  - Coverage floor per package must remain >= 70%.
  - Validation path must include deterministic suite + `npm run ai:validate`.

## Fix Steps

1. [x] Build requirements trace matrix baseline
   - Create `docs/qa/traceability/known-issues-trace-matrix.md` (or update existing QA trace index) with one row per known issue.
   - For each issue, bind at least one BR ID, one FR ID, and one NFR ID.
   - Add canonical test IDs (`KI-01`..`KI-15`) and target test files.

2. [x] KI-01: Add UI comment composer in task details and cover with GUI/API regressions
   - Implement comment composer in `TaskDetail`/`TaskComments` using existing UI primitives.
   - Wire to existing `POST /tasks/:id/comments` flow and optimistic refresh.
   - Add tests:
     - Component test for compose/send/disabled/error states.
     - GUI E2E flow “create comment from detail panel” and verify persisted render after reload.
   - Trace anchors: BR-fact.audit.observability; REQ-FR-dashboard.detail.display-task-details; REQ-NFR-api.compliance.request-validation.

3. [x] KI-02 + KI-04: Align kanban/list scenarios with actual state model and reorder capability
   - Decide and implement one source-of-truth path:
     - Option A: keep 10 statuses and update requirement docs + test fixtures.
     - Option B: introduce explicit `plan_ready` status in state model and UI.
   - Keep reorder behavior explicit as backlog button-based reorder until drag-and-drop is implemented.
   - Add regressions:
     - GUI spec validating rendered column labels against `STATUS_CONFIG`.
     - GUI/API spec validating backlog reorder buttons and persistence.
     - Negative spec proving drag-and-drop reorder is unavailable (documented expectation) until implemented.
   - Trace anchors: BR-fact.task-lifecycle.stages; REQ-FR-dashboard.board.render-kanban-columns; REQ-NFR-data.compliance.task-state-persistence.

4. [x] KI-03 + KI-05: Make E2E auth/roles and health-check behavior environment-aware and deterministic
   - Add env-aware branching in E2E:
     - When `PARTICIPANTS_MODE_ENABLED=true`: run full L-08/L-06 flows.
     - When disabled: run explicit disabled-mode assertions with stable skip/xfail reason tags.
   - Keep `L-01d` as infra smoke with explicit non-US classification in trace matrix.
   - Add regressions:
     - `participants-mode` matrix test for both enabled and disabled modes.
     - Health smoke test classification assertion (infra-only, non-US).
   - Trace anchors: BR-constraint.auth.sessions + BR-fact.auth.roles; REQ-FR-auth.registration.sign-up-participant + REQ-FR-auth.roles.assign-participant-role; REQ-NFR-security.compliance.session-auth.

5. [x] KI-06 + KI-07 + KI-08: Stabilize observability + shared-schema coverage + perf gate policy
   - KI-06: Preserve/normalize `component` semantics for migrated parsers (`data` vs `shared`) with explicit compatibility test.
   - KI-07: Add lightweight shared contract test importing `schema.ts` metadata without DB driver to avoid 0% local artifact.
   - KI-08: Make perf gate deterministic policy explicit:
     - Convert local flaky budgets to retry/median policy for non-blocking lane.
     - Keep strict thresholds in CI profile where hardware baseline is controlled.
   - Add regressions:
     - Logger component compatibility test.
     - Shared schema import/contract test.
     - Perf harness policy test (budget evaluator logic, retry window behavior).
   - Trace anchors: BR-fact.audit.observability; REQ-FR-audit.errors.classify-runtime-error; REQ-NFR-ops.observability.log-level-config + REQ-NFR-ops.observability.telemetry-overhead-budget.

6. [x] KI-09 + KI-10 + KI-11: Consolidate task-operation and MCP plan/validation contracts
   - KI-09: Keep common task operations in `@aif/data` as canonical boundary; remove/avoid duplicate policy logic upstream.
   - KI-10: Harmonize `handoff_push_plan` with canonical plan-file behavior (`persistTaskPlanForTask`) or explicitly codify field-vs-file dual contract behind flag.
   - KI-11: Preserve structured validation code while supporting MCP-facing message compatibility mode if required by clients.
   - Add regressions:
     - Data-layer contract tests for managed operations.
     - MCP tool tests for pushPlan writing expected storage targets.
     - MCP validation tests matching by structured code and expected message policy.
   - Trace anchors: BR-trigger.automation.plan-review-gate + BR-fact.project.runtime-profiles; REQ-FR-runtime.profile.configure-project-runtime + REQ-FR-vcs-auto.plan-review.publish-plan-for-approval; REQ-NFR-data.compliance.task-transactional-consistency + REQ-NFR-ops.observability.tool-error-readability.

7. [x] KI-12 + KI-13 + KI-14: Fix agent orchestration consequences and lifecycle gaps
   - KI-12: Guarantee usage-broadcast propagation for every valid runtime execution path (injected registry path + guarded fallback/diagnostic path).
   - KI-13: Route `done -> implementing` rework via `$aif-fix`-oriented prompt contract while preserving current review-loop semantics.
   - KI-14: Add threshold trigger (`N >= 5` fix patches) for `$aif-evolve` recommendation/run path with config and docs.
   - Add regressions:
     - Agent tests for usage broadcast in coordinator and non-coordinator execution contexts.
     - Coordinator/rework tests asserting `$aif-fix` prompt intent on done-rework transitions.
     - Evolution trigger tests over patch directory counters and debounce behavior.
   - Trace anchors: BR-trigger.task-lifecycle.done-to-accepted + BR-trigger.automation.pipeline; REQ-FR-pipeline.review-loop.iterate-review-feedback + REQ-FR-pipeline.implementation.execute-change-in-isolation; REQ-NFR-api.availability.coordinator-resilience + REQ-NFR-ops.observability.audit-trail-completeness.

8. [x] KI-15 (Defect D/E): Remove legacy-scope noise and harden delete/broadcast race behavior
   - Defect D:
     - Isolate coordinator processing/log emission to test-scoped projects in E2E lane.
     - Add trace/test correlation fields for GitLab E2E (`traceId`, `testId`, `projectScope`).
   - Defect E:
     - Make notifier broadcast idempotent for deleted entities (`already_deleted` reason path), avoid noisy 404 as error for expected race.
   - Add regressions:
     - Agent integration test proving no legacy-project fetch noise in scoped lane.
     - Notifier race test validating idempotent handling after task deletion.
   - Trace anchors: BR-constraint.automation.concurrency + BR-trigger.automation.failure-recovery; REQ-FR-dashboard.realtime.broadcast-live-updates + REQ-FR-audit.logging.record-state-transition; REQ-NFR-integration.compliance.review-event-idempotency + REQ-NFR-ops.observability.error-categorization.

9. [x] Enforce traceability and quality gates across all new/updated tests
   - Add BR/FR/NFR IDs into test titles or structured comments for each `KI-*` case.
   - Update test docs/checklists with requirement mappings.
   - Run targeted suites by package, then full validation:
     - `npm run test --workspace=@aif/shared`
     - `npm run test --workspace=@aif/data`
     - `npm run test --workspace=@aif/api`
     - `npm run test --workspace=@aif/agent`
     - `npm run test --workspace=@aif/mcp`
     - `npm run test --workspace=@aif/web`
     - `npm run ai:validate`

## Files to Modify

- `docs/known-issues.md` — update status/progress and links to executed regression tests.
- `docs/qa/traceability/known-issues-trace-matrix.md` (new or existing) — KI ↔ BR/FR/NFR ↔ test-case mapping.
- `packages/web/src/components/task/TaskComments.tsx` — comment composer UI + integration hooks.
- `packages/web/src/components/task/TaskDetail.tsx` — detail panel wiring for comment submission and refresh.
- `packages/web/src/components/kanban/Board.tsx` and/or `packages/shared/src/constants.ts` — canonical column/status alignment.
- `packages/web/e2e/gui/task-details.spec.ts` — UI comment creation regression.
- `packages/web/e2e/gui/kanban-board.spec.ts` — columns/reorder/expectation regressions.
- `packages/web/e2e/gui/auth-mode.spec.ts` and `packages/web/e2e/participants-mode.spec.ts` — enabled/disabled participant-mode matrix.
- `packages/web/e2e/api/health.spec.ts` — infra-only health-check classification.
- `packages/shared/src/__tests__/` (new schema contract test) — ensure `schema.ts` is covered in shared package.
- `packages/agent/src/coordinator.ts` — done-rework routing and scope filtering hooks.
- `packages/agent/src/subagents/implementer.ts` (or related stage runner) — `$aif-fix` prompt path for done-rework context.
- `packages/agent/src/notifier.ts` — idempotent deleted-task broadcast handling.
- `packages/agent/src/index.ts` and `packages/agent/src/subagentQuery.ts` — usage-broadcast invariants.
- `packages/agent/src/__tests__/coordinator.test.ts` — rework/usage/scope regressions.
- `packages/agent/src/__tests__/notifier.test.ts` — delete/broadcast race regression.
- `packages/mcp/src/tools/pushPlan.ts` — field-vs-file plan persistence decision and implementation.
- `packages/mcp/src/__tests__/tools.test.ts` and/or `taskToolsRuntimeContract.test.ts` — pushPlan and validation-message regressions.
- `packages/data/src/taskOperations.ts` + `packages/data/src/__tests__/` — shared operation contract regressions.
- `packages/web/e2e/perf/*.spec.ts` and related perf helper/config — deterministic local budget policy.

## Risks & Considerations

- Requirement artifact drift risk:
  - Some FR text currently encodes target behavior not fully implemented; plan must decide per issue whether to align code to FR or FR to current accepted architecture.
- Behavioral compatibility risk:
  - `pushPlan` contract changes may impact MCP clients expecting current field-only semantics.
  - Runtime-profile validation text changes may break text-parsing clients; structured-code contract must remain stable.
- Pipeline regression risk:
  - Introducing `$aif-fix` route in done-rework path can alter coordinator stage timing and retry semantics.
- Test stability risk:
  - E2E perf and GitLab integration tests require strict environment isolation to avoid non-deterministic failures.
- Coverage risk:
  - New tests must be distributed by package to keep each package >= 70% coverage.

## Test Coverage

- Traceability policy for every new/updated regression test:
  - Add metadata comment block in each test case/file:
    - `BR: <id[,id...]>`
    - `FR: <id[,id...]>`
    - `NFR: <id[,id...]>`
    - `KI: <known-issue-id>`
- Planned regression matrix:

| KI | Regression test target | BR trace | FR trace | NFR trace |
|---|---|---|---|---|
| KI-01 comments composer missing | `web` component + GUI E2E (`task-details.spec.ts`) | `BR-fact.audit.observability` | `REQ-FR-dashboard.detail.display-task-details` | `REQ-NFR-api.compliance.request-validation` |
| KI-02 columns mismatch vs statuses | GUI E2E (`kanban-board.spec.ts`) + shared constants contract | `BR-fact.task-lifecycle.stages` | `REQ-FR-dashboard.board.render-kanban-columns` | `REQ-NFR-data.compliance.task-state-persistence` |
| KI-03 auth/roles vs participants disabled | GUI/API E2E matrix (`auth-mode.spec.ts`, `participants-mode.spec.ts`) | `BR-constraint.auth.sessions`, `BR-fact.auth.roles` | `REQ-FR-auth.registration.sign-up-participant`, `REQ-FR-auth.roles.assign-participant-role` | `REQ-NFR-security.compliance.session-auth` |
| KI-04 list-view/reorder vs drag-and-drop expectation | GUI E2E + unit tests for reorder controls | `BR-fact.task-lifecycle.stages` | `REQ-FR-dashboard.board.render-kanban-columns` | `REQ-NFR-data.compliance.task-transactional-consistency` |
| KI-05 L-01d infra health-check no US-trace | API E2E (`health.spec.ts`) with infra-tag policy | `BR-fact.audit.observability` | `REQ-FR-dashboard.realtime.broadcast-live-updates` | `REQ-NFR-api.availability.coordinator-resilience` |
| KI-06 logger component changed (`data`->`shared`) | shared/data logging contract tests | `BR-fact.audit.observability` | `REQ-FR-audit.errors.classify-runtime-error` | `REQ-NFR-ops.observability.log-level-config` |
| KI-07 `schema.ts` 0% in shared report | shared schema metadata contract test | `BR-constraint.audit.state-snapshot` | `REQ-FR-audit.logging.record-state-transition` | `REQ-NFR-data.compliance.database-migration-integrity` |
| KI-08 flaky local perf gate | perf harness tests (`web/e2e/perf/*` helpers) | `BR-trigger.automation.pipeline` | `REQ-FR-dashboard.board.render-kanban-columns` | `REQ-NFR-ops.observability.telemetry-overhead-budget` |
| KI-09 task operations live in `@aif/data` | data contract tests (`taskOperations`) + API/MCP integration tests | `BR-trigger.automation.pipeline` | `REQ-FR-pipeline.stage.auto-advance-after-gate` | `REQ-NFR-data.compliance.task-transactional-consistency` |
| KI-10 MCP `pushPlan` writes field not file | MCP tool tests + data persistence tests | `BR-trigger.automation.plan-review-gate` | `REQ-FR-vcs-auto.plan-review.publish-plan-for-approval` | `REQ-NFR-data.compliance.task-state-persistence` |
| KI-11 runtime-profile validation text generalized | MCP validation tests (code-first contract) | `BR-fact.project.runtime-profiles` | `REQ-FR-runtime.profile.configure-project-runtime` | `REQ-NFR-ops.observability.tool-error-readability` |
| KI-12 usage-broadcast tied to injected registry | agent runtime/usage tests (`subagentQuery`, `coordinator`) | `BR-trigger.automation.runtime-limit-gate` | `REQ-FR-dashboard.realtime.broadcast-live-updates` | `REQ-NFR-ops.observability.audit-trail-completeness` |
| KI-13 done-rework uses generic implementer | coordinator/implementer tests for done->implementing rework path | `BR-trigger.task-lifecycle.done-to-accepted` | `REQ-FR-pipeline.review-loop.iterate-review-feedback` | `REQ-NFR-api.availability.coordinator-resilience` |
| KI-14 no `$aif-evolve` auto trigger after 5+ fix patches | skill/evolution trigger tests | `BR-trigger.automation.failure-recovery` | `REQ-FR-pipeline.plan.refine-plan-second-pass` | `REQ-NFR-ops.observability.audit-trail-completeness` |
| KI-15D legacy GitLab noise (`gitlab_prepare_fetch_failed`) | agent integration tests for project-scope filtering and trace correlation | `BR-constraint.automation.concurrency` | `REQ-FR-pipeline.implementation.execute-change-in-isolation` | `REQ-NFR-ops.observability.error-categorization` |
| KI-15E notifier 404 after delete | notifier race/idempotency tests | `BR-trigger.automation.failure-recovery` | `REQ-FR-dashboard.realtime.broadcast-live-updates` | `REQ-NFR-integration.compliance.review-event-idempotency` |

- Exit criteria:
  - Every KI row has at least one passing regression test with BR/FR/NFR annotations.
  - No untraced tests introduced for KI scope.
  - `npm run ai:validate` passes with coverage thresholds preserved per package.
