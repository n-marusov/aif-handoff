# Research

Updated: 2026-08-16 01:51
Status: active

## Active Summary (input for /aif-plan)
<!-- aif:active-summary:start -->
Topic: Live GUI feedback — Kanban heartbeat animation + real-time token/cost counters in task detail

Goal: Make the board visibly show that tasks are actively executing, and update token/cost counters in the task detail instantly as usage is recorded. Explicitly exclude LLM reasoning/thinking streaming.

Scope: (1) Heartbeat pulse on Kanban cards and the task-detail header. (2) Instant run-boundary token/cost updates in the detail header (option 2a). No mid-run incremental token counting, no reasoning console.

Key decisions:
- Heartbeat: add `lastHeartbeatAt` to `TaskListItem` + `listTaskListItems()` projection. Emit `task:heartbeat { taskId, lastHeartbeatAt }` from `startHeartbeat`. Patch cached card/task via `setQueryData` (NOT a full `tasks` invalidation) to avoid refetch + `updatedAt` resort churn.
- Running indicator = status in {planning, improve, implementing, review, verify} AND `lastHeartbeatAt` fresh. Staleness threshold = `AGENT_STAGE_STALE_TIMEOUT_MS` (default 90 min) — same as the coordinator watchdog.
- Token/cost: reuse run-boundary usage. Emit `task:usage_updated { taskId, projectId, usage: RuntimeUsage }` from the usage sink `onRecorded`; patch `task.tokenInput/Output/Total/costUsd` directly instead of the current `project:runtime_limit_updated` full-refetch over-invalidation.
- Visual for counter updates: a small "robot blink"/activity indicator, not number animation.
- No LLM reasoning/thinking text surfaced.

Constraints:
- No schema migration (columns already exist; only read projection changes).
- New visuals (heartbeat pulse, robot blink) must be synced with Pencil (.pen).
- No expensive CSS (opacity/transform only; no box-shadow/blur/backdrop-filter).
- Theme color pairing → docs/ui-theme-colors.md.
- DB boundary: api/agent/runtime via @aif/data only.
- Every package >=70% coverage; finish with `npm run ai:validate`.

Success signals:
- Kanban cards pulse while running and turn "stalled" after `AGENT_STAGE_STALE_TIMEOUT_MS` without a heartbeat.
- Task detail header shows the same pulse plus a "robot blink" when token/cost counters update.
- Token/cost counters in the open detail update with no manual refresh and no full board refetch.

Next step: /aif-plan fast (or full) for scope (1) + (2a)
<!-- aif:active-summary:end -->

## Sessions
<!-- aif:sessions:start -->
### 2026-08-13 14:00 — GitLab adapter exploration (Option A)
What changed:
- Clarified "adapter" ambiguity: GitLab = repository-hosting integration (GitHub Issue-to-PR mirror), NOT an AI runtime adapter (runtime/adapters/ is for LLM providers only).
- Mapped the full GitHub integration surface (schema v28, data layer, API client/routes, agent workflow, env flag, web UI, docs, tests).
- Found the original feature plan (.ai-factory/plans/feature-github-issue-pr-mode.md) — the exact 4-phase blueprint to mirror.
- Investigated Option A (mirror) in depth: per-file checklist, GitLab REST v4 API mapping, test surface (3 packages + web), UI wiring points (ProjectSelector block, TaskDetailHeader badge, read-only descriptions).
- Captured project rules that constrain implementation (migration append-only v29, DB boundary, structured errors, nullable casts, coverage/ai:validate, Pencil sync if new UI).

