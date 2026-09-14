[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-pipeline.verification.verify-change-result: Верификация результата изменения

**Приоритет:** P1

**Ключевая функция:** HF1.5 Верификация результата, HF5.4 Независимая верификация

**Источник:** [UC-pipeline.verification.verify-change-result](../use-cases/UC-pipeline.verification.verify-change-result.md), BR-trigger.automation.pipeline

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (runtime adapter → AI provider)

**Описание:** Coordinator запускает верификатора (verify-sidecar) для задачи в статусе `verify`. Верификатор независимо (read-only) проверяет реализованное изменение на соответствие плану, работоспособность и отсутствие регрессий. Результат определяет: переход в `review` (pass) или возврат в `implementing` (fail).

**Критерии приёмки:**

1. Coordinator выбирает задачу в статусе `verify` и захватывает блокировку.
2. Coordinator запускает `runVerifier` — read-only sidecar-агент.
3. Верификатор открывает Git worktree задачи в read-only режиме.
4. Загружает agent definition `verify-sidecar`.
5. AI-провайдер выполняет проверку: сравнивает реализацию с планом, проверяет синтаксис, структуру, запускает тесты.
6. При успехе Coordinator переводит задачу в `review`.
7. При неудаче Coordinator возвращает задачу в `implementing` с `reworkRequested=true`.
8. Если `runPostVerify=false`, задача переходит из `implementing` напрямую в `review` минуя верификацию.
9. При превышении `maxReviewIterations` Coordinator эскалирует задачу.

## See Also

- [REQ-FR-pipeline.review-loop.iterate-review-feedback](REQ-FR-pipeline.review-loop.iterate-review-feedback.md) — цикл ревью
- [REQ-FR-pipeline.sidecar.run-read-only-review](REQ-FR-pipeline.sidecar.run-read-only-review.md) — sidecar-агенты
- [REQ-FR-pipeline.escalation.escalate-after-exhausted-retries](REQ-FR-pipeline.escalation.escalate-after-exhausted-retries.md) — эскалация
