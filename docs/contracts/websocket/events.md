[← README](../README.md)

# WebSocket Events

> Источник правды: `packages/api/src/ws.ts`, `packages/shared/src/types.ts` (WsEvent, WsEventType)
> Версия: 1.0.0
> Статус: `implemented`

## Базовая информация

- **Endpoint:** `ws://<host>:3009/ws`
- **Protocol:** WebSocket (RFC 6455)
- **Library:** `ws`
- **Auth:** Session cookie (при `PARTICIPANTS_MODE_ENABLED=true`)
- **Формат сообщений:** JSON

## Аутентификация

При `PARTICIPANTS_MODE_ENABLED=true` WebSocket-соединение проходит аутентификацию через session cookie:

1. Проверяется `Origin` заголовок (CSRF)
2. Извлекается session token из cookie (`PARTICIPANT_SESSION_COOKIE_NAME`)
3. Сессия верифицируется через `resolveParticipantSession()`
4. При успехе — соединение авторизовано с `WebSocketIdentity`
5. При неудаче — HTTP-ответ 401/403 до upgrade

```
WebSocketIdentity {
  participantId: string | null;
  sessionId: string | null;
  expiresAt: string | null;
}
```

## Жизненный цикл соединения

1. **connect** — сервер создаёт `clientId` (UUID), добавляет в пул, шлёт `ws:connected`
2. **message** — все входящие сообщения от клиента логируются (на данный момент не обрабатываются)
3. **disconnect** — клиент удаляется из пула, логируется
4. **error** — ошибка логируется, соединение закрывается
5. **cleanup** — каждые 30 секунд невалидные сессии (expired) отключаются принудительно

## Событие подключения

При успешном подключении сервер отправляет клиенту:

```json
{
  "type": "ws:connected",
  "payload": {
    "clientId": "uuid",
    "participantId": "uuid | null"
  }
}
```

`clientId` используется для целевой отправки событий конкретному клиенту.

## Типы событий (WsEventType)

Все события broadcast всем подключённым клиентам, кроме специальных случаев.

### Проекты

| Тип                               | Payload                        | Описание                      |
| --------------------------------- | ------------------------------ | ----------------------------- |
| `project:created`                 | `Project`                      | Создан новый проект           |
| `project:organization_updated`    | `Project`                      | Обновлена организация проекта |
| `project:auto_queue_mode_changed` | `Project`                      | Изменён режим auto-queue      |
| `project:auto_queue_advanced`     | `Project`                      | Auto-queue продвинул задачу   |
| `project:runtime_limit_updated`   | `RuntimeLimitBroadcastPayload` | Обновлён лимит runtime        |
| `project:warmup_updated`          | `WarmupBroadcastPayload`       | Обновлён статус warmup        |

### Участники

| Тип                       | Payload                            | Описание                                      |
| ------------------------- | ---------------------------------- | --------------------------------------------- |
| `participant:created`     | `ParticipantBroadcastPayload`      | Создан участник                               |
| `participant:updated`     | `ParticipantBroadcastPayload`      | Обновлён участник                             |
| `participant:deactivated` | `ParticipantBroadcastPayload`      | Деактивирован участник                        |
| `auth:session_revoked`    | `ParticipantSessionRevokedPayload` | Сессия отозвана (disconnect целевого клиента) |

### Задачи

| Тип                       | Payload                         | Описание                         |
| ------------------------- | ------------------------------- | -------------------------------- |
| `task:created`            | `Task`                          | Создана задача                   |
| `task:updated`            | `Task`                          | Обновлена задача                 |
| `task:deleted`            | `Task`                          | Задача удалена                   |
| `task:moved`              | `Task`                          | Задача перемещена (drag-drop)    |
| `task:assignment_updated` | `Task`                          | Обновлены назначения             |
| `task:handoff`            | `TaskOwnershipBroadcastPayload` | Передача владения                |
| `task:comment_created`    | `TaskCommentBroadcastPayload`   | Создан комментарий               |
| `task:activity`           | `Task`                          | Активность по задаче             |
| `task:scheduled_fired`    | `Task`                          | Сработал запланированный триггер |
| `task:commit_started`     | `TaskCommitPayload`             | Запущен авто-коммит              |
| `task:commit_done`        | `TaskCommitPayload`             | Авто-коммит завершён             |
| `task:commit_failed`      | `TaskCommitPayload`             | Авто-коммит не удался            |
| `task:qa_started`         | `TaskQaPayload`                 | Запущен QA                       |
| `task:qa_done`            | `TaskQaPayload`                 | QA завершён                      |
| `task:qa_failed`          | `TaskQaPayload`                 | QA не удался                     |
| `task:heartbeat`          | `TaskHeartbeatPayload`          | Heartbeat выполнения             |
| `task:usage_updated`      | `TaskUsagePayload`              | Обновлён учёт использования      |

