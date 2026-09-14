# ADR-IMPL.PROCESS.auto-queue-advancement

**Статус:** ПРИНЯТО
**Дата:** 2026-09-14
**Контекст:** В project с большим числом задач ручной перевод каждой из backlog в обработку — узкое место. Пользователь хочет, чтобы система сама брала следующую задачу из очереди, как только предыдущая завершена. При этом:

- Для sequential проектов: одна задача → выполнение → завершение → следующая.
- Для parallel проектов: N задач в пайплайне одновременно, заполнение пула по мере освобождения.
  Создание задач должно быть append-only (FIFO), а не LIFO (как default SQL `ORDER BY created_at DESC`).

**Требование-источник:** `docs/architecture.md` §Auto-Queue Mode, `vision.md` §1.4 HF-6

**Решение:** Опция `autoQueueMode` на проекте (default `false`). Функция `processAutoQueueAdvance()` в координаторе:

1. Позиционирование задач: при создании через `POST /tasks` без явного `position` — `max(position) + 100` (FIFO вместо LIFO). Auto-queue потребляет наименьший backlog position.
2. Sequential: pool depth = 1. Следующая задача стартует только после terminal статуса (`done`/`verified`) предыдущей. «В работе» считается по pipeline status, не по lock.
3. Parallel (требует `AIF_TASK_WORKTREES_ENABLED=true`): pool depth = `COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT` (default 3). Fill loop за один tick заполняет весь пул.
4. Commit gate (optional): `AIF_AGENT_AUTO_QUEUE_COMMIT_GATE_ENABLED=true` — перед переходом в `done` coordinator синхронно коммитит изменения через `/aif-commit` и проверяет чистое дерево.
5. Auto-queue and scheduled execution compose: `processDueScheduledTasks()` → fire по расписанию → `processAutoQueueAdvance()` → fill pool.

**Рассмотренные альтернативы:**

- **Manual queue (human triggers each task)** — пользователь вручную нажимает Start Implementation. Отвергнуто: для проектов с десятками задач ручной триггер не масштабируется.
- **Continuous delivery (все задачи бегут одновременно)** — нет ограничений параллельности. Отвергнуто: гонка за Git-write (без worktree isolation), перегрузка runtime-провайдера.
- **Только sequential** — одна задача за раз, параллельные проекты не поддерживаются. Отвергнуто: ограничивает пропускную способность.

**Последствия:**

- **Положительные:** автоматический pipeline для проектов с большим backlog; FIFO-упорядочивание через `max(position)+100`; parallel fill за один tick.
- **Отрицательные:** sequential без commit gate — коммиты не гарантированы (legacy); commit gate добавляет latency перед `done`; dirty worktree в parallel-проекте может заблокировать advance для всех последующих задач (commit gate не пройдёт — `blocked_external`).
- **Смягчение:** commit gate off по умолчанию; лимит parallel pool depth предотвращает чрезмерную нагрузку; dirty worktree (при commit gate on) фиксируется через stash или reconcile.
