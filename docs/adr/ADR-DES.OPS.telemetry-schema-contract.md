# ADR-DES.OPS.telemetry-schema-contract

**Статус:** ПРЕДЛОЖЕНО
**Дата:** 2026-09-18
**Контекст:** Сигналы поступают из пяти источников (`web`, `api`, `agent`, `mcp`, адаптеры провайдеров) и предназначены не только человеку, но и AI-разбору, строящему признаки поверх исторических данных. Без зафиксированного контракта имён схема дрейфует: признаки и дашборды ломаются молча, разные процессы описывают одну сущность по-разному. Практика проекта уже противостоит этому: допустимые значения фиксируются закрытыми перечислениями (`UsageSource`, `UsageReporting`, `RuntimeTransport` в `packages/runtime/src/types.ts`), а не строками в местах вызова.

**Требование-источник:** `BR-fact.audit.observability`, `REQ-NFR-ops.observability.error-categorization`, `docs/telemetry.md`, `.ai-factory/references/opentelemetry-genai-semconv.md`, evidence: `packages/runtime/src/types.ts`, `packages/runtime/src/errors.ts`

**Решение:** Единый контракт из четырёх правил.

1. **Resource-контракт** — одинаковый во всех сигналах процесса: `service.name` (`aif-api`, `aif-agent`, `aif-mcp`, `aif-web`), `service.namespace`, `service.version`, `service.instance.id` (новый UUID при старте процесса), `deployment.environment.name` (актуальное имя semconv; устаревшее `deployment.environment` не используется). Набор согласован со списками атрибутов, которые Loki и Prometheus promote'ят в метки по умолчанию.
2. **Именование** — приоритет внешних семантических соглашений: `http.*`, `db.*`, `gen_ai.*`, `mcp.*`, `error.type`. Собственные поля — только под пространством `aif.*`: `aif.task.id`, `aif.project.id`, `aif.chat_session.id`, `aif.stage`, `aif.workflow.kind`, `aif.usage.source`, `aif.runtime.id`, `aif.runtime.transport`, `aif.cost.usd` (стоимость отсутствует в `gen_ai.*`), `aif.link.type`, `aif.schema.version`.
3. **Кардинальность** — неограниченные значения (`aif.task.id`, `aif.project.id`, идентификатор чата) допускаются в атрибутах трассировок и structured metadata логов, но никогда не становятся метками Prometheus. Свёртки по задачам/проектам остаются в SQLite (`usage_events`); operational-дашборды оперируют ограниченными измерениями: стадия, источник, runtime, провайдер, модель, категория ошибки.
4. **Ошибки** — `error.type` принимает структурированные категории существующей классификации (`rate_limit`, `auth`, `timeout`, `permission`, `stream`, `transport`, `model_not_found`, `context_length`, `content_filter`, `unknown`), а не текст сообщения (правило структурной классификации ошибок из `AGENTS.md`).

Имена атрибутов и версия схемы объявляются константными реестрами в `@aif/telemetry` (по образцу `UsageReporting`) и покрываются тестами, запрещающими устаревшие ключи (`gen_ai.system`, `gen_ai.usage.prompt_tokens`, `gen_ai.usage.completion_tokens`, `deployment.environment`).

**Рассмотренные альтернативы:**

- **Только внешние semconv, без `aif.*`.** Отвергнуто: доменные сущности (задача, стадия, профиль runtime, стоимость) в них отсутствуют.
- **Свободные строки вместо реестров-констант.** Отвергнуто: опечатки и дрейф не детектируются; противоречит сложившейся практике закрытых перечислений.
- **`aif.task.id` как метка Prometheus ради дашбордов стоимости.** Отвергнуто: кардинальность растёт с числом задач; эти данные уже есть в SQLite.

**Последствия:**

- **Положительные:** стабильные признаки для AI-контура; межсигнальная корреляция (log↔trace↔metric) опирается на один набор resource-атрибутов; переименование поля — правка реестра и теста, а не поиск по коду.
- **Отрицательные:** `gen_ai.*`/`mcp.*` имеют статус Development и меняются без гарантий; трансляция имён метрик в Prometheus искажает исходные имена (`.` → `_`, суффиксы).
- **Смягчение:** версия semconv в константе и в CI-тесте; неизвестные значения enum трактуются как совместимые вперёд; `translation_strategy` задан явно; контракт публикуется в `docs/telemetry.md`, детальный `schema-contract.yaml` с CI-валидацией — Phase 2.
