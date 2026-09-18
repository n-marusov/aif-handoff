# REQ-NFR-ops.observability.telemetry-overhead-budget: Бюджет накладных расходов телеметрии

**Приоритет:** P1
**Статус:** proposed
**Класс:** to be
**Источник:** `ADR-DES.PROCESS.manual-seam-instrumentation`, `docs/telemetry.md`
**Ключевая функция:** HF10.4
**Домен L1:** ops

## Описание

Инструментация OpenTelemetry не должна деградировать производительность системы за пределы утверждённого бюджета. Накладные расходы измеряются относительно baseline «телеметрия выключена» существующими гейтами проекта (`npm run ai:load` — API-нагрузка, `npm run ai:perf` — Playwright-метрики UI). Целевые значения утверждаются при имплементации; до утверждения порог-заглушка — регрессия p95 > 5% относительно baseline считается неприемлемой.

## Критерии приёмки

| Метрика                    | Целевое значение                                                    | Способ проверки                                  |
| -------------------------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| p95 latency API under load | деградация ≤ 5% против baseline (значение финализируется в Phase 2) | `packages/api/perf/run.mjs`, две прогона: on/off |
| Lighthouse / UI budget     | отсутствие регрессии при ленивой загрузке OTel-стека в web          | `npm run ai:perf` (Playwright/Lighthouse)        |
| Poll-цикл координатора     | пустые циклы без span'ов; overhead только на полезной работе        | проверка трасс: нет span'ов «прогремевшего» poll |
| Объём экспорта             | очереди ограничены; drop-метрикиcollector видны                     | self-observability collector на дашборде         |

## Связанные требования

- `REQ-NFR-ops.observability.otel-export-resilience`
- `REQ-NFR-infra.performance.concurrency-limits`
- `BR-fact.audit.otel-telemetry-backbone`

## See Also

- [REQ-NFR-ops.observability.otel-export-resilience](REQ-NFR-ops.observability.otel-export-resilience.md)
- [REQ-NFR-api.performance.coordinator-polling-latency](REQ-NFR-api.performance.coordinator-polling-latency.md)
- [ADR-DES.PROCESS.manual-seam-instrumentation](../adr/ADR-DES.PROCESS.manual-seam-instrumentation.md)
