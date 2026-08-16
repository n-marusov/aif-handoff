# Implementation Plan: Task Progress Indication — "Working vs Hung" Detection

Branch: feature/live-kanban-heartbeat-usage (planned in the current branch — no new branch created)
Created: 2026-08-16

## Settings
- Testing: yes (TDD: red → green → refactor per task)
- Logging: verbose
- Docs: yes

## Roadmap Linkage
Milestone: "none"
Rationale: Skipped by user — all roadmap milestones are already completed.

## Research Context
Source: .ai-factory/RESEARCH.md (Active Summary)

Topic: Task progress indication — "working vs hung" detection for executing tasks.

Goal: Let the user reliably see that an agent is actively working rather than hung. Loop detection is a separate concern; percentage progress is out of scope.

Scope: (1) Server-side `lastActivityAt` (survives F5) written only on activity events. `startHeartbeat` must NOT write it. (2) In-flight `currentTool` tracking (tool START via `onEvent` `tool:use`; cleared on completion) so long-running commands are not misread as hung. (3) UI indicator "working · 12s" vs "hung · no activity for Nm" (danger), driven by `lastActivityAt` with a 5-minute threshold.

Key decisions:
- Silence threshold = 5 min, new `AGENT_ACTIVITY_SILENCE_MS` (default 300000). NOT `AGENT_STAGE_STALE_TIMEOUT_MS` (90 min, server auto-recovery).
- `lastActivityAt` = new append-only migration column, exposed via `TaskListItem`/`Task` + WS.
- In-flight: `currentTool { name, startedAt }` set on tool START, cleared on completion and run end. Transport caveat: SDK emits START events; CLI is opaque (completion-recency only); app-server best-effort.
- Heartbeat remains liveness-only and must NOT count as activity.
- Loop detection — SEPARATE feature (out of scope).

Constraints:
- Migration versions append-only (new version; never edit an existing one).
- DB boundary: api/agent/runtime via @aif/data only.
- New visuals (hung icon) synced with Pencil (.pen).
- No expensive CSS (opacity/transform only).
- Theme color pairing → docs/ui-theme-colors.md.
- Every package >=70% coverage; finish with `npm run ai:validate`.

Success signals:
- A hung task (no activity > 5 min) shows a danger "hung" state even while the heartbeat is fresh.
- A long-running command (tool START, no completion yet) shows "running <tool> (<duration>)" and is NOT flagged hung.
- The state survives page refresh (server column).

## Commit Plan
- **Commit 1** (after Tasks 1-3): `feat(shared,data): add activity timestamp and in-flight tool tracking`
- **Commit 2** (after Tasks 4-5): `feat(api,agent): broadcast task activity progress`
- **Commit 3** (after Task 6): `feat(api): expose activity silence threshold via settings`
- **Commit 4** (after Tasks 7-8): `feat(web): working/hung indicator with in-flight tool`
- **Commit 5** (after Task 9): `docs: document activity progress signals`

## Tasks

### Phase 1: Contracts & data layer

- [x] Task 1: Add shared contracts, env, and settings types for activity progress.
  Files to create/modify:
  - `packages/shared/src/types.ts` — add `TaskCurrentTool { name: string; detail?: string; startedAt: string }`; add `lastActivityAt?: string | null` and `currentTool?: TaskCurrentTool | null` to `TaskListItem`; add `lastActivityAt: string | null` and `currentTool: TaskCurrentTool | null` to `Task`.
  - `packages/shared/src/env.ts` — add `AGENT_ACTIVITY_SILENCE_MS` (z.coerce.number().default(300000)).
  - `packages/web/src/lib/api.ts` — add `agentActivitySilenceMs?: number` to `SettingsResponse`.
  - Tests: `packages/shared/src/__tests__/participantsContracts.test.ts` — type/export guard for `TaskCurrentTool` and the new `TaskListItem`/`Task` fields.
  TDD: type/contract-only (no runtime red/green).
  Deliverable: shared types expose `lastActivityAt`/`currentTool`/`agentActivitySilenceMs`.
  LOGGING REQUIREMENTS: n/a (types/env only).

- [x] Task 2: Add the append-only migration for `last_activity_at` and `current_tool_json`.
  Files to create/modify:
  - `packages/shared/src/db.ts` — append a NEW `MIGRATIONS` entry (never renumber/re-edit existing): `ALTER TABLE tasks ADD COLUMN last_activity_at TEXT` + `ALTER TABLE tasks ADD COLUMN current_tool_json TEXT`.
  - `packages/shared/src/schema.ts` — add `lastActivityAt: text("last_activity_at")` and `currentToolJson: text("current_tool_json")` to the `tasks` table.
  - Tests: `packages/shared/src/__tests__/db.test.ts` (or schema test) — assert the new migration version exists, is append-only, and the columns are queryable on a migrated test DB.
  TDD: RED first (assert columns exist after migration), then implement.
  Deliverable: `tasks` table has `last_activity_at` and `current_tool_json` after migration.
  LOGGING REQUIREMENTS: n/a (DDL); existing migration runner logs already cover application.

