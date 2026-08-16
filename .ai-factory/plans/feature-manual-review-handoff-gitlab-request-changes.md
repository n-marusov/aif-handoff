# Implementation Plan: Unblock Manual-Review Handoff + GitLab Request-Changes → Rework

Branch: feature/live-kanban-heartbeat-usage (same branch, per user request; no new branch created)
Created: 2026-08-16

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes

## TDD Discipline
Every behavioral task follows strict TDD (red → green → refactor):

1. **Red** — write the failing tests first for the described behavior (file paths are listed per task). Do NOT write production code before the failing test exists.
2. **Green** — implement the minimal change that makes the tests pass.
3. **Refactor** — clean up the implementation while keeping the suite green; no behavior change.

Tasks that are type/contract-only (Path 3 Task 1) or migration-only (Path 3 Task 2) are exempt from the red/green cycle; their tests are compile/type-guard or DB round-trip respectively. After each phase, run the affected package test suite, and finish with `npm run ai:validate` plus a per-package coverage check (>=70%).

## Roadmap Linkage
Milestone: "none"
Rationale: Skipped — all roadmap milestones are already completed.

## Research Context
Source: .ai-factory/RESEARCH.md (Active Summary)

Topic: Unblock manual-review handoff + wire GitLab "request changes" to rework.

