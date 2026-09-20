<a id="us-accounting.tracking.record-runtime-call"></a>

# US-accounting.tracking.record-runtime-call: Учёт использования AI-runtime по проекту и задачам

```gherkin
@US-accounting.tracking.record-runtime-call @HF6.1 @UC-accounting.tracking.record-runtime-call @P0 @accounting @tracking @api
Feature: US-accounting.tracking.record-runtime-call Учёт использования AI-runtime по проекту и задачам

  Background:
    Given проект выполняет задачи через AI-runtime

  Scenario: Использование runtime отражается в задаче после выполнения
    Given задача завершает очередной runtime-вызов
    When внешний наблюдатель запрашивает состояние задачи
    Then в задаче отображаются обновлённые показатели использования (токены и стоимость)

  Scenario: Использование агрегируется на уровне проекта
    Given в проекте выполнены runtime-вызовы по нескольким задачам
    When внешний наблюдатель запрашивает агрегированные показатели проекта
    Then система возвращает актуальные суммарные значения использования

  Scenario: Отсутствие usage-данных не ломает основной поток
    Given runtime-вызов завершён без доступных метрик использования
    When внешний наблюдатель проверяет результат выполнения
    Then задача остаётся в согласованном состоянии
    and система явно показывает, что метрики usage недоступны для этого запуска
```
