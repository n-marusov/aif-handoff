# Implementation Plan: Parallel Agent Execution (Worktree Isolation + Intra-Issue Fan-Out)

Branch: feature/parallel-agent-execution (planned, NOT created — no git branch operations were performed while planning)
Created: 2026-09-10
Refined: 2026-09-10

## Settings

- Testing: yes
- Logging: verbose
- Docs: yes

## Quality Gates (project rules)

- `npm run ai:validate` must pass after implementation.
- Every package must keep ≥70% coverage (`@vitest/coverage-v8`).
- DB access only through `@aif/data` (lint-enforced).
- Migration versions are append-only — never renumber a merged migration.
- Do not use string/pattern matching on error messages for control flow. Git stderr is diagnostic data only.

## Roadmap Linkage

Milestone: "none"
Rationale: `ROADMAP.md` has no open milestones (all entries are `[x]`); this capability is not yet on the roadmap, and adding a milestone entry is `/aif-roadmap`'s responsibility.

## Research Context

Source: `.ai-factory/RESEARCH.md` (Active Summary)

Goal: Replace the current serial "one shared tree" behaviour with a two-level parallelism model that survives task re-execution.

- Level 1 (across issues): one git worktree per issue branch → real isolation (separate HEAD/index/files).
- Level 2 (within one issue): N `implement-worker` subagents inside ONE worktree; no git isolation, so safety comes from file-scope partitioning. Fan-out width capped by `AIF_IMPLEMENT_MAX_WORKERS` (default 2).

Origin incident: a retained worktree `vnc-feature-github-issue-1-a1342eab-…` held branch `feature/github-issue-1`; later tasks computed a different path but the same branch, so `git worktree add` failed → `worktree_create_failed` → permanent `blocked_external` (`retryAfter=null`).

Constraints:
- Worktree path must be a function of the BRANCH, never of `taskId`.
- Occupied branch must be adopted, never fatal.
- DB is the source of truth for worktree structure; folders are reconciled to it.
- Branch-isolation failures must be diagnosable from logs (currently they are not).
- Repo-mutating git operations must be serialized per project root to avoid ref-lock races under parallel scheduling.

Decisions:
- Worktree root: `/home/www/.worktrees/<project>/<branch>` (option C), implemented as a deterministic project segment plus branch segment.
- Branch name from the project RULES (`## Git conventions` → `branch_prefix`) + issue number.
- Enablement requires `AIF_TASK_WORKTREES_ENABLED=true` + `project.parallelEnabled=true`.
- Restart: same worktree, NEW agent session.
- Delete: stash, then `git worktree remove`.
- Reconciliation at agent start and after terminal transitions.
- Level 2: workers are edit-only; the coordinator owns git writes and the plan file; per-layer checkpoint for rollback.

Open questions (deferred, see "Deferred / Open Questions" below): PR-comment → `/aif-improve`; shared-artifact divergence; branch deletion on task delete.

## Assumptions

1. Deleting a task removes its worktree but KEEPS the issue branch (open PR/MR still needs it). Revisit if deferred Q3 resolves otherwise.
2. Level 1 enablement is a deployment change (`AIF_TASK_WORKTREES_ENABLED=true`, `project.parallelEnabled=true`), not a code change.
3. `.claude/agents/*` and project skills/rules are project content under VCS and are NOT modified by this plan (Level 2 enforcement is expressed through the orchestrator prompt and coordinator-side validation).
4. `isFix=true` tasks are not eligible for parallel scheduling until they have deterministic `branchName + worktreePath`; this plan adds a guard, not full fix-branch semantics.

## Commit Plan

- **Commit 1** (after tasks 1-4): `feat(git): branch-scoped task worktrees with safe provisioning`
- **Commit 2** (after tasks 5-8): `feat(agent): worktree diagnostics cleanup and reconciliation`
- **Commit 3** (after tasks 9-13): `feat(agent): bounded intra-issue worker fan-out`
- **Commit 4** (after task 14): `docs(agent): document parallel worktree lifecycle`

