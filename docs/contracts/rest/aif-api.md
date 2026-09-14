[← README](../README.md)

# REST API (Hono)

> Источник правды: `packages/api/src/routes/*.ts`
> Версия: 0.1.0 (формальная спецификация в разработке)
> Статус: `implemented`

## Базовая информация

- **Base URL:** `http://<host>:3009`
- **Transport:** HTTP/1.1
- **Framework:** Hono + @hono/node-server
- **Validation:** zod + @hono/zod-validator
- **Auth:** Session-based (cookie + CSRF-токен)
- **CORS:** Настраивается через `PARTICIPANT_ALLOWED_ORIGINS`

## Аутентификация

Система поддерживает два режима:

- **Legacy** (`PARTICIPANTS_MODE_ENABLED=false`): анонимный доступ, все запросы проходят
- **Участники** (`PARTICIPANTS_MODE_ENABLED=true`): session-based аутентификация

Middleware-цепочка:

1. `participantCors()` — CORS
2. `trackApiLoad()` — метрики нагрузки
3. `requestLogger()` — логгирование
4. `participantAuth()` — аутентификация
5. `participantRouteAuthorization()` — проверка роли
6. `participantCsrf()` — CSRF-защита

## Эндпоинты

### Health & Status

| Метод | Путь            | Описание                                           | Аутентификация |
| ----- | --------------- | -------------------------------------------------- | -------------- |
| `GET` | `/health`       | Проверка здоровья сервера                          | Нет            |
| `GET` | `/agent/status` | Статус агента (uptime, активные задачи, heartbeat) | Нет            |
| `GET` | `/settings`     | Настройки по умолчанию для фронтенда               | Нет            |

**`GET /health` → Response:**

```json
{ "status": "ok", "uptime": 3600 }
```

**`GET /agent/status` → Response:**

```json
{
  "uptime": 3600,
  "activeTasks": [
    {
      "id": "...",
      "title": "...",
      "status": "implementing",
      "heartbeatLagMs": 5000,
      "heartbeatStale": false
    }
  ],
  "activeTaskCount": 1,
  "staleTasks": 0,
  "checkedAt": "2026-09-14T..."
}
```

### Tasks (`/api/tasks`)

| Метод    | Путь                         | Описание                                                    | Auth        |
| -------- | ---------------------------- | ----------------------------------------------------------- | ----------- |
| `GET`    | `/api/tasks`                 | Список задач (с фильтрацией по проекту, статусу, владельцу) | Опционально |
| `POST`   | `/api/tasks`                 | Создание задачи                                             | Требуется   |
| `GET`    | `/api/tasks/:id`             | Детали задачи                                               | Опционально |
| `PATCH`  | `/api/tasks/:id`             | Обновление задачи                                           | Требуется   |
| `DELETE` | `/api/tasks/:id`             | Удаление задачи (soft)                                      | Требуется   |
| `POST`   | `/api/tasks/:id/transition`  | Ручной переход стадии                                       | Требуется   |
| `POST`   | `/api/tasks/:id/handoff`     | Передача владения                                           | Требуется   |
| `POST`   | `/api/tasks/:id/comments`    | Создание комментария                                        | Требуется   |
| `POST`   | `/api/tasks/:id/position`    | Изменение позиции (drag-drop)                               | Требуется   |
| `POST`   | `/api/tasks/:id/run-qa`      | Запуск QA                                                   | Требуется   |
| `POST`   | `/api/tasks/:id/plan`        | Обновление плана задачи                                     | Требуется   |
| `GET`    | `/api/tasks/:id/plan`        | Статус файла плана                                          | Опционально |
| `POST`   | `/api/tasks/:id/plan-sync`   | Синхронизация плана из файла                                | Требуется   |
| `POST`   | `/api/tasks/:id/attachments` | Загрузка вложений                                           | Требуется   |

**`POST /api/tasks` → Request:**

