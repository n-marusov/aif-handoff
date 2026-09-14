[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-auth.roles.assign-participant-role: Разграничение ролей и прав участников

**Приоритет:** P1

**Ключевая функция:** HF9.2 Разграничение ролей

**Источник:** [UC-auth.roles.assign-participant-role](../use-cases/UC-auth.roles.assign-participant-role.md), BR-fact.auth.roles, BR-fact.auth.admin-privileges, BR-constraint.auth.member-scope, BR-constraint.auth.task-isolation

**Статус:** proposed

**Класс:** as is

**Канал:** GUI (ParticipantManagementDialog) / API

**Описание:** Администратор управляет участниками: назначает роли (`admin`/`member`), деактивирует, сбрасывает пароли. RBAC проверяется в `resolveTaskAction` и `resolveTaskPermissions`. Каждый участник имеет ограниченные права согласно роли.

**Критерии приёмки:**

1. Администратор открывает ParticipantManagementDialog (доступен только `admin`).
2. UI показывает список участников с их ролями и статусами (`GET /api/participants`).
3. Администратор может:
   - Изменить роль участника (`member` ↔ `admin`) через `PUT /api/participants/:id`.
   - Деактивировать/реактивировать участника.
   - Сбросить пароль участника.
4. Изменения применяются немедленно: middleware проверяет `participant.active` и `role` на каждом запросе.
5. RBAC проверяется в `resolveTaskAction`:
   - `admin` — полный доступ, может действовать на любых задачах.
   - `member` — может действовать только на назначенных задачах (`assignment_required`).
   - Неактивные участники получают `actor_not_authorized`.
6. `resolveTaskPermissions` вычисляет: `canAssign`, `canHandoff`, `canSelfAssign`, `canAct`, `permittedActions`.
7. Пользователь может изменить свой пароль через Header (`onChangePassword`).
8. Member может видеть только задачи, на которые назначен (task isolation).
9. User может видеть только проекты, в которые добавлен (member-scope).

## See Also

- [REQ-FR-auth.registration.sign-up-participant](REQ-FR-auth.registration.sign-up-participant.md) — регистрация
- [REQ-FR-pipeline.manual-override.intervene-task-stage](REQ-FR-pipeline.manual-override.intervene-task-stage.md) — RBAC в actions
- [REQ-FR-pipeline.gate.enforce-stage-transition-gate](REQ-FR-pipeline.gate.enforce-stage-transition-gate.md) — гейты авторизации
