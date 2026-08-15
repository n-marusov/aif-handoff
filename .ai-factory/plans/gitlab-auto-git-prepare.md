# Implementation Plan: GitLab auto git-prepare on connect/sync

**Branch:** none (working on `feature/gitlab-issue-mr-mode`)
**Created:** 2026-08-15
**Type:** feature (enhancement)

## Original Request

When a GitLab repo is connected via the Web UI (Edit Project → **Connect** / **Sync now**), the agent must automatically prepare the local git repo: extract the default branch (whatever it is named) and initialize it with AI Factory files if missing. Removes the manual demo steps 4.2–4.4 (remote add, credential helper, mirroring) and fixes blocked tasks (`dirty_worktree` / `base_branch_unavailable` / `dubious ownership`).

**Scope:** NO MR mirroring. Only: default-branch extraction + AI Factory scaffold init. Standard git behavior only.

## Settings

- **Testing:** yes — regression tests for the git-prepare module, API bridge, and agent endpoint
- **Logging:** verbose — structured DEBUG/INFO logs for each git step + `[gitlab-prepare]` component
- **Docs:** yes — mandatory docs checkpoint at completion (gitlab-demo.md + dev-gui-demo.md steps 4.2–4.4 become automatic)
- **Roadmap Linkage:** skipped by user (training mode)

## Research Context

From `.ai-factory/RESEARCH.md` Active Summary (2026-08-15):

- Triggers (both sync, option B): `PUT /projects/:id/gitlab` (Connect) and `POST /projects/:id/gitlab/sync` (Sync now). API calls agent synchronously via internal HTTP; on error → immediate response to client + task `status=blocked`.
- Algorithm `prepareGitLabRepository(root, connection)` in agent:
  1. `git remote add origin <webUrl>.git` (if origin missing)
  2. `git config credential.helper` (token from `$GITLAB_TOKEN` in agent container)
  3. `git config --global --add safe.directory <root>` (idempotent)
  4. `git fetch origin`
  5. `git checkout -B <defaultBranch> origin/<defaultBranch>` — name from `connection.defaultBranch` (GitLab reports real name); fallback `origin/HEAD`
  6. `initProject(root, registry)` — AFTER checkout; REUSE existing idempotent `initProject` (`runtime/src/projectInit.ts`): skips if `.ai-factory/` exists, else `ai-factory init --agents ...`
  7. `git add -A && git commit "chore: ai-factory scaffold"` (if files appeared)
- Empty repo (decision a): if `origin/<defaultBranch>` doesn't exist → skip checkout, stay on local branch (`git branch -M <defaultBranch>` if needed), initProject creates scaffold, commit, then `git push -u origin <defaultBranch>` (scaffold becomes initial default-branch content).
- Token owner: bot in prod / current user now — credentials from `$GITLAB_TOKEN` in agent container.
- Error → immediate + task blocked (no silent per-cycle retries; retry only via explicit user sync).

## Architecture Context (verified in code)

- **Agent→API already exists:** `publishGitLabTask` / `synchronizeGitLabProjects` call API via `internalApiHeaders()`.
- **API→agent pattern exists:** `codexAuth.ts` proxies to `AGENT_INTERNAL_URL` (`http://agent:3010`) → broker Hono app. BUT the broker only starts when `AIF_ENABLE_CODEX_LOGIN_PROXY=true` (dev-only; prod sets `false`). **There is no always-on agent HTTP server in production.**
- **`initProject` exists and is idempotent:** `packages/runtime/src/projectInit.ts` — `initBaseProjectDirectory` + `ai-factory init --agents` only if `.ai-factory/` missing. Reuse as-is.
- **`AGENT_INTERNAL_URL`** env var exists (`http://agent:3010` default); the agent must actually listen there in prod.
- `GitLabRepositoryConnection` already carries `webUrl`, `defaultBranch`, `tokenEnvVar`, `namespace`, `name`.
- `findProjectById(projectId).rootPath` gives the repo root (agent has `/home/www` mount).

## Tasks

### Phase 1: Data layer — `gitPreparedAt` flag (TDD)

