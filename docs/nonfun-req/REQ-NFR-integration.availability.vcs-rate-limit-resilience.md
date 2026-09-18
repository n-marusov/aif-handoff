[← REQ-NFR-security.compliance.login-rate-limit](REQ-NFR-security.compliance.login-rate-limit.md) · [Back to README](README.md) · [REQ-NFR-integration.compliance.review-event-idempotency →](REQ-NFR-integration.compliance.review-event-idempotency.md)

# REQ-NFR-integration.availability.vcs-rate-limit-resilience

**Приоритет:** P2
**Статус:** implemented
**Класс:** as is
**Источник:** G4 (автоматизация VCS — бесперебойность); P5 (ручное управление git-ветками); A1 (доступность провайдера)
**Ключевая функция:** HF11, HF11.2
**Домен L1:** integration

## Описание

При превышении rate-limit API GitHub/GitLab (HTTP 429/403) coordinator не «зависает» и не теряет контекст задачи. После получения rate-limit ошибки система ожидает окно восстановления (resetAt) и возвращается в нормальный polling-цикл. Задача переводится в blocked_external с сохранением исходной стадии и retryAfter.

## Критерии приёмки

| Метрика              | Целевое значение                                                             | Способ проверки                                          |
| -------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| Обработка 429        | При HTTP 429 задача переходит в blocked_external без потери стадии           | Интеграционный тест с имитацией ответа 429               |
| Ожидание resetAt     | Coordinator ожидает resetAt перед повтором                                   | Тест: имитация rate-limit с resetAt, проверка retryAfter |
| Отсутствие зависания | Coordinator не блокируется на rate-limit: переход к следующему циклу polling | Тест: множество rate-limit, проверка продолжения цикла   |
| Логирование          | Rate-limit ошибки логируются с категорией rate_limit                         | Проверка лога                                            |

## Связанные требования

- `BR-trigger.automation.failure-recovery`
- `BR-trigger.task-lifecycle.blocked`
- `REQ-NFR-api.availability.coordinator-resilience`
- `REQ-NFR-ops.observability.error-categorization`

## See Also

- [REQ-NFR-api.availability.coordinator-resilience](REQ-NFR-api.availability.coordinator-resilience.md)
- [REQ-NFR-integration.availability.runtime-provider-fallback](REQ-NFR-integration.availability.runtime-provider-fallback.md)
- [REQ-NFR-ops.observability.error-categorization](REQ-NFR-ops.observability.error-categorization.md)
