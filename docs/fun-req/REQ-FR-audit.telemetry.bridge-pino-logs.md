[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-audit.telemetry.bridge-pino-logs: Мост доставки логов pino в OTLP

**Приоритет:** P2

**Ключевая функция:** HF10.4 Сквозная трасса задачи (предложено)

**Источник:** [UC-audit.telemetry.view-task-telemetry](../use-cases/UC-audit.telemetry.view-task-telemetry.md), HF10.4, `BR-fact.audit.otel-telemetry-backbone`

**Статус:** proposed

**Класс:** to be

**Канал:** Config (env) / Agent / API

**Описание:** Логи приложения остаются в `pino`; при включённом `AIF_TELEMETRY_LOG_BRIDGE` к существующему назначению добавляется второй поток, кодирующий записи в модель логов OTel и отправляющий их в collector. В каждую запись основной поток добавляет `trace_id`/`span_id` активного контекста через mixin.

**Критерии приёмки:**

1. Локальное поведение не меняется: `LOG_LEVEL`, `LOG_DESTINATION` и синхронность записи продолжают работать как до включения моста.
2. При активном мосте каждая запись доставляется в Loki с `trace_id`/`span_id`/`trace_flags`, обеспечивающими переход log→trace в Grafana.
3. В stdio-режиме MCP в stdout не попадает ни байт телеметрии — OTLP-экспорт идёт через HTTP.
4. Сбой collector или Loki не приводит к потере локального вывода и не прерывает выполнение.
5. Крупные атрибуты (stacktrace) не превышают лимиты structured metadata — перенос в тело записи выполняет collector.

## See Also

- [REQ-FR-audit.telemetry.emit-correlated-signals](REQ-FR-audit.telemetry.emit-correlated-signals.md) — контракт сигналов
- [REQ-FR-audit.telemetry.control-content-capture](REQ-FR-audit.telemetry.control-content-capture.md) — управление захватом
- [ADR-DES.OPS.pino-otel-log-bridge](../adr/ADR-DES.OPS.pino-otel-log-bridge.md) — решение по мосту
