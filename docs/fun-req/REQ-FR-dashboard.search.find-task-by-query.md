[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-dashboard.search.find-task-by-query: Поиск по проектам и изменениям

**Приоритет:** P2

**Ключевая функция:** HF2.5 Поиск по проектам и изменениям

**Источник:** [UC-dashboard.search.find-task-by-query](../use-cases/UC-dashboard.search.find-task-by-query.md)

**Статус:** proposed

**Класс:** as is

**Канал:** GUI (Command Palette)

**Описание:** Пользователь открывает Command Palette (Cmd+K), вводит поисковый запрос и получает отфильтрованные результаты по проектам и задачам. Поиск выполняется через REST API с LIKE-поиском по title и description.

**Критерии приёмки:**

1. Пользователь открывает Command Palette (Cmd+K или через Header).
2. Вводит поисковый запрос — UI выполняет `GET /api/tasks/search?q=<query>&projectId=X`.
3. API выполняет `searchTasksPaginated` с LIKE-поиском по `title` и `description`.
4. UI отображает результаты, сгруппированные по проектам.
5. Пользователь выбирает проект (переключение activeProjectId) или задачу (открытие TaskDetail).
6. При пустом результате UI показывает "No matching tasks".
7. Фильтрация через FilterBar позволяет фильтровать по статусу, приоритету, assignee.

## See Also

- [REQ-FR-dashboard.board.render-kanban-columns](REQ-FR-dashboard.board.render-kanban-columns.md) — Kanban-доска
- [REQ-FR-dashboard.detail.display-task-details](REQ-FR-dashboard.detail.display-task-details.md) — детальный просмотр
