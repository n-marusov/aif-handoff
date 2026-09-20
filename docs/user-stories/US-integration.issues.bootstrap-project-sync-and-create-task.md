<a id="us-integration.issues.bootstrap-project-sync-and-create-task"></a>

# US-integration.issues.bootstrap-project-sync-and-create-task: Подключение проекта и постановка задачи

```gherkin
@US-integration.issues.bootstrap-project-sync-and-create-task @HF11.1 @HF2.1 @UC-integration.issues.bootstrap-project-sync-and-create-task @P1 @integration @issues @gui
Feature: US-integration.issues.bootstrap-project-sync-and-create-task Подключение проекта и постановка задачи

  Background:
    Given администратор вошёл в систему
    and у администратора есть доступ к удалённому репозиторию

  Scenario: Администратор подключает проект и получает результат синхронизации
    Given администратор открыл экран управления проектами
    When администратор добавляет проект и запускает синхронизацию
    Then система показывает результат синхронизации и готовность проекта к работе

  Scenario: Администратор вручную ставит задачу в подключённом проекте
    Given проект уже подключён и доступен на доске
    When администратор создаёт задачу через форму добавления задачи
    Then задача сохраняется в проекте
    and новая карточка появляется в колонке Backlog

  Scenario: Ошибка синхронизации не блокирует ручную постановку задач
    Given удалённый репозиторий временно недоступен
    When администратор запускает синхронизацию проекта
    Then система показывает диагностируемую ошибку синхронизации
    and администратор всё равно может создать задачу вручную
```
