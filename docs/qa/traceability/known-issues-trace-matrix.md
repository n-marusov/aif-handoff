# Known Issues Trace Matrix

> Canonical KI → BR/FR/NFR → regression test mapping.
> Last updated: 2026-09-22.
> Scope: KI-01..KI-15 from `docs/known-issues.md` and `.ai-factory/FIX_PLAN.md`.

## Legend

- **KI** — known issue identifier from the fix plan.
- **BR / FR / NFR** — requirement anchors used in regression metadata.
- **Primary tests** — main regression or contract tests that must pass.
- **Status**:
  - `planned` — mapped but implementation/tests not yet fully completed,
  - `in_progress` — implementation underway,
  - `done` — fixed and covered by passing regression(s).

## Matrix

| KI     | Problem summary                                                  | BR anchors                                          | FR anchors                                                                                                          | NFR anchors                                               | Primary tests / targets                                                                                                                              | Status |
| ------ | ---------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| KI-01  | Missing UI comment composer in task details                      | `BR-fact.audit.observability`                       | `REQ-FR-dashboard.detail.display-task-details`                                                                      | `REQ-NFR-api.compliance.request-validation`               | `packages/web/src/components/task/TaskComments.tsx`; `packages/web/src/__tests__/TaskComments.test.tsx`; `packages/web/e2e/gui/task-details.spec.ts` | done   |
| KI-02  | Kanban column set mismatch vs expected lifecycle labels          | `BR-fact.task-lifecycle.stages`                     | `REQ-FR-dashboard.board.render-kanban-columns`                                                                      | `REQ-NFR-data.compliance.task-state-persistence`          | `packages/web/e2e/gui/kanban-board.spec.ts`; `packages/web/src/__tests__/Board.test.tsx`; `packages/shared/src/constants.ts` contract alignment      | done   |
| KI-03  | Auth/roles E2E flows depend on participants mode env             | `BR-constraint.auth.sessions`, `BR-fact.auth.roles` | `REQ-FR-auth.registration.sign-up-participant`; `REQ-FR-auth.roles.assign-participant-role`                         | `REQ-NFR-security.compliance.session-auth`                | `packages/web/e2e/gui/auth-mode.spec.ts`; `packages/web/e2e/gui/participants-mode.spec.ts`                                                           | done   |
| KI-04  | Reorder UX expectation drift (buttons vs drag-and-drop)          | `BR-fact.task-lifecycle.stages`                     | `REQ-FR-dashboard.board.render-kanban-columns`                                                                      | `REQ-NFR-data.compliance.task-transactional-consistency`  | `packages/web/e2e/gui/kanban-board.spec.ts` (button reorder + persistence); negative drag-and-drop unavailability assertion                          | done   |
| KI-05  | Health smoke lacks explicit infra-only classification            | `BR-fact.audit.observability`                       | `REQ-FR-dashboard.realtime.broadcast-live-updates`                                                                  | `REQ-NFR-api.availability.coordinator-resilience`         | `packages/web/e2e/api/health.spec.ts`; `packages/web/e2e/gui/kanban-board.spec.ts` (`L-01d` classification note)                                     | done   |
| KI-06  | Logger `component` semantics drift (`data` vs `shared`)          | `BR-fact.audit.observability`                       | `REQ-FR-audit.errors.classify-runtime-error`                                                                        | `REQ-NFR-ops.observability.log-level-config`              | `packages/shared/src/__tests__/...` + `packages/data/src/__tests__/...` parser/log compatibility test                                                | done   |
| KI-07  | `schema.ts` has 0% in shared local coverage artifact             | `BR-constraint.audit.state-snapshot`                | `REQ-FR-audit.logging.record-state-transition`                                                                      | `REQ-NFR-data.compliance.database-migration-integrity`    | `packages/shared/src/__tests__/schema.contract.test.ts` (driver-free schema import/metadata assertions)                                              | done   |
| KI-08  | Flaky local perf budgets and nondeterministic gate behavior      | `BR-trigger.automation.pipeline`                    | `REQ-FR-dashboard.board.render-kanban-columns`                                                                      | `REQ-NFR-ops.observability.telemetry-overhead-budget`     | `packages/web/e2e/perf/*.spec.ts`; perf helper policy tests for retry/median evaluation                                                              | done   |
| KI-09  | Canonical managed task operations boundary in `@aif/data`        | `BR-trigger.automation.pipeline`                    | `REQ-FR-pipeline.stage.auto-advance-after-gate`                                                                     | `REQ-NFR-data.compliance.task-transactional-consistency`  | `packages/data/src/taskOperations.ts`; `packages/data/src/__tests__/taskOperations*.test.ts`                                                         | done   |
| KI-10  | MCP `pushPlan` field-vs-file persistence contract divergence     | `BR-trigger.automation.plan-review-gate`            | `REQ-FR-vcs-auto.plan-review.publish-plan-for-approval`                                                             | `REQ-NFR-data.compliance.task-state-persistence`          | `packages/mcp/src/tools/pushPlan.ts`; MCP contract tests (`tools.test.ts`, `taskToolsRuntimeContract.test.ts`)                                       | done   |
| KI-11  | Runtime-profile validation message drift in MCP                  | `BR-fact.project.runtime-profiles`                  | `REQ-FR-runtime.profile.configure-project-runtime`                                                                  | `REQ-NFR-ops.observability.tool-error-readability`        | MCP validation tests asserting structured code + compatibility message policy                                                                        | done   |
| KI-12  | Usage broadcast depends on injected registry path                | `BR-trigger.automation.runtime-limit-gate`          | `REQ-FR-dashboard.realtime.broadcast-live-updates`                                                                  | `REQ-NFR-ops.observability.audit-trail-completeness`      | `packages/agent/src/usageSinkCallbacks.ts`; `packages/agent/src/index.ts`; `packages/agent/src/__tests__/usageSinkCallbacks.test.ts`                 | done   |
| KI-13  | `done -> implementing` rework should route via `$aif-fix` intent | `BR-trigger.task-lifecycle.done-to-accepted`        | `REQ-FR-pipeline.review-loop.iterate-review-feedback`; `REQ-FR-pipeline.implementation.execute-change-in-isolation` | `REQ-NFR-api.availability.coordinator-resilience`         | `packages/agent/src/subagents/implementer.ts`; `packages/agent/src/__tests__/implementer.test.ts`                                                    | done   |
| KI-14  | Missing `$aif-evolve` trigger after N>=5 fix patches             | `BR-trigger.automation.failure-recovery`            | `REQ-FR-pipeline.plan.refine-plan-second-pass`                                                                      | `REQ-NFR-ops.observability.audit-trail-completeness`      | `packages/agent/src/evolveTrigger.ts`; `packages/agent/src/subagents/implementer.ts`; `packages/agent/src/__tests__/evolveTrigger.test.ts`           | done   |
| KI-15D | Legacy project fetch noise in GitLab E2E lanes                   | `BR-constraint.automation.concurrency`              | `REQ-FR-pipeline.implementation.execute-change-in-isolation`                                                        | `REQ-NFR-ops.observability.error-categorization`          | `packages/agent/src/gitlabWorkflow.ts`; `packages/agent/src/__tests__/gitlabWorkflow.test.ts` (project scope + trace correlation)                    | done   |
| KI-15E | Notifier 404 race after delete should be idempotent              | `BR-trigger.automation.failure-recovery`            | `REQ-FR-dashboard.realtime.broadcast-live-updates`; `REQ-FR-audit.logging.record-state-transition`                  | `REQ-NFR-integration.compliance.review-event-idempotency` | `packages/agent/src/notifier.ts`; `packages/agent/src/__tests__/notifier.test.ts`                                                                    | done   |

## Test Metadata Policy (for KI scope)

Every new or updated regression test related to this matrix must include requirement metadata in a test-level comment block (or equivalent structured annotation):

```text
BR: <id[,id...]>
FR: <id[,id...]>
NFR: <id[,id...]>
KI: <KI-id>
```

This matrix is the canonical source to keep those anchors consistent across packages.
