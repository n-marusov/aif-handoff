# @aif/api — Checklist

Run through this list whenever you touch anything under `packages/api/`.

- [x] New or changed REST endpoints → update `docs/api.md` and the Zod schemas in `schemas.ts`. (GitLab routes + `gitlabConnectSchema`/`gitlabSyncSchema`/`gitlabPublishSchema`; docs/api.md updated)
- [ ] New or changed WebSocket events → update `docs/api.md` and the web client (`packages/web/src/hooks/useWebSocket.ts`).
- [x] All DB access goes through `@aif/data`. Never import drizzle helpers or construct SQL directly here.
- [ ] Runtime execution goes through `@aif/runtime` — no direct provider SDK calls from routes or services.
- [x] Validate every new request body/query with Zod via the `zodValidator` middleware.
- [x] Add integration tests for new routes (happy path + one error path minimum). (`packages/api/src/__tests__/gitlab.test.ts`)
- [x] `npm run lint`
- [x] `npm test`
