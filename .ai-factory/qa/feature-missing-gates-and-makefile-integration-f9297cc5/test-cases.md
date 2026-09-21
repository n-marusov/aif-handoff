# Test Cases — E2E GUI suite

Branch: `feature/missing-gates-and-makefile-integration`. Level: E2E GUI.
Stand: dev stack (API :3009 + web :5180), chromium. Project under test: `VNC` (`c1de80b3-2ba0-48c7-9f04-2d777472d218`).

Global fixture rules:
- test tasks are named `e2e-<scenario>-<runId>` and created with `autoMode:false`, `paused:true` to keep the coordinator from hijacking them;
- cleanup deletes created rows via REST before the test exits;
- runner Vars: `runId = Date.now()`; API base `http://localhost:3009` via `page.request`.

---

## TC-L-01 Kanban view

Trace: `UC-dashboard.board.view-kanban-columns`; `HF2.1`, `BR-fact.audit.observability`.

Preconditions: dev stack; project VNC has ≥1 task; browser navigates to `/project/<VNC>`.

| Step | Action | Expected |
| ---- | ------ | -------- |
| 1 | `page.goto("/project/<VNC>")` | board renders, no login |
| 2 | `expect` columns: Backlog, Planning, Improve, Plan Ready, Plan Review, Implementing, Verify, Review, Blocked, Done, Accepted | all 11 headings visible |
| 3 | API oracle: `GET /tasks?projectId=VNC` → backlog count `n` | Backlog column shows count `n` |
| 4 | Open first real task card | title text present on card; card shows `AI owner` badge or human; priority badge if `priority>0` |
| 5 | Negative: assert that a random non-existent title does NOT appear (`toBeHidden`) | no false positive |

Artifacts: trace on failure, screenshot on failure.

---

## TC-L-02 Task detail + comment

Trace: `UC-dashboard.detail.view-task-details`; `HF2.3`.

Preconditions: one disposable task (`e2e-detail-<runId>`) created via REST: canvas "Task details E2E <runId>", status backlog, paused, no plan file.

| Step | Action | Expected |
| ---- | ------ | -------- |
| 1 | Open project, click the task card | slide-over appears; badge shows status; description text visible |
| 2 | Assert token badges (in/out/total/cost) visible when values present | badges render |
| 3 | Switch to `Comments` tab | comment list empty or existing; input field present |
| 4 | Type comment `e2e-comment-<runId>` and submit | comment appears in the list |
| 5 | External oracle | `GET /tasks/:id/comments` contains the message |
| 6 | Close panel | slide-over closes |
| 7 | Cleanup | `DELETE /tasks/:id` (200) |

Negative: posting empty comment is disabled (submit disabled while empty) — assert the submit control is disabled with empty input.

---

## TC-L-03 Manual override (Start AI)

Trace: `UC-pipeline.manual-override.intervene-task-stage`; `HF1.7`.

Preconditions: disposable task (`e2e-manual-<runId>`), backlog, paused, `autoMode:false`, plan file absent.

| Step | Action | Expected |
| ---- | ------ | -------- |
| 1 | Open task; in Actions click `Start AI` | request `POST /tasks/:id/events {event:start_ai}`; dialog closes |
| 2 | Assert UI | status badge changes to `Planning`; card leaves Backlog, appears in Planning column |
| 3 | External oracle | `GET /tasks/:id` → `status:"planning"` |
| 4 | Cleanup | `DELETE /tasks/:id` (200) |

Negative: try `start_ai` on a task already in planning via direct API — expect state machine rejection (non-200 / error body). (UI-level negative if reachable.)

---

## TC-L-04 Handoff

Trace: `UC-handoff.transfer.ownership-to-executor`; `HF7.1`, `BR-constraint.ownership.handoff`.

Preconditions: disposable task (`e2e-handoff-<runId>`), backlog, paused, owner AI.

| Step | Action | Expected |
| ---- | ------ | -------- |
| 1 | Open task → `Assign / hand off` | dialog `Assign or hand off task` opens |
| 2 | Select `Human` radio, fill reason `e2e-handoff-<runId>` | Save ownership enabled |
| 3 | Click `Save ownership` | dialog closes; `Human owner` badge visible |
| 4 | Switch to `Executors` tab | history entry with reason visible |
| 5 | External oracle | `GET /tasks/:id` → `executionOwner:"human"`, `ownershipRevision≥1`; `GET /tasks/:id/executor-history` includes entry |
| 6 | Cleanup | `DELETE /tasks/:id` (200) |

---

## TC-L-05 Runtime profile

Trace: `UC-runtime.profile.configure-project-runtime`; `HF3.1`.

Preconditions: admin (participants disabled); project VNC.

| Step | Action | Expected |
| ---- | ------ | -------- |
| 1 | Open header runtime settings (`ProjectRuntimeSettings`) | dialog opens |
| 2 | Create profile `e2e-profile-<runId>`: runtimeId from `/runtime-profiles/runtimes` (pick first, e.g. `claude`), model, transport, apiKeyEnvVar=`E2E_FAKE_KEY_ENV` | POST `/runtime-profiles` 200; profile appears in list |
| 3 | External oracle | `GET /runtime-profiles?projectId=VNC` contains the profile |
| 4 | Cleanup | `DELETE /runtime-profiles/:id` (200) |

