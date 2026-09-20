# Test Plan — E2E GUI suite (Playwright, real dev stack)

- Branch: `feature/missing-gates-and-makefile-integration`
- Level: E2E GUI (`docs/qa/e2e-gui-testing.md`)
- Stand: dev stack (API :3009 + web :5180), browser chromium, Playwright `packages/web/playwright.config.ts`
- Trace format: primary UC (`UC-<domain>.<...>`, channel GUI) + context HF/BR/KI, one per line (per §5.3)

## Scenario cards

### L-01. Kanban board: view columns and task cards

**Trace:** `UC-dashboard.board.view-kanban-columns` (primary); `HF2.1`, `BR-fact.audit.observability`, `contract-aif-rest-api` (context)
**Priority:** P0

Preconditions:
- dev stack up; project with tasks present (`VNC`, `c1de80b3-...`)
- navigation to `/project/<id>`

Steps:
1. Open the project page.
2. Assert the 11 stage columns render (labels + counts).
3. Open a real task card and assert title/priority/owner present on the card.

Expected:
- Columns by `STATUS_CONFIG` labels: Backlog, Planning, Improve, Plan Ready, Plan Review, Implementing, Verify, Review, Blocked, Done, Accepted.
- Task card shows title, priority label, ownership badge (`AI owner`), activity line (`#id · time · auto on/off`).
- External oracle: `GET /api/tasks?projectId=X` returns the tasks; card count in Backlog equals API backlog count.

### L-02. Task details: slide-over, sections, comment flow

**Trace:** `UC-dashboard.detail.view-task-details` (primary); `HF2.3`, `contract-aif-rest-api` (context)
**Priority:** P0

Preconditions:
- a task exists; disposable task created via API if the project has no openable task.

Steps:
1. Open the task (click card) → slide-over panel appears.
2. Assert Description section, token/cost badges, status badge.
3. Switch to Comments tab; post a comment; assert it appears.
4. External oracle: `POST /api/tasks/:id/comments` persisted; comment visible in `GET /api/tasks/:id/comments`.
5. Plan section: hidden when `plan=null` (US scenario "План не сгенерирован").

### L-03. Manual stage override (Start AI)

**Trace:** `UC-pipeline.manual-override.intervene-task-stage` (primary); `HF1.7`, `BR-trigger.*` (context)
**Priority:** P1

Preconditions:
- disposable task: backlog, `autoMode:false`, `paused:true`, plan file absent.

Steps:
1. Open the task, click `Start AI`.
2. Assert status badge changes to Planning; card moves out of Backlog.
3. External oracle: `GET /api/tasks/:id` → `status: "planning"`.
4. Negative: action not allowed for current status — e.g. `start_ai` on a non-backlog task is rejected with an error message.

### L-04. Handoff ownership (AI → Human)

**Trace:** `UC-handoff.transfer.ownership-to-executor` (primary); `HF7.1`, `BR-constraint.ownership.handoff`, `BR-fact.ownership.*`, `contract-aif-rest-api` (context)
**Priority:** P0

Preconditions:
- disposable task: backlog, `autoMode:false`, `paused:true`, owner AI.

Steps:
1. Open task → Actions → `Assign / hand off`.
2. Select `Human` owner, set reason, save.
3. Assert: dialog closes; `Human owner` badge + reason visible; Executor history shows the handoff entry.
4. External oracle: task `executionOwner=human`, `ownershipRevision` incremented; `GET /api/tasks/:id/executor-history` contains entry.

### L-05. Runtime profile creation

**Trace:** `UC-runtime.profile.configure-project-runtime` (primary); `HF3.1`, `contract-aif-rest-api` (context)
**Priority:** P0

Preconditions:
- admin (participants disabled → everyone); `ProjectRuntimeSettings` openable.

Steps:
1. Open runtime settings → create a disposable project-scoped profile with a known `runtimeId`, model, transport, `apiKeyEnvVar` (no secrets).
2. Assert profile appears in the list.
3. External oracle: `POST /runtime-profiles` 200; `GET /runtime-profiles` contains the profile.
4. Cleanup: `DELETE /runtime-profiles/:id`.

### L-07. Real-time status updates via WebSocket

**Trace:** `UC-dashboard.realtime.receive-live-status-updates` (primary); `HF2.4`, `contract-aif-ws` (context)
**Priority:** P1

Preconditions:
- board open; disposable task in backlog (`autoMode:false`, `paused:true`).

Steps:
1. Open board page → WS connects (`ws:connected`).
2. Move the task to `planning` via the API (`POST /tasks/:id/events` `start_ai`) — external actor.
3. Assert the board updates without reload: card leaves Backlog, appears in Planning, count changes.

### L-08. Registration / login

**Trace:** `UC-auth.registration.sign-up-participant` (primary); `HF9.1`, `BR-constraint.auth.sessions` (context)
**Priority:** P1

**Status on this stand: BLOCKED.** The US scenario requires `PARTICIPANTS_MODE_ENABLED=true`; the dev stand runs with `false` (`.env`). `/participants` returns `participants_mode_disabled`, and the UI renders no LoginPage. Per user rule ("не менять ни код, ни сценарий"), the defect/environment gap is recorded in `docs/known-issues.md`; the spec is implemented as a guarded smoke that asserts the participants-disabled state (or skipped with explicit reason).

### L-06. Participant roles (admin dialog)

**Trace:** `UC-auth.roles.assign-participant-role` (primary); `HF9.2`, `BR-fact.auth.roles` (context)
**Priority:** P1

**Status on this stand: BLOCKED** — same root cause as L-08 (participants mode disabled). Recorded in `docs/known-issues.md`.

## Contract references

- `docs/contracts/` — `contract-aif-rest-api`, `contract-aif-ws`
- API paths: `/tasks`, `/tasks/:id/events`, `/tasks/:id/handoff`, `/tasks/:id/comments`, `/runtime-profiles`
- WS events handled by `useWebSocket`: `ws:connected`, `task:moved`, `task:heartbeat`, `task:comment_created`, `task:handoff`

## Artifacts per run

- Playwright traces (`trace: retain-on-failure`) in `playwright-report/`
- Screenshots on failure
- HTML report + JSON results