Key notes:
- GitHub equivalents found: github_repositories/github_issues tables (migration v28); data/src/github.ts (repo ops + atomic import + PR update + fingerprint); services/github.ts (GitHubApiError + GitHubClient); routes/github.ts (5 endpoints, rollout middleware); agent githubWorkflow.ts (sync poll + publish); 4 web hooks + ProjectSelector GitHub section + TaskDetailHeader GITHUB badge; tests in data/api/agent + web.
- GitLab diffs vs GitHub: namespace/project vs owner/repo; project-id-based API; iid vs number; MR vs PR; approvals vs reviews; pipelines/commit statuses vs check runs; PRIVATE-TOKEN header; self-hosted baseUrl; Retry-After rate limits.
- Wired points for agent: coordinator.ts runPollCycle → synchronizeGitHubProjects(); implementer + reviewer stage → publishGitHubTask(); internal API auth via notifier.ts internalApiHeaders; branch push to origin via git credentials (no token in git).
- API mount: packages/api/src/index.ts → app.route("/projects", githubRouter).
- UI: GitHub section is a single block in ProjectSelector edit dialog guarded by githubIssuePrEnabled; TaskDetailHeader renders GITHUB #N badge and hides local approve/request-changes actions when task.github exists.

Links (paths):
- .ai-factory/plans/feature-github-issue-pr-mode.md (blueprint)
- packages/shared/src/schema.ts (github tables), db.ts (migration v28), types.ts (GitHub types, Task.github)
- packages/data/src/github.ts, data/src/index.ts
- packages/api/src/services/github.ts, routes/github.ts, schemas.ts, index.ts, routes/settings.ts
- packages/agent/src/githubWorkflow.ts, coordinator.ts, notifier.ts, autoQueueCommit.ts
- packages/shared/src/env.ts (AIF_GITHUB_ISSUE_PR_ENABLED)
- packages/web/src/lib/api.ts, hooks/useProjects.ts, components/project/ProjectSelector.tsx, components/task/TaskDetailHeader.tsx, components/task/TaskDescription.tsx
- docs/api.md, docs/architecture.md, docs/configuration.md
- Tests: packages/{data,api,agent}/src/__tests__/github*.test.ts

### 2026-08-13 15:30 — GitLab Option A: env design + API research (GitLab docs)
What changed:
- User decisions: (1) self-hosted baseUrl ONLY via global AIF_GITLAB_BASE_URL env; (2) introduce GIT_PROVIDER env to select the active provider; (3) research approvals mapping further; (4) propose justification.
- Researched official GitLab docs (docs.gitlab.com): merge request approvals API, discussions API, commits/commit-status API.
- CORRECTION to earlier assumption: the MR approvals endpoint GET /projects/:id/merge_requests/:iid/approvals IS available on all tiers including Free (approve/unapprove/reset/retrieve approval state are Free; /approval_state and approval rules require Premium/Ultimate). CE: approved=true iff >=1 approval; EE: rules satisfied, true when no rules apply.
- Confirmed GitLab has NO first-class "changes requested" review state. Closest signals: unresolved discussions (Free tier, notes carry resolvable/resolved) or EE /approval_state.
- Confirmed commit statuses endpoint (Free): GET /projects/:id/repository/commits/:sha/statuses; statuses pending/running/success/failed/canceled/skipped; allow_failure marks non-blocking failures. Chose it over pipelines for prChecksStatus (see justification in discussion).
- env.ts pattern verified: AIF_GITHUB_ISSUE_PR_ENABLED: booleanEnvSchema.default(false) (line 276). New vars: GIT_PROVIDER z.enum(["github","gitlab"]).default("github"); AIF_GITLAB_ISSUE_MR_ENABLED booleanEnvSchema.default(false); AIF_GITLAB_BASE_URL string with default https://gitlab.com/api/v4.