## Tasks

### Phase 1: Worktree Identity and Git Safety (Level 1)

- [x] **Task 1: Branch-scoped deterministic worktree path + configurable worktree root**

  Deliverable: `buildTaskWorktreePath` no longer takes `taskId` and produces `/home/www/.worktrees/<project-segment>/<branch-slug>`; the root is overridable.

  Why: the task-scoped path is the structural cause of the incident — every new task id created a new folder for the same branch.

  Files:
  - Modify: `packages/shared/src/gitIsolation.ts` (`buildTaskWorktreePath`, `ensureTaskWorktree` call site)
  - Modify: `packages/shared/src/env.ts` (new optional `AIF_WORKTREE_ROOT`)
  - Modify: `packages/agent/src/gitBranch.ts` (re-export surface stays consistent)
  - Test: `packages/shared/src/__tests__/gitIsolation.test.ts`

  Change scope:
  - New artifacts: none.
  - Modified artifacts (code): path builder signature; env schema entry.
  - Modified artifacts (tests): path assertions.

  Details:
  - The project segment must avoid collisions between projects with the same basename. Use either project id when available at the call site, or a deterministic `<basename>-<shortHash(projectRoot)>` fallback inside shared code.
  - Preserve a readable branch segment by replacing `/` with `-` and sanitizing unsupported path characters.

  Logging requirements:
  - DEBUG on path resolution: `logger("git-isolation")` with `{ projectRoot, branchName, worktreeRoot, worktreePath, projectSegment }`.
  - WARN when `AIF_WORKTREE_ROOT` is set to a path outside the project mount.

  Dependencies: none.

- [x] **Task 2: Per-project git mutation lock**

  Deliverable: repo-mutating git operations are serialized per project root, without holding the lock during LLM/runtime execution.

  Why: once Level 1 parallelism is enabled, two tasks for the same project can concurrently run `git fetch`, create branches, add/remove worktrees, or prune registrations. Without a per-project lock, ref-lock races and flaky provisioning remain possible.

  Files:
  - Create: `packages/agent/src/gitOperationLock.ts` or add a shared lock helper where both agent lifecycle modules can use it.
  - Modify: `packages/shared/src/gitIsolation.ts` only if the lock must wrap shared provisioning entry points; otherwise keep the lock at agent call sites.
  - Modify: `packages/agent/src/subagents/planner.ts` (wrap branch/worktree provisioning calls)
  - Modify: `packages/agent/src/worktreeLifecycle.ts` and `packages/agent/src/worktreeReconcile.ts` once created by later tasks.
  - Test: `packages/agent/src/__tests__/gitOperationLock.test.ts`, `packages/agent/src/__tests__/planner.test.ts`

  Change scope:
  - New artifacts (code): keyed async mutex helper.
  - Modified artifacts (code): provisioning/lifecycle/reconciliation call sites.
  - Modified artifacts (tests): concurrent provisioning is serialized; lock is released on throw.

  Logging requirements:
  - DEBUG when waiting for/acquiring/releasing a project git lock with `{ projectRoot, operation, waitMs }`.
  - WARN when a lock wait exceeds a bounded threshold, but do not fail the task solely due to wait time.

  Dependencies: none.

