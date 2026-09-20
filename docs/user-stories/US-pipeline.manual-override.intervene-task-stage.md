<a id="us-pipeline.manual-override.intervene-task-stage"></a>

# US-pipeline.manual-override.intervene-task-stage: Ручное управление движением задачи

```gherkin
@US-pipeline.manual-override.intervene-task-stage @HF1.7 @UC-pipeline.manual-override.intervene-task-stage @P1 @pipeline @manual-override @gui
Feature: US-pipeline.manual-override.intervene-task-stage Ручное управление движением задачи

  Background:
    Given пользователь открыл детальный просмотр задачи
    and пользователь имеет права на выполнение действия согласно роли

  Scenario: Пользователь вручную переводит задачу на другую стадию
    Given задача в статусе, допускающем выполнение действия (например, start_ai из backlog)
    When пользователь нажимает кнопку действия в UI (например, "Start AI")
    Then API проверяет переход через state machine (resolveTaskAction)
    and задача атомарно переводится на новую стадию
    and UI получает WebSocket-событие task:stageChanged
    and событие аудита TaskEvent записано

  Scenario: Действие не разрешено для текущего статуса
    Given событие не применимо к текущему статусу (например, start_ai из implementing)
    When пользователь нажимает кнопку действия
    Then state machine возвращает отказ с кодом error
    and UI отображает мотивированное сообщение об ошибке

  Scenario: Восстановление задачи из блокировки
    Given задача в статусе blocked_external
    When пользователь выполняет действие retry_from_blocked
    Then задача возвращается к blockedFromStatus
    and конвейер продолжает выполняться

  Scenario: Администратор выполняет действие вне роли исполнителя
    Given пользователь с ролью admin не назначен исполнителем задачи
    When админ выполняет действие над задачей
    Then действие разрешено (admin bypass)
```
