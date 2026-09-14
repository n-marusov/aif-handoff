# Implementation Plan: Remove `plan_ready` — Unify `plan_review` as the Single Plan Gate

Branch: feature/remove-plan-ready-state
Created: 2026-09-14
ADR: docs/adr/ADR-IMPL.PROCESS.task-state-machine.md (source of truth for the status model)

## Settings

- Testing: yes — TDD: tests are written first in every phase (RED → GREEN → REFACTOR)
- Logging: verbose — DEBUG for stage/candidate decisions, INFO for gate transitions
- Docs: yes — mandatory documentation checkpoint at completion

## Roadmap Linkage

Milestone: "none"
Rationale: All roadmap milestones are completed; this change refactors the existing Autonomous Agent Pipeline milestone rather than adding a new one.

## Research Context

Source: .ai-factory/RESEARCH.md (Active Summary)

Goal: Parallel agent execution — per-issue git-worktree isolation plus worktree lifecycle. Out of scope for this plan; only its cross-cutting constraints apply.

Constraints:
- DB boundary via `@aif/data`.
- Migration versions append-only — never renumber a merged migration.
- Every package ≥70% coverage; `npm run ai:validate` after implementation.

Decisions: none applicable — the active research targets a different feature.

Open questions: research question #1 is resolved by this plan — `request_plan_changes` now moves `plan_review → improve` (previously `→ planning`).

## TDD Protocol

- Every phase starts with a **RED** task: write the tests that encode the target behavior, run them, and confirm they fail for the expected reason.
- **GREEN** tasks implement the minimum needed to make the RED tests pass.
- **REFACTOR** tasks migrate the remaining fixtures/assertions in the same layer and re-run the suite.
- `plan_ready` stays in the `TaskStatus` union until Phase 5. Until then both statuses are valid, so tests can target `plan_review` without breaking compilation.
- Every commit must leave the whole workspace compiling (`npx tsc --noEmit` in each touched package).

## Commit Plan

- **Commit 1** (after tasks 1.1-1.3): `refactor(shared): accept plan_review as the plan gate source`
- **Commit 2** (after tasks 2.1-2.4): `refactor(data): move plan gate queries and publication to plan_review`
- **Commit 3** (after tasks 3.1-3.5): `refactor(agent): run plan stages on plan_review`
- **Commit 4** (after tasks 4.1-4.3): `refactor(api,web): align plan gate with plan_review`
- **Commit 5** (after tasks 5.1-5.3): `refactor: remove plan_ready from the task status model`
- **Commit 6** (after tasks 6.1-6.3): `docs: align pipeline documentation with plan_review gate`

## Tasks

### Phase 1: State Machine Behavior (shared)

- [ ] Task 1.1: RED — encode the new gate transitions as failing tests

  Files: `packages/shared/src/__tests__/stateMachine.test.ts`

  ADR reference: `docs/adr/ADR-IMPL.PROCESS.task-state-machine.md` — the `plan_review` exit set.

  - Assert `start_implementation` from `plan_review` returns `{ status: "implementing" }`.
  - Assert `approve_plan` from `plan_review` returns `{ status: "implementing" }`.
  - Assert `request_replanning` from `plan_review` returns `{ status: "improve" }`.
  - Assert `request_plan_changes` from `plan_review` returns `{ status: "improve" }`.
  - Assert `fast_fix` from `plan_review` returns `{ status: "plan_review" }`.
  - Assert human-owner `mark_plan_ready` returns `{ status: "plan_review" }`.
  - Assert `publish_plan` is rejected with `action_not_allowed`.
  - Run: `npx vitest run src/__tests__/stateMachine.test.ts` in `packages/shared` — confirm the new cases fail.

  LOGGING: none — tests.

