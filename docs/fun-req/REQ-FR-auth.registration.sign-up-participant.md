[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-auth.registration.sign-up-participant: Регистрация и вход участника

**Приоритет:** P1

**Ключевая функция:** HF9.1 Регистрация и вход

**Источник:** [UC-auth.registration.sign-up-participant](../use-cases/UC-auth.registration.sign-up-participant.md), BR-constraint.auth.credentials, BR-constraint.auth.sessions, BR-fact.auth.roles

**Статус:** proposed

**Класс:** as is

**Канал:** GUI (LoginPage) / API

**Описание:** Участник регистрируется в системе через API, создаётся запись в `participants` с хешированным паролем (bcrypt) и ролью. Аутентификация через сессии: создаётся `participantSession` с токеном, CSRF-токеном и временем истечения.

**Критерии приёмки:**

1. При включённом `PARTICIPANTS_MODE_ENABLED` приложение показывает LoginPage.
2. Регистрация: пользователь отправляет `POST /api/participants` с username, password, displayName.
3. API создаёт запись в `participants` с `passwordHash` (bcrypt), `role=member`, `active=true`.
4. Вход: пользователь отправляет `POST /api/auth/login` с credentials.
5. API проверяет пароль через bcrypt, создаёт сессию (`participantSessions`) с токеном, CSRF-токеном и expiry.
6. UI получает `AuthSessionState` с `authenticated=true`, `participant`, `role`.
7. Все последующие запросы включают session cookie и CSRF-токен.
8. При неверном пароле API возвращает 401.
9. Middleware проверяет `expiresAt` сессии — если истекла, возвращает 401.
10. Первый зарегистрированный участник получает роль `admin`.
11. Logout: `POST /api/auth/logout` — `revokeAt` на сессии.

## See Also

- [REQ-FR-auth.roles.assign-participant-role](REQ-FR-auth.roles.assign-participant-role.md) — роли
- [REQ-FR-pipeline.manual-override.intervene-task-stage](REQ-FR-pipeline.manual-override.intervene-task-stage.md) — RBAC в actions
