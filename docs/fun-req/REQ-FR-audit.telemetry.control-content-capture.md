[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-audit.telemetry.control-content-capture: Управление захватом содержимого и деградация

**Приоритет:** P1

**Ключевая функция:** HF10.5 Управление телеметрией (предложено)

**Источник:** [UC-audit.telemetry.control-content-capture](../use-cases/UC-audit.telemetry.control-content-capture.md), HF10.5, `BR-constraint.audit.telemetry-content-minimality`

**Статус:** proposed

**Класс:** to be

**Канал:** Config (env)

**Описание:** Флаги телеметрии валидируются zod-схемой `getEnv()` наряду с остальным окружением: `AIF_TELEMETRY_ENABLED`, `AIF_TELEMETRY_LOG_BRIDGE`, `AIF_TELEMETRY_CONTENT_CAPTURE` (все — `false` по умолчанию). Захват содержимого AI-взаимодействий применяется только при явном включении и проходит через сокрытие (`redactProviderText`) и усечения по образцу `queryAudit.ts`. Сбой доставки телеметрии не влияет на конвейер.

**Критерии приёмки:**

1. Все новые флаги объявлены в `envSchema` с дефолтом `false`; тесты переключают их через `resetEnvCache()`.
2. `AIF_TELEMETRY_CONTENT_CAPTURE=true` без `AIF_TELEMETRY_ENABLED=true` игнорируется с предупреждением в стартовом логе.
3. При включённом захвате атрибуты содержимого проходят `redactProviderText` и ограничение размера/глубины по образцу аудита запросов.
4. Экспортёры non-throwing: очередь ограничена, переполнение сбрасывается с метрикой потерь; выполнение задачи не прерывается из-за телеметрии.
5. Завершение процесса выполняет flush экспорта с ограничением по таймауту (для stdio-MCP — синхронный экспорт).

## See Also

- [REQ-FR-audit.telemetry.emit-correlated-signals](REQ-FR-audit.telemetry.emit-correlated-signals.md) — контракт сигналов
- [REQ-NFR-ops.observability.otel-export-resilience](../nonfun-req/REQ-NFR-ops.observability.otel-export-resilience.md) — устойчивость экспорта
- [ADR-DES.PROCESS.correlation-first-async-traces](../adr/ADR-DES.PROCESS.correlation-first-async-traces.md) — opt-in содержимого
