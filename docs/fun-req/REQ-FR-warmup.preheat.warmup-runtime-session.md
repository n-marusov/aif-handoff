[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-warmup.preheat.warmup-runtime-session: Предварительный разогрев сессий runtime

**Приоритет:** P2

**Ключевая функция:** HF12.1 Предварительный прогрев сессий

**Источник:** [UC-warmup.preheat.warmup-runtime-session](../use-cases/UC-warmup.preheat.warmup-runtime-session.md)

**Статус:** proposed

**Класс:** as is

**Канал:** Schedule (cron)

**Описание:** Coordinator периодически создаёт и прогревает сессии runtime (`RuntimeWarmupSession`) для проектов. Прогретая сессия готова к переиспользованию: при старте задачи Coordinator может переиспользовать существующую сессию вместо создания новой, сокращая время старта. Старые сессии очищаются по истечении TTL.

**Критерии приёмки:**

1. Coordinator запускает warmup-цикл для проектов с настроенными runtime-профилями.
2. Warmup проверяет наличие активной сессии (`findRuntimeWarmupSession`: status=ready, не истекла).
3. Если сессии нет — создаёт новую через runtime-адаптер.
4. Сессия прогревается (`status=warming`) и отмечается как `ready` с `expiresAt`.
5. При старте задачи Coordinator может переиспользовать готовую сессию.
6. Если сессия не прогрелась за TTL, `markRuntimeWarmupSessionFailed`.
7. `expireStaleRuntimeWarmupSessions` — очистка истёкших сессий.
8. `findRuntimeWarmupSession` фильтрует по projectId, runtimeProfileId, model.

## See Also

- [REQ-FR-runtime.profile.configure-project-runtime](REQ-FR-runtime.profile.configure-project-runtime.md) — профили runtime
- [REQ-FR-pipeline.stage.auto-advance-after-gate](REQ-FR-pipeline.stage.auto-advance-after-gate.md) — poll-цикл coordinator