Key notes:
- GIT_PROVIDER design: deployment-level selector, default "github" (backward compatible — existing GitHub deployments unchanged). Mode active ⇔ GIT_PROVIDER matches provider AND provider rollout flag true. Independent axes: which provider vs whether feature on. Prevents accidental dual activation. Consumed in: routes/github.ts + routes/gitlab.ts middleware, agent workflows, settings overview (gitProvider), web UI gates.
- AIF_GITLAB_BASE_URL justification: self-hosted GitLab is common; base URL is org/deployment property, non-secret → env var; no baseUrl column or UI input needed.
- Checks justification (statuses over pipelines): direct analog of GitHub combined status+check-runs fold; single Free-tier endpoint; includes pipeline jobs AND external statuses; allow_failure mirrors GitHub's neutral/skipped semantics; pipelines API is per-pipeline (multiple per commit), ref-scoped, more requests, status values differ → no benefit for tri-state prChecksStatus.
- Approvals recommendation: ship v1 with approvals-only reviewState (approved/pending, no auto-rework); defer unresolved-discussions→changes_requested (v1.1 spike) due to false-positive risk. User to confirm.
- Upstream doc pages: https://docs.gitlab.com/api/merge_request_approvals/ , https://docs.gitlab.com/api/discussions/ , https://docs.gitlab.com/api/commits/

Links (paths):
- packages/shared/src/env.ts (line 276 — booleanEnvSchema pattern)
- packages/api/src/routes/settings.ts (buildSettingsOverview → githubIssuePrEnabled pattern)
- docs.gitlab.com/api/merge_request_approvals/ (approvals tiers + CE/EE approved semantics)
- docs.gitlab.com/api/discussions/ (MR discussions, resolvable/resolved notes)
- docs.gitlab.com/api/commits/ (commit statuses endpoint, allow_failure)
### 2026-08-13 16:00 — GitLab Option A: decisions finalized
What changed:
- User confirmed all remaining decisions: (1) reviewState = approvals-only (Option A) — no auto-rework in v1; (2) GitLab MR note marker "<!-- aif-gitlab-review -->"; (3) GIT_PROVIDER default "github".
- All open questions resolved; exploration of Option A is complete → ready for /aif-plan.

Key notes:
- v1 reviewState semantics: "approved" ⇔ GET /merge_requests/:iid/approvals → approved=true; else "pending". No changes_requested in v1; no approval-driven task resumption (human reopens).
- v1 GitLab task transitions: MR merged → task verified; MR closed unmerged → task paused; review feedback note posted with marker; fingerprint dedupe like GitHub.
- changes_requested via unresolved discussions stays a v1.1 candidate (spike on real data first).
- GIT_PROVIDER default "github" + AIF_GITLAB_ISSUE_MR_ENABLED=false keeps GitLab fully dormant by default (zero behavior change for existing deployments).

Links (paths):
- .ai-factory/RESEARCH.md (Active Summary — all decisions recorded)
- .ai-factory/plans/feature-github-issue-pr-mode.md (plan blueprint)
### 2026-08-13 17:30 — Corporate deployment topology (trusted zone, no DMZ)
What changed:
- Explored AIF Handoff deployment in a corporate environment.
- Compared DMZ vs Internal (trusted) placement for GitLab + LLM.
- DECISION: GitLab + LLM both in the trusted Internal zone, no DMZ, with a self-hosted LLM.

Key notes:
- DMZ vs Internal differ by trust level, connection direction, and blast radius on compromise.
- Trusted-only removes the DMZ boundary; defense shifts to internal segmentation (VLANs), least-privilege, and deny-all egress.
- If the LLM is fully self-hosted, the autonomous agent can be firewalled with zero internet egress — the strongest exfiltration control.
- Runtime adapters reach the LLM via ANTHROPIC_BASE_URL / OPENAI_BASE_URL / OPENROUTER_BASE_URL / OPENCODE_BASE_URL or a custom module; GitLab via AIF_GITLAB_BASE_URL + GIT_PROVIDER=gitlab.

C4 Deployment diagram:

