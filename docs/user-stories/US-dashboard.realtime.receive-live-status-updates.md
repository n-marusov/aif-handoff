<a id="us-dashboard.realtime.receive-live-status-updates"></a>

# US-dashboard.realtime.receive-live-status-updates: Обновления статуса в реальном времени

```gherkin
@US-dashboard.realtime.receive-live-status-updates @HF2.4 @UC-dashboard.realtime.receive-live-status-updates @P1 @dashboard @realtime @gui
Feature: US-dashboard.realtime.receive-live-status-updates Обновления статуса в реальном времени

  Background:
    Given приложение установило WebSocket-соединение с сервером
    and пользователь работает с Kanban-доской проекта

  Scenario: UI обновляет задачу при изменении её статуса
    Given Coordinator (или API) изменяет статус задачи
    When сервер рассылает WebSocket-событие task:stageChanged
    Then UI инвалидирует react-query кэш
    and доска и детали задачи перерисовываются без полного reload страницы

  Scenario: UI обновляется при получении хартбита выполнения
    Given субагент выполняет длительную работу
    When сервер рассылает WebSocket-событие task:heartbeat
    Then UI отображает актуальный прогресс выполнения задачи

  Scenario: Соединение WebSocket разорвано и восстановлено
    Given WebSocket-соединение разорвано
    When useWebSocket обнаруживает разрыв
    Then соединение устанавливается заново автоматически
    and UI продолжает получать обновления

  Scenario: Изменение владения и комментариев транслируется в реальном времени
    Given пользователь (или Coordinator) выполнил handoff или добавил комментарий
    When сервер рассылает task:ownershipChanged или task:comment
    Then UI обновляет ownership и комментарии без ручного обновления
```
