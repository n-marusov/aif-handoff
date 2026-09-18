# ADR-DES.OPS.otel-collector-adoption

**Статус:** ПРЕДЛОЖЕНО
**Дата:** 2026-09-18
**Контекст:** Система состоит из нескольких процессов (`api`, `agent`, `mcp`, `web`), каждый из которых генерирует собственные сигналы: HTTP/WS, выполнение runtime-адаптеров, git/worktree-операции, MCP-вызовы. Сейчас наблюдаемость фрагментирована: pino-логи, `usage_events`, heartbeat — каждый канал сам по себе, сквозной картины по задаче нет. Для продакшена и AI-анализа нужен единый стандарт сбора и единая точка применения политик (redaction, sampling, cardinality) без redeploy приложения.

**Требование-источник:** `BR-fact.audit.observability`, `BR-fact.audit.otel-telemetry-backbone`, `REQ-NFR-ops.observability.otel-export-resilience`, `REQ-NFR-ops.observability.telemetry-overhead-budget`, `REQ-NFR-ops.observability.telemetry-cardinality-cap`, `docs/telemetry.md` (концепция), `.ai-factory/ARCHITECTURE.md`

**Решение:** Открытая спецификация **OpenTelemetry** принимается единым стандартом телеметрии для всех трёх сигналов (трассировки, метрики, логи) всех процессов. Экспорт — только в **OTel Collector** по **OTLP/HTTP protobuf**; Collector — единственная точка нормализации, redaction, cardinality guard и sampling, дальше маршрутизирующая в бэкенды (выбор бэкендов — отдельный ADR). Инициализация SDK и экспорт — в новом пакете `@aif/telemetry`; `@aif/runtime` получает только порт-контракт телеметрии (аналог `RuntimeUsageSink`) без зависимости от OTel SDK. Интеграция в код — ручная instrumentation на существующих швах (Hono middleware, `wrapAdapter`, coordinator-стадии, `@aif/data`, MCP server, git-операции); ESM loader hook для автоинструментации не используется.

**Рассмотренные альтернативы:**

- **Прямые экспорты SDK в каждый бэкенд** — нет единой точки политик; нормализация/redaction требовали бы redeploy приложения. Отвергнуто.
- **`@opentelemetry/auto-instrumentations-node`** — в чистом ESM требует `--experimental-loader` hook, нестабилен под `node --import tsx` (dev) и меняет команду старта в прод-контейнерах. Отвергнуто для MVP; точечная автоинструментация допустима позже.
- **Сбор логов из файлов (tail) без OTLP-сигналов** — трассировки и метрики остаются без standardized-канала; resource-атрибуты и trace context теряются. Отвергнуто.

**Последствия:**

- **Положительные:** вендор-независимость; единый контракт сигналов для operational- и AI-контуров; политики — в конфиге Collector; существующие границы пакетов сохраняются (runtime без OTel-зависимости); stdio-MCP не затрагивается (stdout остаётся только для JSON-RPC).
- **Отрицательные:** новая инфраструктура (Collector); задержка/потери при batch-экспорте; overhead на hot-path.
- **Смягчение:** OTLP-only экспортеры (никогда console); bounded queue, non-throwing контракт (аналог usage sink); awaited flush на graceful shutdown; всё под флагом `AIF_TELEMETRY_ENABLED=false` по умолчанию; метрика self-observability Collector.