```mermaid
C4Deployment
  title AIF Handoff — Corporate Deployment (Trusted Zone, no DMZ)

  Person(dev, "Corporate Developer", "Human operator and code reviewer")

  Deployment_Node(trusted, "Trusted Internal Network", "Corporate data center", "Single trusted segment, no DMZ") {
    Deployment_Node(gl_node, "GitLab Server", "Self-hosted", "Issue source and code repository") {
      Container(gitlab, "GitLab", "GitLab CE/EE", "REST API v4 + git transport")
    }
    Deployment_Node(llm_node, "LLM Inference Server", "Self-hosted", "Private model endpoint") {
      Container(llm, "LLM", "vLLM / TGI / LiteLLM", "OpenAI- or Anthropic-compatible API")
    }
    Deployment_Node(handoff, "AIF Handoff Host", "Docker", "Autonomous task pipeline") {
      Container(web, "Web SPA", "React 19 + Vite", "Kanban UI on port 5180")
      Container(api, "API Server", "Hono + WebSocket", "REST and WS on port 3009")
      Container(agent, "Agent", "Node.js coordinator", "Planner, implementer, reviewer; 30s poll")
      ContainerDb(db, "Database", "SQLite", "Tasks, projects, audit, usage events")
    }
  }

  Rel(dev, web, "Manages tasks", "HTTPS")
  Rel(dev, gitlab, "Reviews and merges", "HTTPS/SSH")
  Rel(web, api, "REST + WebSocket", "HTTPS/WS")
  Rel(api, db, "Reads and writes", "SQL")
  Rel(agent, db, "Reads and writes via @aif/data", "SQL")
  Rel(agent, api, "Sync, publish, broadcasts", "HTTP")
  Rel(api, gitlab, "List issues, create MR", "HTTPS, REST v4")
  Rel(agent, gitlab, "Push branch", "git over HTTPS")
  Rel(agent, llm, "Planner / implementer / reviewer", "HTTPS")
  Rel(api, llm, "Chat / fast-fix", "HTTPS")
```

Links (paths):
- .ai-factory/references/mermaid-c4.md (C4 syntax reference)
- packages/shared/src/env.ts (ANTHROPIC_BASE_URL, OPENAI_BASE_URL, AIF_GITLAB_BASE_URL, GIT_PROVIDER, proxy vars)
- packages/runtime/src/adapters/ (claude, codex, opencode, openrouter — baseUrl support)
- packages/api/src/services/gitlab.ts (GitLabClient, baseUrl from AIF_GITLAB_BASE_URL)
- packages/agent/src/gitlabWorkflow.ts (sync + publish via internal API)
### 2026-08-13 18:00 — Verification runbook: gitlab.com + router.ai (OpenAI-compatible)
What changed:
- Captured the final code-grounded verification runbook for the GitLab Issue-to-MR flow, with router.ai (OpenAI-compatible) as the LLM backend.
- Corrected an earlier assumption: the Codex API transport is a one-shot /chat/completions call (no tool-calling) and therefore cannot run the implement/review pipeline. The pipeline needs the local agentic Codex transport (CLI/SDK/App Server) with CODEX_BASE_URL pointing at router.ai.

Key notes:
- User decisions: Option A (OpenAI-compatible router.ai); simplest setup (Participants Mode off, anonymous); secrets only via .env.
- GitLab PAT needs scopes api + write_repository (api for REST, write_repository for git push).
- inferDefaultTransport("codex") = CLI (not API); the runtime profile must set transport cli/sdk/app-server + baseUrl + apiKeyEnvVar=OPENAI_API_KEY.
- Issue import → task autoMode=true, executionOwner=ai, status=backlog; auto-queue advances backlog→planning.
- MR merged → verified; MR closed → paused; the human owns the merge.
- Precondition: router.ai must be Codex-CLI-protocol-compatible and the model must support tool use.

### 2026-08-16 12:00 — Remove Root Path field; auto-generate project folder path
What changed:
- Explored the project create/edit Root Path flow across web, API, data, shared, and agent.
- Decided to remove the editable Root Path field and derive the container folder path from the project name.
Key notes:
- `rootPath` column/type stays (downstream: git, worktrees, chat, MCP, roadmap).
- Existing `slugify` (shared/planPath.ts) is reusable for folder-name generation.
- Name uniqueness: trimmed + case-insensitive; plus slug/rootPath collision suffix.
- rootPath immutable on rename to avoid moving live git repos.
Links (paths):
- packages/web/src/components/project/ProjectSelector.tsx
- packages/api/src/repositories/projects.ts
- packages/api/src/schemas.ts
- packages/shared/src/types.ts, planPath.ts, schema.ts
- packages/data/src/index.ts

