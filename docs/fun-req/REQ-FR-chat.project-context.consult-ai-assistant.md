[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-chat.project-context.consult-ai-assistant: Диалог с AI-ассистентом в контексте проекта

**Приоритет:** P1

**Ключевая функция:** HF8.1 Диалог в контексте проекта

**Источник:** [UC-chat.project-context.consult-ai-assistant](../use-cases/UC-chat.project-context.consult-ai-assistant.md)

**Статус:** proposed

**Класс:** as is

**Канал:** GUI (WebSocket, ChatPanel)

**Описание:** Пользователь открывает чат-панель и общается с AI-ассистентом в контексте проекта. Ассистент имеет доступ к задачам проекта, планам, runtime-профилям, но не может запускать конвейер. Диалог сохраняется в `chatSessions`/`chatMessages`.

**Критерии приёмки:**

1. Пользователь нажимает на ChatBubble в углу экрана — ChatPanel открывается с выбором/созданием сессии.
2. UI отправляет запрос `GET /api/chat/sessions?projectId=X` — список сессий.
3. Пользователь создаёт новую сессию или выбирает существующую.
4. Пользователь вводит сообщение — UI отправляет через WebSocket/API.
5. API разрешает chat runtime profile (`defaultChatRuntimeProfileId`) через `@aif/runtime`.
6. AI-провайдер возвращает потоковый ответ (stream tokens через WS).
7. UI рендерит ответ по мере получения токенов.
8. Сообщения сохраняются в `chatMessages` для истории.
9. Usage (токены, стоимость) учитывается на `chatSessions`.
10. AI может предложить создать задачу (`ChatActionCreateTask`) — пользователь подтверждает.
11. Пользователь может прикреплять файлы к сообщениям через `ChatMessageAttachment`.

## See Also

- [REQ-FR-chat.task-context.discuss-task-with-ai](REQ-FR-chat.task-context.discuss-task-with-ai.md) — чат в контексте задачи
- [REQ-FR-dashboard.realtime.broadcast-live-updates](REQ-FR-dashboard.realtime.broadcast-live-updates.md) — WebSocket