- [x] Task 3: Data layer — write `lastActivityAt` on activity, add in-flight tool setters, extend projections.
  Files to create/modify:
  - `packages/data/src/index.ts`:
    - `appendTaskActivityLog` — additionally set `lastActivityAt: nowIso` (keep existing `lastHeartbeatAt`/`updatedAt` writes so the stale watchdog baseline is unchanged).
    - New `setTaskInFlightTool(taskId, tool: TaskCurrentTool | null)` — writes `currentToolJson`; when `tool` is non-null also write `lastActivityAt: nowIso` (a tool START is activity); on clear, only clear `currentToolJson`.
    - Add `lastActivityAt` + `currentToolJson` to `TASK_LIST_COLUMNS`; parse `currentToolJson` in `toTaskListItem` and `toTaskResponse`.
    - `updateTaskHeartbeat` — unchanged (must NOT write `lastActivityAt`).
  - Tests: `packages/data/src/__tests__/index.test.ts` — RED first: activity append sets `lastActivityAt`; `setTaskInFlightTool` sets/clears `currentTool` and stamps `lastActivityAt` only on set; `listTaskListItems`/`findTaskById` expose both fields; `updateTaskHeartbeat` does not change `lastActivityAt`.
  Deliverable: DB layer tracks `lastActivityAt` (activity-only) and in-flight `currentTool`, exposed on list + detail.
  LOGGING REQUIREMENTS: DEBUG in `setTaskInFlightTool` with `{ taskId, tool }`; reuse existing activity log DEBUG lines.
  Dependencies: Tasks 1, 2.

### Phase 2: Agent emission

- [x] Task 4: Wire activity + in-flight tool tracking into the subagent execution path.
  Files to create/modify:
  - `packages/agent/src/subagentQuery.ts`:
    - In `buildExecutionIntent`: on `onToolUse` (completion) also `setTaskInFlightTool(taskId, null)` (clear).
    - In `executeSubagentQuery`'s `onEvent` bridge: on `event.type === "tool:use"` (START, `event.data.name`) call `setTaskInFlightTool(taskId, { name, detail?, startedAt })`; keep the existing watchdog + limit logic.
    - Wrap the run in `try/finally` so `setTaskInFlightTool(taskId, null)` runs on success AND failure (no lingering in-flight).
    - `onSubagentStart` already logs activity (which stamps `lastActivityAt` via Task 3).
  - Tests: `packages/agent/src/__tests__/subagentQuery.test.ts` — RED first: a `tool:use` event sets the in-flight tool; completion clears it; run end (success and error) clears it; CLI/opaque transports degrade gracefully (no `tool:use` events → `currentTool` stays null).
  Deliverable: while a tool is in flight the task carries `currentTool`; after completion/run-end it is cleared.
  LOGGING REQUIREMENTS: DEBUG on set/clear with `{ taskId, tool }`; INFO on run-end clear (with tool name if it was set); errors must not prevent the finally-clear.
  Dependencies: Task 3.

- [x] Task 5: Extend the `task:activity` broadcast to carry `lastActivityAt` + `currentTool`.
  Files to create/modify:
  - `packages/agent/src/notifier.ts` — add `notifyTaskProgress(taskId, payload: { lastActivityAt: string | null; currentTool: TaskCurrentTool | null })` (or extend the activity path) that POSTs `{ type: "task:activity", payload }` to `/tasks/:id/broadcast`; call it from the activity append path and from `setTaskInFlightTool` call sites.
  - `packages/api/src/schemas.ts` — extend `broadcastTaskSchema` to accept a `task:activity` payload (`{ lastActivityAt, currentTool }`) alongside the existing heartbeat/usage payloads.
  - `packages/api/src/routes/tasks.ts` — broadcast route already honors an optional payload; confirm the `task:activity` payload passes through.
  - Tests: `packages/agent/src/__tests__/notifier.test.ts` (payload shape) and `packages/api/src/__tests__/tasks.test.ts` (broadcast emits the activity payload).
  Deliverable: `task:activity` WS events carry `lastActivityAt` + `currentTool` so the UI can patch cards without a full board refetch.
  LOGGING REQUIREMENTS: DEBUG per activity broadcast with `{ taskId, lastActivityAt, currentTool }`; WARN on failure (best-effort, non-blocking).
  Dependencies: Tasks 3, 4.

