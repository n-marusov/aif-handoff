# План реализации: Plan Review PR Gate для hand-off конвейера

Branch: feature/plan-review-pr-gate
Created: 2026-09-09

## Original Request

Привести автомат `aif-handoff` в соответствие с `flow.md`: после получения GitHub/GitLab Issue агент должен создать ветку, построить Change Plan, закоммитить план, опубликовать ветку, создать PR/MR с объёмом изменений, дорабатывать план по комментариям PR/MR и начинать реализацию только после одобрения плана человеком.

## Settings

- Testing: yes
- Logging: verbose
- Docs: yes
- PR/MR policy: one Issue = one branch = one PR/MR; the PR/MR changes mode from `plan_review` to `implementation`.
- Branch/commit policy: resolve branch naming and commit message format from the target project's RULES under the project root; if absent, use default conventions.
- Provider scope: runtime-neutral; изменения не должны быть привязаны к Claude/Codex/OpenRouter/OpenCode
- VCS scope: GitHub first, GitLab parity в том же плане

## Roadmap Linkage

Milestone: "Autonomous Agent Pipeline"
Rationale: изменение уточняет центральный stage-based orchestration: добавляет обязательный hand-off gate между планированием и реализацией.

## Plan Review Summary

### Why

Текущий конвейер создаёт локальную ветку/worktree и план, но не делает обязательный PR/MR-gate для Change Plan. В результате агент может перейти от `plan_ready` к `implementing` без человеческого подтверждения объёма изменений, что расходится с `flow.md`.

### Context

Сейчас релевантные точки выглядят так:

- `packages/agent/src/coordinator.ts`: `PIPELINE` переводит `planning -> plan_ready -> implementing`; публикация PR/MR вызывается только после implementer/reviewer stages.
- `packages/agent/src/subagents/planner.ts`: создаёт/восстанавливает branch/worktree и сохраняет план, но не коммитит и не публикует plan PR/MR.
- `packages/agent/src/githubWorkflow.ts` и `packages/agent/src/gitlabWorkflow.ts`: публикуют финальный PR/MR с `Closes #...`, implementation log и test evidence.
- `packages/api/src/routes/github.ts` и `packages/api/src/routes/gitlab.ts`: sync реагирует на review state в основном для финального review/rework, а не для plan approval.
- `packages/shared/src/stateMachine.ts`: нет статуса `plan_review` и событий `approve_plan` / `request_plan_changes`.

### Scope

Нужно добавить явный этап `plan_review` между `plan_ready` и `implementing`, отдельный deterministic commit плана, режим PR/MR body `plan_review`, обработку approval/comments из VCS и защиту от старта implementation до approve. Ключевой invariant: один Issue создаёт одну branch/worktree и один PR/MR; этот же PR/MR сначала используется для plan review, а после approval и реализации конвертируется в финальный Atomic PR/MR.

### Affected artifacts

- `packages/shared/src/types.ts`
- `packages/shared/src/stateMachine.ts`
- `packages/shared/src/schema.ts`
- `packages/shared/src/db.ts`
- `packages/data/src/github.ts`
- `packages/data/src/gitlab.ts`
- `packages/data/src/taskTransitions.ts`
- `packages/data/src/index.ts`
- `packages/agent/src/coordinator.ts`
- `packages/agent/src/subagents/planner.ts`
- `packages/agent/src/githubWorkflow.ts`
- `packages/agent/src/gitlabWorkflow.ts`
- `packages/agent/src/autoQueueCommit.ts`
- new `packages/agent/src/planReviewCommit.ts`
- new `packages/agent/src/planReviewPublisher.ts`
- `packages/api/src/routes/github.ts`
- `packages/api/src/routes/gitlab.ts`
- `packages/api/src/services/github.ts`
- `packages/api/src/services/gitlab.ts`
- `packages/api/src/schemas.ts`
- `packages/web/src/lib/api.ts`
- `packages/web/src/hooks/useTasks.ts`
- `packages/web/src/components/kanban/*`
- `packages/web/src/components/task/*`
- `.agents/skills/aif-plan/SKILL.md`
- `.agents/skills/aif-improve/SKILL.md`
- `.agents/skills/aif-implement/SKILL.md`
- `.agents/skills/aif-commit/SKILL.md`
- `.claude/agents/plan-coordinator.md`
- `.claude/agents/plan-polisher.md`
- `.claude/agents/implement-coordinator.md`
- `docs/architecture.md`
- `docs/api.md`
- `docs/configuration.md`
- `docs/gitlab-demo.md`
- new or updated GitHub runbook