- [ ] Task 1.2: GREEN — implement the gate transitions (depends on 1.1)

  Files: `packages/shared/src/stateMachine.ts`, `packages/shared/src/types.ts`

  ADR reference: `docs/adr/ADR-IMPL.PROCESS.task-state-machine.md` §Описание состояний (`plan_review` row).

  - Accept `plan_review` as the source status for `start_implementation`, `request_replanning`, and `fast_fix`; update their denial messages.
  - `fast_fix` patch target becomes `plan_review`.
  - Human-owner `mark_plan_ready` target becomes `plan_review`; update the denial message.
  - `HUMAN_ACTIONS_BY_STATUS`: assign `["start_implementation", "request_replanning", "fast_fix"]` to `plan_review`.
  - Delete the `publish_plan` case from `resolveLegacyAction`, from `TASK_ACTION_LOOKUP`, and from the `TaskEvent` union.
  - Run the RED suite — confirm it passes.

  LOGGING: none — the resolver performs no I/O and returns `TransitionResult`.

- [ ] Task 1.3: REFACTOR — align the remaining shared fixtures (depends on 1.2)

  Files: `packages/shared/src/__tests__/stateMachine.test.ts`, `packages/shared/src/__tests__/schema.test.ts`

  - Migrate any remaining `plan_ready` fixtures in the touched suites to `plan_review`.
  - Keep the `TASK_STATUSES` membership assertion for `plan_review`; add the `plan_ready` removal assertion in Phase 5.
  - Run: full `packages/shared` suite — confirm green.

  LOGGING: none — tests.

<!-- Commit checkpoint: tasks 1.1-1.3 -->

### Phase 2: Data Layer Behavior

- [ ] Task 2.1: RED — encode the plan-gate query and publication behavior (depends on 1.2)

  Files: `packages/data/src/__tests__/index.test.ts`, `packages/data/src/__tests__/taskOwnership.test.ts`, `packages/data/src/__tests__/taskTransitions.test.ts`

  - Assert `coordinatorStageFilter` for `plan-checker` and `plan-publisher` selects `plan_review` candidates (all tasks, not only `autoMode`).
  - Assert `coordinatorStageFilter` for `implementer` selects `implementing` plus `plan_review` with `autoMode=true`.
  - Assert `markTaskPlanPublished` succeeds from `plan_review` and stamps `planReviewState=published` without changing the status.
  - Assert the ownership guard accepts `plan_review` as the pre-handoff status.
  - Run the data suite — confirm the new cases fail.

  LOGGING: none — tests.

- [ ] Task 2.2: GREEN — implement the data-layer changes (depends on 2.1)

  Files: `packages/data/src/index.ts`, `packages/data/src/taskOwnership.ts`, `packages/data/src/taskTransitions.ts`

  - `coordinatorStageFilter`: `plan-checker` / `plan-publisher` select `inArray(status, ["plan_review"])`; `implementer` selects `implementing` OR (`plan_review` AND `autoMode=true`).
  - `coordinatorAnyStageFilter`: replace the `plan_ready` disjunct with `plan_review`.
  - `countActivePipelineTasksForProject`, `hasActiveBranchBoundTasksForProject`, `NON_TERMINAL_WORKTREE_STATUSES`: swap `"plan_ready"` for `"plan_review"`.
  - `taskOwnership.ts`: replace both `plan_ready` guards with `plan_review`.
  - `markTaskPlanPublished`: `expectedStatus: "plan_review"` with `status: "plan_review"` (self-loop).
  - Add a reset path clearing `planReviewState` / `planReviewApprovedAt` / `planReviewFeedback` when the task re-enters `plan_review` from `improve`.
  - Run the RED suite — confirm it passes.

  LOGGING: INFO `task.plan_review.published` (existing) and new INFO `task.plan_review.reset` with `taskId` and reason `replanned`; DEBUG candidate counts keyed by `stage` and `projectId`.