### 2026-08-16 01:51 — Live board heartbeat + real-time token/cost feedback
What changed: Explored the live-feedback pipeline; scoped to (1) heartbeat pulse on board + detail, (2) instant run-boundary token/cost updates with a "robot blink" indicator. No LLM reasoning stream.
Key notes:
- `startHeartbeat` (subagentQuery) already writes `lastHeartbeatAt` + `updatedAt` every 30s but broadcasts nothing; `TaskListItem` has no `lastHeartbeatAt`.
- Staleness threshold = `AGENT_STAGE_STALE_TIMEOUT_MS` (default 90 min), same as the coordinator watchdog.
- Token/cost are run-boundary: `recordUsageEvent` rolls usage into task columns on run completion; `onRecorded` currently emits `project:runtime_limit_updated` (full refetch). Replace with targeted `task:usage_updated { taskId, projectId, usage }`.
- Board must patch cache via `setQueryData`, not invalidate `tasks`, to avoid `updatedAt` resort churn.
- No schema change; only `TaskListItem` projection + WS events + UI.
- Pencil sync, theme-pairing, no-expensive-CSS rules apply to new visuals.
Links (paths):
- packages/agent/src/subagentQuery.ts (heartbeat, usageSink onRecorded)
- packages/data/src/index.ts (updateTaskHeartbeat, recordUsageEvent, listTaskListItems projection)
- packages/shared/src/types.ts (TaskListItem, WsEventType/WsEvent)
- packages/api/src/ws.ts, packages/api/src/routes/tasks.ts (broadcast path)
- packages/agent/src/notifier.ts (broadcast helpers)
- packages/web/src/hooks/useWebSocket.ts (WS handler)
- packages/web/src/components/kanban/TaskCard.tsx, packages/web/src/components/task/TaskDetailHeader.tsx

<!-- aif:sessions:end -->

## Runbook (final)

### 0. Inputs to prepare
- gitlab.com repo path: NAMESPACE/PROJECT (nested groups: group/subgroup/project).
- GitLab PAT scopes: api + write_repository.
- router.ai: base URL, model id, API key.
- Precondition: router.ai compatible with Codex CLI protocol; model supports function calling / tool use.

### 1. .env
```dotenv
# GitLab
GIT_PROVIDER=gitlab
AIF_GITLAB_ISSUE_MR_ENABLED=true
AIF_GITLAB_BASE_URL=https://gitlab.com/api/v4
GITLAB_TOKEN=<PAT: api + write_repository>

# router.ai (OpenAI-compatible) via local Codex
OPENAI_API_KEY=<router.ai key>
OPENAI_MODEL=<router.ai model id>
CODEX_BASE_URL=<router.ai base URL>

# skills mode (required: Codex has no agent definitions)
AGENT_USE_SUBAGENTS=false
```

### 2. Build + run prod compose
```bash
cd aif-handoff
docker compose -f docker-compose.production.yml build
docker compose -f docker-compose.production.yml up -d
docker compose -f docker-compose.production.yml ps
```
Health:
```bash
curl -s http://localhost:3009/health
curl -s http://localhost:3100/health
curl -s http://localhost/health
```