- [x] **Task 3: Adopt-don't-fail provisioning (reuse existing checkout, structured retry only)**

  Deliverable: when the target branch is already checked out in some worktree, `ensureTaskWorktree` returns that worktree (`action: "reused"`) instead of throwing; when the target path exists but is bound elsewhere, the task is blocked with a precise reason rather than a generic `worktree_create_failed`.

  Why: this converts the incident from a permanent block into a no-op resume.

  Files:
  - Modify: `packages/shared/src/gitIsolation.ts` (add `listWorktrees()` parsing `git worktree list --porcelain`; adoption branch in `ensureTaskWorktree`; bounded generic retry for provisioning failures)
  - Modify: `packages/agent/src/subagents/planner.ts` (persist the adopted `worktreePath`)
  - Test: `packages/shared/src/__tests__/gitIsolation.test.ts`, `packages/agent/src/__tests__/planner.test.ts`

  Change scope:
  - New artifacts (code): `listWorktrees()` helper + `WorktreeEntry` type.
  - Modified artifacts (code): control flow of `ensureTaskWorktree`; planner persistence.
  - Modified artifacts (tests): reuse/adopt cases; retry case.

  Details:
  - Do not branch logic on `stderr.includes(...)` or regex-matching error messages. Stderr is logged only.
  - Retry policy should be based on operation class and fresh structured state checks after each failed attempt: `git worktree list --porcelain`, `show-ref`, target path existence, and current branch at candidate worktree.
  - Repo-mutating operations must run under the Task 2 project git lock.

  Logging requirements:
  - INFO `"Adopted existing worktree for branch"` with `{ taskId, branchName, worktreePath }`.
  - WARN on provisioning retry with `{ attempt, status, stderr }`.
  - ERROR with `{ branchName, projectRoot, stderr }` when provisioning ultimately fails.

  Dependencies: Task 1, Task 2.

- [x] **Task 4: Gate issue-task worktrees on the rollout flag + pass the RULES-derived branch in-tree + exclude unsafe fix tasks**

  Deliverable: with `AIF_TASK_WORKTREES_ENABLED=false`, issue tasks provision an in-tree branch via `ensureFeatureBranch` using the RULES-derived issue branch name; with the flag on, they use `ensureTaskWorktree`. The two paths yield the SAME branch name for the same issue. `isFix=true` tasks remain serial unless they already have both `branchName` and `worktreePath`.

  Why: today `shouldCreateWorktree = Boolean(githubIssue) || (…)` ignores the flag, and the in-tree path omits `explicitBranchName`, silently producing a task-scoped branch name. Fix tasks currently get no branch and would be unsafe in a parallel scheduler.

  Files:
  - Modify: `packages/agent/src/subagents/planner.ts` (extract `shouldProvisionWorktree(task, project, env)`; pass `explicitBranchName` to `ensureFeatureBranch`)
  - Modify: `packages/agent/src/gitConventions.ts` (expose a documented `resolveBranchName(prefix, provider, issueNumber)` helper with fallback chain RULES → `git.branch_prefix` → provider default)
  - Modify: `packages/agent/src/coordinator.ts` (do not treat branchless `isFix=true` tasks as parallel-eligible)
  - Test: `packages/agent/src/__tests__/planner.test.ts`, `packages/agent/src/__tests__/gitConventions.test.ts`, `packages/agent/src/__tests__/coordinator.test.ts`

  Change scope:
  - New artifacts (code): `shouldProvisionWorktree`, `resolveBranchName`.
  - Modified artifacts (code): planner provisioning branch; worktree/feature-branch call sites; scheduler eligibility guard for fix tasks.
  - Modified artifacts (tests): flag-off and flag-on branch-name parity; branchless fix tasks stay serial.

  Logging requirements:
  - INFO on provisioning decision with `{ taskId, flagEnabled, provider, branchName, mode: "worktree" | "in_tree" | "serial_fix" }`.
  - WARN when the RULES convention is missing and the fallback prefix is used, including its source.

  Dependencies: Task 1, Task 3.

### Phase 2: Diagnostics, Cleanup and DB Reconciliation

- [ ] **Task 5: Make branch-isolation failures diagnosable**

  Deliverable: branch-isolation failures log the underlying git stderr and a worktree snapshot; the activity log carries the same detail.

  Why: during the incident the real `git` error existed only in `tasks.blockedReason` — `runGit(..., { ignoreExit: true })` swallows it and the classifier logs only `branchKind`.

  Files:
  - Modify: `packages/agent/src/stageErrorHandler.ts` (add `errorMessage: branchErr.message` + snapshot to the branch-isolation ERROR log)
  - Modify: `packages/shared/src/gitIsolation.ts` (include the failing command and stderr in `BranchIsolationError.message` for every throw site; DEBUG-log the command on failure even with `ignoreExit: true`)
  - Test: `packages/agent/src/__tests__/stageErrorHandler.test.ts`

  Change scope:
  - New artifacts: none.
  - Modified artifacts (code): error message construction; stage-error logging payload.
  - Modified artifacts (tests): assertions on the logged payload.

  Logging requirements:
  - ERROR on branch-isolation block with `{ taskId, stage, branchKind, branchName, projectRoot, errorMessage, worktreeSnapshot }` (snapshot truncated to a bounded length).
  - Redact provider text where the existing helpers require it; git stderr is safe to keep.

  Dependencies: none (independent — can land first if desired).

