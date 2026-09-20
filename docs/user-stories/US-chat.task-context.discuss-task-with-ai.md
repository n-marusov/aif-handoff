<a id="us-chat.task-context.discuss-task-with-ai"></a>

# US-chat.task-context.discuss-task-with-ai: Диалог с AI в контексте конкретной задачи

```gherkin
@US-chat.task-context.discuss-task-with-ai @HF8.2 @UC-chat.task-context.discuss-task-with-ai @P1 @chat @task-context @gui
Feature: US-chat.task-context.discuss-task-with-ai Диалог с AI в контексте конкретной задачи

  Background:
    Given пользователь открыл детальный просмотр задачи

  Scenario: Пользователь задаёт вопрос AI в контексте задачи
    Given задача связана с активной чат-сессией
    When пользователь открывает чат с задачей и задаёт вопрос
    Then ассистент видит контекст задачи (план, статус, проверки)
    and пользователь получает ответ со ссылками на артефакты задачи

  Scenario: Ответы сессии сохраняются в истории задачи
    Given диалог ведётся в контексте задачи
    When пользователь закрывает и снова открывает сессию
    Then история диалога доступна и привязана к задаче
```
