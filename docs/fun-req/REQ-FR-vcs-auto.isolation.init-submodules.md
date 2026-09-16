[← Back to README](README.md)

# REQ-FR-vcs-auto.isolation.init-submodules: Инициализация субмодулей при git-prepare

**Приоритет:** P1

**Ключевая функция:** HF4.1 Изоляция и подготовка репозитория

**Источник:** [UC-vcs-auto.isolation.init-submodules](../use-cases/UC-vcs-auto.isolation.init-submodules.md), BR-constraint.git.submodule-init

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (Git)

**Описание:** При автоматической подготовке репозитория (git-prepare) после fetch и checkout дефолтной ветки Coordinator проверяет наличие `.gitmodules` и инициализирует субмодули. Ошибка инициализации субмодуля блокирует prepare и возвращает `submodule_failed`. Отсутствие `.gitmodules` не является ошибкой.

**Критерии приёмки:**

1. После checkout дефолтной ветки `prepareRepository` проверяет наличие `.gitmodules` в корне проекта.
2. Если `.gitmodules` существует — выполняется `git submodule update --init --recursive`.
3. Команда выполняется с рекурсивным флагом — вложенные субмодули также инициализируются.
4. При успехе — prepare продолжается без изменений потока.
5. При ошибке инициализации — prepare прерывается с `RepositoryPrepareError("submodule_failed", ...)`, синхронизация блокируется.
6. Если `.gitmodules` отсутствует — шаг пропускается (idempotent).

## See Also

- [REQ-FR-vcs-auto.isolation.create-worktree](REQ-FR-vcs-auto.isolation.create-worktree.md) — изоляция worktree
- [REQ-FR-vcs-auto.commit.auto-commit-before-completion](REQ-FR-vcs-auto.commit.auto-commit-before-completion.md) — автоматический коммит