### Open decisions

- The pipeline uses exactly one PR/MR per Issue: first in `plan_review` mode, then the same PR/MR becomes the final Atomic PR/MR after implementation.
- Plan PR/MR must not include `Closes #...`; final implementation PR/MR must include it.
- Branch naming and commit message format are not hardcoded in Handoff; they are resolved from the target project's RULES under the project root. If no explicit convention exists, use the default Handoff branch naming and Conventional Commits-style messages.
- For tasks without VCS linkage, keep legacy local flow unless `AIF_PLAN_REVIEW_PR_ENABLED=strict` is introduced later.

### Approval criteria

- A GitHub Issue creates an issue branch/worktree whose name follows the target project's RULES; if absent, the default convention is used.
- Planner writes Change Plan only.
- Agent commits only plan files before approval.
- Plan and implementation commit messages follow the target project's RULES; if absent, the default convention is used.
- Agent pushes branch and creates/updates PR in `plan_review` mode.
- Task waits in `plan_review` until VCS approval.
- PR comments/changes requested trigger replanning, new plan commit, push, and PR body update.
- Approved plan triggers implementation.
- Final publish updates the same PR/MR to implementation mode and adds `Closes #...`.

## Commit Plan

- **Commit 1** (after tasks 1-3): `feat: add plan review state model`
- **Commit 2** (after tasks 4-7): `feat: publish change plans for review`
- **Commit 3** (after tasks 8-11): `feat: resume pipeline from plan reviews`
- **Commit 4** (after tasks 12-15): `feat: expose plan review workflow in UI and docs`

## Tasks

### Phase 1: State machine and persistence foundation

- [x] Task 1: Add shared task status and events for plan approval. Extend `TASK_STATUSES` with `plan_review`; extend `TASK_EVENTS` with `publish_plan`, `approve_plan`, and `request_plan_changes`; update browser-safe exports and all task type surfaces. Logging requirements: no new runtime logging in shared types; add clear test names that describe denied/allowed transitions. Files: `packages/shared/src/types.ts`, `packages/shared/src/browser.ts`, `packages/shared/src/index.ts`, `packages/shared/src/__tests__/stateMachine.test.ts`.

- [x] Task 2: Add append-only DB migration and Drizzle fields for plan review state. Add task fields `planReviewState`, `planReviewCommitSha`, `planReviewPublishedAt`, `planReviewApprovedAt`, `planReviewFeedback`; add GitHub/GitLab linkage mode fields `prMode` / `mrMode` with values `plan_review | implementation`. Do not edit or renumber existing migrations. Logging requirements: keep existing migration/bootstrap logs; do not log review feedback bodies unless already sanitized/truncated. Files: `packages/shared/src/schema.ts`, `packages/shared/src/db.ts`, `packages/shared/src/types.ts`.

- [x] Task 3: Update `@aif/data` repositories for plan review state and VCS mode tracking. Add focused methods such as `markTaskPlanPublished`, `markTaskPlanApproved`, `recordTaskPlanReviewFeedback`, `updateGitHubPullRequestMode`, and `updateGitLabMergeRequestMode`; export them through `packages/data/src/index.ts`. Logging requirements: repository writes should use existing structured log style where present; include `taskId`, `projectId`, issue number, PR/MR number, and mode, never tokens or full secrets. Files: `packages/data/src/github.ts`, `packages/data/src/gitlab.ts`, `packages/data/src/taskTransitions.ts`, `packages/data/src/index.ts`, `packages/data/src/__tests__/github.test.ts`, `packages/data/src/__tests__/gitlab.test.ts`, `packages/data/src/__tests__/taskTransitions.test.ts`. (depends on 1, 2)

