# ADR-IMPL.PROCESS.coordinator-pipeline-pattern

**Статус:** ПРИНЯТО
**Дата:** 2026-09-14
**Контекст:** Ядро AIF Handoff — координатор (`packages/agent/src/coordinator.ts`), который управляет жизненным циклом задач: отбирает кандидатов каждой стадии, запускает субагентов, обрабатывает результаты и ошибки. Без чёткой архитектуры пайплайна координатор превращается в спагетти-логику с размытыми границами стадий, дублированием error handling и race condition при параллельном запуске.

**Требование-источник:** `docs/architecture.md` §Agent Pipeline, `.ai-factory/ARCHITECTURE.md`

**Решение:** Координатор реализован как **pipeline с явными стадиями (stages)**:

- Dual-trigger: `node-cron` poll каждые 30s + WebSocket `agent:wake` сигналы от API. Оба триггера coalesce в single-flight poll loop. При недоступности WebSocket — fallback к poll-only.
- Pipeline stages: `backlog → planning → plan_check → plan-publisher (optional) → implementer → reviewer → verify (optional) → done → verified`. Каждая стадия — функция `runner` с единым интерфейсом `(taskId, executionRoot) => Promise<void>`.
- **Parallel execution (experimental):** до `COORDINATOR_MAX_CONCURRENT_PROJECTS` (default 4) независимых project lane; внутри lane — sequential (default) или parallel (до `COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT` при parallelEnabled и worktree isolation). FIFO permit governor распределяет global capacity.
- **Claim-lease:** атомарный `tryClaimTask` (lockedBy/lockedUntil) с TTL = `STAGE_RUN_TIMEOUT` + heartbeat renewal. Stale-claim auto-release. Shutdown — release active locks.
- **Error recovery (classifyStageError):** четыре стратегии: `fast_retry` (transient stream failure), `blocked_external` (runtime limit, auth, branch isolation), `revert` (unknown error → рестарт стадии), `blocked_external manual` (loop detection, configuration error — ждёт человека).
- **Runtime-limit gate:** `proactivelyBlockTaskForRuntimeGate()` — перед запуском стадии проверяет persisted runtime-limit snapshot; если threshold превышен — задача goes to `blocked_external` без вызова runtime.
- **Heartbeat liveness + stale watchdog:** `lastHeartbeatAt` обновляется при активности; stale tasks > timeout — force recovery.

**Рассмотренные альтернативы:**

- **Event-driven (все переходы через WebSocket)** — координатор реагирует только на внешние события. Отвергнуто: без poll-цикла нет гарантии обработки при временной недоступности API.
- **Single-loop (все стадии в одном цикле)** — нет разделения на lane. Отвергнуто: глобальный lock на один проект блокирует остальные.
- **Worker pool (RabbitMQ / Bull queue)** — задачи через очередь сообщений. Отвергнуто: избыточно для SQLite-based системы; дополнительный сервис (RabbitMQ) усложняет развёртывание.

**Последствия:**

- **Положительные:** изолированные стадии с единым интерфейсом; гибкая стратегия error recovery; lane-based параллелизм с permit governor; stale watchdog предотвращает зависшие задачи.
- **Отрицательные:** poll-based latency (30s); sequential lane — узкое место для long-running задач (планирование может занять минуты, пока другие задачи ждут); сложность конфигурации параллельности (три concurrent-параметра).
- **Смягчение:** dual-trigger (WebSocket wake) снижает latency до ~1s при нормальной работе; concurrency-параметры имеют разумные defaults; stale watchdog — fallback для hang-сценариев.