### Phase 3: Settings exposure

- [x] Task 6: Expose `AGENT_ACTIVITY_SILENCE_MS` to the web client.
  Files to create/modify:
  - `packages/api/src/routes/settings.ts` — add `agentActivitySilenceMs: env.AGENT_ACTIVITY_SILENCE_MS` to both branches of `buildSettingsOverview`.
  - Tests: `packages/api/src/__tests__/settings.test.ts` — RED first: assert the setting follows env default (300000) and an override.
  Deliverable: web reads the 5-minute silence threshold via `useSettings()`.
  LOGGING REQUIREMENTS: DEBUG when resolving the setting (extend existing settings DEBUG log).
  Dependencies: Task 1.

### Phase 4: Web UI

- [x] Task 7: Handle the enriched `task:activity` payload in `useWebSocket`.
  Files to create/modify:
  - `packages/web/src/hooks/useWebSocket.ts` — extend the `task:activity` branch: keep the `["task", id]` invalidation AND patch the cached `TaskListItem`/`Task` `lastActivityAt`/`currentTool` via `setQueryData` (no full `tasks` invalidation).
  - Tests: `packages/web/src/__tests__/useWebSocketLiveFeedback.test.tsx` (extend) — RED first: an activity event with the payload patches the cached card/detail and does not invalidate `["tasks"]`.
  Deliverable: board cards and the open detail reflect `lastActivityAt`/`currentTool` without a full board refetch.
  LOGGING REQUIREMENTS: DEBUG on the handled event (extend existing `[ws] Event received` log).
  Dependencies: Task 5.

- [x] Task 8: Add the `working | hung | idle` progress hook and wire the UI.
  Files to create/modify:
  - `packages/web/src/hooks/useTaskProgress.ts` (new) — `useTaskProgress(status, lastActivityAt, currentTool): "working" | "hung" | "idle"`: `idle` for non-in-progress statuses; `working` when `currentTool` is present (in-flight) OR `now - lastActivityAt < agentActivitySilenceMs`; `hung` otherwise. Coarse 60s tick; IGNORES `lastHeartbeatAt`. Remove `useTaskLiveness.ts` (replaced by this hook).
  - `packages/web/src/components/ui/heartbeat-indicator.tsx` — change the input type to `"working" | "hung" | "idle"` (working = green pulse, hung = existing `AlertTriangle` danger icon, idle = hidden).
  - `packages/web/src/components/kanban/TaskCard.tsx` + `packages/web/src/components/task/TaskDetailHeader.tsx` — wire `useTaskProgress`; the detail header shows an in-flight line "running: <tool> (<Ns>)" when `currentTool` is present.
  - Tests: `packages/web/src/__tests__/useTaskProgress.test.tsx` (hook behavior: idle/working/hung, in-flight override) + extend `TaskCard.test.tsx` and `TaskDetailHeader.test.tsx` — RED first.
  Deliverable: UI shows "working" vs "hung" (danger) using activity freshness; a long-running command shows as working with its in-flight tool.
  LOGGING REQUIREMENTS: n/a for UI; DEBUG in the hook only if it aids diagnosis (avoid render-loop noise).
  Dependencies: Tasks 6, 7.

### Phase 5: Docs

- [x] Task 9: Document the activity-progress signals and configuration.
  Files to create/modify:
  - `docs/configuration.md` — document `AGENT_ACTIVITY_SILENCE_MS` (default 5 min) and its role (UI "working/hung" threshold; distinct from `AGENT_STAGE_STALE_TIMEOUT_MS`).
  - `docs/architecture.md` — extend "Real-Time Updates"/"Activity Logging": `lastActivityAt`, `currentTool` in-flight tracking, transport caveat (SDK/app-server vs CLI), `task:activity` payload.
  - `docs/api.md` — document the `task:activity` payload (`lastActivityAt`, `currentTool`) and `SettingsResponse.agentActivitySilenceMs`.
  - `docs/ui-theme-colors.md` — note any new indicator colors/usage (append "Learnings" entry if a contrast issue is fixed).
  TDD: n/a (docs only).
  Deliverable: docs reflect the new signals and config.
  LOGGING REQUIREMENTS: n/a.
  Dependencies: Tasks 1-8.

## Implementation Note
Because this plan lives in the current branch (`feature/live-kanban-heartbeat-usage`) under a slug filename (`.ai-factory/plans/task-activity-progress.md`), `/aif-implement` would by default discover the older branch-named plan. Use an explicit pointer:
`/aif-implement @.ai-factory/plans/task-activity-progress.md`
