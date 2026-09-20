<a id="us-audit.heartbeat.receive-agent-heartbeat"></a>

# US-audit.heartbeat.receive-agent-heartbeat: Наблюдаемость длительного выполнения задач

```gherkin
@US-audit.heartbeat.receive-agent-heartbeat @HF10.2 @UC-audit.heartbeat.receive-agent-heartbeat @P1 @audit @heartbeat @api
Feature: US-audit.heartbeat.receive-agent-heartbeat Наблюдаемость длительного выполнения задач

  Background:
    Given задача выполняется в длительном автоматическом режиме

  Scenario: Внешний наблюдатель видит признаки активности выполняемой задачи
    Given задача находится в in-progress состоянии
    When внешний наблюдатель запрашивает статус задачи во время выполнения
    Then статус содержит актуальный признак активности выполнения
    and задача не воспринимается как зависшая

  Scenario: Отсутствие активности переводит задачу в контролируемую блокировку
    Given задача перестала подавать признаки активности дольше допустимого окна
    When система выполняет проверку зависших задач
    Then задача переводится в blocked_external
    and причина блокировки явно указывает на отсутствие признаков активности
```
