<a id="us-pipeline.gate.enforce-stage-transition-gate"></a>

# US-pipeline.gate.enforce-stage-transition-gate: Формальные гейты переходов между стадиями

```gherkin
@US-pipeline.gate.enforce-stage-transition-gate @HF5.1 @UC-pipeline.gate.enforce-stage-transition-gate @P0 @pipeline @gate
Feature: US-pipeline.gate.enforce-stage-transition-gate Формальные гейты переходов между стадиями

  Background:
    Given Coordinator выполняет poll-цикл и обрабатывает задачи-кандидаты

  Scenario: Допустимый переход проходит формальные гейты
    Given статус задачи соответствует from-статусу перехода
    and autoMode=true и владение (executionOwner) соответствует действию
    When Coordinator вызывает resolveTaskAction для кандидата
    Then state machine подтверждает переход
    and runtime-гейт подтверждает, что лимит не превышен (blockCandidateIfRuntimeLimited)
    and Coordinator запускает stage runner соответствующей стадии

  Scenario: Переход запрещён по статусу
    Given событие не применимо к текущему статусу задачи
    When Coordinator вызывает resolveTaskAction
    Then переходит denied с кодом action_not_allowed
    and Coordinator пропускает задачу в текущем цикле (причина логируется)

  Scenario: Task заблокирован runtime-гейтом лимитов
    Given лимит проекта превышен (RuntimeLimitSnapshot = BLOCKED)
    When Coordinator проверяет runtime-гейт
    Then задача блокируется через proactivelyBlockTaskForRuntimeGate
    and переводится в blocked_external до reset-окна лимита

  Scenario: Действие требует AI-владения
    Given executionOwner=human, а событие требует AI-владения
    When Coordinator вызывает resolveTaskAction
    Then переход сотклоняется с кодом ai_handoff_required
```
