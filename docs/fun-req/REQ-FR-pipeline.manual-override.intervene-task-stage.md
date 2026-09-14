[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-pipeline.manual-override.intervene-task-stage: Ручное управление движением задачи

**Приоритет:** P1

**Ключевая функция:** HF1.7 Ручное управление движением

**Источник:** [UC-pipeline.manual-override.intervene-task-stage](../use-cases/UC-pipeline.manual-override.intervene-task-stage.md), BR-fact.auth.roles, BR-constraint.auth.member-scope, BR-constraint.task-lifecycle.transitions

**Статус:** proposed

**Класс:** as is

**Канал:** GUI (REST API)

**Описание:** Пользователь выполняет действие над задачей через UI или API, принудительно переводя её на другую стадию. Доступные действия определяются статусом задачи, `executionOwner` и ролью пользователя. State machine (`resolveTaskAction`) проверяет допустимость перехода, роль пользователя и authorship.

**Критерии приёмки:**

1. UI отправляет POST-запрос в API: `/api/tasks/:id/event` с `TaskEventInput`.
2. API вызывает `applyTaskAction` — атомарная проверка через `resolveTaskAction` в state machine.
3. State machine проверяет: статус задачи ∈ `from`, `autoMode`, `executionOwner`, роль актора, назначение (assignees).
4. Если переход разрешён, API вызывает `updateTaskStatus` — атомарный переход статуса в БД.
5. API отправляет WebSocket-событие `task:stageChanged`.
6. UI получает обновление и отображает новый статус.
7. API записывает событие аудита `task.action.<event>`.
8. Если действие не разрешено, возвращается 403 с кодом (`action_not_allowed`, `actor_not_authorized`, `ai_handoff_required`).
9. Для human-owner задач доступны actions: `start_human_work`, `mark_plan_ready`, `submit_implementation`, `complete_review`, `pass_verification`, `fail_verification`.
10. Для AI-owner задач доступны actions: `start_ai`, `start_implementation`, `approve_plan`, `request_plan_changes`, `request_replanning`, `approve_done`, `request_changes`.
11. Администратор может выполнить action, даже если не назначен исполнителем задачи.
12. `retry_from_blocked` восстанавливает задачу из `blocked_external` в `blockedFromStatus`.

## See Also

- [REQ-FR-pipeline.gate.enforce-stage-transition-gate](REQ-FR-pipeline.gate.enforce-stage-transition-gate.md) — формальные гейты
- [REQ-FR-auth.roles.assign-participant-role](REQ-FR-auth.roles.assign-participant-role.md) — RBAC
- [REQ-FR-audit.logging.record-state-transition](REQ-FR-audit.logging.record-state-transition.md) — аудит переходов
