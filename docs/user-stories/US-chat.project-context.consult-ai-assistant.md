<a id="us-chat.project-context.consult-ai-assistant"></a>

# US-chat.project-context.consult-ai-assistant: Диалог с AI-ассистентом в контексте проекта

```gherkin
@US-chat.project-context.consult-ai-assistant @HF8.1 @UC-chat.project-context.consult-ai-assistant @P1 @chat @project-context @gui
Feature: US-chat.project-context.consult-ai-assistant Диалог с AI-ассистентом в контексте проекта

  Background:
    Given пользователь открыл Kanban-доску проекта

  Scenario: Пользователь получает ответ AI-ассистента в контексте проекта
    Given выбран проект с настроенным runtime-профилем для чата
    When пользователь открывает чат и отправляет вопрос
    Then пользователь видит стриминговый ответ ассистента
    and диалог сохраняется в истории сессии
    and использование runtime (токены/стоимость) учитывается

  Scenario: Диалог продолжается в рамках одной сессии
    Given ассистент уже ответил на предыдущий вопрос в этой сессии
    When пользователь задаёт следующий вопрос
    Then ответ приходит в контексте предыдущего диалога
    and обе реплики видны в ленте сессии

  Scenario: Чат не запускает конвейер задач
    Given пользователь в диалоге с ассистентом
    When ассистент отвечает на вопрос по проекту
    Then ни одна задача не меняет стадию от действий чата
```