Goal: Fix two gaps that left task b0f811dc (GitLab issue #1, MR !1) stuck in `review` after auto-review hit max iterations (4/3) and handed off to a human with zero actionable UI buttons in legacy mode.

Key decisions (from research, verified against live GitLab API):
- **Path 2** is a legacy-mode state-machine bugfix: `complete_review` / `request_review_changes` exist only in `resolveHumanOwnerAction` (participants mode). In legacy mode `resolveTaskAction` routes every task through `resolveLegacyAction`, which has NO events from `review`. Fix = add the two events to `resolveLegacyAction`, gated on `executionOwner === "human"`, so AI-owned review tasks (coordinator-owned) stay untouched. Do NOT reroute all human-owned tasks through the human resolver — test `stateMachine.test.ts` "preserves disabled-mode anonymous compatibility" pins `start_ai` on human-owned backlog in legacy mode.
- **Path 3** detects GitLab "Request changes" NOT via `detailed_merge_status` (verified: stays `mergeable` even with `with_merge_status_recheck=true` on gitlab.com Free) but via the **system note** in the MR notes API: `{ system: true, body: "requested changes" }` (verified live: note id 3691116788). Dedup by storing the last-seen review note id (`last_review_note_id`), analogous to GitHub's `lastReviewId` in `routes/github.ts:254-274`.
- `request_review_changes`/`requested_changes` → `implementing` must set `reworkRequested: true` and reset the auto-queue commit state (`autoQueueCommitStatus: "pending"`, baseSha = current commitSha, commitSha: null), mirroring GitHub.

Constraints:
- Migration append-only: new column `last_review_note_id` on `gitlab_issues` goes to version **32** (next free slot); never renumber existing migrations.
- DB boundary via @aif/data.
- Legacy-mode semantics pinned by existing tests — preserve anonymous compatibility.
- Every package >=70% coverage; finish with `npm run ai:validate`.

Success signals:
- Task b0f811dc (or any manual-review handoff) shows "Complete review" / "Request review changes" buttons in Web UI (legacy mode).
- Clicking "Request review changes" moves the task to `implementing` with `reworkRequested: true`.
- A new "requested changes" system note on the GitLab MR moves an AI-owned `review`/`done` task back to `implementing` exactly once (edge-triggered by note id).

## Commit Plan
- **Commit 1** (after Path 2): `fix(shared): allow human review actions from review in legacy mode`
- **Commit 2** (after Path 3 Tasks 1-3): `feat(data,api): persist and detect GitLab request-changes review notes`
- **Commit 3** (after Path 3 Task 4): `feat(api): resume implementing on GitLab requested-changes`
- **Commit 4** (after docs): `docs: document legacy review actions and GitLab request-changes flow`

## Tasks

### Path 2 — Legacy-mode human review actions (bugfix)

- [ ] Task 1: Allow `complete_review` / `request_review_changes` for human-owned `review` tasks in legacy mode.
  Files to create/modify:
  - `packages/shared/src/stateMachine.ts`:
    - Widen the `resolveLegacyAction` parameter type from `Pick<TaskPolicyView, "status" | "autoMode" | "blockedFromStatus">` to include `executionOwner` and `runPostVerify` (both already exist on `TaskPolicyView`; `resolveTaskAction` already passes the full `TaskPolicyView`).
    - Add two cases to `resolveLegacyAction`:
      - `complete_review`: allowed when `task.status === "review" && task.executionOwner === "human"` → `{ ...CLEAN_STATE_RESET, status: task.runPostVerify ? "verify" : "done" }`; otherwise `denied("action_not_allowed", ...)`.
      - `request_review_changes`: allowed when `task.status === "review" && task.executionOwner === "human"` → `{ ...CLEAN_STATE_RESET, status: "implementing", reworkRequested: true }`; otherwise denied.
    - Do NOT change the `resolveTaskAction` routing (legacy mode stays on `resolveLegacyAction`); keep AI-owned review tasks action-less in legacy mode (coordinator owns that stage).
  - Tests: `packages/shared/src/__tests__/stateMachine.test.ts` — RED first:
    - legacy mode (`participantsModeEnabled: false`), human-owned `review` task: `complete_review` → `done`; `request_review_changes` → `implementing` + `reworkRequested: true`.
    - legacy mode, AI-owned `review` task: both events denied (no new buttons for coordinator-owned tasks).
    - regression: human-owned `backlog` + `start_ai` still resolves (existing "disabled-mode anonymous compatibility" test must keep passing).
  TDD: red → green → refactor.
  Deliverable: legacy-mode human-owned review tasks expose `complete_review` / `request_review_changes` in `permissions.permittedActions` → Web UI buttons render.
  LOGGING REQUIREMENTS: no new logging in the pure state machine (it is I/O-free by contract); rely on the existing `data:task-transitions` WARN for rejected actions.

### Path 3 — GitLab "request changes" → rework (feature)

- [ ] Task 2: Add `system` to the GitLab note response model.
  Files to create/modify:
  - `packages/api/src/services/gitlab.ts` — add `system?: boolean` (and `type?: string | null` for future use) to `GitLabNoteResponse` (currently only `id`, `body`, `author`, `created_at`, `updated_at`). `listMergeRequestNotes` already exists and is used by `upsertMarkerNote` — no new client method needed.
  - Tests: `packages/api/src/__tests__/gitlab.test.ts` — type/contract guard: a note parsed from the API can carry `system: true` (extend an existing client test or add a small parse assertion).
  TDD: type/contract-only (no runtime red/green; the field flows through the generic `request<T>()`).
  Deliverable: `GitLabNoteResponse.system` is available to sync logic.
  LOGGING REQUIREMENTS: n/a (type only).

- [ ] Task 3: Persist `last_review_note_id` on `gitlab_issues`.
  Files to create/modify:
  - `packages/shared/src/schema.ts` — add `lastReviewNoteId: integer("last_review_note_id")` to the `gitlabIssues` table definition.
  - `packages/shared/src/db.ts` — append migration **version 32** (append-only; do NOT touch existing entries): `ALTER TABLE gitlab_issues ADD COLUMN last_review_note_id INTEGER;`
  - `packages/data/src/gitlab.ts` — extend `updateGitLabMergeRequest` input with optional `lastReviewNoteId?: number | null` and persist it when provided (spread-style like `reviewFingerprint`). Also expose it via `GitLabIssueLink`/`toIssueLink` if the row mapping doesn't already carry it.
  - Tests: `packages/data/src/__tests__/gitlab.test.ts` — RED first: call `updateGitLabMergeRequest({ ..., lastReviewNoteId: 3691116788 })`, then assert the stored issue row round-trips the value (and `null`/absent leaves it unchanged).
  TDD: DB round-trip red → green.
  Deliverable: the sync can read the last-processed review note id from the DB.
  LOGGING REQUIREMENTS: DEBUG in `updateGitLabMergeRequest` when `lastReviewNoteId` changes (extend the existing write path log if present; keep INFO-free).

- [ ] Task 4: Detect GitLab "requested changes" system note in sync and resume the task at `implementing`.
  Files to create/modify:
  - `packages/api/src/routes/gitlab.ts` — in the sync handler (the `if (mrIid)` block, around lines 245-287):
    1. After fetching MR approvals/checks, fetch MR notes: `const mrNotes = await client.listMergeRequestNotes(connection.namespace, connection.name, mr.iid)`.
    2. Find the latest "request changes" note: `notes.filter(n => n.system && n.body?.trim() === "requested changes").sort by id desc` → take `[0]`.
    3. If such a note exists AND `note.id > (existing?.lastReviewNoteId ?? 0)` AND `task.status === "done" || task.status === "review"`:
       - `updateTaskStatus(task.id, "implementing", { reworkRequested: true, reviewComments: task.reviewComments, autoQueueCommitStatus: "pending", autoQueueCommitBaseSha: task.commitSha, commitSha: null, autoQueueCommitError: null, autoQueueCommitCompletedAt: null }, { kind: "system", id: "gitlab-review", displayNameSnapshot: "GitLab Review" })` — mirror `routes/github.ts:254-274`. Preserve `reviewComments` (the system note body is just "requested changes" — no useful review text).
       - After the transition, persist `lastReviewNoteId: note.id` via `updateGitLabMergeRequest` (edge-trigger: only fire once per note).
    4. If the note exists but was already processed (`note.id <= lastReviewNoteId`), skip the transition but still refresh `lastReviewNoteId`/other MR metadata (idempotent sync).
  - Tests: `packages/api/src/__tests__/gitlab.test.ts` — RED first:
    - MR notes contain a new `system: true, body: "requested changes"` note → task `done` (or `review`) moves to `implementing` with `reworkRequested: true`; `lastReviewNoteId` persisted.
    - Same note on the next sync → task does NOT bounce again (edge-triggered; `updateTaskStatus` not called).
    - `detailed_merge_status: "mergeable"` with NO request-changes note → no transition (guard against false positives).
    - MR merged → `verified` still works (regression).
  TDD: red → green → refactor.
  Deliverable: a human clicking "Request changes" on the GitLab MR resumes an AI-owned task at `implementing` (the AI then fixes and re-runs the review loop).
  LOGGING REQUIREMENTS: INFO `{ taskId, iid, noteId }` when resuming the task at `implementing` (component `gitlab-routes`); DEBUG for the idempotent skip (already-processed note); WARN only on API failures (existing `gitlabErrorResponse` path).

- [ ] Task 5: Update documentation for both changes.
  Files to create/modify:
  - `docs/api.md` — GitLab Issue-to-MR "Synchronize Issues and Merge Requests" section: document the `requested_changes → implementing` resume (system-note signal, edge-triggered by note id), replacing the "no automatic changes_requested transition in v1" sentence for GitLab; note the Web UI legacy-mode human review actions (`complete_review` / `request_review_changes` from `review` for human-owned tasks).
  - `docs/architecture.md` — Task State Machine "Human-owned status" table: clarify `review` → `complete_review` / `request_review_changes` also apply in legacy mode for human-owned tasks; GitLab Issue-to-MR section: note the request-changes resume signal.
  - `docs/configuration.md` — Auto-Review Convergence section: update "Humans then resolve it with the existing approve_done or request_changes actions" to also mention the review-status actions and the GitLab MR request-changes path.
  TDD: n/a (documentation only).
  Deliverable: docs reflect the new legacy review actions and the GitLab request-changes → rework flow.
  LOGGING REQUIREMENTS: n/a.
  Dependencies: Tasks 1-4.

## Risks & Considerations

- **Legacy-mode pin:** the existing test "preserves disabled-mode anonymous compatibility" must keep passing — do not reroute all human-owned tasks through `resolveHumanOwnerAction`; only add the two guarded cases to `resolveLegacyAction`.
- **AI-owned review tasks:** in legacy mode, `complete_review` / `request_review_changes` must NOT appear for AI-owned `review` tasks — the coordinator owns that stage and a human clicking "Complete review" mid-run would bypass the auto-review gate.
- **Human-owned implementing after request_review_changes:** `request_review_changes` → `implementing` keeps the task human-owned; the coordinator skips non-AI tasks (`processOneTask` returns false). The human then uses the existing "Assign / hand off" UI (canHandoff=true in legacy) to hand back to AI. Document this in the task detail or leave as two-click flow (documented in docs task).
- **GitLab "requested changes" is a system note, not a status:** rely on `{ system: true, body: "requested changes" }` from `GET /merge_requests/:iid/notes`. `detailed_merge_status` stays `mergeable` on gitlab.com Free — do NOT gate on it.
- **Edge-trigger correctness:** `last_review_note_id` must be persisted atomically with (or right after) the status transition; on sync idempotency, skip already-processed note ids. Watch ordering: a note may be created while the task is `review` (human-owned) — the condition `status === "review"` covers it; the transition keeps `executionOwner` as-is (AI-owned stays AI-owned so the coordinator picks it up).
- **No new MR review text:** the system note body is just "requested changes" — keep existing `reviewComments` intact.
- **Test coverage:** state machine (shared), GitLab sync (api), data round-trip (data) — all >=70% per package after the change; run `npm run ai:validate`.
