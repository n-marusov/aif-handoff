[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-dashboard.gate-status.display-gate-results: Отображение статуса формальных гейтов

**Приоритет:** P1

**Ключевая функция:** HF2.2 Статус формальных гейтов

**Источник:** [UC-dashboard.gate-status.view-gate-results](../use-cases/UC-dashboard.gate-status.view-gate-results.md), BR-audit.observability

**Статус:** proposed

**Класс:** as is

**Канал:** GUI (React SPA)

**Описание:** Пользователь видит на карточке задачи и в детальном просмотре, какие гейты пройдены и какие блокируют задачу. Статус гейтов включает: runtime-гейт (лимиты), гейт плана, гейт ревью, гейт верификации.

**Критерии приёмки:**

1. Пользователь открывает детальный просмотр задачи.
2. API возвращает задачу с метаданными гейтов: `blockedReason`, `blockedFromStatus`, `runtimeLimitSnapshot`, `autoReviewState`, `manualReviewRequired`, `retryCount`, `reviewIterationCount`.
3. UI отображает статус каждого гейта цветовым индикатором (✓ пройден, ⚠️ предупреждение, ✗ заблокирован).
4. При блокировке гейта UI показывает причину и рекомендацию.
5. `autoReviewState` отображает: strategy, iteration count, findings count.

## See Also

- [REQ-FR-pipeline.gate.enforce-stage-transition-gate](REQ-FR-pipeline.gate.enforce-stage-transition-gate.md) — формальные гейты
- [REQ-FR-dashboard.detail.display-task-details](REQ-FR-dashboard.detail.display-task-details.md) — детальный просмотр
- [REQ-FR-dashboard.board.render-kanban-columns](REQ-FR-dashboard.board.render-kanban-columns.md) — Kanban-доска
