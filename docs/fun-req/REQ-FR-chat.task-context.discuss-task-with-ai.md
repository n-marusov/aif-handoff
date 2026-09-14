[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-chat.task-context.discuss-task-with-ai: Диалог с AI в контексте конкретного изменения

**Приоритет:** P1

**Ключевая функция:** HF8.2 Диалог в контексте изменения

**Источник:** [UC-chat.task-context.discuss-task-with-ai](../use-cases/UC-chat.task-context.discuss-task-with-ai.md)

**Статус:** proposed

**Класс:** as is

**Канал:** GUI (ChatPanel + TaskDetail)

**Описание:** Пользователь может задать вопрос AI-ассистенту в контексте конкретной задачи: ассистент видит план задачи, текущий статус, результаты проверок, лог выполнения. Диалог привязан к `taskId` и `sessionId`.

**Критерии приёмки:**

1. Пользователь открывает ChatPanel с активной задачей.
2. Чат-сессия привязывается к `taskId`.
3. Пользователь задаёт вопрос в контексте задачи (план, ревью, статус).
4. API включает контекст задачи (plan, status, findings, activity log) в промпт ассистента.
5. AI-ассистент отвечает, ссылаясь на конкретные артефакты задачи.
6. Ответ сохраняется в `chatMessages` с указанием `sessionId`.

## See Also

- [REQ-FR-chat.project-context.consult-ai-assistant](REQ-FR-chat.project-context.consult-ai-assistant.md) — общий чат
- [REQ-FR-dashboard.detail.display-task-details](REQ-FR-dashboard.detail.display-task-details.md) — детальный просмотр