- [ ] Task 2.3: GREEN — add the backfill migration (depends on 2.2)

  Files: `packages/shared/src/db.ts`

  ADR reference: `docs/adr/ADR-IMPL.PROCESS.task-state-machine.md` — `blocked_external` exits include `plan_review`.

  - Append a new migration at the next free version (never renumber a merged entry):
    `UPDATE tasks SET status = 'plan_review' WHERE status = 'plan_ready';`
    `UPDATE tasks SET blocked_from_status = 'plan_review' WHERE blocked_from_status = 'plan_ready';`
  - Add a migration test asserting both columns are backfilled and that a second run is a no-op.
  - Assert `retry_from_blocked` restores a task whose `blocked_from_status` is `plan_review` back to `plan_review`.

  LOGGING: INFO with the applied migration version and the updated row count.

- [ ] Task 2.4: REFACTOR — align the remaining data fixtures (depends on 2.3)

  Files: `packages/data/src/__tests__/runtimeProfiles.test.ts`

  - Migrate remaining `plan_ready` fixtures and assertions in the data suites.
  - Run: full `packages/data` suite — confirm green.

  LOGGING: none — tests.

<!-- Commit checkpoint: tasks 2.1-2.4 -->

### Phase 3: Coordinator Behavior (agent)

- [ ] Task 3.1: RED — encode the coordinator gate behavior (depends on 2.2)

  Files: `packages/agent/src/__tests__/coordinator.test.ts`, `packages/agent/src/__tests__/planReviewPublisher.test.ts`

  - Assert an `autoMode` task advances `plan_review → implementing → verify` within one poll cycle.
  - Assert a non-`autoMode` task stays in `plan_review` until `start_implementation`.
  - Assert the publisher skips an unchanged published plan and re-publishes after a replan reset.
  - Assert `planReviewStageIneligible` blocks implementation for an unapproved VCS task in `plan_review`.
  - Run the agent suite — confirm the new cases fail.

  LOGGING: none — tests.

- [ ] Task 3.2: GREEN — implement the pipeline and guard changes (depends on 3.1)

  Files: `packages/agent/src/coordinator.ts`

  ADR reference: `docs/adr/ADR-IMPL.PROCESS.task-state-machine.md` §Описание состояний (`planning`, `plan_review`, `implementing` rows).

  - `planner` and `improver`: `onSuccess: "plan_review"`.
  - Preserve the `planning → improve` override: `getStageSuccessStatus` keeps returning `improve` for the planner when `shouldRunSkillsModeImprove(task)` is true (ADR `runPlanImprove` flag).
  - `plan-checker` and `plan-publisher`: `from: ["plan_review"]`, `inProgress: "plan_review"`, `onSuccess: "plan_review"` (self-loop).
  - `implementer`: `from: ["plan_review", "implementing"]`.
  - Preserve the `implementing → done` override: the implementer early-return block keeps routing `skipReview` tasks straight to `done` (ADR `skipReview` flag).
  - Replace every `task.status === "plan_ready"` guard and `expectedAutoMode` predicate with `"plan_review"`.
  - Update the plan-publisher early-return block comments to describe the `plan_review` self-loop.
  - Run the RED suite — confirm it passes.

  LOGGING: DEBUG stage selection keyed by `stage`, `projectId`, `taskId`; INFO on plan-review publish deferral; WARN with `taskId`, `status`, `planReviewState` when implementation is blocked for a missing approval.

- [ ] Task 3.3: GREEN — make the publisher idempotent (depends on 3.2)

  Files: `packages/agent/src/planReviewPublisher.ts`

  - Add an early return when `planReviewState === "published"` and the plan revision is unchanged (compare `planReviewCommitSha` with the current plan commit), so the self-looping stage does not re-publish the PR/MR on every poll cycle.
  - Confirm the guard still permits a genuine re-publish after a replan reset (Task 2.2).
  - Update `plan_ready` wording in comments and log messages.
  - Run: `planReviewPublisher` suite — confirm green.

  LOGGING: DEBUG `publish skipped: already published` with `taskId` and `planReviewCommitSha`; keep the WARN deferral (missing branch/plan) and INFO publish logs.

