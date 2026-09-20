<a id="us-integration.issues.sync-github-issue"></a>

# US-integration.issues.sync-github-issue: Синхронизация задач с GitHub Issues

```gherkin
@US-integration.issues.sync-github-issue @HF11.1 @UC-integration.issues.sync-github-issue @P2 @integration @issues
Feature: US-integration.issues.sync-github-issue Синхронизация задач с GitHub Issues

  Background:
    Given проект подключён к GitHub-репозиторию (githubRepositories)
    and синхронизация включена (enabled=true)

  Scenario: Coordinator синхронизирует задачи с GitHub Issues
    Given Coordinator запускает синхронизацию (по расписанию или вручную)
    When GitHubWorkflow запрашивает Issues через REST API
    Then новые Issues добавляются, существующие обновляются в таблице githubIssues
    and связанные задачи сопоставляются по title/description
    and состояние Issues и PR сохраняется (prNumber, prState, prChecksStatus)

  Scenario: Синхронизация GitLab
    Given проект подключён к GitLab
    When запускается синхронизация
    Then gitlabWorkflow синхронизирует Issues и MR аналогично GitHub

  Scenario: Синхронизация отключена
    Given githubRepositories.enabled=false
    When Coordinator достигает шага синхронизации
    Then синхронизация пропускается

  Scenario: Ошибка синхронизации
    Given GitHub API вернул ошибку
    When Coordinator выполняет синхронизацию
    Then syncError сохраняется для диагностики
    and синхронизация не блокирует другие циклы Coordinator
```
