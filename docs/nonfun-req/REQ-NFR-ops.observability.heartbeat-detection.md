[← REQ-NFR-api.availability.runtime-adapter-timeouts](REQ-NFR-api.availability.runtime-adapter-timeouts.md) · [Back to README](README.md) · [REQ-NFR-ops.observability.error-categorization →](REQ-NFR-ops.observability.error-categorization.md)

# REQ-NFR-ops.observability.heartbeat-detection

**Приоритет:** P1
**Статус:** implemented
**Класс:** as is
**Источник:** G1 (бесперебойность конвейера); G2 (прозрачность статуса); `BR-fact.audit.observability`
**Ключевая функция:** HF10, HF10.2
**Домен L1:** pipeline

## Описание

Выполняющиеся агенты периодически отправляют сигналы активности (heartbeat). При отсутствии heartbeat в течение настроенного таймаута задача считается зависшей. После исчерпания попыток восстановления задача переводится в блокированное состояние с эскалацией.

## Критерии приёмки

| Метрика                   | Целевое значение                                                        | Способ проверки                                  |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| Периодичность heartbeat   | Агенты отправляют heartbeat в течение настроенного интервала молчания   | Тест: мониторинг heartbeat при выполнении задачи |
| Stale-детекция            | Задача без heartbeat дольше таймаута распознаётся как stale             | Тест: имитация зависшей задачи                   |
| Эскалация после N попыток | После исчерпания попыток восстановления задача блокируется с эскалацией | Тест: проверка после 3 неудачных попыток         |
| Heartbeat-статус в API    | Heartbeat виден через API задачи (lastHeartbeatAt)                      | Тест: запрос задачи, проверка поля heartbeat     |

## Связанные требования

- `BR-fact.audit.observability`
- `BR-trigger.automation.failure-recovery`
- `REQ-NFR-api.availability.coordinator-resilience`
- `REQ-NFR-api.availability.runtime-adapter-timeouts`
- `REQ-NFR-ops.observability.error-categorization`

## See Also

- [REQ-NFR-api.availability.coordinator-resilience](REQ-NFR-api.availability.coordinator-resilience.md)
- [REQ-NFR-ops.observability.error-categorization](REQ-NFR-ops.observability.error-categorization.md)
- [REQ-NFR-ops.observability.log-level-config](REQ-NFR-ops.observability.log-level-config.md)
