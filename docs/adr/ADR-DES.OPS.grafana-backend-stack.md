# ADR-DES.OPS.grafana-backend-stack

**Статус:** ПРЕДЛОЖЕНО
**Дата:** 2026-09-18
**Контекст:** После принятия OpenTelemetry как стандарта сбора требуется слой хранения и визуализации. Телеметрия используется в продакшене коммерческого продукта: развёртывание — Docker Compose (`docker-compose.yml`, `docker-compose.production.yml`) с обратной прокси Angie; поддержка air-gapped установок уже отражена в коде (`probeAiFactory` в `packages/agent/src/index.ts` предупреждает о недоступности npm-реестра). Данные телеметрии могут содержать идентификаторы клиентов и пути к репозиториям.

**Требование-источник:** `BR-fact.audit.observability`, `REQ-NFR-ops.observability.audit-trail-completeness`, `docs/telemetry.md`, `ADR-DES.OPS.otel-collector-adoption`, evidence: `docker-compose.yml`, `.docker/`

**Решение:** Self-hosted стек Grafana OSS: **Tempo** (трассировки, OTLP), **Loki** (логи, OTLP-ingestion через `otlphttp` с `allow_structured_metadata: true`), **Prometheus** (метрики), **Grafana** (дашборды и переходы log→trace, metric→trace). Хранилища опубликованы только внутри docker-сети; приложение знает лишь об Collector (`ADR-DES.OPS.otel-collector-adoption`).

Метрики доставляются **pull-ем**: Prometheus скрейпит `prometheus`-экспортёр Collector с `enable_open_metrics: true`, потому что Prometheus' собственный OTLP-приёмник по умолчанию выключен (сервер не аутентифицирует входящие запросы), а exemplars (переход «метрика → трассировка») выгружаются только в OpenMetrics и только для гистограмм и монотонных сумм. Имена метрик транслируются явно (`translation_strategy`), набор promoted-атрибутов совпадает с контрактом `ADR-DES.OPS.telemetry-schema-contract`. Выборка трассируется в Collector (гарантированно сохраняются ошибочные и медленные прогоны).

**Рассмотренные альтернативы:**

- **SaaS (Grafana Cloud, Datadog).** Отвергнуто: вывод идентификаторов клиентов за контур заказчика несовместим с air-gapped и коммерческими ограничениями; стоимость растёт с объёмом.
- **Jaeger вместо Tempo.** Отвергнуто: Tempo нативно читает OTLP и даёт готовые переходы Loki↔Tempo и exemplars из Prometheus без отдельного индексного сервиса.
- **Push в Prometheus OTLP-приёмник.** Отложено: приёмник требует явного включения и сетевого ограничения; pull безопаснее по умолчанию.
- **ELK вместо Loki.** Отвергнуто: Loki индексирует только метки — соответствует корреляционной политике без захвата содержимого (`ADR-DES.PROCESS.correlation-first-async-traces`).

**Последствия:**

- **Положительные:** один open-source вендор для трёх сигналов и готовая межсигнальная корреляция; развёртывание вписывается в существующий Compose-контур; отсутствие лицензионных рисков.
- **Отрицательные:** четыре дополнительных сервиса и их эксплуатация; retention и лимиты требуют настройки — у Loki лимит structured metadata 64 KB / 128 полей на строку, превышение отбрасывается HTTP 400 без повтора; хранение трассировок дорогое на объёме.
- **Смягчение:** memory_limiter и self-observability Collector; transform-процессор переносит `exception.stacktrace` в тело лога до отправки в Loki; retention задаётся в конфигурации хранилищ; `loki_discarded_samples_total` выводится на дашборд; выборка сокращает объём Tempo.