- [ ] **Task 6: API-side agent-internal client for worktree lifecycle calls**

  Deliverable: API can call the agent internal API via HTTP without importing agent code. The helper supports the new cleanup endpoint and follows the existing `AGENT_INTERNAL_URL` + internal token pattern.

  Why: `api → agent` direct imports violate the architecture. Cleanup on task delete and PR/MR merge needs a safe HTTP bridge, not an import from `packages/agent/src/notifier.ts`.

  Files:
  - Create: `packages/api/src/services/agentInternal.ts` (`callAgentWorktreeCleanup(...)`, shared internal headers, timeout, structured response handling)
  - Modify: `packages/api/src/schemas.ts` if request/response schemas are centralized there.
  - Test: `packages/api/src/__tests__/agentInternal.test.ts` or extend route tests with fetch mocking.

  Change scope:
  - New artifacts (code): API-side agent internal client.
  - Modified artifacts (tests): API-side HTTP bridge behaviour.

  Details:
  - Use `AGENT_INTERNAL_URL` and `INTERNAL_BROADCAST_TOKEN`/internal broadcast token semantics from API-side env access.
  - Do not import from `packages/agent/src/notifier.ts` or any agent source file.
  - Network failure must be best-effort for delete/merge cleanup callers unless explicitly stated otherwise by the caller.

  Logging requirements:
  - DEBUG before call with `{ taskId, projectId, worktreePath, reason }`.
  - WARN on non-OK or network failure with `{ taskId, status, code, reason }`, without failing best-effort callers.

  Dependencies: none.

- [ ] **Task 7: Worktree cleanup on task delete (snapshot → stash -u → reference check → remove → prune)**

  Deliverable: deleting a task snapshots its git identity before DB deletion, stashes uncommitted tracked and untracked changes under a task-tagged message, checks no other live task references the same worktree, then removes the worktree and prunes registrations. The git side effect runs in the agent, not in the API process.

  Why: keeps `git worktree list` equal to the live task set, and makes uncommitted work recoverable rather than destroyed.

  Files:
  - Create: `packages/agent/src/worktreeLifecycle.ts` (`stashAndRemoveWorktree({ taskId, projectId, projectRoot, branchName, worktreePath, reason })`)
  - Modify: `packages/agent/src/internalApi.ts` (add `POST /worktrees/cleanup` next to `/gitlab/prepare`, same auth)
  - Modify: `packages/api/src/routes/tasks.ts` (on `DELETE /tasks/:id`, snapshot `projectId`, `projectRoot`, `branchName`, `worktreePath` before `deleteTask(id)`, then best-effort call through Task 6 helper; failure must NOT fail the delete)
  - Modify: `packages/data/src/index.ts` (query helper for other live tasks referencing the same `projectId + branchName + worktreePath`)
  - Test: `packages/agent/src/__tests__/internalApi.test.ts`, `packages/agent/src/__tests__/worktreeLifecycle.test.ts`, `packages/api/src/__tests__/tasks.test.ts`, `packages/data/src/__tests__/index.test.ts`

  Change scope:
  - New artifacts (code): `worktreeLifecycle.ts`; internal route.
  - Modified artifacts (code): API delete handler; API-side agent client usage; agent internal app; data query helper.
  - Modified artifacts (tests): cleanup endpoint + delete flow + reference-protection cases.

  Details:
  - Stash command must include untracked files: `git stash push -u -m "aif task <taskId> cleanup: <reason>"`.
  - Clean tree is not an error: skip stash and continue removal.
  - If stash fails, do not remove the worktree.
  - If another non-terminal task references the same worktree, skip physical removal and log a reference-protection warning.
  - Repo-mutating cleanup operations must run under the Task 2 project git lock.

  Logging requirements:
  - INFO on each step with `{ taskId, branchName, worktreePath, step: "snapshot" | "stash" | "reference_check" | "remove" | "prune", stashSha }`.
  - WARN when the task had no worktree, the tree was already clean, or cleanup is skipped because another live task references the same worktree.
  - ERROR when stash/removal fails, including stderr; the reconciliation sweep is the backstop.

  Dependencies: Task 1, Task 2, Task 3, Task 6.

