[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-accounting.tracking.record-runtime-call: Учёт каждого вызова runtime

**Приоритет:** P0

**Ключевая функция:** HF6.1 Учёт каждого вызова runtime

**Источник:** [UC-accounting.tracking.record-runtime-call](../use-cases/UC-accounting.tracking.record-runtime-call.md), BR-automation.runtime-limit-gate

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (usage sink) / API

**Описание:** Каждый вызов runtime-адаптера фиксируется в `UsageEvent` через `RuntimeUsageSink`: источник (`UsageSource`), runtimeId, providerId, transport, workflowKind, количество токенов (input, output), стоимость в USD. Данные персистентно хранятся в таблице `usageEvents` и аггрегируются на уровне задачи, проекта и чат-сессии.

**Критерии приёмки:**

1. При выполнении runtime-запроса `RegistryAdapter.run` вызывает `usageSink.record(usageEvent)` с не-null `usage`.
2. `createDbUsageSink` создаёт запись в `usageEvents` с метаданными: source, runtimeId, providerId, projectId, taskId/chatSessionId.
3. Синк инкрементирует счётчики токенов и стоимости на задаче (`incrementTaskTokenUsage`).
4. Синк инкрементирует счётчики на проекте (`incrementProjectTokenUsage`).
5. Coordinator отправляет WS-событие `task:usage_updated` с обновлёнными значениями.
6. UI отображает usage в RuntimeUsageDialog.
7. Для чат-сессий usage записывается на `chatSessions` через `incrementChatSessionTokenUsage`.
8. Для Codex адаптера usage может собираться из файлов (`readCodexSessionLimitSnapshotsFromAppend`).
9. `record()` должен быть синхронным и non-throwing — ошибки логируются внутри имплементации.

## See Also

- [REQ-FR-accounting.limits.configure-project-limits](REQ-FR-accounting.limits.configure-project-limits.md) — лимиты проекта
- [REQ-FR-accounting.blocking.block-on-limit-exceeded](REQ-FR-accounting.blocking.block-on-limit-exceeded.md) — блокировка
- [REQ-FR-pipeline.gate.enforce-stage-transition-gate](REQ-FR-pipeline.gate.enforce-stage-transition-gate.md) — runtime-гейт
