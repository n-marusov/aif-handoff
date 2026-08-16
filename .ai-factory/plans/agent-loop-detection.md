# Implementation Plan: Agent Loop Detection (Stage 1 — Tool-Call Cap + Read-Only Burst)

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

Topic: Agent loop detection — prevent runaway tool-call loops (stage 1: hard caps + read-only burst).

Goal: Detect and stop an agent that spins in a repetitive tool-call loop (e.g. the review agent re-running `git diff <sha>^ <sha> -- <file>` hundreds of times) before it burns hours of wall-clock and ~40M tokens. Confirmed incident: task b0f811dc (review, Codex CLI / deepseek-v4-flash) looped twice (~25-28 min per attempt) on read-only `git diff`/`git show` of the same commit; the 1h `runTimeoutMs` was the only guard.

Scope (stage 1): agent-side detection + blocking only (no UI "possible loop" indicator yet).
- (A) Hard tool-call cap per stage: `AGENT_MAX_TOOL_CALLS_PER_STAGE` (default 500). Exceed → block.
- (B) Read-only burst: 20 consecutive read-only tool calls (Read/Glob/Grep/Bash `git show|diff|cat|sed|rg`) with NO write (Edit/Write/Bash `git add|commit|push`) → block.
- Action: immediately move the task to `blocked_external` with reason `possible_loop` (human decides next), NO auto-retry.

Key decisions:
- Detection counts from `onToolUse` (completion events) in the agent (`subagentQuery`) — works for all transports including CLI.
- Blocking mirrors the stale-watchdog transition (classifyStageError → `blocked_external` with `retryAfter: null`).
- Deferred: normalized-template repetition (C), novelty ratio (D), token-bloat (E), UI indicator (F).

Constraints:
- No new migration (blocking reuses blocked_external columns).
- DB boundary via @aif/data.
- Structured errors only — never message-pattern matching (classify the loop error via a structured code, not `error.message`).
- Every package >=70% coverage; `npm run ai:validate`.

Success signals:
- A looping stage is blocked within minutes (not hours); the task lands in `blocked_external` with a clear `possible_loop` reason.
- Legit long stages (build/install) are NOT falsely blocked.

## Tasks

### Phase 1: Detection (shared + agent)

- [x] Task 1: Add loop-detection contracts — env vars, read-only classification, and the loop error.
  Files to create/modify:
  - `packages/shared/src/env.ts` — add `AGENT_MAX_TOOL_CALLS_PER_STAGE` (`z.coerce.number().default(500)`) and `AGENT_LOOP_READ_ONLY_BURST` (`z.coerce.number().default(20)`).
  - `packages/shared/src/loopDetection.ts` (new) — `READ_ONLY_TOOLS: ReadonlySet<string>` (`Read`, `Glob`, `Grep`), `READ_ONLY_BASH_PATTERNS: RegExp` (matches `git show|diff|status|log|grep`, `cat `, `sed `, `rg `), and `isReadOnlyToolCall(toolName: string, detail: string | undefined): boolean`.
  - `packages/shared/src/index.ts` + `browser.ts` — export `isReadOnlyToolCall` (and the constants).
  - `packages/agent/src/errors.ts` — add `AiLoopDetectedError extends Error` with structured fields: `code = "possible_loop"`, `reason: "tool_call_cap" | "read_only_burst"`, `count: number`, `limit: number`. NO message-pattern parsing anywhere.
  - Tests: `packages/shared/src/__tests__/loopDetection.test.ts` (classification matrix) + env test for the two new vars; agent error test.
  TDD: RED first (classification + error shape), then implement.
  Deliverable: shared read-only classification + structured loop error + env defaults.
  LOGGING REQUIREMENTS: n/a for the pure helper; DEBUG in the error constructor is not needed (structured fields carry context).

- [x] Task 2: Wire the loop guard into the subagent execution path.
  Files to create/modify:
  - `packages/agent/src/subagentQuery.ts` — add a per-run `LoopGuard` (a small class or closure) that `buildExecutionIntent`'s `onToolUse` updates: increment `toolCallCount`; if `> AGENT_MAX_TOOL_CALLS_PER_STAGE` throw `AiLoopDetectedError("tool_call_cap", count, limit)`; classify the call with `isReadOnlyToolCall` — read-only increments `consecutiveReads`, a write resets it to 0; if `consecutiveReads >= AGENT_LOOP_READ_ONLY_BURST` throw `AiLoopDetectedError("read_only_burst", consecutiveReads, limit)`.
  - The thrown error must propagate OUT of `executeSubagentQuery` (it must NOT be swallowed by the first-activity stall-retry `continue` or reclassified as a transient error). Verify the catch paths rethrow it unchanged.
  - Tests: `packages/agent/src/__tests__/subagentQuery.test.ts` — RED first: cap exceeded → run fails with `AiLoopDetectedError("tool_call_cap")`; read-only burst → `AiLoopDetectedError("read_only_burst")`; a write resets the burst counter; the error is NOT retried by the stall-retry loop.
  Deliverable: a looping agent run fails fast with a structured `possible_loop` error.
  LOGGING REQUIREMENTS: DEBUG per guard update (`{ taskId, toolCallCount, consecutiveReads }`); ERROR when the guard trips (`{ taskId, reason, count, limit }`).
  Dependencies: Task 1.

### Phase 2: Blocking (coordinator)

- [x] Task 3: Block the task on a loop-detection error (no retry).
  Files to create/modify:
  - `packages/agent/src/coordinator.ts` — in `classifyStageError` (the function that builds the `recovery` object consumed by `processOneTask`'s catch), detect `AiLoopDetectedError` via its structured `code === "possible_loop"` (never `message` matching) and return `{ kind: "blocked_external", blockedReason: "possible_loop: <reason> (<count>/<limit>)", retryAfter: null, retryCount: 0, limitSnapshot: null }`.
  - Tests: `packages/agent/src/__tests__/coordinator.test.ts` — RED first: a stage error with `code: "possible_loop"` transitions the task to `blocked_external` with the reason and `retryAfter: null`; retryCount is NOT incremented; no `task:moved` retry is scheduled.
  Deliverable: a loop-detected task lands in `blocked_external` immediately, no auto-retry.
  LOGGING REQUIREMENTS: ERROR with `{ taskId, reason, count, limit }` on the block; INFO with `{ taskId, from, to: "blocked_external" }` on the transition.
  Dependencies: Tasks 1, 2.

### Phase 3: Docs

- [x] Task 4: Document loop detection and the new env vars.
  Files to create/modify:
  - `docs/configuration.md` — document `AGENT_MAX_TOOL_CALLS_PER_STAGE` (500) and `AGENT_LOOP_READ_ONLY_BURST` (20), and the `possible_loop` blocking behavior.
  - `docs/architecture.md` — add a "Loop Detection" bullet under "Reliability Guards": per-stage tool-call cap + read-only burst, action = `blocked_external` (`possible_loop`), no retry; deferred stages (C/D/E/F) noted.
  TDD: n/a (docs only).
  Deliverable: docs reflect the new guards and env vars.
  LOGGING REQUIREMENTS: n/a.
  Dependencies: Tasks 1-3.

## Implementation Note
This plan lives in the current branch (`feature/live-kanban-heartbeat-usage`) under a slug filename (`.ai-factory/plans/agent-loop-detection.md`). Use an explicit pointer to implement:
`/aif-implement @.ai-factory/plans/agent-loop-detection.md`

## Commit Plan
4 tasks — single commit at the end:
`feat(agent): detect and block runaway agent tool-call loops`
