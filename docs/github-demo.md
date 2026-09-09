[← Architecture](architecture.md) · [Back to README](../README.md) · [GitLab Demo →](gitlab-demo.md)

# GitHub + router.ai demo runbook (Issue → Plan PR → approve → implementation PR)

> **Goal:** show the **Plan Review PR Gate** on GitHub.com. An Issue is imported as a task,
> the agent plans, publishes a **plan-only pull request**, and the task stops at
> `plan_review` until a human approves the PR on GitHub. After approval the agent
> implements and reviews, and the **same** PR is converted to the final implementation PR
> (now with `Closes #<issue>`), which a human merges.
>
> **Environment:** production stack from `docker-compose.production.yml`; LLM backend —
> router.ai (OpenAI-compatible) through the local Codex CLI; repository — GitHub.com.
>
> This runbook mirrors the [GitLab Demo](gitlab-demo.md) but adds the plan-review gate and
> the GitHub specifics (token scopes, no auto git-prepare).

```
┌────────────┐   Issue    ┌───────────┐   sync 60s   ┌────────────────┐
│  github.com│───────────▶│  AIF API  │◀─────────────│  AIF Agent     │
│  (Issues)  │            │  :3009    │              │  (координатор) │
└────────────┘            └─────┬─────┘              └───────┬────────┘
        ▲                       │                            │
        │      PR / push        │                            │ router.ai
        └───────────────────────┼────────────────────────────┘ (Codex CLI)
                                 │
                          ┌──────▼──────┐
                          │  Web UI     │
                          │  :80        │  ← человек видит задачи и PR
                          └─────────────┘
```

**What the human does (5 actions):**

1. Creates an Issue on GitHub.com.
2. Connects the GitHub repository (or re-runs Sync now).
3. Watches the board until the task reaches **Plan Review**.
4. Approves (or requests changes on) the plan PR on GitHub.com.
5. Merges the final implementation PR when implementation is done.

---

## 0. Prerequisites

| Item           | How to get / format                                                                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub repo    | A repository with a default branch and at least one commit. Format `owner/repository`.                                                                                                                                                                                                |
| GitHub token   | Fine-grained PAT scoped to the repository: Metadata read, Issues read+write, Pull requests read+write, Contents read+write, Commit statuses read, Checks read. Git push uses normal Git credentials, not this token.                                                                  |
| router.ai      | OpenAI-compatible base URL, model id with tool use, API key. Codex CLI needs the Responses API (`wire_api = "responses"`), auto-configured by the adapter from the profile `baseUrl`.                                                                                                 |
| Local checkout | Unlike GitLab mode, GitHub mode has **no auto git-prepare**: point the project at a normal clone of the repository with `origin` configured, working credentials for push, and the default branch fetched. The connect step validates repository access via the GitHub REST API only. |

---

## 1. `.env`

```dotenv
# ── GitHub ─────────────────────────────────────────────
# GIT_PROVIDER=github is the default; shown for clarity.
GIT_PROVIDER=github
AIF_GITHUB_ISSUE_PR_ENABLED=true
AIF_PLAN_REVIEW_PR_ENABLED=true
GITHUB_TOKEN=<fine-grained PAT>

# ── router.ai (OpenAI-compatible) via local Codex ──────
OPENAI_API_KEY=<router.ai key>
OPENAI_MODEL=<router.ai model id>
CODEX_BASE_URL=<router.ai base URL>

# ── Mode ───────────────────────────────────────────────
AGENT_USE_SUBAGENTS=false

# ── Automatic runtime-profile bootstrap ────────────────
AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED=true
```

| Variable                      | Purpose                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `AIF_GITHUB_ISSUE_PR_ENABLED` | Master switch for the GitHub Issue-to-PR mode. GitHub routes return `403 feature_disabled` without it.      |
| `AIF_PLAN_REVIEW_PR_ENABLED`  | Plan-review gate: VCS-linked tasks stop in `plan_review` until the plan PR is approved.                     |
| `GITHUB_TOKEN`                | Used by the GitHub REST client for issues/PRs/checks/reviews. Git push uses the repository Git credentials. |

Verify the file contains all eight lines, then restart any running containers so the new
env is picked up.

---

## 2. Build and start the stack

```bash
cd aif-handoff
docker compose -f docker-compose.production.yml build
docker compose -f docker-compose.production.yml up -d
```

Health checks:

```bash
curl -s http://localhost:3009/health   # API → {"status":"ok",...}
curl -s http://localhost:3100/health   # MCP HTTP
curl -s http://localhost/health        # Web UI (SPA)
```

Readiness of the LLM path is `GET /settings` → `runtimeReadiness` plus
`POST /runtime-profiles/validate`. Coordinator state (active tasks) is
`GET /agent/status`.

---

## 3. Runtime profile for router.ai

The API bootstrap provisions the global `Bootstrap (Codex CLI)` profile on first start.
Validate it:

