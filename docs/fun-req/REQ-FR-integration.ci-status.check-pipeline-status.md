[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-integration.ci-status.check-pipeline-status: Проверка CI-статусов PR/MR

**Приоритет:** P2

**Ключевая функция:** HF11.3 Проверка CI-статусов

**Источник:** [UC-integration.ci-status.check-pipeline-status](../use-cases/UC-integration.ci-status.check-pipeline-status.md), BR-fact.git.vcs-workflow

**Статус:** proposed

**Класс:** as is

**Канал:** Schedule (cron)

**Описание:** Coordinator проверяет статусы CI-проверок для опубликованных PR/MR через GitHub Checks API / GitLab CI API. Статус сохраняется в `githubIssues.prChecksStatus` / `gitlabIssues.mrChecksStatus`. Задача не переходит на следующую стадию, пока CI не пройден.

**Критерии приёмки:**

1. Coordinator запускает проверку CI для всех опубликованных PR/MR (`checkCI(projectId)`).
2. GitHubWorkflow запрашивает GitHub Checks API для commit SHA: `GET /repos/:owner/:name/commits/:sha/check-runs`.
3. Статус обновляется в `githubIssues.prChecksStatus` (queued/in_progress/completed, conclusion: success/failure).
4. Если CI не пройден — задача не переходит на следующую стадию.
5. При успешном CI — конвейер продолжается.
6. GitLab: `gitlabWorkflow.ts` проверяет статусы через Merge Requests API.
7. Если `prChecksStatus=null` (CI не настроен) — проверка пропускается.
8. Если CI висит слишком долго, Coordinator эскалирует задачу.

## See Also

- [REQ-FR-integration.issues.sync-github-issues](REQ-FR-integration.issues.sync-github-issues.md) — синхронизация Issues
- [REQ-FR-integration.pr-mr.publish-github-pr](REQ-FR-integration.pr-mr.publish-github-pr.md) — публикация PR
- [REQ-FR-pipeline.gate.enforce-stage-transition-gate](REQ-FR-pipeline.gate.enforce-stage-transition-gate.md) — гейты
