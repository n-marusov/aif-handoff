<a id="us-runtime.profile.configure-project-runtime"></a>

# US-runtime.profile.configure-project-runtime: Настройка runtime-профиля для проекта

```gherkin
@US-runtime.profile.configure-project-runtime @HF3.1 @UC-runtime.profile.configure-project-runtime @P0 @runtime @profile @gui
Feature: US-runtime.profile.configure-project-runtime Настройка runtime-профиля для проекта

  Background:
    Given пользователь имеет роль admin
    and в системе доступны runtime-адаптеры (claude, codex, openrouter, opencode)

  Scenario: Администратор настраивает runtime-профиль проекта
    Given пользователь открыл ProjectRuntimeSettings
    When пользователь создаёт профиль с runtimeId, моделью и транспортом
    Then профиль сохраняется (POST /api/runtime-profiles)
    and профиль привязывается к стадиям проекта (task, plan, review, chat)
    and API-ключ указывается как переменная окружения (apiKeyEnvVar)

  Scenario: Администратор редактирует существующий профиль
    Given профиль проекта уже существует
    When пользователь изменяет модель или транспорт профиля
    Then изменения сохраняются (PUT /api/runtime-profiles)
    and новые задачи проекта используют обновлённый профиль

  Scenario: Для проекта используется профиль по умолчанию
    Given для проекта не указан собственный профиль
    When задачи проекта выполняются
    Then используется системный дефолт (getAppDefaultRuntimeProfileId)

  Scenario: Пользователь видит список доступных моделей
    Given включён сервис Model Discovery
    When администратор конфигурирует профиль
    Then UI отображает список доступных моделей runtime-провайдера
```
