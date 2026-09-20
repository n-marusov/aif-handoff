<a id="us-vcs-auto.mr.publish-atomic-merge-request"></a>

# US-vcs-auto.mr.publish-atomic-merge-request: Создание единого atomic MR/PR

```gherkin
@US-vcs-auto.mr.publish-atomic-merge-request @HF4.3 @UC-vcs-auto.mr.publish-atomic-merge-request @P2 @vcs-auto @mr
Feature: US-vcs-auto.mr.publish-atomic-merge-request Создание единого atomic MR/PR

  Background:
    Given проект подключён к GitHub или GitLab
    and изменения задачи закоммичены в ветку

  Scenario: Coordinator создаёт единый atomic MR/PR
    Given auto-commit завершён для ветки задачи
    When Coordinator выполняет git push ветки в remote
    Then создаётся PR/MR через REST API с заголовком и описанием (сводка Change Plan)
    and ссылка (prUrl, prNumber) сохраняется в БД

  Scenario: PR/MR публикуется в режиме plan review
    Given задача имеет planReviewState=published
    When Coordinator публикует PR/MR
    Then PR/MR создаётся в Draft-режиме с планом для утверждения

  Scenario: VCS недоступен
    Given GitHub/GitLab API не отвечает
    When Coordinator публикует MR/PR
    Then ошибка синхронизации сохраняется
    and задача не переходит на следующую стадию
```