- [x] **Task 1 (TESTS):** Write failing shared/data tests BEFORE schema change. New/updated: `packages/shared/src/__tests__/schema.test.ts` (assert migration v30 is appended after v29, `version` is `30`, and `gitlab_repositories` has `git_prepared_at` TEXT NULL), `packages/data/src/__tests__/gitlab.test.ts` (upsert accepts optional `gitPreparedAt`; connection round-trip includes `gitPreparedAt`). Red gate: `npm run test --workspace=@aif/shared` and `--workspace=@aif/data` fail on missing column/field. Files: `packages/shared/src/__tests__/schema.test.ts`, `packages/data/src/__tests__/gitlab.test.ts`.
- [x] **Task 2 (IMPL):** Make Task 1 green. Append-only migration v30 in `packages/shared/src/db.ts` (`ALTER TABLE gitlab_repositories ADD COLUMN git_prepared_at TEXT` — idempotent via `isIgnorableMigrationError`). Add `gitPreparedAt: string | null` to `GitLabRepositoryConnection` in `packages/shared/src/types.ts` + browser exports. Update `toConnection()` in `packages/data/src/gitlab.ts`, `upsertGitLabRepository` to accept/return it, and add a `markGitLabRepositoryPrepared(projectId)` helper (sets `git_prepared_at = now`, returns updated row). Green gate: shared+data tests + coverage. Files: `packages/shared/src/db.ts`, `packages/shared/src/types.ts`, `packages/shared/src/index.ts`, `packages/shared/src/browser.ts`, `packages/data/src/gitlab.ts`, `packages/data/src/index.ts`.

### Phase 2: Agent — internal HTTP server + `prepareGitLabRepository` (TDD)

- [x] **Task 3 (TESTS):** Write failing agent tests BEFORE implementation. New `packages/agent/src/__tests__/gitlabPrepare.test.ts` mirroring `gitlabWorkflow.test.ts` (mock `@aif/data`, `@aif/shared`, temp git repos via `createGitTestRoot`):
  - remote add only when origin missing;
  - credential helper written when `GITLAB_TOKEN` set;
  - safe.directory added (idempotent — second call no error);
  - fetch + `checkout -B <defaultBranch> origin/<defaultBranch>` using `connection.defaultBranch` (test with `master` to prove not hardcoded `main`);
  - `initProject` invoked AFTER checkout when `.ai-factory/` missing; skipped when present;
  - scaffold committed when files appear (`git log --oneline -1` shows `chore: ai-factory scaffold`);
  - empty origin: stays local, `git branch -M <defaultBranch>`, `git push -u origin <defaultBranch>` called;
  - on any git failure → throws typed error (`GitLabPrepareError`) with structured kind; no silent retry.
  Red gate: `npm run test --workspace=@aif/agent` fails (module missing). Files: `packages/agent/src/__tests__/gitlabPrepare.test.ts`.
