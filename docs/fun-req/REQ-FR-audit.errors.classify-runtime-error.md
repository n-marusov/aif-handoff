[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-audit.errors.classify-runtime-error: Категоризация ошибок выполнения runtime

**Приоритет:** P1

**Ключевая функция:** HF10.3 Категоризация ошибок

**Источник:** [UC-audit.errors.classify-runtime-error](../use-cases/UC-audit.errors.classify-runtime-error.md), BR-audit.observability

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (error handling pipeline)

**Описание:** При сбое выполнения runtime-запроса ErrorClassifier категоризирует ошибку по `RuntimeErrorCategory`: rate_limit, auth, timeout, permission, stream, transport, model_not_found, context_length, content_filter, unknown. Категория определяет стратегию retry (retriable/non-retriable) и логику блокировки.

**Критерии приёмки:**

1. Runtime-адаптер возвращает ошибку с HTTP-статусом, adapter code и message.
2. ErrorClassifier применяет классификацию в `classifyStageError`:
   - `classifyByHttpStatus(status)` — точное совпадение по статусу.
   - `classifyByMessageFallback(message)` — pattern matching на тексте сообщения (fallback).
3. Результат — `RuntimeErrorCategory`: retriable с backoff (rate_limit, timeout, permission, stream, transport) или non-retriable требующий ручного действия (auth, model_not_found, context_length, content_filter).
4. Coordinator выбирает стратегию:
   - Retriable: задача перезапускается с задержкой (`retryAfter`).
   - Non-retriable: задача блокируется с диагностикой (`blocked_external`).
5. `RuntimeExecutionError` содержит `category`, `adapterCode`, `httpStatus`, `retryAfterMs`, `limitSnapshot`.
6. Consumer никогда не парсит `message` для классификации — использует structured поля.
7. Provider-specific codes передаются через `adapterCode` (e.g., `rate_limit_exceeded`, `context_length_exceeded`).

## See Also

- [REQ-FR-accounting.blocking.block-on-limit-exceeded](REQ-FR-accounting.blocking.block-on-limit-exceeded.md) — блокировка лимитов
- [REQ-FR-pipeline.stage.auto-advance-after-gate](REQ-FR-pipeline.stage.auto-advance-after-gate.md) — обработка ошибок в poll-цикле
- [REQ-FR-pipeline.escalation.escalate-after-exhausted-retries](REQ-FR-pipeline.escalation.escalate-after-exhausted-retries.md) — эскалация
