[← REQ-NFR-ops.observability.error-categorization](REQ-NFR-ops.observability.error-categorization.md) · [Back to README](README.md) · [REQ-NFR-api.compliance.request-validation →](REQ-NFR-api.compliance.request-validation.md)

# REQ-NFR-ops.observability.log-level-config

**Приоритет:** P1
**Статус:** implemented
**Класс:** as is
**Источник:** G2 (диагностика состояния); §2.6 (ограничение — наблюдаемость без внешних систем)
**Ключевая функция:** HF10
**Домен L1:** ops

## Описание

Уровень логирования конфигурируется через переменную окружения и поддерживает стандартные уровни: fatal, error, warn, info, debug, trace. Логи структурированы в формате JSON и содержат идентификатор компонента-источника.

## Критерии приёмки

| Метрика                  | Целевое значение                            | Способ проверки                                 |
| ------------------------ | ------------------------------------------- | ----------------------------------------------- |
| Конфигурируемость уровня | Уровень LOG_LEVEL изменяется без пересборки | Проверка: установка, перезапуск, подтверждение  |
| Поддержка всех уровней   | Все уровни fatal–trace валидны              | Проверка схемы LOG_LEVEL                        |
| Структурированный формат | Логи выводятся в JSON с компонентом         | Проверка: тестовое сообщение содержит component |
| Два канала вывода        | Логи направляются в stdout или stderr       | Проверка: LOG_DESTINATION                       |

## Связанные требования

- `BR-fact.audit.observability`
- `REQ-NFR-ops.observability.error-categorization`
- `REQ-NFR-ops.observability.activity-log-batching`

## See Also

- [REQ-NFR-ops.observability.error-categorization](REQ-NFR-ops.observability.error-categorization.md)
- [REQ-NFR-ops.observability.activity-log-batching](REQ-NFR-ops.observability.activity-log-batching.md)
- [REQ-NFR-ops.observability.heartbeat-detection](REQ-NFR-ops.observability.heartbeat-detection.md)