```bash
curl -s -X POST http://localhost:3009/runtime-profiles/validate \
  -H 'Content-Type: application/json' \
  -d '{"profileId":"<profile-id>"}'
```

Expect `{ "ok": true, ... }`. Stop here if validation fails — the pipeline needs tool use
and the Responses API.

---

## 4. Project + Git remote (manual for GitHub)

Create a project whose `rootPath` is the local checkout of the GitHub repository.
Because GitHub Connect does not auto-prepare the repository, ensure the checkout already
has a working `origin`, credentials for push, and the default branch checked out/fetched
(this is the documented parity gap with GitLab auto git-prepare).

## 5. Connect the repository

**Edit Project → GitHub Issue-to-PR → Connect** (or `PUT /projects/:id/github`) with
`repository: "owner/repository"`, `tokenEnvVar: "GITHUB_TOKEN"`, and eligibility filters
(empty = all open issues). The connection stores the token variable name only — never the
token value.

Then enable auto-queue (**Edit Project → Auto-Queue Mode → Save** or
`PATCH /projects/:id/auto-queue-mode {"enabled": true}`). Without it imported tasks stay
in Backlog.

## 6. Create an Issue and import it

Create an Issue on GitHub.com (optionally labeled to match eligibility), then run
**Sync now** (`POST /projects/:id/github/sync`). The task card appears in Backlog with a
`GITHUB #<issue>` badge. Sync is idempotent per issue number.

## 7. Watch the task reach Plan Review

The coordinator advances the task `backlog → planning → plan_ready`. Because
`AIF_PLAN_REVIEW_PR_ENABLED=true` and the task is GitHub-linked, the `plan-publisher`
stage then:

1. creates a deterministic **plan-only commit** (product files in the work tree block the
   publish until cleaned);
2. pushes the branch;
3. publishes a PR whose body starts with `<!-- aif:pr-mode=plan_review -->` and contains
   the change plan, affected artifacts, open questions, and approval instructions —
   **no `Closes #<issue>`**;
4. transitions the task to `plan_review` (Web UI column **Plan Review**, banner
   `Waiting for plan approval` with a link to the PR).

Implementation actions are hidden in the UI while the task waits.

## 8. Approve the plan PR

Open the plan PR on GitHub.com and **Approve** it (or **Request changes** with comments).

- **Approve** → the next sync (≤ 60 s) transitions the task `plan_review → implementing`
  (`planReviewState=approved`) and the agent starts implementation automatically.
- **Request changes / review comments** → sync returns the task to `planning`
  (`planReviewState=changes_requested`); the feedback is stored as `planReviewFeedback`
  and given to the planner. Replanning reuses the same branch and the next publish updates
  the **same** PR body.

## 9. Implementation and final PR

The agent implements, reviews, and publishes the final PR through the existing
`POST /projects/:id/github/tasks/:taskId/publish` flow. The final publish **converts the
same PR**: the marker becomes `implementation`, the body gains the implementation log and
test evidence plus the approved-plan summary, and only now is `Closes #<issue>` added.
Merge the PR on GitHub.com. The next sync advances the task to `verified`.

---

## Acceptance checklist

| #   | Check                                                                | Expected                                                                   |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | `curl -s http://localhost:3009/health`                               | service alive                                                              |
| 2   | `POST /runtime-profiles/validate`                                    | `{ ok: true }`                                                             |
| 3   | Task board                                                           | task reached `plan_review` and stopped (no implementation before approval) |
| 4   | Plan PR on GitHub.com                                                | body marker `plan_review`, contains the plan, **no** `Closes #<issue>`     |
| 5   | Approve the plan PR                                                  | task moves to `implementing` within ≤ 60 s                                 |
| 6   | Final PR after implementation                                        | same PR, marker `implementation`, body includes `Closes #<issue>`          |
| 7   | Merge the final PR                                                   | task → `verified` within ≤ 60 s                                            |
| 8   | Agent logs (`plan-review:publisher`, `coordinator`, `github-routes`) | no `StageManualBlockError`; INFO for publish/approval transitions          |

## Logging

- Plan publication: logger `plan-review:publisher` (INFO on push + PR publication,
  WARN on deferred publish when the branch/plan is missing).
- Approval / replanning transitions: API GitHub sync route logs INFO on `plan_review →
implementing` / `plan_review → planning`, DEBUG for deduped review ids.
- Blocked implementation: coordinator/implementer WARN with `taskId`, `status`, and
  `planReviewState` — no stack trace for the expected waiting state.

## See Also

- [Architecture](architecture.md) — Agent Pipeline and Task State Machine
- [API Reference](api.md) — GitHub Issue-to-PR endpoints (sync, publish, publish-plan)
- [Configuration](configuration.md) — env vars, token scopes, Plan Review PR/MR Gate
- [GitLab Demo](gitlab-demo.md) — the same Issue → MR cycle on GitLab.com
