[← REQ-NFR-integration.compliance.review-event-idempotency](REQ-NFR-integration.compliance.review-event-idempotency.md) · [Back to README](README.md) · [REQ-NFR-infra.performance.concurrency-limits →](REQ-NFR-infra.performance.concurrency-limits.md)

# REQ-NFR-integration.availability.runtime-provider-fallback

**Приоритет:** P2
**Статус:** implemented
**Класс:** as is
**Источник:** G7 (провайдер-независимость); P8 (vendor lock-in, единая точка отказа); A1 (доступность AI-провайдеров)
**Ключевая функция:** HF3, HF3.1
**Домен L1:** runtime

## Описание

Система поддерживает несколько runtime-адаптеров одновременно. При недоступности одного провайдера (timeout, auth error, rate-limit) coordinator не блокируется — задача переводится в blocked_external с эскалацией. При настроенном runtime-профиле с резервным адаптером система может переключиться на альтернативного провайдера.

## Критерии приёмки

| Метрика                   | Целевое значение                                             | Способ проверки                                           |
| ------------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| Обнаружение недоступности | Недоступность провайдера детектируется через таймаут/ошибку  | Тест: имитация отказа провайдера                          |
| Блокировка задачи         | При недоступности задача блокируется, а не зависает          | Тест: отказ провайдера, проверка статуса задачи           |
| Наличие альтернатив       | Не менее 2 различных адаптеров зарегистрированы одновременно | Интеграционный тест: проверка registry                    |
| Resilience runtime        | Runtime error не приводит к падению coordinator              | Тест: все runtime ошибки обрабатываются категоризированно |

## Связанные требования

- `BR-trigger.automation.failure-recovery`
- `BR-trigger.task-lifecycle.blocked`
- `REQ-NFR-api.availability.runtime-adapter-timeouts`
- `REQ-NFR-api.availability.coordinator-resilience`
- `REQ-NFR-ops.observability.error-categorization`

## See Also

- [REQ-NFR-api.availability.runtime-adapter-timeouts](REQ-NFR-api.availability.runtime-adapter-timeouts.md)
- [REQ-NFR-api.availability.coordinator-resilience](REQ-NFR-api.availability.coordinator-resilience.md)
- [REQ-NFR-ops.observability.error-categorization](REQ-NFR-ops.observability.error-categorization.md)