### Agent

| Тип          | Payload          | Описание                                         |
| ------------ | ---------------- | ------------------------------------------------ |
| `agent:wake` | `{ id: string }` | Пробуждение координатора (форсированный polling) |

### Roadmap

| Тип                | Payload                  | Описание                    |
| ------------------ | ------------------------ | --------------------------- |
| `roadmap:complete` | `RoadmapCompletePayload` | Генерация roadmap завершена |
| `roadmap:error`    | `RoadmapErrorPayload`    | Ошибка генерации roadmap    |

### Chat

| Тип                    | Payload                  | Описание             |
| ---------------------- | ------------------------ | -------------------- |
| `chat:token`           | `ChatStreamTokenPayload` | Токен стриминга чата |
| `chat:done`            | `ChatDonePayload`        | Ответ чата завершён  |
| `chat:error`           | `ChatErrorPayload`       | Ошибка чата          |
| `chat:session_created` | `ChatSession`            | Создана сессия чата  |
| `chat:session_deleted` | `ChatSession`            | Удалена сессия чата  |

### Sync (MCP Handoff ↔ AIF)

| Тип                   | Payload | Описание                                 |
| --------------------- | ------- | ---------------------------------------- |
| `sync:task_created`   | `Task`  | Задача создана через MCP-синхронизацию   |
| `sync:task_updated`   | `Task`  | Задача обновлена через MCP-синхронизацию |
| `sync:status_changed` | `Task`  | Статус изменён через MCP-синхронизацию   |
| `sync:plan_pushed`    | `Task`  | План отправлен через MCP-синхронизацию   |

## Механизм отправки

Все события отправляются через `broadcast(event: WsEvent)`:

```typescript
function broadcast(event: WsEvent): void;
```

Исключение — событие `auth:session_revoked` отправляется только конкретному участнику
(все его WebSocket-соединения).

Целевая отправка конкретному клиенту (по `clientId`):

```typescript
function sendToClient(clientId: string, event: WsEvent): boolean;
```

## Формат сообщения

```json
{
  "type": "task:updated",
  "payload": {
    /* зависит от типа */
  }
}
```

## Управление соединениями

| Функция                                          | Описание                                   |
| ------------------------------------------------ | ------------------------------------------ |
| `broadcast(event)`                               | Отправить всем подключённым клиентам       |
| `sendToClient(clientId, event)`                  | Отправить конкретному клиенту              |
| `getConnectedWebSocketClientCount()`             | Количество активных соединений             |
| `disconnectParticipantWebSockets(participantId)` | Отключить все сессии участника             |
| `closeAllWebSocketClients()`                     | Закрыть все соединения (graceful shutdown) |

## Очистка невалидных сессий

Каждые 30 секунд выполняется `disconnectInvalidWebSocketSessions()`:

- Проверяется `expiresAt` каждой сессии
- Если сессия истекла — WebSocket принудительно закрывается
- Если `isParticipantSessionActive()` возвращает false — соединение закрывается

## See Also

- [REST API](../rest/aif-api.md) — HTTP-эндпоинты системы
- [RuntimeAdapter](../adapter/runtime-adapter.md) — AI-адаптеры и контракт выполнения
- [Data Layer](../data/data-layer.md) — централизованный слой доступа к данным
- [README](../README.md) — реестр контрактов

## Трассируемость

- **HF2.4** (Обновления в реальном времени)
- **UC-dashboard.realtime.receive-live-status-updates**
- **UC-pipeline.completion.auto-complete-pipeline** (broadcast переходов)
