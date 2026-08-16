# Implementation Plan: Live Kanban Heartbeat + Real-Time Token/Cost Feedback

Branch: feature/live-kanban-heartbeat-usage
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

Tasks that are type/contract-only (Task 1) or documentation-only (Task 10) are exempt from the red/green cycle; their tests are compile/type-guard or n/a respectively. After each phase, run the affected package test suite, and finish the whole feature with `npm run ai:validate` plus a per-package coverage check (>=70%).

## Roadmap Linkage
Milestone: "none"
Rationale: Skipped by user — all roadmap milestones are already completed.

## Research Context
Source: .ai-factory/RESEARCH.md (Active Summary)

Topic: Live GUI feedback — Kanban heartbeat animation + real-time token/cost counters in task detail.

Goal: Make the board visibly show that tasks are actively executing, and update token/cost counters in the task detail instantly as usage is recorded. Explicitly exclude LLM reasoning/thinking streaming.

Scope: (1) Heartbeat pulse on Kanban cards and the task-detail header. (2) Instant run-boundary token/cost updates in the detail header (option 2a). No mid-run incremental token counting, no reasoning console.

Key decisions:
- Heartbeat: add `lastHeartbeatAt` to `TaskListItem` + `listTaskListItems()` projection. Emit `task:heartbeat { taskId, lastHeartbeatAt }` from `startHeartbeat`. Patch cached card/task via `setQueryData` (NOT a full `tasks` invalidation) to avoid refetch + `updatedAt` resort churn.
- Running indicator = status in {planning, improve, implementing, review, verify} AND `lastHeartbeatAt` fresh. Staleness threshold = `AGENT_STAGE_STALE_TIMEOUT_MS` (default 90 min) — same as the coordinator watchdog.
- Token/cost: reuse run-boundary usage. Emit `task:usage_updated { taskId, projectId, usage }` from the usage sink `onRecorded`; update the open detail with a targeted `["task", id]` refetch instead of the current `project:runtime_limit_updated` full-refetch over-invalidation.
- Visual for counter updates: a small "robot blink"/activity indicator, not number animation.
- No LLM reasoning/thinking text surfaced.

Constraints:
- No schema migration (columns already exist; only read projection changes).
- New visuals (heartbeat pulse, robot blink) must be synced with Pencil (.pen).
- No expensive CSS (opacity/transform only; no box-shadow/blur/backdrop-filter).
- Theme color pairing -> docs/ui-theme-colors.md.
- DB boundary: api/agent/runtime via @aif/data only.
- Every package >=70% coverage; finish with `npm run ai:validate`.

Success signals:
- Kanban cards pulse while running and turn "stalled" after `AGENT_STAGE_STALE_TIMEOUT_MS` without a heartbeat.
- Task detail header shows the same pulse plus a "robot blink" when token/cost counters update.
- Token/cost counters in the open detail update with no manual refresh and no full board refetch.

## Commit Plan
- **Commit 1** (after Tasks 1-2): `feat(shared): add heartbeat/usage WS contracts and task-list liveness field`
- **Commit 2** (after Tasks 3-5): `feat(api,agent): emit task heartbeat and usage broadcasts`
- **Commit 3** (after Task 6): `feat(api): expose agent stale timeout via settings`
- **Commit 4** (after Tasks 7-9): `feat(web): live heartbeat pulse and usage activity indicators`
- **Commit 5** (after Task 10): `docs: document real-time heartbeat and usage events`

## Tasks

### Phase 1: Contracts & data layer

- [x] Task 1: Add shared WebSocket contracts and `TaskListItem.lastHeartbeatAt`.
  Files to create/modify:
  - `packages/shared/src/types.ts` — add `lastHeartbeatAt: string | null` to `TaskListItem`; add `TaskHeartbeatPayload` (`{ taskId: string; lastHeartbeatAt: string | null }`) and `TaskUsagePayload` (`{ taskId: string; projectId: string; usage: ChatDoneUsage }`); add `"task:heartbeat"` and `"task:usage_updated"` to `WsEventType` and to the `WsEvent.payload` union.
  - Tests: `packages/shared/src/__tests__/participantsContracts.test.ts` — extend with a type/export guard asserting the two new event types and payloads are reachable from `@aif/shared/browser`.
  TDD: type/contract-only — add the export/type guard assertions first; there is no runtime red/green cycle.
  Deliverable: `@aif/shared/browser` exposes `TaskListItem.lastHeartbeatAt`, `TaskHeartbeatPayload`, `TaskUsagePayload`, and the two new `WsEventType` values.
  LOGGING REQUIREMENTS: n/a (types only; no runtime logging).