Negative: `apiKeyEnvVar` must be a valid env-var name; invalid name → 400 with message (UI shows error).

---

## TC-L-07 Real-time

Trace: `UC-dashboard.realtime.receive-live-status-updates`; `HF2.4`, `contract-aif-ws`.

Preconditions: disposable task; board open.

| Step | Action | Expected |
| ---- | ------ | -------- |
| 1 | Open board | WS `ws:connected` received (clientId assigned) |
| 2 | Move task via API: `POST /tasks/:id/events {event:"start_ai"}` | `task:moved` broadcast |
| 3 | Assert without reload | card disappears from Backlog column, appears in Planning; no `page.reload()` |
| 4 | External oracle | `GET /tasks/:id` → `planning` |
| 5 | Cleanup | `DELETE /tasks/:id` (200) |

---

## TC-L-09 LLM integration smoke (Codex API transport)

Trace: `UC-runtime.profile.configure-project-runtime`; `HF3.1`, `contract-runtime-adapter`.

Preconditions:
- integration env file exists: `.env.integration` (copied from `.env.e2e`), with `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`;
- run flag enabled: `AIF_LLM_INTEGRATION=1`;
- runtime package dependencies installed.

| Step | Action | Expected |
| ---- | ------ | -------- |
| 1 | Load env from `.env.integration` for test process | process has non-empty `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` |
| 2 | Call `validateCodexAgentApiConnection` with `baseUrl`+`apiKey` from env | result `ok:true` (provider `/models` reachable and key accepted) |
| 3 | Run `runCodexAgentApi` with model from env and prompt `Reply with exactly: OK` | run completes without exception; `outputText` is non-empty |
| 4 | Verify envelope fields | `sessionId` is `string \| null`; `usage` is `RuntimeUsage \| null` |
| 5 | Negative guard | when `AIF_LLM_INTEGRATION!=1`, test is skipped (does not hit external LLM) |

---

## TC-L-10 GitLab integration (Issue → MR → review → merge)

Trace: `UC-integration.issues.bootstrap-project-sync-and-create-task`; `UC-integration.pr-mr.publish-github-pr` (GitLab-вариант); `HF11.1/HF11.2/HF1.6`, `contract-aif-gitlab`.

Preconditions:
- integration env file `.env.integration` carries GitLab settings from `docker-compose.e2e.yml`: `GIT_PROVIDER=gitlab`, `AIF_GITLAB_ISSUE_MR_ENABLED=true`, `AIF_GITLAB_BASE_URL=http://localhost:8929/api/v4`, `GITLAB_TOKEN=<PAT>`, `GITLAB_TEST_NAMESPACE=root`, `GITLAB_TEST_PROJECT=e2e-target`;
- test GitLab stand is up (e.g. `node scripts/e2e-docker.mjs --prepare` brings up `gitlab-ce` + provisions root PAT `aif-e2e` and repository `root/e2e-target`);
- run flag enabled: `AIF_GITLAB_INTEGRATION=1`.

| Step | Action | Expected |
| ---- | ------ | -------- |
| 1 | Load env from `.env.integration` | process has non-empty `AIF_GITLAB_BASE_URL`, `GITLAB_TOKEN`, test project path |
| 2 | `GitLabClient.getRepository(namespace/name)` for `root/e2e-target` | remote project returned; `default_branch` non-empty; `web_url` contains repo path |
| 3 | Create branch + commit file in test repo via GitLab REST API | branch exists; commit created on the branch |
| 4 | Create issue via REST API | issue `iid` returned, state `opened` |
| 5 | `GitLabClient.createMergeRequest` (source branch, target main, description `Closes #<iid>`) | MR created; `findMergeRequest` finds it |
| 6 | `getMergeRequestApprovals` | `reviewState: "pending"` before any approve |
| 7 | `upsertMarkerNote` twice with same marker | only one note with the marker exists (idsempotent update) |
| 8 | `getCommitChecks(sha)` | result is `null \| "pending" \| "success" \| "failure"` (no exception) |
| 9 | Approve MR via REST API (`POST /merge_requests/:iid/approve`) | `getMergeRequestApprovals` → `reviewState: "approved"`; system note `approved this merge request` appears |
| 10 | Merge MR via REST API (`PUT /merge_requests/:iid/merge`) | `getMergeRequest` → `state: "merged"`; issue auto-closed (`Closes #<iid>`) → `listIssues` shows `state: "closed"` |
| 11 | Negative guard | when `AIF_GITLAB_INTEGRATION!=1` or settings missing, test is skipped (no GitLab traffic) |

---

## TC-L-08 Registration/login — BLOCKED on stand

Trace: `UC-auth.registration.sign-up-participant`; `HF9.1`, `BR-constraint.auth.sessions`.

Environment gap: `PARTICIPANTS_MODE_ENABLED=false`. `/participants` → `participants_mode_disabled`; UI shows no LoginPage (App renders `AppContent` directly). The spec, when run, verifies the disabled state (assert no LoginPage rendered and `/auth/session` reports `participantsModeEnabled:false`) or is skipped with explicit `known issue` reason. See `docs/known-issues.md`.

---

## TC-L-06 Roles — BLOCKED on stand

Trace: `UC-auth.roles.assign-participant-role`; `HF9.2`, `BR-fact.auth.roles`.

Same environment gap as L-08. Recorded in `docs/known-issues.md`.