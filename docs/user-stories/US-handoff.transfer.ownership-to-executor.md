<a id="us-handoff.transfer.ownership-to-executor"></a>

# US-handoff.transfer.ownership-to-executor: Передача владения изменением (handoff)

```gherkin
@US-handoff.transfer.ownership-to-executor @HF7.1 @UC-handoff.transfer.ownership-to-executor @P0 @handoff @transfer @gui
Feature: US-handoff.transfer.ownership-to-executor Передача владения изменением (handoff)

  Background:
    Given пользователь открыл задачу и диалог «Assign / hand off»
    and current ownership задачи известен (executionOwner, ownershipRevision)

  Scenario: Пользователь передаёт владение задачей другому исполнителю
    Given задача принадлежит текущему владельцу (revision совпадает)
    When пользователь выбирает нового исполнителя (AI или Human) и указывает причину
    Then API выполняет handoffTaskExecution с ownershipRevision
    and executionOwner обновляется и ownershipRevision инкрементируется
    and запись в taskExecutorHistory создаётся
    and UI отображает нового владельца и причину handoff
    and WebSocket-событие task:ownershipChanged рассылается

  Scenario: Handoff отклоняется при конфликте ревизии
    Given ownershipRevision задачи изменился (конкурентное изменение)
    When пользователь отправляет handoff
    Then API возвращает 409 Conflict (TaskOwnershipConflict)
    and владение не изменяется

  Scenario: Автоматический handoff AI → Human при эскалации
    Given задача эскалирована (исчерпаны попытки исправления)
    When Coordinator выполняет handoff
    Then executionOwner устанавливается в human
    and в taskExecutorHistory фиксируется передача с указанием причины

  Scenario: Human → AI handoff через manual action
    Given задача принадлежит человеку
    When пользователь выполняет действие start_ai
    Then executionOwner устанавливается в ai
    and Coordinator продолжает выполнение конвейера
```