```json
{
  "projectId": "uuid",
  "title": "Fix login validation",
  "description": "Add email format validation...",
  "autoMode": true,
  "executionOwner": "ai",
  "assigneeIds": ["uuid"],
  "isFix": false
}
```

**`PATCH /api/tasks/:id` → Request (partial):**

```json
{
  "title": "Updated title",
  "status": "planning",
  "autoMode": true
}
```

**`POST /api/tasks/:id/transition` → Request:**

```json
{
  "action": "advance",
  "reason": "Plan is ready"
}
```

**`POST /api/tasks/:id/handoff` → Request:**

```json
{
  "executionOwner": "human",
  "assigneeIds": ["uuid"]
}
```

### Projects (`/api/projects`)

| Метод    | Путь                                | Описание                   | Auth              |
| -------- | ----------------------------------- | -------------------------- | ----------------- |
| `GET`    | `/api/projects`                     | Список проектов            | Опционально       |
| `POST`   | `/api/projects`                     | Создание проекта           | Требуется         |
| `GET`    | `/api/projects/:id`                 | Детали проекта             | Опционально       |
| `PATCH`  | `/api/projects/:id`                 | Обновление проекта         | Требуется         |
| `DELETE` | `/api/projects/:id`                 | Удаление проекта           | Требуется (admin) |
| `GET`    | `/api/projects/:id/runtime-profile` | Runtime-профиль проекта    | Опционально       |
| `PUT`    | `/api/projects/:id/runtime-profile` | Установка runtime-профиля  | Требуется         |
| `GET`    | `/api/projects/:id/token-summary`   | Статистика токенов проекта | Опционально       |

### Participants (`/api/participants`)

| Метод   | Путь                               | Описание              | Auth              |
| ------- | ---------------------------------- | --------------------- | ----------------- |
| `GET`   | `/api/participants`                | Список участников     | Требуется (admin) |
| `GET`   | `/api/participants/:id`            | Детали участника      | Требуется         |
| `PATCH` | `/api/participants/:id`            | Обновление участника  | Требуется         |
| `POST`  | `/api/participants/:id/deactivate` | Деактивация участника | Требуется (admin) |
| `POST`  | `/api/participants/:id/activate`   | Активация участника   | Требуется (admin) |

### Auth (`/api/auth`)

| Метод  | Путь               | Описание                     | Auth      |
| ------ | ------------------ | ---------------------------- | --------- |
| `POST` | `/api/auth/signup` | Регистрация нового участника | Нет       |
| `POST` | `/api/auth/login`  | Вход в систему               | Нет       |
| `POST` | `/api/auth/logout` | Выход из системы             | Требуется |

**`POST /api/auth/login` → Request:**

```json
{ "username": "admin", "password": "secret" }
```

### Chat (`/api/chat`)

| Метод    | Путь                     | Описание                         | Auth        |
| -------- | ------------------------ | -------------------------------- | ----------- |
| `POST`   | `/api/chat`              | Отправка сообщения AI-ассистенту | Опционально |
| `POST`   | `/api/chat/sessions`     | Создание сессии чата             | Требуется   |
| `GET`    | `/api/chat/sessions`     | Список сессий чата               | Требуется   |
| `DELETE` | `/api/chat/sessions/:id` | Удаление сессии чата             | Требуется   |

### Runtime Profiles (`/api/runtime-profiles`)

| Метод    | Путь                        | Описание                | Auth        |
| -------- | --------------------------- | ----------------------- | ----------- |
| `GET`    | `/api/runtime-profiles`     | Список runtime-профилей | Опционально |
| `POST`   | `/api/runtime-profiles`     | Создание профиля        | Требуется   |
| `PUT`    | `/api/runtime-profiles/:id` | Обновление профиля      | Требуется   |
| `DELETE` | `/api/runtime-profiles/:id` | Удаление профиля        | Требуется   |

### VCS Integration (`/api/github`, `/api/gitlab`)