- [x] Task 2: Add `lastHeartbeatAt` to the board list projection.
  Files to create/modify:
  - `packages/data/src/index.ts` — add `lastHeartbeatAt: tasks.lastHeartbeatAt` to `TASK_LIST_COLUMNS`. Confirm `toTaskListItem` spreads it through into `TaskListItem`.
  - Tests: `packages/data/src/__tests__/index.test.ts` — RED first: assert `listTaskListItems` returns `lastHeartbeatAt`, and assert the list row still excludes heavy detail-only fields (no plan/implementationLog/reviewComments). Then implement (GREEN), then refactor if the projection reads can be simplified.
  Deliverable: `GET /tasks?projectId=...` list payloads include `lastHeartbeatAt` per task.
  LOGGING REQUIREMENTS: reuse the existing `listTaskListItems` DEBUG log (`Listed task list items`); no new logging needed.
  Dependencies: Task 1.

### Phase 2: Backend emission (agent + api)

- [x] Task 3: Extend the task broadcast endpoint to accept lightweight payloads.
  Files to create/modify:
  - `packages/api/src/schemas.ts` — extend `broadcastTaskSchema` to accept an optional `payload` for the new types (`task:heartbeat` payload and `task:usage_updated` payload).
  - `packages/api/src/routes/tasks.ts` — in `POST /:id/broadcast`, when the validated body carries a payload, broadcast `{ type, payload }`; otherwise fall back to the current `toTaskBroadcastPayload(task)`.
  - Tests: `packages/api/src/__tests__/tasks.test.ts` — RED first: assert heartbeat/usage broadcasts emit the lightweight payload, and the fallback path still emits the full task payload for existing types. Then implement.
  Deliverable: internal broadcast endpoint can emit `task:heartbeat` and `task:usage_updated` without serializing the full task.
  LOGGING REQUIREMENTS: DEBUG on every broadcast with `{ taskId, type }` (extend existing log); WARN on non-existent task (404); ERROR only on unexpected validation/broadcast failures.
  Dependencies: Task 1.

- [x] Task 4: Emit `task:heartbeat` from the coordinator heartbeat loop.
  Files to create/modify:
  - `packages/agent/src/notifier.ts` — add `notifyTaskHeartbeat(taskId, lastHeartbeatAt)` that POSTs `{ type: "task:heartbeat", payload: { taskId, lastHeartbeatAt } }` to `/tasks/:id/broadcast`.
  - `packages/agent/src/subagentQuery.ts` — in `startHeartbeat`, compute a single `lastHeartbeatAt = new Date().toISOString()`, pass it to `updateTaskHeartbeat` (or read it back) so the DB write and the broadcast use the exact same timestamp, then `void notifyTaskHeartbeat(taskId, lastHeartbeatAt)`.
  - Tests: `packages/agent/src/__tests__/notifier.test.ts` (payload shape) and `packages/agent/src/__tests__/subagentQuery.test.ts` (heartbeat loop invokes the notifier). RED first for both.
  Deliverable: each running task emits a `task:heartbeat` event every `HEARTBEAT_INTERVAL_MS`.
  LOGGING REQUIREMENTS: DEBUG per heartbeat broadcast with `{ taskId, lastHeartbeatAt }`; WARN on broadcast failure (best-effort, non-blocking — agent must not fail because API is unavailable).
  Dependencies: Task 3.

- [x] Task 5: Emit `task:usage_updated` when usage is recorded for a task.
  Files to create/modify:
  - `packages/agent/src/notifier.ts` — add `notifyTaskUsageBroadcast(taskId, projectId, usage)` that POSTs `{ type: "task:usage_updated", payload: { taskId, projectId, usage } }`.
  - `packages/agent/src/subagentQuery.ts` — in the usage sink `onRecorded` (via `notifyRuntimeUsageRefresh`), also emit `task:usage_updated` when `event.context.taskId` is present.
  - `packages/agent/src/index.ts` — in the bootstrap usage sink `onRecorded`, mirror the same `task:usage_updated` emission when `event.context.taskId` is present (project/chat-only scopes must NOT emit it).
  - Tests: `packages/agent/src/__tests__/notifier.test.ts` and `packages/agent/src/__tests__/subagentQuery.test.ts` — RED first: assert task-scoped usage emits `task:usage_updated`, while chat/commit-only scopes do not. Cover the `agent/index.ts` path only where it can be exercised cheaply; the subagent path is the primary runtime flow.
  Deliverable: task-scoped usage events reach the UI as `task:usage_updated` at run boundary.
  LOGGING REQUIREMENTS: DEBUG with `{ taskId, projectId, usage }` on emission; WARN on broadcast failure; preserve the existing `onRecorded` error handling (sink is non-throwing).
  Dependencies: Task 3.

### Phase 3: Settings exposure

