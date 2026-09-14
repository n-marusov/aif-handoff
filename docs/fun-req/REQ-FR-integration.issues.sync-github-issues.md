[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-integration.issues.sync-github-issues: Синхронизация задач с GitHub Issues

**Приоритет:** P2

**Ключевая функция:** HF11.1 Синхронизация с Issues

**Источник:** [UC-integration.issues.sync-github-issue](../use-cases/UC-integration.issues.sync-github-issue.md), BR-git.vcs-workflow

**Статус:** proposed

**Класс:** as is

**Канал:** Schedule (cron)

**Описание:** Coordinator синхронизирует задачи AIF Handoff с GitHub Issues: статусы, заголовки, assignees, комментарии. Связь хранится в таблице `githubIssues` с полями issueNumber, taskId, state, prNumber, prState, sourceUpdatedAt. Аналогично для GitLab через `gitlabWorkflow.ts`.

**Критерии приёмки:**

1. Coordinator запускает синхронизацию по расписанию или по запросу (`synchronizeGitHubProjects` / `synchronizeGitLabProjects`).
2. GitHubWorkflow читает конфигурацию репозитория (`githubRepositories`).
3. Запрашивает Issues и MR через GitHub REST API / GitLab API.
4. Обновляет `githubIssues`: создаёт новые записи, обновляет существующие (upsert).
5. Пытается связать Issues с задачами AIF Handoff (по title/description/assignee).
6. Обновляет статусы PR: открыт/закрыт/merged, CI-checks.
7. Если `githubRepositories.enabled=false` — синхронизация пропускается.
8. При ошибке `syncError` сохраняется для диагностики.

## See Also

- [REQ-FR-integration.pr-mr.publish-github-pr](REQ-FR-integration.pr-mr.publish-github-pr.md) — публикация PR
- [REQ-FR-integration.ci-status.check-pipeline-status](REQ-FR-integration.ci-status.check-pipeline-status.md) — CI-статусы
- [REQ-FR-vcs-auto.mr.publish-atomic-merge-request](REQ-FR-vcs-auto.mr.publish-atomic-merge-request.md) — MR/PR
