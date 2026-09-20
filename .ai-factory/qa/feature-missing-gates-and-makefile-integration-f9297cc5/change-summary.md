# Change Summary — E2E GUI Test Suite (Playwright)

- Branch: `feature/missing-gates-and-makefile-integration`
- Date: 2026-09-20
- Scope: implement the E2E GUI suite in `packages/web/e2e/` per `docs/qa/e2e-gui-testing.md`, tracing to GUI user stories (`docs/user-stories/`).

## What changed

New Playwright specs are added under `packages/web/e2e/` that run against the **real**
dev stack (API :3009 + web :5180, browser chromium). Each spec:

- carries machine-checkable trace comments (primary UC, context HF/BR) per §5.3 of `e2e-gui-testing.md`;
- uses the real API as the external oracle (DOM assertions + REST verification);
- creates only disposable data (tasks/profiles), deletes it in cleanup;
- relies on the existing Playwright config (`trace: retain-on-failure`, `workers: 1`).

## Stand facts (verified live, 2026-09-20)

| Fact | Value |
| ---- | ----- |
| API `/health` | 200 |
| web `/` | 200 |
| `PARTICIPANTS_MODE_ENABLED` | `false` (`.env`) |
| `/auth/session` | `{participantsModeEnabled:false,...}` |
| `/participants` | `participants_mode_disabled` |
| Runtime profiles | `[]` (empty) |
| Project | `VNC` (`c1de80b3-...`), tasks present |
| Dev stack processes | api + web + **agent (coordinator)** via `npm run dev` |

## Risks / mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Coordinator hijacks test tasks | create tasks with `autoMode:false` and `paused:true`; manual `start_ai` on paused tasks |
| Tests write to dev DB | only disposable fixtures; `afterAll`/`afterEach` cleanup via REST DELETE |
| Participants mode disabled | L-08 (auth/roles) is **not runnable** on this stand — the US scenario requires `PARTICIPANTS_MODE_ENABLED=true`; recorded in `docs/known-issues.md` |
| Handoff dialog with participants disabled | handoff AI→human without assignees works on the real API (verified: `executionOwner=human`, `ownershipRevision=1`) |
| Runtime profile creation is persistent | create + delete profile in cleanup; profile uses `apiKeyEnvVar` only, no secrets in DB |

## Priority mapping (e2e-gui-testing.md §3.1, §12)

- L-01 Kanban view — P0
- L-02 Task details + comment — P0
- L-03 Manual stage override (Start AI) — P1
- L-04 Handoff — P0
- L-05 Runtime profile config — P0
- L-07 Real-time status updates — P1
- L-08 Registration/login — P1 — **blocked on stand** (participants mode disabled)
- L-06 Roles — P1 — **blocked on stand** (participants mode disabled)