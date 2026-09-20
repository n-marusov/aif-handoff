<a id="us-integration.pr-mr.publish-github-pr"></a>

# US-integration.pr-mr.publish-github-pr: Публикация Pull Request на GitHub

```gherkin
@US-integration.pr-mr.publish-github-pr @HF11.2 @UC-integration.pr-mr.publish-github-pr @P2 @integration @pr-mr
Feature: US-integration.pr-mr.publish-github-pr Публикация Pull Request на GitHub

  Background:
    Given задача связана с GitHub Issue
    and изменения задачи закоммичены в ветку

  Scenario: Coordinator публикует Pull Request с изменениями
    Given Coordinator запускает publishPR(taskId, completion)
    When GitHubWorkflow пушит ветку в remote и создаёт PR через REST API
    Then PR содержит заголовок и описание (сводка изменений)
    and ссылка prUrl и prNumber сохраняются в githubIssues

  Scenario: PR публикуется в режиме plan review
    Given задача в mode=plan_review
    When Coordinator публикует PR
    Then PR создаётся в Draft-режиме с планом для утверждения
    and при утверждении (planReviewState=approved) продолжается реализация

  Scenario: VCS недоступен при публикации
    Given GitHub API не отвечает
    When Coordinator публикует PR
    Then syncError сохраняется
    and задача не переходит на следующую стадию
```
