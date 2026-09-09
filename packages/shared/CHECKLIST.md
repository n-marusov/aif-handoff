# @aif/shared — Checklist

Run through this list whenever you touch anything under `packages/shared/`.

- [x] If you changed `schema.ts`, generate/apply the drizzle migration and update `@aif/data` repository functions that touch the affected tables. (Append-only migrations v29 + v30; `gitlab_repositories.git_prepared_at` + `markGitLabRepositoryPrepared` in `packages/data/src/gitlab.ts`)
- [x] If you changed `types.ts`, check all consumers (`api`, `agent`, `runtime`, `web`) still compile — shared types fan out everywhere. (All packages build green; added GitLab types + `Task.gitlab`)
- [x] If you changed `stateMachine.ts`, verify every subagent and API route that drives stage transitions still honours the new rules. (plan_review gate: coordinator plan-publisher stage + implementer guard require `planReviewState=approved`; GitHub/GitLab sync routes drive approve/replan transitions; web hides Start implementation in plan_review)
- [x] Keep `browser.ts` free of Node-only imports — the web package depends on it. (GitLab types exported from browser.ts; web builds green)
- [x] `npm run lint`
- [x] `npm test`
