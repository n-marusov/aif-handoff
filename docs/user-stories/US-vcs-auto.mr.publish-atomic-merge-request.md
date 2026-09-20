<a id="us-vcs-auto.mr.publish-atomic-merge-request"></a>

# US-vcs-auto.mr.publish-atomic-merge-request: Публикация единого MR/PR по задаче

```gherkin
@US-vcs-auto.mr.publish-atomic-merge-request @HF4.3 @UC-vcs-auto.mr.publish-atomic-merge-request @P2 @vcs-auto @mr @agent
Feature: US-vcs-auto.mr.publish-atomic-merge-request Публикация единого MR/PR по задаче

  Background:
    Given проект подключён к поддерживаемой VCS-платформе
    and изменения по задаче подготовлены к публикации

  Scenario: Система публикует единый MR/PR для изменений задачи
    Given у задачи сформирован набор изменений для публикации
    When запускается шаг публикации в VCS
    Then создаётся один MR/PR для этой задачи
    and в задаче сохраняется ссылка на опубликованный MR/PR

  Scenario: Режим plan review публикует черновик для согласования
    Given задача находится в режиме plan review
    When система публикует изменение в VCS
    Then MR/PR создаётся как черновик для проверки плана человеком

  Scenario: Ошибка публикации не продвигает задачу в следующую стадию
    Given внешняя VCS-система недоступна
    When система пытается опубликовать MR/PR
    Then задача остаётся в стадии ожидания публикации
    and внешний наблюдатель видит диагностируемую причину ошибки
```
