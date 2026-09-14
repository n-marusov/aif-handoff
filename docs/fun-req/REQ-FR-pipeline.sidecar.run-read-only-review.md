[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-pipeline.sidecar.run-read-only-review: Sidecar-агенты (read-only) проверки результата

**Приоритет:** P0

**Ключевая функция:** HF5.2 Sidecar-агенты (read-only)

**Источник:** [UC-pipeline.sidecar.review-with-sidecar-agent](../use-cases/UC-pipeline.sidecar.review-with-sidecar-agent.md), BR-trigger.automation.auto-review

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (runtime adapter → AI provider)

**Описание:** Sidecar-агенты (reviewer и verifier) запускаются в read-only режиме: они проверяют результат изменения, но не могут его модифицировать. Каждый sidecar использует изолированный runtime-профиль (lightModel) и действует в рамках своих agent definitions. Sidecar возвращает `pass | fail` Coordinator-у, но не может начать новый run.

**Критерии приёмки:**

1. Coordinator запускает sidecar-агента для соответствующей стадии: `verify` → verify-sidecar, `review` → review-sidecar.
2. Sidecar открывает Git worktree задачи в read-only режиме (не может писать в worktree).
3. Sidecar разрешает runtime-профиль — обычно `lightModel` (легковесная модель для экономии затрат).
4. Загружает agent definition sidecar-агента (`verify-sidecar` или `review-sidecar`).
5. AI-провайдер выполняет проверку: анализ кода, сравнение с планом, поиск дефектов (read-only).
6. Sidecar сохраняет результаты (findings, comments) в `AutoReviewState` / `reviewComments` в БД.
7. Sidecar возвращает `pass | fail` Coordinator-у.
8. Sidecar не может модифицировать worktree или запускать новый run.
9. При ошибке runtime (rate_limit, auth) Coordinator блокирует задачу.
10. При fail Coordinator запускает цикл доработки (review-loop).
11. Sidecar сохраняет массив `AutoReviewFinding` с source (security, style, correctness).

## See Also

- [REQ-FR-pipeline.verification.verify-change-result](REQ-FR-pipeline.verification.verify-change-result.md) — верификация
- [REQ-FR-pipeline.completion.auto-complete-pipeline](REQ-FR-pipeline.completion.auto-complete-pipeline.md) — ревью
- [REQ-FR-pipeline.review-loop.iterate-review-feedback](REQ-FR-pipeline.review-loop.iterate-review-feedback.md) — цикл доработки
