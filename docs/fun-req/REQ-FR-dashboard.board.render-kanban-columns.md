[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-dashboard.board.render-kanban-columns: Отображение задач в Kanban-доске

**Приоритет:** P0

**Ключевая функция:** HF2.1 Просмотр изменений по стадиям

**Источник:** [UC-dashboard.board.view-kanban-columns](../use-cases/UC-dashboard.board.view-kanban-columns.md), BR-audit.observability

**Статус:** proposed

**Класс:** as is

**Канал:** GUI (React SPA, TailwindCSS 4)

**Описание:** Пользователь видит все задачи проекта, сгруппированные по стадиям конвейера в Kanban-доске с возможностью drag-and-drop переупорядочивания. Доступны два режима отображения: kanban (колонки) и list (таблица).

**Критерии приёмки:**

1. Пользователь выбирает проект в ProjectSelector.
2. UI запрашивает задачи через REST API: `GET /api/tasks?projectId=X` (возвращает `TaskListItem[]`).
3. API возвращает задачи со статусами, assignees, permissions.
4. UI группирует задачи по статусу и отображает колонки: Backlog, Planning, Improve, Plan Ready, Plan Review, Implementing, Verify, Review, Blocked, Done, Accepted.
5. Для каждой задачи отображаются: заголовок, приоритет, assignee, runtime, статус гейтов, время последней активности.
6. Drag-and-drop через `@dnd-kit` изменяет позицию задачи в колонке (`PUT /api/tasks/reorder`).
7. Доступны режимы: `comfortable` (с preview) и `compact` (таблица).
8. При отсутствии проектов показывается `ProjectsOverview` — сводка всех проектов с метриками.
9. FilterBar позволяет фильтровать по статусу, приоритету, assignee, тегам.

## See Also

- [REQ-FR-dashboard.realtime.broadcast-live-updates](REQ-FR-dashboard.realtime.broadcast-live-updates.md) — real-time обновления
- [REQ-FR-dashboard.detail.display-task-details](REQ-FR-dashboard.detail.display-task-details.md) — детальный просмотр
- [REQ-FR-dashboard.gate-status.display-gate-results](REQ-FR-dashboard.gate-status.display-gate-results.md) — статусы гейтов