- [ ] Task 3.4: REFACTOR — align the remaining agent fixtures (depends on 3.3)

  Files: `packages/agent/src/__tests__/autoQueue.test.ts`, `notifier.test.ts`, `planChecker.test.ts`, `planReviewCommit.test.ts`, `stageErrorHandler.test.ts`

  - Migrate remaining `plan_ready` fixtures and assertions in the agent suites.
  - Run: full `packages/agent` suite — confirm green.

  LOGGING: none — tests.

- [ ] Task 3.5: GREEN — delete the dead `skipReview`/`verify` branches (depends on 3.2)

  Files: `packages/agent/src/coordinator.ts`

  ADR reference: `docs/adr/ADR-IMPL.PROCESS.task-state-machine.md` — `implementing → done : skipReview flag` bypasses `verify`, so the verifier never receives a `skipReview` task.

  - Delete the unused `shouldRunSkillsModeVerify` helper (zero callers repo-wide after `verify` became mandatory).
  - Delete the unreachable `stage.label === "verifier" && task.skipReview` branch in `getStageSuccessStatus`.
  - Run: full `packages/agent` suite — confirm green and that coverage does not regress.

  LOGGING: none — dead-code removal.

<!-- Commit checkpoint: tasks 3.1-3.5 -->

### Phase 4: API + Web Behavior

- [ ] Task 4.1: RED — encode the API and UI gate behavior (depends on 3.2)

  Files: `packages/api/src/__tests__/tasks.test.ts`, `packages/web/src/__tests__/ProjectsOverview.test.tsx`, `packages/web/src/__tests__/TaskDetailHeader.test.tsx`

  - Assert the API accepts `fast_fix` from `plan_review` and rejects it from any other status with the observed status in the payload.
  - Assert the board renders a `plan_review` column.
  - Assert `Start implementation` renders for a non-`autoMode` `plan_review` task.
  - Run the api and web suites — confirm the new cases fail.

  LOGGING: none — tests.

- [ ] Task 4.2: GREEN — implement the API and UI changes (depends on 4.1)

  Files: `packages/api/src/services/taskEvents.ts`, `packages/web/src/components/project/ProjectsOverview.tsx`, `packages/web/src/components/task/TaskDetailHeader.tsx`, `packages/web/src/components/task/TaskOwnership.tsx`

  - `taskEvents.ts`: replace the `plan_ready` guard and 409 message with `plan_review`; include the observed `status` in the structured error payload.
  - `ProjectsOverview`: replace `plan_ready` in the ordered-status list with `plan_review`.
  - `TaskDetailHeader`: move the `plan_ready` human-action block to `plan_review`; keep the `mark_plan_ready` mapping.
  - `TaskOwnership`: derive the `start_implementation` affordance from `plan_review`.
  - Run the RED suites — confirm they pass.

  LOGGING: keep the existing API 409 path with structured `status`; none for UI.

- [ ] Task 4.3: REFACTOR — align the remaining api and web fixtures (depends on 4.2)

  Files: `packages/api/src/__tests__/github.test.ts`, `gitlab.test.ts`, `taskCollaboration.test.ts`, `packages/web/src/__tests__/projectSorting.test.ts`, `TaskDetail.test.tsx`

  - Migrate remaining `plan_ready` fixtures and assertions.
  - Run: full `packages/api` and `packages/web` suites — confirm green.

  LOGGING: none — tests.

<!-- Commit checkpoint: tasks 4.1-4.3 -->

### Phase 5: Remove `plan_ready` from the Status Model

- [ ] Task 5.1: Remove the status and migrate the last references (depends on Phase 1-4)

  Files: `packages/shared/src/types.ts`, `packages/shared/src/constants.ts`, plus every remaining `plan_ready` reference

  - Remove `"plan_ready"` from `TASK_STATUSES` / `TaskStatus`, from `STATUS_CONFIG`, and from `ORDERED_STATUSES`.
  - Resolve every compile error surfaced by `tsc` — these enumerate the remaining references across all packages.
  - Run: `npx tsc --noEmit` in every package — confirm zero errors.

  LOGGING: none — type-level change; `tsc` drives the enumeration.

