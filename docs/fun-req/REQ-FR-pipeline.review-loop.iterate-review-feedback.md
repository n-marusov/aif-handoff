[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-pipeline.review-loop.iterate-review-feedback: Циклическое авторевью с итерациями доработки

**Приоритет:** P1

**Ключевая функция:** HF5.3 Автоматическое ревью с итерациями

**Источник:** [UC-pipeline.review-loop.iterate-review-feedback](../use-cases/UC-pipeline.review-loop.iterate-review-feedback.md), BR-automation.auto-review, BR-task-lifecycle.skip-review

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (coordinator, subagents)

**Описание:** При обнаружении проблем sidecar-агентом задача возвращается на доработку (implementing → verify/review). Цикл повторяется до прохождения всех гейтов или исчерпания лимита попыток `maxReviewIterations`. При исчерпании попыток задача эскалируется человеку.

**Критерии приёмки:**

1. Sidecar-агент возвращает `fail` с набором finding-ов (`AutoReviewFinding`).
2. Coordinator проверяет `reviewIterationCount < maxReviewIterations`.
3. Coordinator возвращает задачу в `implementing` с `reworkRequested=true`.
4. При повторном запуске implementer получает finding-и и исправляет их.
5. Coordinator повторно запускает verify/review sidecar.
6. Цикл повторяется до прохождения или исчерпания попыток.
7. Если лимит попыток исчерпан (`reviewIterationCount >= maxReviewIterations`):
   - Устанавливается `manualReviewRequired=true`.
   - Задача переводится в `blocked_external` с диагностикой.
   - Ожидает вмешательства человека.
8. На любой итерации sidecar может вернуть `pass`, цикл завершается.
9. При ручном вмешательстве человека `manualReviewRequired` может быть сброшен.

## See Also

- [REQ-FR-pipeline.sidecar.run-read-only-review](REQ-FR-pipeline.sidecar.run-read-only-review.md) — sidecar-агенты
- [REQ-FR-pipeline.escalation.escalate-after-exhausted-retries](REQ-FR-pipeline.escalation.escalate-after-exhausted-retries.md) — эскалация
- [REQ-FR-handoff.escalation.escalate-unresolvable-decision](REQ-FR-handoff.escalation.escalate-unresolvable-decision.md) — эскалация решений
