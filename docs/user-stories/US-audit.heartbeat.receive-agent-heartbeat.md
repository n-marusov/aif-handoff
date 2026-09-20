<a id="us-audit.heartbeat.receive-agent-heartbeat"></a>

# US-audit.heartbeat.receive-agent-heartbeat: Получение хартбитов от выполняющихся агентов

```gherkin
@US-audit.heartbeat.receive-agent-heartbeat @HF10.2 @UC-audit.heartbeat.receive-agent-heartbeat @P1 @audit @heartbeat
Feature: US-audit.heartbeat.receive-agent-heartbeat Получение хартбитов от выполняющихся агентов

  Background:
    Given субагент выполняет длительный runtime-запрос

  Scenario: Адаптер отправляет хартбиты во время выполнения
    Given runtime-адаптер поддерживает сигналы жизни (RuntimeSubagentStartCallback)
    When адаптер отправляет хартбит (toolName, detail, startedAt)
    Then Coordinator обновляет lastHeartbeatAt на задаче
    and сохраняет текущий инструмент (currentToolJson)

  Scenario: UI отображает живой прогресс выполнения
    Given хартбит получен Coordinator-ом
    When WebSocket-событие task:heartbeat рассылается
    Then UI отображает актуальный прогресс и текущий инструмент субагента

  Scenario: Waitdog обнаруживает зависшую задачу
    Given задача не отправляет хартбит дольше AGENT_STAGE_RUN_TIMEOUT_MS
    When taskWatchdog выполняет listStaleInProgressTasks
    Then задача считается зависшей
    and блокируется в blocked_external с причиной «no heartbeat»
```
