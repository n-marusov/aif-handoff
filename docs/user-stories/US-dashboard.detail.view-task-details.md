<a id="us-dashboard.detail.view-task-details"></a>

# US-dashboard.detail.view-task-details: Детальный просмотр изменения

```gherkin
@US-dashboard.detail.view-task-details @HF2.3 @UC-dashboard.detail.view-task-details @P0 @dashboard @detail @gui
Feature: US-dashboard.detail.view-task-details Детальный просмотр изменения

  Background:
    Given пользователь работает с проектом, содержащим задачи

  Scenario: Пользователь открывает детальный просмотр задачи
    Given пользователь видит карточку задачи на Kanban-доске
    When пользователь кликает на карточку задачи
    Then открывается панель TaskDetail (slide-over)
    and отображаются: описание, приоритет, статус, ownership
    and отображается Change Plan (если сгенерирован)
    and отображаются результаты проверок и комментарии
    and отображается история исполнителей (ExecutorTimeline)
    and отображаются runtime usage (токены, стоимость) и лог выполнения

  Scenario: План не сгенерирован для задачи
    Given planPath=null
    When открывается детальный просмотр задачи
    Then секция плана скрыта

  Scenario: Пользователь добавляет комментарий к задаче
    Given пользователь открыл детальный просмотр задачи
    When пользователь пишет комментарий и отправляет его
    Then комментарий сохраняется (POST /api/tasks/:id/comments)
    and отображается в ленте комментариев задачи

  Scenario: Пользователь изменяет runtime-настройки задачи
    Given пользователь открыл секцию TaskSettings
    When пользователь изменяет runtime-профиль или model override
    Then настройки сохраняются и применяются при следующем запуске Coordinator
```
