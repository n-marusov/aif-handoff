[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-pipeline.gate.enforce-stage-transition-gate: Формальные гейты переходов между стадиями

**Приоритет:** P0

**Ключевая функция:** HF5.1 Формальные гейты переходов

**Источник:** [UC-pipeline.gate.enforce-stage-transition-gate](../use-cases/UC-pipeline.gate.enforce-stage-transition-gate.md), BR-task-lifecycle.transitions, BR-automation.runtime-limit-gate

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (coordinator + data layer)

**Описание:** Каждый переход задачи между стадиями защищён формальным гейтом. State machine (`resolveTaskAction`) проверяет, что переход разрешён для текущего статуса, `executionOwner`, `autoMode` и контекста актора. Дополнительно Coordinator проверяет runtime-гейт (лимиты) перед запуском субагента. Оба гейта должны быть пройдены для выполнения stage.

**Критерии приёмки:**

1. Coordinator для каждой задачи-кандидата вызывает `resolveTaskAction` с соответствующим `event`, определяемым стадией.
2. State machine проверяет: статус ∈ `from`, `autoMode`, `executionOwner`, роль актора, назначение.
3. Если переход не разрешён — Coordinator логирует причину (`action_not_allowed`, `actor_not_authorized`, `ai_handoff_required`) и пропускает задачу.
4. Если переход разрешён — Coordinator проверяет runtime-гейт через `blockCandidateIfRuntimeLimited(task)`.
5. `evaluateRuntimeLimitGate` проверяет `RuntimeLimitSnapshot` проекта — если лимит превышен, задача блокируется.
6. Runtime-гейт использует `RuntimeLimitWindow` с source, scope, limit, status, precision.
7. При прохождении обоих гейтов Coordinator запускает stage runner.
8. Stage runner определяет `onSuccess` статус для успешного выполнения.
9. `action_not_allowed` — событие не применимо к текущему статусу (например, `start_ai` из `implementing`).
10. `ai_handoff_required` — действие требует AI-владения, но `executionOwner=human`.
11. `actor_not_authorized` — участник не активен или роль не позволяет.
12. Plan Review Gate проверяет `planReviewState` — если `pending`, задача ожидает утверждения плана человеком.

## See Also

- [REQ-FR-pipeline.stage.auto-advance-after-gate](REQ-FR-pipeline.stage.auto-advance-after-gate.md) — auto-advance
- [REQ-FR-accounting.blocking.block-on-limit-exceeded](REQ-FR-accounting.blocking.block-on-limit-exceeded.md) — runtime-гейт
- [REQ-FR-pipeline.manual-override.intervene-task-stage](REQ-FR-pipeline.manual-override.intervene-task-stage.md) — ручные действия
