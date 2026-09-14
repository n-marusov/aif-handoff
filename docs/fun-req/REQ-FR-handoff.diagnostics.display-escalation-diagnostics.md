[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-handoff.diagnostics.display-escalation-diagnostics: Получение диагностики эскалации

**Приоритет:** P1

**Ключевая функция:** HF7.4 Диагностика эскалации

**Источник:** [UC-handoff.diagnostics.receive-escalation-diagnostics](../use-cases/UC-handoff.diagnostics.receive-escalation-diagnostics.md), BR-inference.ownership.automation-eligibility

**Статус:** proposed

**Класс:** as is

**Канал:** GUI (TaskDetail)

**Описание:** При эскалации задачи пользователь получает структурированную диагностику: какой гейт упал, что ожидалось, что проверено, какие гипотезы рассматривались. Диагностика отображается в UI как часть blocked-статуса задачи.

**Критерии приёмки:**

1. Пользователь видит задачу в колонке Blocked с badge "Manual review required".
2. При открытии TaskDetail диагностика отображается в структурированном виде.
3. Диагностика содержит: gate, finding, expected, actual, hypotheses.
4. Если `blockedReason` пуст, UI показывает generic "Blocked" сообщение.
5. Пользователь может: исправить, отклонить, изменить план, сбросить счётчик, изменить runtime-профиль и вызвать `retry_from_blocked`.

## See Also

- [REQ-FR-handoff.escalation.escalate-unresolvable-decision](REQ-FR-handoff.escalation.escalate-unresolvable-decision.md) — эскалация
- [REQ-FR-pipeline.escalation.escalate-after-exhausted-retries](REQ-FR-pipeline.escalation.escalate-after-exhausted-retries.md) — эскалация retries
- [REQ-FR-dashboard.gate-status.display-gate-results](REQ-FR-dashboard.gate-status.display-gate-results.md) — статусы гейтов
