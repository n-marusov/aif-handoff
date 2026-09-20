<a id="us-accounting.blocking.block-on-limit-exceeded"></a>

# US-accounting.blocking.block-on-limit-exceeded: Блокировка задачи при превышении лимита

```gherkin
@US-accounting.blocking.block-on-limit-exceeded @HF6.3 @UC-accounting.blocking.block-on-limit-exceeded @P1 @accounting @blocking
Feature: US-accounting.blocking.block-on-limit-exceeded Блокировка задачи при превышении лимита

  Background:
    Given для проекта настроены лимиты использования
    and Coordinator готовится запустить stage runner

  Scenario: Задача блокируется при превышении лимита
    Given evaluateRuntimeLimitGate определяет, что окно лимита превышено (source=BLOCKED)
    When Coordinator вызывает blockCandidateIfRuntimeLimited
    Then задача переводится в blocked_external
    and blockedFromStatus фиксирует текущий статус
    and retryAfter вычисляется до времени сброса окна
    and UI уведомляется через WebSocket-событие task:limitBroadcast

  Scenario: Задача близка к исчерпанию лимита (WARNING)
    Given лимит близок к превышению, но не превышен
    When Coordinator проверяет runtime-гейт
    Then задача не блокируется
    and в лог записывается предупреждение о близости к лимиту

  Scenario: Провайдер вернул rate limit
    Given адаптер получил HTTP 429 с заголовком Retry-After
    When ErrorClassifier обрабатывает ответ
    Then категория rate_limit сохраняется
    and retryAfter берётся из заголовков провайдера
```
