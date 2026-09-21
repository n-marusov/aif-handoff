# Browser E2E suite

Playwright-driven browser tests. The suite exercises the real web stack
(API + web bundle) against a running dev server, covers browser-only interaction
regressions, and enforces latency budgets.

## Run

The primary path is the monorepo Makefile, which **brings up the docker-compose stack**
(api / web / agent / mcp **+ a test GitLab CE instance**), waits for readiness, seeds the
reference E2E project, provisions GitLab (root PAT + test repository `root/e2e-target`),
and runs the Playwright suite against it:

```bash
# one-time: install browsers
npm run perf:install --workspace=@aif/web

# from the repo root — prepares + starts the docker-compose stack (+ GitLab)
make e2e          # GUI + API спектры против docker-compose
make e2e-gui      # только GUI-спектры (e2e/gui)
make e2e-api      # только API-спектры (e2e/api, REST+WS напрямую в сервис api)
make e2e-docker   # только поднять/подготовить стек, без прогона

# остановка стека, когда он больше не нужен
make docker-e2e-down
```

The orchestration lives in `scripts/e2e-docker.mjs`: it creates `.env` from
`.env.example` and **`.env.e2e` from `.env.e2e.example`** (E2E host ports are isolated
from dev — see the rule in `.ai-factory/RULES.md`), then runs
`docker compose --env-file .env.e2e -f docker-compose.yml -f docker-compose.e2e.yml up -d`,
waits for `GET /health`, web `/` and GitLab `GET /users/sign_in`, seeds the reference
project (`c1de80b3-...`, idempotently) and provisions GitLab: the `root` user (password
from `GITLAB_ROOT_PASSWORD` in `.env.e2e`, created only if missing), a root PAT named
`aif-e2e` (value from `GITLAB_TOKEN` in `.env.e2e`) and the test repository
`root/e2e-target` (with a README so the default branch exists). The stack is left
running after the run (analogous to `make docker-dev`).

The e2e specs can reach the test GitLab via `GITLAB_TOKEN` / `GITLAB_WEB_URL`
(host: `http://localhost:8929`) injected into the Playwright process — full API
access for create Issue / MR / Approve / comment / merge scenarios.

GitLab readiness is polled on `GET /users/sign_in` (a real `2xx`), not on
`/-/health`: the health endpoint is served only to `monitoring_whitelist`
(loopback), so from the host it always answers `404` and would make the check
vacuous. `GITLAB_ROOT_PASSWORD` must pass GitLab's password-strength check
(no dictionary words, no username `root`) — otherwise the `003_admin.rb` seed
aborts and no root user is created (see `scripts/e2e-docker.mjs`).

Direct npm invocations are still available for local-dev iteration:

```bash
npm run e2e:gui --workspace=@aif/web    # GUI-спектры (e2e/gui)
npm run e2e:api --workspace=@aif/web    # API-спектры (e2e/api)
npm run perf --workspace=@aif/web      # полный набор (GUI + perf-бюджеты + scroll/participants)
```

The Playwright config launches `npm run dev` via `webServer` only when
the stack is not already up, and reuses an existing server (so local-shell
iteration works). The docker path sets `AIF_SKIP_DEV_SERVER=1` (bypass the
auto-launch) and points `AIF_WEB_URL`/`AIF_E2E_API_URL`/`AIF_E2E_WS_URL` at the
compose stack ports (`localhost:5180` / `localhost:3009`).

## What each spec measures

- `kanban-horizontal-scroll.spec.ts` — verifies horizontal wheel gestures over
  a vertically scrollable card list still scroll the Kanban board.
- `perf/dashboard-load.spec.ts` — cold kanban render. Asserts DOM-ready and
  LCP budgets after the first column paints.
- `perf/runtime-profiles-endpoint.spec.ts` — cold + warm `/runtime-profiles`
  timings from inside the browser (covers fetch, React Query, render).
- `perf/chat-sessions-endpoint.spec.ts` — cold + warm `/chat/sessions`
  timings keyed to the first project present in the dev DB.

## Budgets

Budgets live in `e2e/perf/utils.ts` (`PERF_BUDGETS`). Tune them after a few
runs on your hardware so the suite flags real regressions and not natural
variance. Each spec also prints the raw metrics to stdout so you can spot
drift even when the assertions still pass.

## Report

After a run, an HTML report is written to `playwright-report/`. Open it with:

```bash
npm run perf:report --workspace=@aif/web
```

Traces for failed runs live next to the report; open them in
`npx playwright show-trace <path>` for flame charts and network waterfalls.
