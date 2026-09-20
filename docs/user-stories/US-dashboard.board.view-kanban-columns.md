<a id="us-dashboard.board.view-kanban-columns"></a>

# US-dashboard.board.view-kanban-columns: Просмотр изменений по стадиям в Kanban-доске

```gherkin
@US-dashboard.board.view-kanban-columns @HF2.1 @UC-dashboard.board.view-kanban-columns @P0 @dashboard @board @gui
Feature: US-dashboard.board.view-kanban-columns Просмотр изменений по стадиям в Kanban-доске

  Background:
    Given пользователь выбрал проект в ProjectSelector
    and в проекте существуют задачи на разных стадиях конвейера

  Scenario: Пользователь видит все задачи проекта, сгруппированные по стадиям
    When пользователь открывает Kanban-доску проекта
    Then UI запрашивает задачи через GET /api/tasks?projectId=X
    and задачи отображаются колонками стадий (Backlog, Planning, Improve, Plan Ready, Plan Review, Implementing, Verify, Review, Blocked, Done, Accepted)
    and для каждой задачи видны заголовок, приоритет, assignee, статус гейтов и время последней активности

  Scenario: Пользователь переупорядочивает задачи drag-and-drop
    Given доска отображает задачи в режиме kanban
    When пользователь перетаскивает карточку задачи на новую позицию
    Then UI отправляет PUT /api/tasks/reorder
    and позиция задачи сохраняется и отображается обновлённой

  Scenario: Горизонтальный скролл доски при вертикальной прокрутке списка карточек
    Given доска шире окна просмотра (scrollWidth > clientWidth)
    and список карточек вертикально прокручивается (scrollHeight > clientHeight)
    When пользователь наводит указатель на карточку и совершает жест горизонтального колеса
    Then доска прокручивается горизонтально (scrollLeft увеличивается)

  Scenario: Пользователь переключается в list-режим
    When пользователь переключает viewMode=list
    Then задачи отображаются в табличном формате (TaskListTable)

  Scenario: Пользователь фильтрует задачи
    Given FilterBar доступна на доске
    When пользователь задаёт фильтр по статусу, приоритету, assignee или тегам
    Then на доске отображаются только задачи, удовлетворяющие фильтру
```