| Метод  | Путь                              | Описание                    | Auth      |
| ------ | --------------------------------- | --------------------------- | --------- |
| `GET`  | `/api/github/connections`         | Список GitHub-подключений   | Требуется |
| `POST` | `/api/github/connections`         | Создание GitHub-подключения | Требуется |
| `POST` | `/api/github/issues/:number/sync` | Синхронизация Issue         | Требуется |
| `GET`  | `/api/gitlab/connections`         | Список GitLab-подключений   | Требуется |
| `POST` | `/api/gitlab/connections`         | Создание GitLab-подключения | Требуется |
| `POST` | `/api/gitlab/issues/:iid/sync`    | Синхронизация Issue         | Требуется |

### Settings (`/api/settings`)

| Метод   | Путь            | Описание             | Auth              |
| ------- | --------------- | -------------------- | ----------------- |
| `GET`   | `/api/settings` | Настройки приложения | Нет               |
| `PUT`   | `/api/settings` | Обновление настроек  | Требуется (admin) |
| `PATCH` | `/api/settings` | Частичное обновление | Требуется (admin) |

### Codex Auth (`/api/codex-auth`)

| Метод  | Путь                     | Описание            | Auth        |
| ------ | ------------------------ | ------------------- | ----------- |
| `POST` | `/api/codex-auth/login`  | OAuth-логин Codex   | Опционально |
| `GET`  | `/api/codex-auth/status` | Статус Codex-сессии | Опционально |
| `POST` | `/api/codex-auth/logout` | Выход из Codex      | Требуется   |

### Agent Internal

| Метод  | Путь                          | Описание                                       | Auth     |
| ------ | ----------------------------- | ---------------------------------------------- | -------- |
| `POST` | `/api/agent/worktree-cleanup` | Очистка worktree задачи                        | Internal |
| `POST` | `/api/agent/broadcast-task`   | Широковещательная рассылка задачи по WebSocket | Internal |

## Коды ошибок

| HTTP-код | Описание                                      |
| -------- | --------------------------------------------- |
| `200`    | Успех                                         |
| `201`    | Создано                                       |
| `400`    | Некорректный запрос (zod validation error)    |
| `401`    | Не аутентифицирован                           |
| `403`    | Недостаточно прав                             |
| `404`    | Ресурс не найден                              |
| `409`    | Конфликт (например, неверная версия владения) |
| `429`    | Слишком много запросов (rate limit)           |
| `500`    | Внутренняя ошибка сервера                     |

## Сериализация

Все ответы — JSON. Даты в ISO 8601: `2026-09-14T12:00:00.000Z`.
Чувствительные поля (`passwordHash`, `tokenDigest`) не экспортируются.

## Форматы входных данных

Валидация через zod-схемы в `packages/api/src/schemas.ts`:

- `createTaskSchema` — создание задачи
- `updateTaskSchema` — обновление задачи
- `taskEventSchema` — событие перехода
- `createTaskCommentSchema` — комментарий
- `reorderTaskSchema` — изменение позиции
- `broadcastTaskSchema` — внутренняя рассылка
- `handoffTaskSchema` — передача владения

## See Also

- [RuntimeAdapter](../adapter/runtime-adapter.md) — AI-адаптеры и контракт выполнения
- [WebSocket Events](../websocket/events.md) — real-time протокол
- [Data Layer](../data/data-layer.md) — централизованный слой доступа к данным
- [README](../README.md) — реестр контрактов

## Трассируемость

- **HF2** (Единый дашборд изменений)
- **UC-dashboard.\*** (все UC дашборда)
- **UC-auth.\*** (аутентификация)
- **UC-chat.\*** (чат)
- **UC-runtime.\*** (runtime-профили)
- **UC-integration.\*** (VCS-интеграция)
- **UC-handoff.\*** (передача владения)
- **UC-pipeline.manual-override.\*** (ручное управление)
