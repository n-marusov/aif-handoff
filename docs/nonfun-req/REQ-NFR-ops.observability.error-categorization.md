[← REQ-NFR-ops.observability.heartbeat-detection](REQ-NFR-ops.observability.heartbeat-detection.md) · [Back to README](README.md) · [REQ-NFR-ops.observability.log-level-config →](REQ-NFR-ops.observability.log-level-config.md)

# REQ-NFR-ops.observability.error-categorization

**Приоритет:** P1
**Статус:** implemented
**Класс:** as is
**Источник:** G2 (диагностика состояния); `BR-fact.audit.observability`
**Ключевая функция:** HF10, HF10.3
**Домен L1:** runtime

## Описание

Все ошибки выполнения runtime-адаптеров классифицируются по структурированным категориям: rate_limit, auth, timeout, permission, stream, transport, model_not_found, context_length, content_filter, unknown. Категория устанавливается адаптером на основе HTTP-статуса и кода ошибки провайдера. Потребители ошибок ветвят логику по категории, а не по тексту сообщения.

## Критерии приёмки

| Метрика                      | Целевое значение                                                    | Способ проверки                            |
| ---------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| Полнота категорий            | Все перечисленные категории поддерживаются                          | Проверка перечисления RuntimeErrorCategory |
| Отсутствие string matching   | Ни один потребитель не использует includes()/regex на error.message | Ревью кода                                 |
| HTTP-статус в метаданных     | Каждая ошибка runtime содержит httpStatus                           | Проверка ошибок от каждого адаптера        |
| Код адаптера                 | Каждая ошибка содержит adapterCode от провайдера                    | Проверка ошибок от каждого адаптера        |
| Структурированные метаданные | Rate_limit содержит resetAt, retryAfterMs, limitSnapshot            | Интеграционный тест                        |

## Связанные требования

- `BR-fact.audit.observability`
- `BR-trigger.automation.failure-recovery`
- `REQ-NFR-api.availability.runtime-adapter-timeouts`
- `REQ-NFR-api.availability.websocket-reconnect`
- `REQ-NFR-ops.observability.heartbeat-detection`

## See Also

- [REQ-NFR-api.availability.runtime-adapter-timeouts](REQ-NFR-api.availability.runtime-adapter-timeouts.md)
- [REQ-NFR-ops.observability.heartbeat-detection](REQ-NFR-ops.observability.heartbeat-detection.md)
- [REQ-NFR-ops.observability.log-level-config](REQ-NFR-ops.observability.log-level-config.md)