<!-- Commit checkpoint: tasks 1-3 -->

### Phase 2: Deterministic plan commit and plan PR/MR publication

- [x] Task 4: Add deterministic plan-only commit helper and target-project git convention resolver. Implement `resolveTargetProjectGitConventions(projectRoot)` (or equivalent) that reads the target project's RULES/config context under the project root, derives branch naming and commit message conventions when explicit rules exist, and falls back to the default Handoff branch naming plus Conventional Commits-style imperative messages when they do not. Implement `ensurePlanReviewCommit` that stages only allowed plan paths, rejects dirty product files before approval, and creates a non-LLM plan commit message using the resolved target-project commit policy. It must return commit SHA, policy source, and diagnostics. Logging requirements: log dirty path counts, allowed/disallowed path previews, and convention source at DEBUG/WARN; never log file contents, full RULES text, or secrets. Files: new `packages/agent/src/planReviewCommit.ts`, optional new `packages/agent/src/gitConventions.ts`, `packages/agent/src/__tests__/planReviewCommit.test.ts`, `packages/agent/src/__tests__/gitConventions.test.ts`. (depends on 3)

- [ ] Task 5: Add plan publisher runner and insert it after `plan_ready`. Implement `runPlanReviewPublisher(taskId, projectRoot)` that checks branch/worktree, plan presence, commits the plan, pushes the branch, calls GitHub/GitLab plan publish APIs, records `planReviewState=published`, and leaves the task in `plan_review`. Logging requirements: INFO for branch push and PR/MR publication; WARN for missing branch/plan; ERROR/StageManualBlockError with structured reason on push/API failure. Files: new `packages/agent/src/planReviewPublisher.ts`, `packages/agent/src/coordinator.ts`, `packages/agent/src/__tests__/coordinator.test.ts`, `packages/agent/src/__tests__/planReviewPublisher.test.ts`. (depends on 4)

- [ ] Task 6: Add GitHub plan PR publish flow. Add `publishGitHubPlanTask` in agent workflow and `POST /projects/:id/github/tasks/:taskId/publish-plan` in API. Create/update PR by branch, write body with `<!-- aif:pr-mode=plan_review -->`, plan summary, affected artifacts, why/context/scope, open questions, and approval instructions. Do not include `Closes #...`. Logging requirements: log PR number, branch, issue number, mode transition, and API status; never log `GITHUB_TOKEN`. Files: `packages/agent/src/githubWorkflow.ts`, `packages/api/src/routes/github.ts`, `packages/api/src/services/github.ts`, `packages/api/src/schemas.ts`, `packages/agent/src/__tests__/githubWorkflow.test.ts`, API route tests. (depends on 5)

- [ ] Task 7: Add GitLab plan MR publish parity. Add `publishGitLabPlanTask` and `POST /projects/:id/gitlab/tasks/:taskId/publish-plan` with equivalent MR description marker `<!-- aif:mr-mode=plan_review -->`. Do not include `Closes #...`. Preserve existing GitLab approvals/request-changes behavior while routing plan-mode decisions separately. Logging requirements: same as GitHub, with `iid`/`mrIid`; avoid logging private token headers. Files: `packages/agent/src/gitlabWorkflow.ts`, `packages/api/src/routes/gitlab.ts`, `packages/api/src/services/gitlab.ts`, `packages/api/src/schemas.ts`, `packages/agent/src/__tests__/gitlabWorkflow.test.ts`, API route tests. (depends on 5)

<!-- Commit checkpoint: tasks 4-7 -->

### Phase 3: VCS feedback loop and implementation guard

