[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-handoff.escalation.escalate-unresolvable-decision: Эскалация решения вне правил

**Приоритет:** P1

**Ключевая функция:** HF7.2 Эскалация решений вне правил

**Источник:** [UC-handoff.escalation.escalate-unresolvable-decision](../use-cases/UC-handoff.escalation.escalate-unresolvable-decision.md), BR-ownership.automation-eligibility, BR-task-lifecycle.blocked

**Статус:** proposed

**Класс:** as is

**Канал:** Agent

**Описание:** Когда Coordinator или субагент сталкивается с решением, которое не может быть выведено из формальных правил (exhausted retries, неопределённая ситуация), задача эскалируется человеку. Эскалация включает полную диагностику: какой гейт упал, что ожидалось, что проверено, какие гипотезы.

**Критерии приёмки:**

1. Coordinator определяет, что ситуация не может быть разрешена автоматически:
   - `reviewIterationCount >= maxReviewIterations`
   - или runtime-гейт не может быть пройден (лимиты)
   - или субагент вернул non-retriable ошибку
2. Coordinator собирает полную диагностику:
   - гейт, на котором произошла остановка
   - последние finding-и (`AutoReviewFinding`)
   - что ожидалось (expected) и что проверено (actual)
   - гипотезы о причине
3. Coordinator устанавливает `manualReviewRequired=true`, `blocked_external` с `blockedReason`.
4. Coordinator выполняет handoff → человеку (`executionOwner=human`).
5. WS-уведомление (`task:moved`/`task:updated`) отправляется всем участникам.
6. Пользователь анализирует диагностику, исправляет проблему и вызывает `retry_from_blocked`.
7. Пользователь может закрыть задачу или изменить требования.

## See Also

- [REQ-FR-pipeline.escalation.escalate-after-exhausted-retries](REQ-FR-pipeline.escalation.escalate-after-exhausted-retries.md) — эскалация retries
- [REQ-FR-handoff.diagnostics.display-escalation-diagnostics](REQ-FR-handoff.diagnostics.display-escalation-diagnostics.md) — диагностика
- [REQ-FR-handoff.transfer.change-executor](REQ-FR-handoff.transfer.change-executor.md) — handoff
