<a id="us-auth.roles.assign-participant-role"></a>

# US-auth.roles.assign-participant-role: Разграничение ролей и прав участников

```gherkin
@US-auth.roles.assign-participant-role @HF9.2 @UC-auth.roles.assign-participant-role @P1 @auth @roles @gui
Feature: US-auth.roles.assign-participant-role Разграничение ролей и прав участников

  Background:
    Given пользователь с ролью admin открыл ParticipantManagementDialog

  Scenario: Администратор назначает роль участнику
    Given UI отображает список участников с ролями и статусами
    When администратор изменяет роль участника (member ↔ admin)
    Then изменение сохраняется (PUT /api/participants/:id)
    and права доступа обновляются для всех последующих запросов

  Scenario: Администратор деактивирует участника
    Given участник активен
    When администратор деактивирует участника
    Then участник не может входить в систему
    and middleware отклоняет запросы (participant.active=false)

  Scenario: Член команды видит только назначенные задачи
    Given участник с ролью member
    When участник открывает проект
    Then отображаются только задачи, на которые участник назначен (task-isolation)
    and только проекты, в которые участник добавлен

  Scenario: Участник меняет собственный пароль
    Given участник аутентифицирован
    When участник вызывает change password через Header
    Then пароль обновляется в БД (новый bcrypt-хеш)
```
