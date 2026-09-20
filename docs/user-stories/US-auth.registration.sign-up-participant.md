<a id="us-auth.registration.sign-up-participant"></a>

# US-auth.registration.sign-up-participant: Регистрация и вход участника

```gherkin
@US-auth.registration.sign-up-participant @HF9.1 @UC-auth.registration.sign-up-participant @P1 @auth @registration @gui
Feature: US-auth.registration.sign-up-participant Регистрация и вход участника

  Background:
    Given включён режим участников (PARTICIPANTS_MODE_ENABLED)

  Scenario: Участник регистрируется в системе
    Given пользователь на странице входа (LoginPage)
    When пользователь отправляет POST /api/participants с username, password и displayName
    Then создаётся запись в participants с хешированным паролем (bcrypt)
    and роль участника устанавливается (первый участник получает admin)
    and пользователь может войти в систему

  Scenario: Участник входит в систему
    Given участник зарегистрирован в системе
    When пользователь вводит credentials и нажимает Sign in
    Then API проверяет хеш пароля
    and создаётся сессия (token, csrfToken, expiresAt)
    and UI получает AuthSessionState с authenticated=true
    and последующие запросы включают session cookie и CSRF-токен

  Scenario: Неверный пароль отклоняется
    Given участник вводит неверный пароль
    When пользователь отправляет login-запрос
    Then API возвращает 401
    and UI отображает сообщение об ошибке

  Scenario: Сессия истекла
    Given сессия участника истекла (expiresAt просрочено)
    When пользователь выполняет запрос
    Then middleware возвращает 401
    and пользователь перенаправляется на страницу входа

  Scenario: Участник выходит из системы
    Given участник аутентифицирован
    When пользователь отправляет POST /api/auth/logout
    Then сессия помечается revokeAt
    and пользователь возвращается на страницу входа
```