### 3. Runtime profile for router.ai (port 3009, no /api prefix)
Create profile:
```bash
curl -s -X POST http://localhost:3009/runtime-profiles \
  -H "Content-Type: application/json" \
  -d '{ "name":"router.ai (Codex CLI)", "runtimeId":"codex", "providerId":"openai", "transport":"cli", "baseUrl":"<router.ai base URL>", "apiKeyEnvVar":"OPENAI_API_KEY", "defaultModel":"<router.ai model id>", "enabled":true }'
```
Note the returned id as <profile-id>. Validate connection:
```bash
curl -s -X POST http://localhost:3009/runtime-profiles/validate \
  -H "Content-Type: application/json" \
  -d '{ "profile": { "runtimeId":"codex", "providerId":"openai", "transport":"cli", "baseUrl":"<router.ai base URL>", "apiKeyEnvVar":"OPENAI_API_KEY", "defaultModel":"<router.ai model id>" } }'
```
Set app defaults:
```bash
curl -s -X PUT http://localhost:3009/settings/runtime-defaults \
  -H "Content-Type: application/json" \
  -d '{ "defaultTaskRuntimeProfileId":"<profile-id>", "defaultPlanRuntimeProfileId":"<profile-id>", "defaultReviewRuntimeProfileId":"<profile-id>", "defaultChatRuntimeProfileId":"<profile-id>" }'
```
Readiness:
```bash
curl -s http://localhost:3009/agent/readiness
```
Expect ready=true.

### 4. Project + git remote + push credentials (via .env)
Create project (projects volume is mounted at /home/www):
```bash
curl -s -X POST http://localhost:3009/projects \
  -H "Content-Type: application/json" \
  -d '{ "name":"demo", "rootPath":"/home/www/demo" }'
```
Note the returned id as <project-id>. Set origin + credential helper (token read from $GITLAB_TOKEN in the container):
```bash
docker compose -f docker-compose.production.yml exec agent git -C /home/www/demo remote add origin https://gitlab.com/NAMESPACE/PROJECT.git
```
```bash
docker compose -f docker-compose.production.yml exec agent git -C /home/www/demo config credential.helper '!f() { echo username=GITLAB_USERNAME; echo password=$GITLAB_TOKEN; }; f'
```

### 5. Connect GitLab repository
```bash
curl -s -X PUT http://localhost:3009/projects/<project-id>/gitlab \
  -H "Content-Type: application/json" \
  -d '{ "repository":"NAMESPACE/PROJECT", "tokenEnvVar":"GITLAB_TOKEN", "enabled":true, "eligibility":{"labels":[],"assignee":null,"milestone":null} }'
```

### 6. Issue → task
1. Create an open Issue in gitlab.com with a realistic description.
2. Sync runs every 60s; force it:
```bash
curl -s -X POST http://localhost:3009/projects/<project-id>/gitlab/sync -H "Content-Type: application/json" -d '{}'
```
3. A card #<iid> <title> appears with a GITLAB badge, status backlog, autoMode=true; no manual start needed.

### 7. Pipeline → MR
```
Planning → Plan Ready → Implementing → Review → Done
```
Watch: `docker compose -f docker-compose.production.yml logs -f agent`.
- implementer + reviewer call publishGitLabTask → git push + create/update MR.
- MR appears in gitlab.com targeting main with description starting with Closes #<iid>.

### 8. Review + merge → verified
1. Review the MR, approve, merge.
2. Agent sync sees mrState=merged and moves task done → verified (≤60s).
- MR merged → verified; MR closed → paused; MR open → waits for human.

### 9. Acceptance
1. GET /agent/readiness → ready=true.
2. Issue imported idempotently (no duplicates).
3. Task reached done (proves router.ai supports tool-calling).
4. MR in main with Closes #<iid>.
5. After approve+merge task is verified.
6. No StageManualBlockError / gitlab_* errors in agent logs.

Links (paths):
- packages/runtime/src/resolution.ts (inferDefaultTransport, inferDefaultBaseUrl)
- packages/runtime/src/adapters/codex/index.ts (descriptor: defaultTransport CLI; supported transports)
- packages/runtime/src/adapters/codex/api.ts (one-shot /chat/completions)
- packages/runtime/src/adapters/codex/appServer/process.ts (baseUrl → CODEX_BASE_URL; apiKeyEnvVar → OPENAI_API_KEY)
- packages/agent/src/coordinator.ts (PIPELINE; publishGitLabTask wiring in implementer/reviewer)
- packages/agent/src/gitlabWorkflow.ts (SYNC_INTERVAL_MS=60_000; pushBranch; publishGitLabTask)
- packages/api/src/routes/gitlab.ts (connect/sync/publish endpoints)
- packages/data/src/gitlab.ts (importGitLabIssueTask: autoMode/backlog)
- packages/shared/src/env.ts (GIT_PROVIDER, AIF_GITLAB_*, CODEX_BASE_URL, OPENAI_*)
- docs/configuration.md (GitLab Issue-to-MR Mode; env vars)
- docker-compose.production.yml (services + volumes)

