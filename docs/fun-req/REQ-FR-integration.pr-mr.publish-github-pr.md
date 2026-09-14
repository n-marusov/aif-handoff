[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-integration.pr-mr.publish-github-pr: Публикация Pull Request на GitHub

**Приоритет:** P2

**Ключевая функция:** HF11.2 Публикация PR/MR

**Источник:** [UC-integration.pr-mr.publish-github-pr](../use-cases/UC-integration.pr-mr.publish-github-pr.md), BR-git.vcs-workflow

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (GitHub REST API)

**Описание:** Coordinator публикует Pull Request на GitHub с изменениями задачи: пушит ветку, создаёт PR с описанием (Change Plan summary), привязывает к Issue. PR Mode может быть `plan_review` (план для утверждения) или `completion` (готовое изменение). Аналогично для GitLab.

**Критерии приёмки:**

1. Coordinator запускает публикацию PR для задачи с GitHub-привязкой (`publishGitHubTask`).
2. GitHubWorkflow пушит ветку задачи в remote (`git push`).
3. Создаёт PR через REST API: `POST /repos/:owner/:name/pulls`.
4. Для `plan_review` mode PR создаётся в Draft-режиме.
5. Описание PR содержит план (plan_review) или сводку изменений (completion).
6. Ссылка сохраняется в `githubIssues.prUrl` / `gitlabIssues.mrUrl`.
7. GitLab: аналогично `gitlabWorkflow.ts` — `POST /projects/:id/merge_requests`.
8. При ошибке VCS `syncError` сохраняется; задача не переходит на следующую стадию.

## See Also

- [REQ-FR-vcs-auto.plan-review.publish-plan-for-approval](REQ-FR-vcs-auto.plan-review.publish-plan-for-approval.md) — Plan Review Gate
- [REQ-FR-integration.issues.sync-github-issues](REQ-FR-integration.issues.sync-github-issues.md) — синхронизация Issues
- [REQ-FR-integration.ci-status.check-pipeline-status](REQ-FR-integration.ci-status.check-pipeline-status.md) — CI-статусы
