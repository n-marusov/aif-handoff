[← REQ-NFR-api.compliance.rate-limit-requests](REQ-NFR-api.compliance.rate-limit-requests.md) · [Back to README](README.md) · [REQ-NFR-infra.compliance.worktree-isolation →](REQ-NFR-infra.compliance.worktree-isolation.md)

# REQ-NFR-ops.observability.activity-log-batching

**Приоритет:** P2
**Статус:** implemented
**Класс:** as is
**Источник:** G2 (прозрачность статуса); `BR-fact.audit.observability`
**Ключевая функция:** HF10, HF10.1
**Домен L1:** dashboard

## Описание

Лог активности агентов (activity log) поддерживает пакетную запись для снижения нагрузки на БД. Режим работы (синхронный/пакетный), размер пакета, максимальный возраст пакета и лимит очереди конфигурируются через переменные окружения. Пакетный режим не теряет события при аварийном завершении.

## Критерии приёмки

| Метрика                     | Целевое значение                                              | Способ проверки                    |
| --------------------------- | ------------------------------------------------------------- | ---------------------------------- |
| Режимы пакетной записи      | Поддерживаются все ACTIVITY_LOG_MODES                         | Проверка: допустимые значения mode |
| Размер пакета               | Пакет ACTIVITY_LOG_BATCH_SIZE записей (20 по умолчанию)       | Интеграционный тест                |
| Максимальный возраст пакета | Не более ACTIVITY_LOG_BATCH_MAX_AGE_MS (5000 мс по умолчанию) | Интеграционный тест                |
| Лимит очереди               | Не более ACTIVITY_LOG_QUEUE_LIMIT событий (500 по умолчанию)  | Интеграционный тест                |
| Конфигурируемость           | Все параметры изменяются через переменные окружения           | Проверка                           |

## Связанные требования

- `BR-fact.audit.observability`
- `REQ-NFR-ops.observability.log-level-config`
- `REQ-NFR-ops.observability.audit-trail-completeness`

## See Also

- [REQ-NFR-ops.observability.log-level-config](REQ-NFR-ops.observability.log-level-config.md)
- [REQ-NFR-ops.observability.audit-trail-completeness](REQ-NFR-ops.observability.audit-trail-completeness.md)
- [REQ-NFR-ops.observability.heartbeat-detection](REQ-NFR-ops.observability.heartbeat-detection.md)
