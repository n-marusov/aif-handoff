[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-pipeline.stage.auto-advance-after-gate: Автоматическое прохождение стадий конвейера

**Приоритет:** P0

**Ключевая функция:** HF1.1 Автоматическое прохождение стадий, HF5.1 Формальные гейты переходов

**Источник:** [UC-pipeline.stage.auto-advance-task](../use-cases/UC-pipeline.stage.auto-advance-task.md), BR-automation.pipeline, BR-task-lifecycle.stages, BR-task-lifecycle.transitions

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (setInterval + startPollScheduler, `POLL_INTERVAL_MS` env, по умолчанию 30 с)

**Описание:** Coordinator опрашивает БД каждые 30 секунд, выбирает задачи, готовые к переходу на следующую стадию, и запускает соответствующие субагенты. Система автоматически продвигает задачу по стадиям: backlog → planning → improve (опционально) → plan_review → implementing → verify → review → done. Каждый переход защищён формальным гейтом (state machine) и runtime-гейтом (лимиты).

**Критерии приёмки:**

1. Coordinator активируется по сигналу setInterval каждые `POLL_INTERVAL_MS` (по умолчанию 30000 — 30 с, конфигурируется через env) и запускает poll-цикл.
2. Coordinator запрашивает из БД задачи-кандидаты: статус соответствует `from`, `autoMode=true`, `blockedReason=null`, не заблокированы гейтом лимитов.
3. Для каждого кандидата Coordinator выполняет `claimTask` — оптимистичную блокировку (устанавливает `lockedBy=coordinatorId`, `lockedUntil` на stage timeout + 5 мин буфера).
4. Coordinator разрешает Effective Runtime Profile для задачи (слияние профилей: задача → проект → система → окружение).
5. Coordinator запускает субагента, соответствующего стадии: `planning` → `runPlanner`, `improve` → `runImprover`, `plan_review` → `runPlanChecker` / `runPlanReviewPublisher`, `implementing` → `runImplementer`, `verify` → `runVerifier`, `review` → `runReviewer`.
6. При успехе Coordinator применяет переход: `transitionTaskStatus` со статусом `onSuccess`.
7. Coordinator освобождает блокировку (`releaseTaskClaim`).
8. Coordinator отправляет WebSocket-событие `task:moved` или `task:updated` для real-time обновления UI.
9. При ошибке выполнения Coordinator устанавливает `blocked_external` с диагностикой, инкрементирует `retryCount`.
10. `releaseStaleTaskClaims` разблокирует задачи с истёкшим `lockedUntil` и отсутствующим хартбитом.

## See Also

- [REQ-FR-pipeline.gate.enforce-stage-transition-gate](REQ-FR-pipeline.gate.enforce-stage-transition-gate.md) — формальные гейты переходов
- [REQ-FR-pipeline.completion.auto-complete-pipeline](REQ-FR-pipeline.completion.auto-complete-pipeline.md) — завершение конвейера
- [REQ-FR-audit.logging.record-state-transition](REQ-FR-audit.logging.record-state-transition.md) — аудит переходовansition.md) — аудит переходов
