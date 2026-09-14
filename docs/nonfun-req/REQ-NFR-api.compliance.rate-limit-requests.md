[← REQ-NFR-data.compliance.database-migration-integrity](REQ-NFR-data.compliance.database-migration-integrity.md) · [Back to README](README.md) · [REQ-NFR-ops.observability.activity-log-batching →](REQ-NFR-ops.observability.activity-log-batching.md)

# REQ-NFR-api.compliance.rate-limit-requests

**Приоритет:** P2
**Статус:** proposed
**Класс:** to be (Фаза 3 — production readiness)
**Источник:** G2 (доступность API); P7 (непредсказуемые затраты); §2.5 (Фаза 3 — нагрузочные тесты)
**Ключевая функция:** HF3, HF6
**Домен L1:** api

## Описание

HTTP API защищён от чрезмерной частоты запросов со стороны одного клиента. При превышении лимита сервер возвращает 429 Too Many Requests. Rate-limit настраивается на уровне маршрута или глобально. Разные классы запросов (чтение, запись, аутентификация) могут иметь разные лимиты.

## Критерии приёмки

| Метрика                   | Целевое значение                             | Способ проверки                    |
| ------------------------- | -------------------------------------------- | ---------------------------------- |
| Ответ 429 при превышении  | После N запросов за окно возвращается 429    | Нагрузочный тест                   |
| Retry-After header        | 429 содержит заголовок Retry-After           | Проверка: заголовок присутствует   |
| Разные лимиты для мутаций | POST/PUT имеют более строгий лимит, чем GET  | Нагрузочный тест                   |
| Конфигурируемость         | Лимиты изменяются через переменные окружения | Проверка: установка, подтверждение |

## Связанные требования

- `BR-constraint.auth.sessions`
- `REQ-NFR-security.compliance.login-rate-limit`
- `REQ-NFR-api.compliance.request-validation`
- `REQ-NFR-infra.performance.concurrency-limits`

## See Also

- [REQ-NFR-security.compliance.login-rate-limit](REQ-NFR-security.compliance.login-rate-limit.md)
- [REQ-NFR-api.compliance.request-validation](REQ-NFR-api.compliance.request-validation.md)
- [REQ-NFR-infra.performance.concurrency-limits](REQ-NFR-infra.performance.concurrency-limits.md)
