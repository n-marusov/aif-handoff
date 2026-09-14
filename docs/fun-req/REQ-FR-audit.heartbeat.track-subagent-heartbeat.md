[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-audit.heartbeat.track-subagent-heartbeat: Получение хартбитов от выполняющихся агентов

**Приоритет:** P1

**Ключевая функция:** HF10.2 Хартбиты выполнения

**Источник:** [UC-audit.heartbeat.receive-agent-heartbeat](../use-cases/UC-audit.heartbeat.receive-agent-heartbeat.md), BR-audit.observability

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (runtime adapter events)

**Описание:** Во время выполнения runtime-запроса адаптер периодически отправляет хартбиты (сигналы жизни) Coordinator-у через `RuntimeSubagentStartCallback`. Coordinator обновляет `lastHeartbeatAt` на задаче и проверяет, не зависло ли выполнение. Watchdog обнаруживает stale-задачи и блокирует их.

**Критерии приёмки:**

1. Во время выполнения runtime-запроса адаптер отправляет хартбиты через `RuntimeSubagentStartCallback`.
2. Coordinator обновляет `lastHeartbeatAt` и `currentToolJson` (название инструмента, детали, startedAt).
3. WebSocket-событие `task:heartbeat` отправляется в UI для отображения прогресса.
4. `taskWatchdog.ts` периодически проверяет `listStaleInProgressTasks()` — задачи с хартбитом старше `AGENT_STAGE_RUN_TIMEOUT_MS`.
5. При stale-задаче watchdog блокирует её (`blocked_external`, "no heartbeat").
6. Если heartbeat не получен дольше таймаута, `releaseStaleTaskClaims` разблокирует задачу.

## See Also

- [REQ-FR-audit.logging.record-state-transition](REQ-FR-audit.logging.record-state-transition.md) — аудит
- [REQ-FR-dashboard.realtime.broadcast-live-updates](REQ-FR-dashboard.realtime.broadcast-live-updates.md) — WebSocket обновления
- [REQ-FR-pipeline.stage.auto-advance-after-gate](REQ-FR-pipeline.stage.auto-advance-after-gate.md) — poll-цикл