- [x] Task 6: Expose `AGENT_STAGE_STALE_TIMEOUT_MS` to the web client.
  Files to create/modify:
  - `packages/api/src/routes/settings.ts` — add `agentStageStaleTimeoutMs: env.AGENT_STAGE_STALE_TIMEOUT_MS` to both branches of `buildSettingsOverview` (success and catch).
  - `packages/web/src/lib/api.ts` — add `agentStageStaleTimeoutMs: number` to the settings response type.
  - Tests: `packages/api/src/__tests__/settings.test.ts` — RED first: assert the setting follows the env default and an override value. Then implement and update the web settings type.
  Deliverable: the web app can read the staleness threshold via `useSettings()`.
  LOGGING REQUIREMENTS: DEBUG when resolving the setting (extend the existing settings DEBUG log).
  Dependencies: none.

### Phase 4: Web UI

- [x] Task 7: Handle the new WS events in `useWebSocket`.
  Files to create/modify:
  - `packages/web/src/hooks/useWebSocket.ts` — on `task:heartbeat`, patch the cached `TaskListItem` and `Task` `lastHeartbeatAt` via `setQueryData` (do NOT invalidate `tasks`); on `task:usage_updated`, invalidate only `["task", taskId]` and dispatch a `window` CustomEvent `task:usage_updated` with the payload.
  - Tests: `packages/web/src/__tests__/useWebSocketOverviewInvalidation.test.ts` (extend) or a new `packages/web/src/__tests__/useWebSocketLiveFeedback.test.ts` — RED first: assert heartbeat patches cache without a full-board invalidation, and usage invalidates only the single task query + dispatches the event.
  Deliverable: heartbeat updates cards without refetching the board; usage updates refresh only the open detail and notify the indicator.
  LOGGING REQUIREMENTS: DEBUG on each handled event (extend the existing `[ws] Event received` log); no new ERROR paths beyond existing parse guards.
  Dependencies: Tasks 1, 3, 4, 5.

- [x] Task 8: Add a liveness hook + heartbeat indicator and wire it into `TaskCard`.
  Files to create/modify:
  - `packages/web/src/hooks/useTaskLiveness.ts` (new) — compute `running | stalled | idle` from status + `lastHeartbeatAt` + `agentStageStaleTimeoutMs` (via `useSettings`). Recompute staleness on a coarse tick (e.g. once per minute), not every render; the pulse itself is a continuous CSS animation.
  - `packages/web/src/components/ui/heartbeat-indicator.tsx` (new) — a small pulsing dot/border indicator (opacity/transform keyframes only). Sync this new primitive with Pencil (`.pen`) before landing.
  - `packages/web/src/components/kanban/TaskCard.tsx` — render the indicator when the task is in an in-progress status.
  - Tests: `packages/web/src/__tests__/useTaskLiveness.test.ts` (new, hook behavior) and `packages/web/src/__tests__/TaskCard.test.tsx` (render behavior) — RED first: pulse shown while fresh, "stalled" when stale, hidden for idle statuses.
  Deliverable: board cards visually pulse while running and turn "stalled" when the heartbeat goes stale.
  LOGGING REQUIREMENTS: n/a for UI rendering; add DEBUG in the liveness hook only if it aids diagnosis (avoid render-loop noise).
  Dependencies: Tasks 6, 7.

- [x] Task 9: Add the heartbeat pulse + "robot blink" to the task detail header.
  Files to create/modify:
  - `packages/web/src/components/ui/robot-blink.tsx` (new) — a small robot/activity icon that blinks via an opacity animation when triggered. Sync with Pencil (`.pen`).
  - `packages/web/src/components/task/TaskDetailHeader.tsx` — render `HeartbeatIndicator` next to the status badge, and render `RobotBlink` that triggers on the `task:usage_updated` DOM event.
  - Tests: `packages/web/src/__tests__/TaskDetailHeader.test.tsx` — RED first: indicator present for in-progress tasks; blink toggles on the custom event; token/cost badges still render.
  Deliverable: the detail header shows liveness and a non-numeric "activity" blink when counters update.
  LOGGING REQUIREMENTS: n/a for UI rendering; no console noise on blink.
  Dependencies: Tasks 6, 7, 8.

### Phase 5: Docs

- [x] Task 10: Update documentation for the new real-time events and UI behavior.
  Files to create/modify:
  - `docs/architecture.md` — extend the "Real-Time Updates" event table with `task:heartbeat` and `task:usage_updated`; note the targeted-vs-full-refetch behavior.
  - `docs/api.md` — document the two new WebSocket events and their payloads.
  - `docs/ui-theme-colors.md` — if any status/indicator colors are introduced, add them to the pairing table (and append a "Learnings" entry if a contrast issue was fixed).
  TDD: n/a (documentation only).
  Deliverable: docs reflect the new events and the liveness/usage indicators.
  LOGGING REQUIREMENTS: n/a.
  Dependencies: Tasks 1-9.
