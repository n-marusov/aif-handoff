# REQ-NFR-ops.observability.otel-export-resilience: Устойчивость экспорта телеметрии

**Приоритет:** P0
**Статус:** proposed
**Класс:** to be
**Источник:** `BR-fact.audit.otel-telemetry-backbone`, `ADR-DES.OPS.otel-collector-adoption`, `ADR-DES.OPS.pino-otel-log-bridge`
**Ключевая функция:** HF10.4, HF10.5
**Домен L1:** ops

## Описание

Отказ или недоступность collector либо любого хранилища не должны влиять на выполнение конвейера задач. Экспорт телеметрии non-throwing: ошибки логируются, очередь ограничена, переполнение сбрасывается с заметным счётчиком; при выключенном сборе noop-реализация не создаёт сетевых запросов. Завершение процесса выполняет flush с ограничением по таймауту.

## Критерии приёмки

| Метрика                    | Целевое значение                                                           | Способ проверки                              |
| -------------------------- | -------------------------------------------------------------------------- | -------------------------------------------- |
| Невлияние на конвейер      | 100% прогонов стадий завершаются штатно при остановленном collector        | Интеграционный тест: collector недоступен    |
| Ограничение памяти         | Размер буфера экспорта не превышает настроенный лимит; переполнение — drop | Нагрузочный тест с заблокированным экспортом |
| Flush при остановке        | Спаны последних прогонов доставлены при штатном SIGTERM (кроме stdio-MCP)  | Тест shutdown-пайплайна                      |
| Чистота stdout (stdio MCP) | Ни байт телеметрии в stdout при `MCP_TRANSPORT=stdio`                      | Регрессионный тест guard                     |

## Связанные требования

- `BR-fact.audit.otel-telemetry-backbone`
- `REQ-FR-audit.telemetry.control-content-capture`
- `REQ-NFR-ops.observability.telemetry-overhead-budget`

## See Also

- [REQ-NFR-ops.observability.telemetry-overhead-budget](REQ-NFR-ops.observability.telemetry-overhead-budget.md)
- [REQ-NFR-api.availability.coordinator-resilience](REQ-NFR-api.availability.coordinator-resilience.md)
- [ADR-DES.OPS.otel-collector-adoption](../adr/ADR-DES.OPS.otel-collector-adoption.md)
