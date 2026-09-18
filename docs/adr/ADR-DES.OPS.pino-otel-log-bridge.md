# ADR-DES.OPS.pino-otel-log-bridge

**Статус:** ПРЕДЛОЖЕНО
**Дата:** 2026-09-18
**Контекст:** `pino` — действующая система журналирования: уровень задаётся `LOG_LEVEL`, назначение потока — `LOG_DESTINATION` (`packages/shared/src/logger.ts`), синхронная запись включена вне production. Есть жёсткое ограничение: в stdio-режиме MCP-сервера `stdout` несёт поток JSON-RPC, поэтому первый импорт `packages/mcp/src/index.ts` (`stdioEnv.js`) принудительно переводит логи в `stderr` до инициализации логгера. Требуется доставка логов в Loki с переходом на трассировку без риска для существующего поведения. SDK логов OTel для JavaScript относится к экспериментальным пакетам (версии `0.x`, `experimental/packages/sdk-logs`), в отличие от стабилизированных трассировок и метрик.

**Требование-источник:** `BR-fact.audit.observability`, `REQ-NFR-ops.observability.log-level-config`, `REQ-NFR-ops.observability.tool-error-readability`, `docs/telemetry.md`, evidence: `packages/shared/src/logger.ts`, `packages/mcp/src/stdioEnv.ts`, `packages/mcp/src/index.ts`, `packages/agent/src/queryAudit.ts` (`redactProviderText`)

**Решение:** `pino` остаётся источником истины и API журналирования приложения. Доставка в Loki решается **аддитивным мостом**: к существующему назначению добавляется второй поток (`pino.multistream`), кодирующий записи в модель данных логов OTel и отправляющий их по OTLP в Collector. Идентификаторы `trace_id`, `span_id`, `trace_flags` добавляются mixin'ом в основном потоке, где доступен контекст OTel; уровни и формат локального вывода не меняются. Допустимы обе реализации второго потока — официальный `pino-opentelemetry-transport` (работает в worker-потоке) или собственный `Writable`-поток поверх OTLP log-экспортёра; критерий выбора — управляемость flush при завершении процесса.

**Рассмотренные альтернативы:**

- **Замена `pino` на OTel Logs API.** Отвергнуто: делает продакшен-логирование зависимым от экспериментального пакета `0.x`; теряются уровни через конфигурацию, child-логгеры, redaction и управление назначением, критичное для stdio MCP.
- **Tail логов из файлов (Promtail/Alloy/`filelog`) без внутрипроцессного моста.** Отвергнуто: `trace_id` всё равно пришлось бы внедрять в приложении (вне процесса активный спан не восстановить); resource-атрибуты собирались бы из метаданных контейнера и расходились бы с контрактом `ADR-DES.OPS.telemetry-schema-contract`; stdio-MCP и локальный `tsx`-запуск остаются без подходящего потока для сбора.
- **Полный захват содержимого логов («для AI»).** Отвергнуто: `ADR-DES.PROCESS.correlation-first-async-traces`.

**Последствия:**

- **Положительные:** существующее поведение логов (уровни, назначение, синхронность, ограничение stdio MCP) полностью сохраняется; при недоступности Loki/Collector записи продолжают попадать в stderr — graceful degradation, а не потеря наблюдаемости; каждая запись получает переход в Tempo.
- **Отрицательные:** двойная сериализация записей; transport-реализация живёт в worker-потоке и не даёт `await` при остановке; крупные атрибуты (stacktrace) упираются в лимиты Loki.
- **Смягчение:** доставка логов опциональна (`AIF_TELEMETRY_LOG_BRIDGE`); transform-процессор Collector переносит `exception.stacktrace` в тело записи; flush при остановке ограничивается таймаутом; `loki_discarded_samples_total` мониторится.
