[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-dashboard.realtime.broadcast-live-updates: Обновления статуса в реальном времени

**Приоритет:** P1

**Ключевая функция:** HF2.4 Обновления в реальном времени

**Источник:** [UC-dashboard.realtime.receive-live-status-updates](../use-cases/UC-dashboard.realtime.receive-live-status-updates.md)

**Статус:** proposed

**Класс:** as is

**Канал:** GUI (WebSocket)

**Описание:** UI получает WebSocket-события от сервера при каждом изменении статуса задачи, броадкасте прогресса execution, хартбитах и ownership-изменениях. Компоненты автоматически обновляются через инвалидацию react-query кэша без полного reload-а страницы.

**Критерии приёмки:**

1. При монтировании приложения UI устанавливает WebSocket-соединение (`useWebSocket(true)`).
2. Каждое изменение статуса задачи (API-запросом или Coordinator-ом) триггерит broadcast в WS.
3. WS-событие содержит тип: `task:updated`, `task:moved`, `task:activity`, `task:heartbeat`, `task:handoff`, `task:comment_created`, `task:usage_updated`, `task:commit_done`, `task:commit_failed`, `project:runtime_limit_updated`.
4. UI обрабатывает событие и инвалидирует react-query кэш (`queryClient.invalidateQueries`).
5. UI перерисовывает обновлённые компоненты (Board, TaskDetail, Header metrics).
6. `useWebSocket` автоматически переподключается при разрыве соединения.
7. При смене проекта WS-соединение переустанавливается.

## See Also

- [REQ-FR-dashboard.board.render-kanban-columns](REQ-FR-dashboard.board.render-kanban-columns.md) — Kanban-доска
- [REQ-FR-audit.heartbeat.track-subagent-heartbeat](REQ-FR-audit.heartbeat.track-subagent-heartbeat.md) — хартбиты
- [REQ-FR-dashboard.detail.display-task-details](REQ-FR-dashboard.detail.display-task-details.md) — детальный просмотр
