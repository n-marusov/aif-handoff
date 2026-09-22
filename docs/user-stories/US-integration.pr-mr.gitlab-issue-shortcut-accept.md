<a id="us-integration.pr-mr.gitlab-issue-shortcut-accept"></a>

# US-integration.pr-mr.gitlab-issue-shortcut-accept: Краткий путь GitLab Issue+MR → Accepted

> Декомпозиция прежней `US-integration.pr-mr.gitlab-issue-to-accepted` (сценарии 10, 11, A8, A9).
> Совместимость: прежние якоря 10/11/A8/A9 остаются валидными.

```gherkin
@US-integration.pr-mr.gitlab-issue-shortcut-accept @HF11.1 @HF11.2 @HF1.6 @HF5.3 @UC-integration.issues.bootstrap-project-sync-and-create-task @UC-integration.pr-mr.resolve-review-decision @P0 @integration @pr-mr @core-e2e
Feature: US-integration.pr-mr.gitlab-issue-shortcut-accept Краткий путь Issue+MR → Accepted

  Background:
    Given проект подключён к GitLab через /api/projects/:id/gitlab
    And синхронизация GitLab Issues/MR включена
    And для задачи-шортката владелец определяется контрактом импорта (P0.2):
      autoQueueMode=true -> executionOwner="ai", autoMode=true;
      autoQueueMode=false -> executionOwner="human", autoMode=false
    And Coordinator выполняет poll-цикл по расписанию (канал Agent)

  Scenario: 1. Issue со связанным MR импортируется сразу в Done
    Given в GitLab для Issue уже существует связанный открытый MR
    When пользователь запускает Sync now
    Then задача импортируется сразу в status=done
    And стадии planning/improve/plan_review/implementing/verify/review не выполняются
    And владелец задачи соответствует проекту на момент импорта:
      autoQueueMode=false -> executionOwner="human", autoMode=false

  Scenario: 2. Merge предсуществующего MR завершает Done → Accepted
    Given задача импортирована в done по краткому пути
    When пользователь выполняет Merge связанного MR
    Then после следующего sync задача переходит в accepted

  Scenario: 3. Запрос доработок из Done возвращает Done → Implementing
    Given задача находится в done
    When по связанному MR приходит действующее решение changes requested
    Then задача переходит в implementing с reworkRequested=true

  Scenario: 4. Закрытие MR без approve/merge не переводит задачу в Accepted
    Given задача находится в done и связана с MR в GitLab
    When пользователь закрывает MR без approve и без merge
    Then после следующего sync задача не переходит в accepted
    And задача переводится в paused (или эквивалентное приостановленное состояние)
```

## Покрытие требований

| Шаг/сценарий | US-ID                                             | UC (основной)                                                        | HF (vision §2.2) | BR                                              | ADR-переход                 | Oracle (что проверять)                                                                        |
| ------------ | ------------------------------------------------- | -------------------------------------------------------------------- | ---------------- | ----------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| 1            | US-integration.pr-mr.gitlab-issue-shortcut-accept | UC-integration.issues.bootstrap-project-sync-and-create-task (Mixed) | HF11.1, HF11.2   | BR-fact.git.vcs-workflow                        | import shortcut → done      | `GET /api/tasks/:id` (status=done, executionOwner по контракту); E2E: L-10g (API), L-10 (GUI) |
| 2            | US-integration.pr-mr.gitlab-issue-shortcut-accept | UC-integration.pr-mr.resolve-review-decision (Schedule/Agent)        | HF1.6, HF11.2    | BR-trigger.automation.done-to-accepted-approval | done → accepted             | merge MR + sync; `status=accepted`; E2E: L-10g, L-10                                          |
| 3            | US-integration.pr-mr.gitlab-issue-shortcut-accept | UC-integration.pr-mr.resolve-review-decision (Schedule/Agent)        | HF11.2, HF5.3    | BR-inference.git.review-decision-precedence     | done → implementing         | `POST sync`; `status=implementing`, reworkRequested; E2E: L-10j (API), L-10c (GUI smoke)      |
| 4            | US-integration.pr-mr.gitlab-issue-shortcut-accept | UC-integration.pr-mr.resolve-review-decision (Schedule/Agent)        | HF11.2           | BR-fact.git.vcs-workflow                        | done (не accepted) / paused | закрыт MR без approve/merge; `status` не `accepted`, `paused=true`; E2E: Negative A (API)     |

## Требования к реальному прогону

1. Обязательные env/флаги: `GIT_PROVIDER=gitlab`, `AIF_GITLAB_ISSUE_MR_ENABLED=true`,
   `GITLAB_WEB_URL`, `GITLAB_TOKEN`, Coordinator poll, WebSocket `/ws`.

2. Обязательные данные: тестовый GitLab-репозиторий доступен токену; Issue создаётся
   **с уже существующим MR**.

3. Качество контракта владения: импорт ветвится по `autoQueueMode` проекта на момент
   импорта; включение автоочереди после импорта существующую human-задачу не
   «продвигает» (human-owned исключены из auto-queue).

## Primary E2E layer

- **Primary: API** — state/ownership-семантика (`L-10g`, `L-10j`, `Negative A`).
- **Secondary smoke: GUI** — UI connect/sync/merge-путь (`L-10`), negative UI connect (`L-10b`).
- Capability: `@core-e2e` (детерминированный, LLM не требуется).

## Совместимость с прежней US

| Прежний сценарий | Новая история/сценарий          |
| ---------------- | ------------------------------- |
| 10               | gitlab-issue-shortcut-accept: 1 |
| 11               | gitlab-issue-shortcut-accept: 2 |
| A8               | gitlab-issue-shortcut-accept: 3 |
| A9               | gitlab-issue-shortcut-accept: 4 |
