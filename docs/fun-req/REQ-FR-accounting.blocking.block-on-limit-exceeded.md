[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-accounting.blocking.block-on-limit-exceeded: Блокировка задачи при превышении лимита

**Приоритет:** P1

**Ключевая функция:** HF6.3 Блокировка при превышении

**Источник:** [UC-accounting.blocking.block-on-limit-exceeded](../use-cases/UC-accounting.blocking.block-on-limit-exceeded.md), BR-trigger.automation.runtime-limit-gate

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (coordinator, data layer)

**Описание:** Перед запуском stage runner Coordinator проверяет runtime-гейт через `evaluateRuntimeLimitGate`. Если лимит проекта превышен, задача блокируется (`blocked_external`) с указанием причины, snapshot-ом лимитов и временем retry-окна. При превышении coordinator инкрементирует `retryCount`.

**Критерии приёмки:**

1. Coordinator вызывает `blockCandidateIfRuntimeLimited(task)` перед запуском stage.
2. `evaluateRuntimeLimitGate` проверяет `RuntimeLimitSnapshot` проекта и runtime-профиля.
3. Если любое окно лимита превышено (source=BLOCKED), задача блокируется:
   - `status` → `blocked_external`
   - `blockedFromStatus` → текущий статус задачи
   - `retryAfter` → время сброса окна
   - Сохраняется `runtimeLimitSnapshot` с деталями
4. Coordinator отправляет WS-событие `project:runtime_limit_updated`.
5. Coordinator инкрементирует `retryCount`.
6. `resolveRuntimeGateRetryAfter` вычисляет `retryAfter` на основе окон лимита или политики провайдера.
7. Если лимит близок к исчерпанию (WARNING), задача не блокируется, но в лог пишется предупреждение.
8. При HTTP 429 (rate limit) адаптер парсит заголовки `Retry-After` и передаёт через `RuntimeLimitEventPayload`.

## See Also

- [REQ-FR-accounting.limits.configure-project-limits](REQ-FR-accounting.limits.configure-project-limits.md) — лимиты проекта
- [REQ-FR-pipeline.gate.enforce-stage-transition-gate](REQ-FR-pipeline.gate.enforce-stage-transition-gate.md) — формальные гейты
- [REQ-FR-accounting.tracking.record-runtime-call](REQ-FR-accounting.tracking.record-runtime-call.md) — учёт вызовов
