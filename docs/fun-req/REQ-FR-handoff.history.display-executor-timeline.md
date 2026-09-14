[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-handoff.history.display-executor-timeline: Просмотр истории исполнителей задачи

**Приоритет:** P2

**Ключевая функция:** HF7.3 История исполнителей

**Источник:** [UC-handoff.history.view-executor-timeline](../use-cases/UC-handoff.history.view-executor-timeline.md), BR-constraint.ownership.executor-history

**Статус:** proposed

**Класс:** as is

**Канал:** GUI (ExecutorTimeline) / API

**Описание:** Пользователь видит полную историю смены исполнителей задачи: кто и когда владел задачей, причина handoff, snapshot assignees и статуса на момент передачи. Данные берутся из `taskExecutorHistory`.

**Критерии приёмки:**

1. Пользователь открывает детальный просмотр задачи и переходит к секции ExecutorTimeline.
2. API возвращает `listTaskExecutorHistory(taskId)` — все записи по `ownershipRevision` (`GET /api/tasks/:id/executor-history`).
3. Каждая запись содержит: `actorKind` (ai/human), `executionOwner`, `assigneesSnapshotJson`, `statusSnapshot`, `reason`.
4. UI отображает timeline с визуальными индикаторами AI ↔ Human.

## See Also

- [REQ-FR-handoff.transfer.change-executor](REQ-FR-handoff.transfer.change-executor.md) — handoff
- [REQ-FR-dashboard.detail.display-task-details](REQ-FR-dashboard.detail.display-task-details.md) — детальный просмотр
- [REQ-FR-audit.logging.record-state-transition](REQ-FR-audit.logging.record-state-transition.md) — аудит