- [ ] **Task 8: DB ↔ filesystem reconciliation sweep**

  Deliverable: at agent start and after terminal transitions, worktrees not referenced by a non-terminal task are removed and pruned; tasks whose `worktreePath` folder is missing are reconciled (recreate, else `blocked_external`); dangling `github_issues.task_id` / `gitlab_issues.task_id` rows pointing at deleted tasks are cleared.

  Why: an ownerless worktree on disk is what poisoned the branch in the first place; the DB is declared the source of truth.

  Files:
  - Create: `packages/agent/src/worktreeReconcile.ts` (`reconcileWorktrees({ projectRoot, reason })`)
  - Modify: `packages/agent/src/index.ts` (run once at startup before the first poll) and `packages/agent/src/coordinator.ts` (run after terminal transitions; never inside a claimed stage)
  - Modify: `packages/data/src/index.ts` (queries: active tasks with `branchName`/`worktreePath`; clear dangling VCS links)
  - Test: `packages/agent/src/__tests__/worktreeReconcile.test.ts`, `packages/data/src/__tests__/index.test.ts`

  Change scope:
  - New artifacts (code): `worktreeReconcile.ts`; data-layer query helpers.
  - Modified artifacts (code): agent bootstrap; coordinator lifecycle hook.
  - Modified artifacts (tests): orphan removal, missing-folder repair, dangling-link cleanup, legacy task-scoped path handling.

  Details:
  - For legacy task-scoped `worktreePath` rows where the folder exists and branch matches, adopt temporarily for that live task; do not move dirty worktrees automatically.
  - New provisioning always uses the canonical branch-scoped path from Task 1.
  - Legacy adopted folders are removed by normal cleanup after terminal state/delete.
  - If a DB row points to a missing folder, attempt canonical recreation from `branchName`; if recreation fails, park the task as `blocked_external` with a precise reason.
  - Repo-mutating reconciliation operations must run under the Task 2 project git lock.

  Logging requirements:
  - INFO summary per run with `{ projectRoot, scanned, removed, repaired, adoptedLegacy, danglingLinksCleared }`.
  - WARN per action with the concrete path/ids; never log full file contents.
  - ERROR if the sweep itself fails — the poll cycle must continue (sweep is best-effort but must not crash the agent).

  Dependencies: Task 1, Task 2, Task 7.

- [ ] **Task 9: Remove the worktree when the issue PR/MR is merged**

  Deliverable: when a merged PR/MR moves a task to `verified`, its worktree is cleaned up via the Task 7 mechanism.

  Why: closes the lifecycle — bounded disk growth and no stale registrations holding branches.

  Files:
  - Modify: `packages/api/src/routes/github.ts` and `packages/api/src/routes/gitlab.ts` (after the merged → `verified` transition, best-effort agent cleanup call through Task 6 helper)
  - Test: `packages/api/src/__tests__/github.test.ts`, `packages/api/src/__tests__/gitlab.test.ts`

  Change scope:
  - New artifacts: none.
  - Modified artifacts (code): two route handlers.
  - Modified artifacts (tests): assert the cleanup call on merge and that cleanup failure does not break the transition.

  Details:
  - Snapshot task git identity before the transition can clear or mutate fields.
  - Keep the branch by default; only remove the worktree registration/folder.
  - Respect Task 7 reference protection if another live task references the same worktree.

  Logging requirements:
  - INFO `"Worktree cleanup requested after merge"` with `{ taskId, prNumber/mrIid, worktreePath }`.
  - WARN when cleanup is skipped (no worktree recorded) or the agent call fails.

  Dependencies: Task 6, Task 7.

