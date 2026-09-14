[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-dashboard.detail.display-task-details: Детальный просмотр изменения

**Приоритет:** P0

**Ключевая функция:** HF2.3 Детали изменения

**Источник:** [UC-dashboard.detail.view-task-details](../use-cases/UC-dashboard.detail.view-task-details.md)

**Статус:** proposed

**Класс:** as is

**Канал:** GUI (React SPA, slide-over панель)

**Описание:** Пользователь открывает детальный просмотр задачи через клик на карточку в Kanban-доске и видит: план (Change Plan), результаты проверок, комментарии, историю эскалаций, ownership, лог выполнения, runtime usage, прогресс выполнения.

**Критерии приёмки:**

1. Пользователь кликает на карточку задачи — UI открывает `TaskDetail` (slide-over панель).
2. API возвращает полные данные задачи: `GET /api/tasks/:id`.
3. Отображаются разделы:
   - Header: статус, priority, title, ownership.
   - Plan: Change Plan с подсветкой (если `planPath` не null).
   - Timeline: AgentTimeline (прогресс выполнения, currentTool).
   - Comments: обсуждения с participant info, возможность добавления (`POST /api/tasks/:id/comments`).
   - ExecutorTimeline: история исполнителей.
   - Settings: runtime profile, model override.
   - QA: статус QA-прогона (если настроен).
   - Log: сырой лог выполнения (agentActivityLog).
4. Если план не сгенерирован (`planPath=null`), секция плана скрыта.
5. Пользователь может изменять runtime profile и model override в TaskSettings.

## See Also

- [REQ-FR-dashboard.board.render-kanban-columns](REQ-FR-dashboard.board.render-kanban-columns.md) — Kanban-доска
- [REQ-FR-handoff.history.display-executor-timeline](REQ-FR-handoff.history.display-executor-timeline.md) — история исполнителей
- [REQ-FR-runtime.override.override-profile-for-task](REQ-FR-runtime.override.override-profile-for-task.md) — переопределение профиля