- [ ] Task 8: Update GitHub sync to drive plan review transitions. When linked PR is in `plan_review` mode and latest review is `approved`, transition task `plan_review -> implementing` and set `planReviewState=approved`. When latest review is `changes_requested` or new review/comment feedback is present, transition `plan_review -> planning`, set `planReviewState=changes_requested`, persist `planReviewFeedback`, reset plan commit metadata as needed, and keep the same branch/PR linkage. Logging requirements: INFO for approved/replan transitions; DEBUG for already-processed review IDs; include `lastReviewId` for dedupe. Files: `packages/api/src/routes/github.ts`, `packages/data/src/github.ts`, API/data tests. (depends on 6)

- [ ] Task 9: Update GitLab sync to drive plan review transitions. Use approvals for approve and the existing request-changes note signal for changes requested, but keep the detection isolated in a helper so route logic does not spread text-pattern checks. Persist feedback where available and dedupe by note/review identity. Logging requirements: INFO for state transitions; DEBUG for ignored duplicate notes; WARN when a plan-mode MR is closed without merge. Files: `packages/api/src/routes/gitlab.ts`, `packages/api/src/services/gitlab.ts`, `packages/data/src/gitlab.ts`, API/data tests. (depends on 7)

- [ ] Task 10: Feed PR/MR plan review feedback back into planner. Extend `runPlanner` prompt context with `task.planReviewFeedback` and any imported VCS review comments. Ensure replanning in `planning` restores the existing task branch/worktree and writes the same plan path. Logging requirements: DEBUG when feedback is attached to planner prompt, with length/count only; do not log full feedback text at INFO. Files: `packages/agent/src/subagents/planner.ts`, `packages/agent/src/__tests__/planner.test.ts`. (depends on 8, 9)

- [ ] Task 11: Guard implementation until plan approval. Ensure coordinator never runs implementer from `plan_ready` when plan review is required; only `plan_review` approval may move to `implementing`. Add a defensive guard in `runImplementer` or immediately before invoking it to block if `planReviewState !== approved` for VCS-linked plan-review tasks. Logging requirements: WARN with `taskId`, status, and plan review state when implementation is blocked; no stack trace for expected waiting state. Files: `packages/agent/src/coordinator.ts`, `packages/agent/src/subagents/implementer.ts`, `packages/agent/src/__tests__/coordinator.test.ts`, `packages/agent/src/__tests__/implementer.test.ts`. (depends on 5, 8, 9)

<!-- Commit checkpoint: tasks 8-11 -->

### Phase 4: Final PR/MR conversion, skills, UI, docs, and pilot hardening

- [ ] Task 12: Convert the same PR/MR from plan mode to implementation mode after implementation/review. Update existing `publishGitHubTask` / `publishGitLabTask` so final body changes marker to `implementation`, includes implementation log and test evidence, preserves approved plan link/summary, and only then adds `Closes #...`. Logging requirements: INFO when converting mode; WARN if final publish finds no prior plan review PR/MR while plan review is enabled. Files: `packages/agent/src/githubWorkflow.ts`, `packages/agent/src/gitlabWorkflow.ts`, `packages/api/src/routes/github.ts`, `packages/api/src/routes/gitlab.ts`, workflow/API tests. (depends on 11)

- [ ] Task 13: Update AI Factory skills and agent definitions for plan-review mode. Add rules that planning may write only plan artifacts, implementation checklist items must remain `[ ]`, implementation starts only after approval, PR/MR comments are first-class replanning input, Handoff owns branch/worktree creation while branch naming and commit message conventions come from the target project's RULES, and `aif-commit` must not be used for plan-only deterministic commits unless it is constrained by the resolved target-project commit policy. Logging requirements: no runtime logs; skill text must require agents to report blockers explicitly with paths and constraints. Files: `.agents/skills/aif-plan/SKILL.md`, `.agents/skills/aif-improve/SKILL.md`, `.agents/skills/aif-implement/SKILL.md`, `.agents/skills/aif-commit/SKILL.md`, `.claude/agents/plan-coordinator.md`, `.claude/agents/plan-polisher.md`, `.claude/agents/implement-coordinator.md`. (depends on 10, 11)

