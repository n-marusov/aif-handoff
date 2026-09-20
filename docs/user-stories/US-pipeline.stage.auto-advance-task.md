<a id="us-pipeline.stage.auto-advance-task"></a>

# US-pipeline.stage.auto-advance-task: Автоматическое прохождение стадий конвейера

```gherkin
@US-pipeline.stage.auto-advance-task @HF1.1 @HF5.1 @UC-pipeline.stage.auto-advance-task @P0 @pipeline @stage
Feature: US-pipeline.stage.auto-advance-task Автоматическое прохождение стадий конвейера

  Background:
    Given задача создана в проекте с настроенным runtime-профилем
    and задача находится в режиме автономного выполнения (autoMode=true)
    and Coordinator запущен и опрашивает БД каждые 30 секунд

  Scenario: Задача автоматически продвигается по стадиям до завершения
    Given задача в статусе backlog без блокировок (blockedReason=null)
    When Coordinator захватывает задачу (claimTask) и запускает субагента соответствующей стадии
    Then субагент выполняет работу через выбранный runtime-адаптер
    and Coordinator применяет переход стадии к следующему статусу (onSuccess)
    and освобождает блокировку задачи
    and UI обновляется в реальном времени через WebSocket-событие task:stageChanged

  Scenario: Задача блокируется при превышении лимита runtime
    Given лимит проекта превышен (runtime-гейт заблокирован)
    When Coordinator проверяет runtime-гейт перед запуском субагента
    Then задача переводится в blocked_external с указанием причины
    and retry планируется после reset-окна лимита

  Scenario: Задача пропускается, если уже захвачена другим Coordinator
    Given задача уже заблокирована другим Coordinator (lockedBy != null)
    When Coordinator обнаруживает задачу в poll-цикле
    Then Coordinator пропускает задачу в текущем цикле
```
