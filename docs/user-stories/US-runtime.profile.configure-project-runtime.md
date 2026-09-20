<a id="us-runtime.profile.configure-project-runtime"></a>

# US-runtime.profile.configure-project-runtime: Настройка AI-runtime профиля проекта

```gherkin
@US-runtime.profile.configure-project-runtime @HF3.1 @UC-runtime.profile.configure-project-runtime @P0 @runtime @profile @gui
Feature: US-runtime.profile.configure-project-runtime Настройка AI-runtime профиля проекта

  Background:
    Given пользователь имеет права администратора проекта

  Scenario: Администратор настраивает профиль выполнения для проекта
    Given администратор открыл настройки runtime проекта
    When администратор задаёт профиль выполнения для этапов проекта
    Then профиль сохраняется
    and новые запуски задач проекта используют выбранные настройки

  Scenario: Администратор обновляет профиль проекта
    Given профиль проекта уже задан
    When администратор изменяет модель или транспорт выполнения
    Then обновлённые настройки применяются к следующим запускам задач

  Scenario: Проект использует системный профиль по умолчанию
    Given для проекта не задан собственный профиль
    When запускается выполнение задачи проекта
    Then система применяет профиль по умолчанию

  Scenario: Администратор выбирает модель из доступного списка
    Given система получила доступные модели выбранного runtime-провайдера
    When администратор настраивает профиль
    Then интерфейс показывает только доступные для выбора модели
```