### 2026-08-14 — Runtime profile bootstrap (Option B): automate demo step 3.1
What changed:
- Explored automating docs/gitlab-demo.md step 3.1 (create runtime profile) + 3.3 (defaults) for the router.ai demo.
- Verified in code that the profile is functionally required for router.ai + Codex CLI: resolution.ts L277-280 sets apiKeyEnvVar=null for local codex transport without explicit apiKeyEnvVar; cli.ts buildCuratedEnv blocks OPENAI_API_KEY when allowApiKey=false (L283-285). Env-only fallback cannot express the API-key opt-in.
- Compared 3 automation levels (curl script wrapper / startup seed in API / docker entrypoint) — user chose Option B (startup seed).
- Full design (env vars, idempotency, edge cases, Docker impact, priority ordering) captured in the Active Summary above.
Links (paths):
- packages/api/src/index.ts (seed insertion point: after listProjects()/resetStaleQaRuns(), before startServer())
- packages/shared/src/env.ts (new AIF_BOOTSTRAP_* vars)
- packages/runtime/src/resolution.ts (env fallback + codex apiKeyEnvVar=null)
- packages/runtime/src/adapters/codex/cli.ts (BLOCKED_ENV_KEYS / buildCuratedEnv allowApiKey)
- packages/data/src/index.ts (createRuntimeProfile L3375, updateAppSettings L1631, listRuntimeProfiles L3315, resolveEffectiveRuntimeProfile L3738)
- packages/api/src/routes/runtimeProfiles.ts (POST /runtime-profiles)
- packages/api/src/routes/settings.ts (PUT /settings/runtime-defaults)
- docker-compose.production.yml (api service uses env_file: .env)

### 2026-08-15 — GitLab auto git-prepare on connect/sync (UC final)
What changed:
- User: manual git steps (remote add / credential helper / mirroring / scaffold commit) are inconvenient; they must run automatically in the agent container when connecting a repo via GUI and syncing.
- Investigated current code: api routes/gitlab.ts (PUT connect validates via REST + saves connection with defaultBranch/webUrl/tokenEnvVar; POST sync does REST-only), agent gitlabWorkflow.ts (synchronizeGitLabProjects polls every 60s → POST /sync; publishGitLabTask does git push assuming origin+credentials ready). No auto git-prep exists in GitHub or GitLab agent workflows.
- Scoped UC down: NO MR mirroring. Only: extract default branch (whatever it is named — from connection.defaultBranch, fallback origin/HEAD) + init AI Factory files if missing (REUSE existing idempotent initProject in runtime/src/projectInit.ts).
- Decisions: option B (API calls agent synchronously via internal HTTP; error → immediate + task blocked, no silent retries); empty repo → push scaffold as initial default branch (decision a); initProject AFTER checkout (decision 2); standard git behavior only; token owner = bot (prod) / current user now.
- Triggers: Connect (PUT /projects/:id/gitlab) + Sync now (POST /projects/:id/gitlab/sync) from Edit Project dialog.
Links (paths):
- packages/agent/src/gitlabWorkflow.ts (synchronizeGitLabProjects, publishGitLabTask)
- packages/api/src/routes/gitlab.ts (PUT /:id/gitlab, POST /:id/gitlab/sync)
- packages/runtime/src/projectInit.ts (initProject — idempotent, reuse)
- packages/data/src/gitlab.ts (listEnabledGitLabRepositories; connection fields webUrl/defaultBranch/tokenEnvVar)
- docs/gitlab-demo.md (manual steps 4.2–4.4 to be automated)

<!-- aif:sessions:end -->
