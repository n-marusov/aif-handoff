<a id="us-integration.issues.bootstrap-project-sync-and-create-task"></a>

# US-integration.issues.bootstrap-project-sync-and-create-task: Добавление проекта, синхронизация и постановка задачи

```gherkin
@US-integration.issues.bootstrap-project-sync-and-create-task @HF11.1 @HF2.1 @UC-integration.issues.bootstrap-project-sync-and-create-task @P1 @integration @issues @gui
Feature: US-integration.issues.bootstrap-project-sync-and-create-task Добавление проекта, синхронизация и постановка задачи

  Background:
    Given пользователь с ролью admin вошёл в систему
    and у пользователя есть доступ к удалённому репозиторию GitHub или GitLab

  Scenario: Пользователь добавляет проект, выполняет sync и создаёт задачу
    Given пользователь открыл экран управления проектами
    When пользователь добавляет новый проект и указывает параметры удалённого репозитория
    and запускает синхронизацию проекта (Sync now)
    Then Coordinator выполняет синхронизацию Issues/MR из удалённого репозитория
    and статус синхронизации отображается без критической ошибки
    When пользователь открывает Kanban-доску проекта
    and создаёт задачу через форму добавления задачи
    Then задача сохраняется в проекте
    and новая карточка задачи отображается в колонке Backlog

  Scenario: Синхронизация не завершилась, создание задачи остаётся доступным
    Given удалённый репозиторий временно недоступен
    When пользователь запускает синхронизацию проекта
    Then система фиксирует ошибку синхронизации для диагностики
    and пользователь всё равно может вручную поставить задачу в проекте
```