### Phase 3: Intra-Issue Fan-Out (Level 2)

- [ ] **Task 10: `AIF_IMPLEMENT_MAX_WORKERS` env + fan-out bound**

  Deliverable: new validated env var (integer, default 2, range 1-10) exposed to the implementer stage and included in the coordinator prompt.

  Why: the container is limited to `cpus: 2 / memory: 1G`; unbounded native subagents cause OOM and timeouts.

  Files:
  - Modify: `packages/shared/src/env.ts`
  - Modify: `packages/agent/src/subagents/implementer.ts` (inject the limit into the prompt + workflow metadata)
  - Test: `packages/shared/src/__tests__/env.test.ts`, `packages/agent/src/__tests__/implementer.test.ts`

  Change scope:
  - New artifacts (code): env entry.
  - Modified artifacts (code): implementer prompt/metadata.
  - Modified artifacts (config/docs): referenced in Task 14.

  Logging requirements:
  - DEBUG resolved limit with `{ maxWorkers, source: "env" | "default" }`.
  - WARN when the configured value is outside the accepted range and the default is applied.

  Dependencies: none.

- [ ] **Task 11: Inject the layer summary + worker contract into the implementer prompt**

  Deliverable: the implementer prompt contains the plan's execution layers and explicit worker rules (edit-only, no git writes, coordinator owns the plan file and git, repo-wide builds/tests run once per layer, per-layer checkpoint for rollback).

  Why: `formatLayerSummary` already renders `"Layer N (parallel): …"` but is dead code; without the contract, fan-out workers race on git and on the checklist.

  Files:
  - Modify: `packages/agent/src/subagents/implementer.ts` (include `formatLayerSummary(layerComputation.layers)` and the contract block in `Execution rules`)
  - Modify: `packages/agent/src/planLayers.ts` (no API change needed unless Task 12 introduces shared types)
  - Test: `packages/agent/src/__tests__/implementer.test.ts`, `packages/agent/src/__tests__/planLayers.test.ts`

  Change scope:
  - New artifacts: none.
  - Modified artifacts (code): prompt construction.
  - Modified artifacts (tests): prompt contains the layer summary and contract lines.

  Logging requirements:
  - DEBUG the injected layer summary and the resolved worker cap: `{ taskId, layers: number[][], maxWorkers }`.
  - INFO when a layer has more than one task (parallel) and when a layer is reduced to sequential.

  Dependencies: Task 10.

- [ ] **Task 12: Plan change-scope contract + disjointness validation + post-layer enforcement**

  Deliverable: plan tasks declare their change scope (target files, purpose, new vs modified artifacts); the parser extracts it; before fan-out the orchestrator validates that tasks in the same layer touch disjoint file sets, sequences any overlapping tasks, and validates actual touched files after each layer against the allowed scope.

  Why: the dependency DAG is logical, not file-based — two "independent" tasks can still edit the same file and silently overwrite each other. Prompt-only enforcement is too weak for Level 2 safety.

  Files:
  - Modify: `packages/agent/src/planLayers.ts` (parse a `Change scope:` block per task; expose per-task file lists and artifact types)
  - Modify: `packages/agent/src/subagents/implementer.ts` (validate disjointness per layer; emit a sequential directive on overlap; collect layer baseline/diff metadata)
  - Test: `packages/agent/src/__tests__/planLayers.test.ts`, `packages/agent/src/__tests__/implementer.test.ts`

  Change scope:
  - New artifacts (code): change-scope parser + `PlanTaskNode.files` / artifact metadata.
  - Modified artifacts (code): layer preparation and post-layer validation in the implementer.
  - Modified artifacts (tests): parsing, disjointness, overlap → sequential, actual touched-file violation → block/rework.

  Details:
  - Treat tasks with missing or unparsable change scope as overlapping, therefore sequential.
  - Workers must not edit the plan file; coordinator owns checklist annotation.
  - After each layer, compare `git diff --name-only` from the layer baseline to actual touched files. If a worker touched files outside its declared scope, block or force sequential rework rather than committing silently.
  - Repo-wide builds/tests run once per layer, not once per worker.

  Logging requirements:
  - INFO per layer with `{ layerIndex, tasks, overlapping: boolean, decision: "parallel" | "sequential" }`.
  - WARN when a task declares no change scope or actual touched files exceed declared scope.
  - DEBUG the parsed file sets and actual diff file set.

  Dependencies: Task 11.

