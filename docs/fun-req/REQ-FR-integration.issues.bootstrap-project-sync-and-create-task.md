[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-integration.issues.bootstrap-project-sync-and-create-task: Добавление проекта, синхронизация и постановка задачи

**Приоритет:** P1

**Ключевая функция:** HF11.1 Синхронизация с Issues, HF2.1 Просмотр изменений по стадиям

**Источник:** [UC-integration.issues.bootstrap-project-sync-and-create-task](../use-cases/UC-integration.issues.bootstrap-project-sync-and-create-task.md), BR-fact.git.vcs-workflow

**Статус:** proposed

**Класс:** as is

**Канал:** Mixed (GUI + API + Schedule/Agent)

**Описание:** Система должна поддерживать сквозной пользовательский путь: администратор добавляет проект с параметрами удалённого репозитория, запускает синхронизацию и может вручную создать задачу в проекте независимо от исхода синхронизации (при фиксируемой диагностике ошибок sync).

**Критерии приёмки:**

1. Администратор может создать проект через UI/API, и проект появляется в списке проектов.
2. Для проекта можно сохранить параметры подключения к удалённому репозиторию (GitHub/GitLab).
3. По действию `Sync now` запускается синхронизация Issues/MR для выбранного проекта.
4. Результат синхронизации фиксируется в состоянии проекта: успешный sync или диагностируемая ошибка (`syncError`).
5. Ошибка синхронизации не блокирует ручное создание задачи в проекте.
6. После создания задачи она сохраняется в проекте в статусе `backlog`.
7. Созданная задача отображается на Kanban-доске проекта.
8. Операции изменения настроек проекта/репозитория доступны только пользователю с правами администратора.

## See Also

- [REQ-FR-integration.issues.sync-github-issues](REQ-FR-integration.issues.sync-github-issues.md) — синхронизация Issues/MR
- [REQ-FR-dashboard.board.render-kanban-columns](REQ-FR-dashboard.board.render-kanban-columns.md) — отображение задач на доске
- [REQ-FR-runtime.profile.configure-project-runtime](REQ-FR-runtime.profile.configure-project-runtime.md) — конфигурация проекта
