<a id="us-dashboard.realtime.receive-live-status-updates"></a>

# US-dashboard.realtime.receive-live-status-updates: Обновления статуса задачи в реальном времени

```gherkin
@US-dashboard.realtime.receive-live-status-updates @HF2.4 @UC-dashboard.realtime.receive-live-status-updates @P1 @dashboard @realtime @gui
Feature: US-dashboard.realtime.receive-live-status-updates Обновления статуса задачи в реальном времени

  Background:
    Given пользователь работает с Kanban-доской проекта

  Scenario: Пользователь видит изменение стадии без ручного обновления страницы
    Given стадия задачи меняется в системе
    When событие обновления доставляется в интерфейс
    Then доска и карточка задачи показывают актуальную стадию без ручного перезапроса страницы

  Scenario: Пользователь видит, что задача всё ещё выполняется
    Given задача выполняется длительное время
    When система отправляет признаки прогресса выполнения
    Then пользователь видит, что задача активна и не зависла

  Scenario: Временный разрыв соединения не лишает пользователя актуальных данных
    Given соединение обновлений было кратковременно потеряно
    When соединение восстановлено
    Then интерфейс снова получает события
    and пользователь видит актуальное состояние задач
```