- [ ] Task 5.2: Add the removal assertions (depends on 5.1)

  Files: `packages/shared/src/__tests__/schema.test.ts`, `packages/shared/src/__tests__/stateMachine.test.ts`

  - Assert `TASK_STATUSES` no longer contains `plan_ready`.
  - Assert `TaskStatus` rejects `plan_ready` via an exhaustive switch over the union.
  - Run: full `packages/shared` suite — confirm green.

  LOGGING: none — tests.

- [ ] Task 5.3: Verify the whole workspace (depends on 5.2)

  Files: none (verification only)

  - Run: `npm run ai:validate` from the repo root.
  - Confirm every package meets the ≥70% coverage floor after the suite changes.
  - Record the exact command and result in the task activity log.

  LOGGING: none — validation run.

<!-- Commit checkpoint: tasks 5.1-5.3 -->

### Phase 6: Documentation

- [ ] Task 6.1: Update the core documentation (depends on Phase 5)

  Files: `docs/architecture.md`, `docs/api.md`, `docs/glossary.md`, `docs/configuration.md`

  - Replace the pipeline chain with `backlog → planning → improve → plan_review → implementing → verify → review → done → accepted`.
  - Update the state table, human-action table, status-counts examples, the plan-review gate description, and the stale-recovery note.
  - Glossary: reduce the status count and remove `plan_ready` from the status and ordered-status definitions.

  LOGGING: none — docs.

- [ ] Task 6.2: Update the demo, sync, ADR, and business-rules docs (depends on 6.1)

  Files: `docs/gitlab-demo.md`, `docs/github-demo.md`, `docs/dev-gui-demo.md`, `docs/mcp-sync.md`, `docs/adr/README.md`, `docs/adr/ADR-IMPL.PROCESS.task-state-machine.md`, `docs/business-rules/BR-task-lifecycle.stages.md`, `docs/business-rules/BR-task-lifecycle.transitions.md`, `docs/business-rules/BR-automation.pipeline.md`, `docs/business-rules/BR-automation.plan-review-gate.md`, `docs/business-rules/BR-ownership.handoff.md`

  - Update pipeline diagrams and `plan_ready` sync examples to `plan_review`.
  - Update both intro pipeline chains in `docs/adr/README.md` — the intro paragraph (line 3: `Backlog → Planning → Plan Ready → Implementing → Review → Done`) and the applied-decisions table (line 18: `backlog → planning → plan_ready → implementing → review → done`) — to `backlog → planning → improve → plan_review → implementing → verify → review → done → accepted`.
  - Correct the stale entry-point symbol in `docs/adr/ADR-IMPL.PROCESS.task-state-machine.md`: the ADR names `computeTransition(action, task, context)`, which does not exist; the real entry points are `resolveTaskAction(task, event, context)` and `applyHumanTaskEvent` in `packages/shared/src/stateMachine.ts`.
  - `BR-task-lifecycle.stages.md`: drop the `Plan Ready` row and make `Plan Review` the universal gate (remove the VCS-only caveat).
  - `BR-task-lifecycle.transitions.md`: remove `publish_plan` from the event list.
  - `BR-automation.pipeline.md`: rewrite the stage list (`Planning → Plan Review`, `Improve → Plan Review`, the in-place plan check, the publish self-loop, `Plan Review / Implementing → Verify`).
  - `BR-automation.plan-review-gate.md`: replace the `Plan Ready` retry mention with `Plan Review`, and the "returns to planning" wording with `improve` upstream of the new gate.
  - `BR-ownership.handoff.md`: replace the `Plan Ready` resume-stage mention with `Plan Review`.

  LOGGING: none — docs.

- [ ] Task 6.3: Update the agent context artifacts (depends on 6.1)

  Files: `AGENTS.md`, `.ai-factory/DESCRIPTION.md`

  - Replace the `Plan Ready` stage with `Plan Review` in the pipeline chain.

  LOGGING: none — docs.

<!-- Commit checkpoint: tasks 6.1-6.3 -->
