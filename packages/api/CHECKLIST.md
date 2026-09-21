# @aif/api — Checklist

Run through this list whenever you touch anything under `packages/api/`.

- [x] New or changed REST endpoints → update `docs/api.md` and the Zod schemas in `schemas.ts`. (GitLab routes + `gitlabConnectSchema`/`gitlabSyncSchema`/`gitlabPublishSchema`; docs/api.md updated)
- [x] New internal bridge to the agent → verify `AGENT_INTERNAL_URL` is used consistently and failures are structured (`gitlabPrepareBridge.ts`; sync aborts import on strict prepare failure).
- [x] New or changed WebSocket events → update `docs/api.md` and the web client (`packages/web/src/hooks/useWebSocket.ts`). (N/A: the GitLab sync review-gate change emits no WebSocket events; it is a REST sync path only.)
- [x] All DB access goes through `@aif/data`. Never import drizzle helpers or construct SQL directly here.
- [x] Runtime execution goes through `@aif/runtime` — no direct provider SDK calls from routes or services. (N/A: no runtime/provider call was added; the route talks to the GitLab REST client and `@aif/data` only.)
- [x] Validate every new request body/query with Zod via the `zodValidator` middleware.
- [x] Add integration tests for new routes (happy path + one error path minimum). (`packages/api/src/__tests__/gitlab.test.ts`; live-стенд из `docker-compose.e2e.yml` покрыт в `gitlab.integration.test.ts`, гейт `AIF_GITLAB_INTEGRATION=1`)
- [x] `npm run lint`
- [x] `npm test`
- **Append-only VCS event notes are not current state.** GitLab system notes are never rewritten, so a note-driven gate must compare the triggering note id against the newest revoking note id before acting (`findLatestApprovalNote` vs `findLatestApprovalResetNote`) — otherwise an unapprove or a push-triggered approval reset still fires the gate. GitHub needs no equivalent because a dismissal rewrites the review's own state.