- [x] **Task 4 (IMPL):** Make Task 3 green. New `packages/agent/src/gitlabPrepare.ts`:
  - `GitLabPrepareError` with `kind` (`remote_failed` | `credential_failed` | `fetch_failed` | `checkout_failed` | `init_failed` | `commit_failed` | `push_failed`) + structured fields (never string-match messages);
  - `prepareGitLabRepository(input: { projectRoot, connection, tokenEnvVar })` implementing the 7-step algorithm from Research Context (standard git via `execFileSync`; reuse `initProject` from `@aif/runtime` with the runtime registry);
  - logging: component `gitlab-prepare`, DEBUG per step, INFO on completion, ERROR + structured fields on failure.
  - **Internal HTTP endpoint:** new `packages/agent/src/internalApi.ts` — always-on Hono server on `AGENT_INTERNAL_URL` port (extract the broker's `serve` into a shared always-on listener; keep codex broker routes gated by its flag). Mount `POST /gitlab/prepare` (body: `{ projectId }` → loads connection + project rootPath → runs `prepareGitLabRepository` → `200 {ok:true, gitPreparedAt}` or `4xx/5xx` with structured error). Guarded by an internal token (reuse `INTERNAL_BROADCAST_TOKEN` or new `AIF_AGENT_INTERNAL_TOKEN`).
  - Wire server start into `packages/agent/src/index.ts` (always-on, not gated by codex flag). Log listen address.
  - Green gate: agent tests + build. Files: `packages/agent/src/gitlabPrepare.ts`, `packages/agent/src/internalApi.ts`, `packages/agent/src/index.ts`, `packages/agent/src/codex/loginBroker.ts` (share server boot if clean).

### Phase 3: API bridge — Connect/Sync trigger the agent (TDD)

- [x] **Task 5 (TESTS):** Write failing API tests. Extend `packages/api/src/__tests__/gitlab.test.ts`:
  - `PUT /projects/:id/gitlab` (connect success) calls `POST ${AGENT_INTERNAL_URL}/gitlab/prepare` with `{ projectId }` and returns the agent result (or 202 with `gitPreparedAt`);
  - `POST /projects/:id/gitlab/sync` (Sync now) also triggers prepare first, and on agent failure returns the structured error immediately (task NOT imported);
  - agent unreachable → `502` with clear `gitlab_prepare_unavailable` code (no silent retry);
  - agent prepare failure → immediate error response with the agent's structured kind surfaced.
  Red gate: `npm run test --workspace=@aif/api` fails. Files: `packages/api/src/__tests__/gitlab.test.ts`.
- [x] **Task 6 (IMPL):** Make Task 5 green. In `packages/api/src/routes/gitlab.ts`:
  - new `callAgentGitPrepare(projectId)` helper — `fetch` to `AGENT_INTERNAL_URL`/`gitlab/prepare` with internal auth header, timeout, structured error mapping (`gitlab_prepare_unavailable` on network failure; surface agent error body otherwise);
  - `PUT /:id/gitlab`: after `upsertGitLabRepository`, call prepare (best-effort? NO — per decision: synchronous; on failure return the error; do not leave connection half-prepared);
  - `POST /:id/gitlab/sync`: call prepare BEFORE issue import; on failure return immediately (task → `blocked` handled by agent side or here via `blockedReason`).
  - Logging: component `gitlab-routes`, log prepare calls + outcomes.
  - Green gate: API tests + build. Files: `packages/api/src/routes/gitlab.ts`, `packages/api/src/schemas.ts` (if response shape changes).

### Phase 4: Docs + validation

- [x] **Task 7:** Update `docs/gitlab-demo.md` and `docs/dev-gui-demo.md`: steps 4.2–4.4 (origin/credential/mirroring) now automatic on Connect/Sync now; remove the manual CLI blocks (or mark "automatic"); update Приложение А/Б (matrix, troubleshooting) accordingly; note the new internal-agent endpoint + `gitPreparedAt`; document any new env var (`AIF_AGENT_INTERNAL_TOKEN` if added). Run `npm run ai:validate`; every touched package >=70% coverage; complete CHECKLIST.md items for touched packages (shared/data/api/agent). Files: `docs/gitlab-demo.md`, `docs/dev-gui-demo.md`, `docs/configuration.md`, package CHECKLISTs.

## Risks & Considerations

- **Always-on agent HTTP server (prod):** currently nothing listens on `AGENT_INTERNAL_URL` in prod. Adding an always-on server is new attack surface — MUST be token-guarded (`INTERNAL_BROADCAST_TOKEN` reuse preferred) and bound to internal network only (compose already internal; dev binds localhost).
- **`git checkout -B <defaultBranch> origin/<defaultBranch>` overwrites local scaffold:** per decision (a) empty-repo path avoids checkout; but for non-empty origin the local scaffold commit is replaced. Confirm this is desired (it is — the demo mirrors real main; scaffold is re-added by `initProject` step).
- **`git reset` vs commit:** we COMMIT the scaffold (not reset) — per user decision "перенести скаффолд в main". Dirty-worktree blocker resolved by committing.
- **`dubious ownership`:** `safe.directory` must be set before any git op; make it step 0 of the prepare (idempotent).
- **Token not in agent env:** if `GITLAB_TOKEN` missing in agent container, credential helper writes an empty password → push fails later. Detect + warn (or fail prepare with `credential_failed`).
- **Parallel/`Sync now` re-entrancy:** prepare is idempotent (remote add guarded; checkout -B is safe on existing branch); `gitPreparedAt` allows skipping, but Sync now re-runs by design — guard against concurrent prepares with a per-project mutex/lock in the agent.
- **Windows dev (Git Bash path mangling):** agent runs in container (POSIX) — not affected; dev-host scenario uses the same container path `/home/www`.

## Test Coverage

- **shared/data:** migration v30 columns, `gitPreparedAt` round-trip, `markGitLabRepositoryPrepared`.
- **agent:** full algorithm (remote/credential/safe.directory/fetch/checkout/init/commit), empty-repo push path, initProject skip-when-present, typed error kinds, idempotency, internal endpoint auth + happy/error paths.
- **api:** connect triggers prepare; sync triggers prepare; agent failure → immediate structured error; agent unreachable → `502 gitlab_prepare_unavailable`.
- **Cross-package:** run `npm run ai:validate` (format/lint/test/coverage/build/perf/load/protocol/checklist).

## Commit Plan

- **Commit 1** (after tasks 1–2): `feat(data): track gitlab repo git preparation (git_prepared_at)`
- **Commit 2** (after tasks 3–4): `feat(agent): auto git-prepare GitLab repos on connect (default branch + AI Factory init)`
- **Commit 3** (after task 5–6): `feat(api): trigger agent git-prepare on GitLab connect and sync`
- **Commit 4** (after task 7): `docs: gitlab demo steps 4.2-4.4 are now automatic`
