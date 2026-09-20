<a id="us-runtime.override.override-profile-for-task"></a>

# US-runtime.override.override-profile-for-task: Переопределение runtime-профиля для конкретной задачи

```gherkin
@US-runtime.override.override-profile-for-task @HF3.2 @UC-runtime.override.override-profile-for-task @P1 @runtime @override @gui
Feature: US-runtime.override.override-profile-for-task Переопределение runtime-профиля для конкретной задачи

  Background:
    Given пользователь открыл детальный просмотр задачи и секцию TaskSettings

  Scenario: Пользователь переопределяет runtime-профиль для задачи
    Given UI отображает текущий Effective Runtime Profile задачи
    When пользователь выбирает другой профиль из доступных
    Then API устанавливает runtimeProfileId на задаче
    and при следующем запуске Coordinator использует профиль задачи вместо профиля проекта

  Scenario: Пользователь переопределяет только модель
    Given задача использует профиль проекта
    When пользователь задаёт modelOverride в TaskSettings
    Then модель задачи изменяется без смены профиля

  Scenario: Пользователь сбрасывает переопределение
    Given задача имеет собственный runtimeProfileId
    When пользователь сбрасывает переопределение в null
    Then задача возвращается к дефолту проекта при разрешении профиля
```