- [ ] Task 14: Expose `plan_review` in the web UI without adding new visual primitives. Add Kanban/status support, task detail messaging (`Waiting for plan approval`), PR/MR links, and disabled/hidden implementation actions while approval is pending. Reuse existing `Badge`, `Button`, `Dialog`, and task components. Logging requirements: client mutations go through existing API client/query invalidation; do not add scattered `fetch()`. Files: `packages/web/src/lib/api.ts`, `packages/web/src/hooks/useTasks.ts`, `packages/web/src/components/kanban/Board.tsx`, `packages/web/src/components/kanban/Column.tsx`, `packages/web/src/components/task/TaskDetailHeader.tsx`, `packages/web/src/components/task/TaskDescription.tsx`, relevant web tests. (depends on 1, 3, 8, 9)

- [ ] Task 15: Update docs, deployment guidance, and validation. Document the new Issue → plan PR/MR → approve → implementation flow, new endpoints, env flag `AIF_PLAN_REVIEW_PR_ENABLED`, IP-only production deployment caveat, current health endpoints (`/health`, `/settings`, `/agent/status`), broadcast token requirement, and GitHub git-prepare parity gap/fix if implemented. Run every touched package checklist and `npm run ai:validate`. Logging requirements: docs should describe where logs appear for plan publication, VCS sync, and blocked implementation. Files: `docs/architecture.md`, `docs/api.md`, `docs/configuration.md`, `docs/gitlab-demo.md`, GitHub runbook docs, package `CHECKLIST.md` files if new recurring rules are discovered. (depends on 12, 13, 14)

<!-- Commit checkpoint: tasks 12-15 -->

## Validation Plan

- `npm run lint`
- `npm test`
- `npm run ai:validate`
- Focused tests before full validation:
  - `npm test --workspace @aif/shared -- stateMachine`
  - `npm test --workspace @aif/data -- github gitlab taskTransitions`
  - `npm test --workspace @aif/api -- github gitlab`
  - `npm test --workspace @aif/agent -- coordinator planReviewPublisher githubWorkflow gitlabWorkflow planner implementer`
  - `npm test --workspace @aif/web -- Board TaskDetailHeader`

## Package Checklist Requirements

Before completion, run through:

- root `CHECKLIST.md`
- `packages/shared/CHECKLIST.md`
- `packages/data/CHECKLIST.md`
- `packages/api/CHECKLIST.md`
- `packages/agent/CHECKLIST.md`
- `packages/web/CHECKLIST.md`

## Risks and Constraints

- Migration versions are append-only; do not edit landed migrations.
- `api`, `agent`, and `runtime` must access DB only through `@aif/data`.
- Do not classify runtime errors by message text.
- Plan-stage commit must not accidentally include product code changes.
- Do not hardcode target-project branch naming or commit message policy in Handoff beyond the default fallback; read target project RULES first and record which source was used.
- GitHub/GitLab plan PR/MR must not close issues before implementation; `Closes #...` belongs only to final implementation mode.
- Existing legacy non-VCS flow must remain compatible unless `AIF_PLAN_REVIEW_PR_ENABLED` explicitly requires strict behavior.
- Web UI changes must reuse existing components and avoid expensive CSS properties.

## Definition of Done

- GitHub and GitLab issue-linked tasks stop in `plan_review` after publishing a plan PR/MR.
- Exactly one branch and one PR/MR are used per Issue across planning, plan approval, implementation, review, and final merge.
- Branch names and commit messages follow the target project's RULES when present, with documented default fallback behavior.
- Human approval in VCS starts implementation automatically.
- Human comments/changes requested in VCS trigger replanning and PR/MR update without product artifact changes.
- Implementation cannot start before plan approval when plan review is required.
- The final PR/MR is the same branch/PR/MR converted to implementation mode and includes `Closes #...` only after implementation.
- Tests and docs cover the new workflow.
