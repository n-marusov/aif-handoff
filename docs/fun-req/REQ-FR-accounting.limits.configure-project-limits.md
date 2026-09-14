[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-accounting.limits.configure-project-limits: Конфигурация лимитов использования на уровне проекта

**Приоритет:** P1

**Ключевая функция:** HF6.2 Лимиты на уровне проекта

**Источник:** [UC-accounting.limits.configure-project-limits](../use-cases/UC-accounting.limits.configure-project-limits.md), BR-trigger.automation.runtime-limit-gate

**Статус:** proposed

**Класс:** as is

**Канал:** GUI (RuntimeUsageDialog) / API

**Описание:** Администратор настраивает лимиты для проекта: максимальный бюджет (USD), лимиты токенов (input/output), временные окна. Лимиты применяются в runtime-гейте (`evaluateRuntimeLimitGate`) перед выполнением каждой стадии конвейера.

**Критерии приёмки:**

1. Пользователь с ролью `admin` открывает RuntimeUsageDialog.
2. UI показывает текущие лимиты проекта: `plannerMaxBudgetUsd`, `implementerMaxBudgetUsd`, `reviewSidecarMaxBudgetUsd`, `planCheckerMaxBudgetUsd`.
3. UI показывает агрегированное использование (токены, стоимость) по профилям.
4. Администратор настраивает лимиты и окна сброса (`retryAfter`).
5. Лимиты сохраняются в проекте через `PUT /api/projects/:id`.
6. Лимиты применяются в `evaluateRuntimeLimitGate` при запуске stage.
7. Snapshots лимитов могут быть получены от провайдера (rate limits, spending limits) через runtime-адаптеры.
8. Precision лимитов: `EXACT` (точные данные от провайдера) или `HEURISTIC` (вычисленные).

## See Also

- [REQ-FR-accounting.tracking.record-runtime-call](REQ-FR-accounting.tracking.record-runtime-call.md) — учёт вызовов
- [REQ-FR-accounting.blocking.block-on-limit-exceeded](REQ-FR-accounting.blocking.block-on-limit-exceeded.md) — блокировка
- [REQ-FR-runtime.profile.configure-project-runtime](REQ-FR-runtime.profile.configure-project-runtime.md) — профили runtime