- [ ] **Task 13: Fresh agent session on task restart**

  Deliverable: the implementer starts a NEW session on every run instead of resuming the previous one.

  Why: a restarted task resumes in the same worktree but must not carry stale model context from the previous attempt.

  Files:
  - Modify: `packages/agent/src/subagents/implementer.ts` (`sessionReusePolicy: "never"`; keep rework semantics unchanged)
  - Test: `packages/agent/src/__tests__/implementer.test.ts`, `packages/agent/src/__tests__/subagentQuery.test.ts` (if session policy is asserted there)

  Change scope:
  - New artifacts: none.
  - Modified artifacts (code): workflow spec session policy.
  - Modified artifacts (tests): session-reuse expectations.

  Logging requirements:
  - INFO `"Implementer starting a fresh session"` with `{ taskId, previousSessionId: null, reason }`.

  Dependencies: none.

### Phase 4: Documentation

- [ ] **Task 14: Documentation update**

  Deliverable: docs describe the two levels of parallelism, the worktree lifecycle, the DB-as-source-of-truth rule, git mutation locking, cleanup reference protection, unsafe fix-task serialization, and the new env vars; stale "worktrees are retained after done/verified" and "GitHub tasks always use a worktree" statements are corrected.

  Files:
  - Modify: `docs/architecture.md` (worktree policy; Level 1 / Level 2; lifecycle; reconciliation; git mutation lock)
  - Modify: `docs/configuration.md` (`AIF_WORKTREE_ROOT`, `AIF_IMPLEMENT_MAX_WORKERS`, enablement combination `AIF_TASK_WORKTREES_ENABLED` + `parallelEnabled`)
  - Modify: `docs/api.md` (the new internal `POST /worktrees/cleanup` contract and best-effort callers)
  - Modify: `AGENTS.md` (project map: new agent modules)

  Change scope:
  - New artifacts: none.
  - Modified artifacts (docs): 4 files.

  Logging requirements: n/a (docs only).

  Dependencies: Tasks 1-13.

## Deferred / Open Questions

Not in this plan's scope; resolve before or alongside a follow-up plan.

1. **PR comment → `/aif-improve`.** Current behaviour moves `plan_review` → `planning` and re-runs the reasoner with `planReviewFeedback`; `/aif-improve` only exists in skills mode (`runPlanImprove && !useSubagents`). Decide whether the VCS-feedback path targets the improver stage or stays planner-based.
2. **Shared-artifact divergence** across parallel issue branches (`AGENTS.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `RULES.md`). Decide the conflict policy (serialise doc-updating stages, or accept merge conflicts).
3. **Branch deletion on task delete.** This plan assumes the issue branch is retained (assumption 1).
4. **Full deterministic branch policy for `isFix` tasks.** This plan adds a safety guard so branchless fix tasks do not run in parallel; a follow-up can give fix tasks deterministic `fix/...` branches/worktrees.

## Post-Implementation (deployment, not code)

To actually enable Level 1 parallelism:

```
AIF_TASK_WORKTREES_ENABLED=true
project.parallelEnabled=true
AIF_IMPLEMENT_MAX_WORKERS=2
```

Enable only after tasks 1-9 have landed — otherwise folder churn, ref-lock races, and collisions reproduce at larger scale.
