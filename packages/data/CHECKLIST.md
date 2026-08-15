# @aif/data — Checklist

Run through this list whenever you touch anything under `packages/data/`.

- [x] `@aif/data` is the only legal DB boundary for `api`, `agent`, and `runtime`. Do not re-export raw drizzle helpers or leak SQL construction.
- [x] If you added a new repository function, keep it cohesive with the existing repository-style API (one function = one intent). (`gitlab.ts` mirrors `github.ts`)
- [x] If `@aif/shared/schema.ts` changed, update the affected repository functions here in the same PR.
- [x] Add unit tests covering new query paths and edge cases (empty result, conflict, update of missing row). (`packages/data/src/__tests__/gitlab.test.ts` incl. `markGitLabRepositoryPrepared` round-trip)
- [x] `npm run lint`
- [x] `npm test`
