[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-pipeline.escalation.escalate-after-exhausted-retries: Эскалация при исчерпании попыток исправления

**Приоритет:** P1

**Ключевая функция:** HF5.5 Эскалация при исчерпании попыток

**Источник:** [UC-pipeline.escalation.escalate-after-exhausted-retries](../use-cases/UC-pipeline.escalation.escalate-after-exhausted-retries.md), BR-task-lifecycle.blocked, BR-ownership.automation-eligibility

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (coordinator)

**Описание:** Если задача не прошла review-цикл после `maxReviewIterations` итераций, Coordinator эскалирует её человеку: устанавливает `manualReviewRequired=true`, `blocked_external` и сохраняет полную диагностику (крайний finding, что ожидалось, что проверено, какие гипотезы). Пользователь видит задачу в статусе `blocked_external` с пометкой "Требуется ручная проверка".

**Критерии приёмки:**

1. Coordinator обнаруживает, что `reviewIterationCount >= maxReviewIterations`.
2. Coordinator собирает диагностику:
   - Последние finding-и sidecar-агента (`AutoReviewFinding`).
   - Что ожидалось (expected) vs что проверено (actual).
   - Какие гипотезы были проверены.
3. Coordinator устанавливает `manualReviewRequired=true`, `status=blocked_external` с `blockedReason`, содержащим диагностику.
4. Coordinator выполняет handoff задачи → человеку (`executionOwner=human`).
5. WebSocket-трансляция уведомляет UI.
6. Пользователь видит задачу в статусе `blocked_external` с пометкой "Требуется ручная проверка".
7. Пользователь может: проанализировать диагностику, отклонить изменение, исправить вручную, сбросить счётчик и продолжить цикл.
8. Пользователь может скорректировать план, изменить runtime-профиль и вызвать `retry_from_blocked`.

## See Also

- [REQ-FR-pipeline.review-loop.iterate-review-feedback](REQ-FR-pipeline.review-loop.iterate-review-feedback.md) — цикл доработки
- [REQ-FR-handoff.diagnostics.display-escalation-diagnostics](REQ-FR-handoff.diagnostics.display-escalation-diagnostics.md) — диагностика эскалации
- [REQ-FR-handoff.escalation.escalate-unresolvable-decision](REQ-FR-handoff.escalation.escalate-unresolvable-decision.md) — эскалация решений
