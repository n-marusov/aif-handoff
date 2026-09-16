[← Back to README](README.md)

# REQ-FR-vcs-auto.isolation.init-scaffold: Инициализация AI Factory scaffold при git-prepare

**Приоритет:** P1

**Ключевая функция:** HF4.1 Изоляция и подготовка репозитория

**Источник:** [UC-vcs-auto.isolation.init-submodules](../use-cases/UC-vcs-auto.isolation.init-submodules.md), BR-constraint.project.scaffold-idempotency

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (Git)

**Описание:** При автоматической подготовке репозитория (git-prepare) после checkout дефолтной ветки и инициализации субмодулей Coordinator инициализирует AI Factory scaffold (директорию `.ai-factory/`), если она отсутствует. При наличии существующего scaffold инициализация пропускается — prepare продолжается без изменений.

**Критерии приёмки:**

1. После checkout дефолтной ветки и шага субмодулей `prepareRepository` проверяет наличие `.ai-factory/` в корне проекта.
2. Если `.ai-factory/` отсутствует — выполняется `initProject({ projectRoot, registry })` для создания scaffold.
3. При успешной инициализации — prepare продолжается к шагу коммита scaffold.
4. Если `.ai-factory/` существует — шаг инициализации пропускается, prepare продолжается без ошибки.
5. При ошибке инициализации (registry недоступен, ошибка записи файлов) — prepare прерывается с `RepositoryPrepareError("init_failed", ...)`.
6. Ошибка инициализации блокирует Sync now и возвращает `{provider}_prepare_init_failed`.
7. Повторный git-prepare (gitPreparedAt != null) не выполняет prepare вообще — scaffold остаётся нетронутым.

## See Also

- [REQ-FR-vcs-auto.isolation.init-submodules](REQ-FR-vcs-auto.isolation.init-submodules.md) — инициализация субмодулей
- [REQ-FR-vcs-auto.isolation.create-worktree](REQ-FR-vcs-auto.isolation.create-worktree.md) — изоляция worktree
