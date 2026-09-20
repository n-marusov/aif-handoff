<a id="us-integration.pr-mr.resolve-review-decision"></a>

# US-integration.pr-mr.resolve-review-decision: Обработка решения ревью по PR/MR

```gherkin
@US-integration.pr-mr.resolve-review-decision @HF11.1 @HF11.2 @UC-integration.pr-mr.resolve-review-decision @P1 @integration @pr-mr
Feature: US-integration.pr-mr.resolve-review-decision Обработка решения ревью по PR/MR

  Background:
    Given задача связана с опубликованным PR/MR
    and Coordinator периодически выполняет VCS sync

  Scenario: Слияние GitLab MR завершает приём результата
    Given связанный GitLab MR перешёл в состояние merged
    When Coordinator считывает состояние MR через gitlabWorkflow
    Then система сохраняет состояние MR как merged
    and задача корректно переводится в финальный принятый результат (done → accepted)
    and стадия ревью считается закрытой решением человека

  Scenario: MR закрыт без слияния
    Given связанный GitLab MR перешёл в состояние closed без merge
    When Coordinator выполняет синхронизацию
    Then задача не принимается
    and система помечает задачу как приостановленную для ручного решения

  Scenario: Действующее решение ревьюера применяется к стадии задачи
    Given у PR/MR есть несколько записей ревью
    When Coordinator вычисляет последнее неотозванное решение ревьюера
    Then одобрение открывает нужный гейт и продвигает задачу
    and запрос изменений возвращает задачу на доработку

  Scenario: Повторная синхронизация идемпотентна
    Given решение ревью уже было успешно применено к задаче
    When Coordinator выполняет следующую сверку того же PR/MR
    Then одно и то же решение не применяется повторно
    and состояние задачи не «откатывается» назад
```
