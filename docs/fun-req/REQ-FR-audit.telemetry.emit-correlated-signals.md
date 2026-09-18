[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-audit.telemetry.emit-correlated-signals: Эмиссия коррелированных сигналов телеметрии

**Приоритет:** P1

**Ключевая функция:** HF10.4 Сквозная трасса задачи (предложено)

**Источник:** [UC-audit.telemetry.view-task-telemetry](../use-cases/UC-audit.telemetry.view-task-telemetry.md), HF10.4, `BR-fact.audit.otel-telemetry-backbone`, `BR-constraint.audit.telemetry-correlation-contract`

**Статус:** proposed

**Класс:** to be

**Канал:** Agent / API / MCP / Web (все процессы)

**Описание:** Каждый процесс эмитирует трассировки, метрики и логи по OpenTelemetry с соблюдением корреляционного контракта: resource-атрибуты процесса, доменные идентификаторы в `aif.*`, трасса на прогон стадии (`invoke_workflow {aif.stage}` → `invoke_agent {gen_ai.agent.name}` → `execute_tool {gen_ai.tool.name}` / `chat`), span links между прогонами, перенос `traceparent` через границу поллинга через иммутабельные записи.

**Критерии приёмки:**

1. Все три типа сигналов доставляются по OTLP в collector; при выключенном `AIF_TELEMETRY_ENABLED` используется noop-реализация и сетевых запросов нет.
2. Каждый прогон стадии даёт ровно один корневой спан `invoke_workflow {aif.stage}`; запуски адаптера дают спан `invoke_agent` с `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.*`, `aif.cost.usd`, `error.type`.
3. Все записи прогонов содержат `aif.task.id`, `aif.project.id`, `aif.stage`; значения совпадают со скоупом `usageContext` существующего учёта.
4. Следующий прогон стадии создаёт span link на трассу предыдущего; carrier `traceparent` записан на истории/аудите перехода в той же транзакции (append-only миграция).
5. `gen_ai.conversation.id` — только реальный `sessionId` адаптера; при его отсутствии атрибут не записывается.
6. `@aif/runtime` не содержит зависимости от OTel SDK: порт телеметрии вызывает реестр (`wrapAdapter`), noop обязателен.
7. Высококардинальные значения отсутствуют среди меток Prometheus-метрик.

## See Also

- [REQ-FR-audit.telemetry.bridge-pino-logs](REQ-FR-audit.telemetry.bridge-pino-logs.md) — доставка логов
- [REQ-FR-audit.telemetry.control-content-capture](REQ-FR-audit.telemetry.control-content-capture.md) — флаги содержимого
- [REQ-FR-audit.logging.record-state-transition](REQ-FR-audit.logging.record-state-transition.md) — записи аудита как carrier
