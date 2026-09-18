# REQ-NFR-ops.observability.telemetry-cardinality-cap: Ограничение кардинальности метрик

**Приоритет:** P1
**Статус:** proposed
**Класс:** to be
**Источник:** `BR-constraint.audit.telemetry-correlation-contract`, `ADR-DES.OPS.telemetry-schema-contract`
**Ключевая функция:** HF10.4
**Домен L1:** ops

## Описание

Метки Prometheus-метрик ограничены конечными измерениями из утверждённого контракта (стадия, источник, runtime, провайдер, модель, категория ошибки и resource-атрибуты). Высококардинальные идентификаторы (`aif.task.id`, `aif.project.id`, идентификаторы чата/сессии) не должны попадать в метки метрик; они допускаются только в атрибутах трассировок и structured metadata логов. Защита двойная: контракт на стороне приложения и cardinality guard в collector.

## Критерии приёмки

| Метрика                     | Целевое значение                                                      | Способ проверки                                       |
| --------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| Состав меток метрик         | только измерения из конечных перечислений контракта                   | CI-тест реестра атрибутов `@aif/telemetry`            |
| High-cardinality в метриках | 0 записей с `aif.task.id`/`aif.project.id` среди label                | аудит экспорта + transform-processor drop в collector |
| Свёртки per-task/project    | остаются в SQLite (`usage_events`), не дублируются метриками          | ревью источников данных дашбордов                     |
| Лимиты Loki                 | structured metadata ≤ 64 KB / 128 полей; overflow не отсекается молча | мониторинг `loki_discarded_samples_total`             |

## Связанные требования

- `BR-constraint.audit.telemetry-correlation-contract`
- `REQ-NFR-ops.observability.telemetry-overhead-budget`
- `REQ-NFR-data.compliance.database-migration-integrity`

## See Also

- [REQ-NFR-ops.observability.otel-export-resilience](REQ-NFR-ops.observability.otel-export-resilience.md)
- [ADR-DES.OPS.telemetry-schema-contract](../adr/ADR-DES.OPS.telemetry-schema-contract.md)
- [ADR-DES.OPS.grafana-backend-stack](../adr/ADR-DES.OPS.grafana-backend-stack.md)
