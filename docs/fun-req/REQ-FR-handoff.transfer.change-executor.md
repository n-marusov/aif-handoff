[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-handoff.transfer.change-executor: Передача владения изменением (handoff)

**Приоритет:** P0

**Ключевая функция:** HF7.1 Передача владения изменением

**Источник:** [UC-handoff.transfer.ownership-to-executor](../use-cases/UC-handoff.transfer.ownership-to-executor.md), BR-ownership.assignment, BR-ownership.handoff, BR-ownership.executor-history

**Статус:** proposed

**Класс:** as is

**Канал:** API (REST) / Agent

**Описание:** Владение задачей может быть передано между исполнителями (AI ↔ Human, Human → Human). Каждая передача фиксируется в `taskExecutorHistory` с монотонной `ownershipRevision` для оптимистичной блокировки. Handoff возможен только при совпадении `ownershipRevision`.

**Критерии приёмки:**

1. Текущий владелец (человек через UI или Coordinator) инициирует handoff через `POST /api/tasks/:id/handoff`.
2. API вызывает `handoffTaskExecution` с `ownershipRevision`, `executionOwner`, `reason`.
3. Data layer атомарно проверяет совпадение `ownershipRevision` в БД (optimistic lock).
4. При совпадении: обновляется `executionOwner`, инкрементируется `ownershipRevision`, создаётся запись в `taskExecutorHistory`.
5. При несовпадении: возвращается `409 Conflict` с `TaskOwnershipConflict`.
6. WS-событие `task:ownershipChanged` уведомляет всех клиентов.
7. Coordinator автоматически передаёт задачу человеку при эскалации (exhausted retries).
8. Пользователь передаёт задачу AI через action `start_ai`.
9. При handoff могут быть обновлены assignees.
10. `allowLockedBy=true` — handoff может быть выполнен даже если задача заблокирована Coordinator-ом.
11. Аудит-запись `TaskOwnershipTransferred` создаётся.

## See Also

- [REQ-FR-handoff.escalation.escalate-unresolvable-decision](REQ-FR-handoff.escalation.escalate-unresolvable-decision.md) — эскалация
- [REQ-FR-handoff.history.display-executor-timeline](REQ-FR-handoff.history.display-executor-timeline.md) — история исполнителей
- [REQ-FR-handoff.diagnostics.display-escalation-diagnostics](REQ-FR-handoff.diagnostics.display-escalation-diagnostics.md) — диагностика
