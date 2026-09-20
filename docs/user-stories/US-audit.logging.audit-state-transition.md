<a id="us-audit.logging.audit-state-transition"></a>

# US-audit.logging.audit-state-transition: Иммутабельный аудит действий системы

```gherkin
@US-audit.logging.audit-state-transition @HF10.1 @UC-audit.logging.audit-state-transition @P0 @audit @logging
Feature: US-audit.logging.audit-state-transition Иммутабельный аудит действий системы

  Background:
    Given система выполняет действие, изменяющее состояние задачи

  Scenario: Каждое действие записывается в иммутабельный аудит
    Given Coordinator или API изменяет состояние задачи (например, переход стадии)
    When действие завершено успешно
    Then в таблицу auditEvents вставляется запись (action, entityType, entityId, actorKind)
    and сохраняется snapshot статуса и assignees на момент действия
    and запись содержит actorDisplayNameSnapshot (имя на момент действия)
    and запись не может быть изменена или удалена

  Scenario: Аудит фиксирует handoff
    Given владение задачей передано через handoff
    When запись аудита создаётся
    Then action=TaskOwnershipTransferred
    and metadata содержит ownershipRevision

  Scenario: Аудит фиксирует создание задачи
    Given создаётся новая задача
    When запись аудита создаётся
    Then action=TaskCreated с entityId новой задачи
```
