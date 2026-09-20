<a id="us-accounting.tracking.record-runtime-call"></a>

# US-accounting.tracking.record-runtime-call: Учёт каждого вызова runtime

```gherkin
@US-accounting.tracking.record-runtime-call @HF6.1 @UC-accounting.tracking.record-runtime-call @P0 @accounting @tracking
Feature: US-accounting.tracking.record-runtime-call Учёт каждого вызова runtime

  Background:
    Given runtime-адаптер выполняет запрос к AI-провайдеру
    and usage sink подключён к БД

  Scenario: Каждый вызов runtime фиксируется в UsageEvent
    Given RuntimeAdapter завершает выполнение runtime-запроса
    When адаптер вызывает usageSink.record(usageEvent)
    Then в таблицу usageEvents вставляется запись с source, runtimeId, providerId, projectId и taskId
    and счётчики токенов и стоимости задачи инкрементируются
    and счётчики токенов и стоимости проекта инкрементируются

  Scenario: UI отображает использование runtime задачи
    Given использование задачи обновлено
    When Coordinator отправляет WebSocket-событие task:usage
    Then UI отображает актуальные значения usage в RuntimeUsageDialog

  Scenario: Учёт использования чат-сессии
    Given пользователь взаимодействует с AI-ассистентом в чате
    When runtime-запрос завершается
    Then usage записывается на chatSessions (incrementChatSessionTokenUsage)
```
