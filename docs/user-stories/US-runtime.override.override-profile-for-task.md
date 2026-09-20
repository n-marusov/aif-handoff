<a id="us-runtime.override.override-profile-for-task"></a>

# US-runtime.override.override-profile-for-task: Переопределение AI-runtime для отдельной задачи

```gherkin
@US-runtime.override.override-profile-for-task @HF3.2 @UC-runtime.override.override-profile-for-task @P1 @runtime @override @gui
Feature: US-runtime.override.override-profile-for-task Переопределение AI-runtime для отдельной задачи

  Background:
    Given пользователь открыл настройки конкретной задачи

  Scenario: Пользователь задаёт отдельный runtime-профиль для задачи
    Given задача наследует профиль проекта
    When пользователь выбирает для задачи другой профиль
    Then задача использует выбранный профиль при следующем запуске
    and остальные задачи проекта продолжают работать по профилю проекта

  Scenario: Пользователь переопределяет только модель
    Given профиль задачи не меняется
    When пользователь задаёт model override для задачи
    Then следующий запуск задачи выполняется на выбранной модели

  Scenario: Пользователь сбрасывает переопределение
    Given у задачи задано переопределение профиля
    When пользователь очищает переопределение
    Then задача снова наследует профиль проекта
```
