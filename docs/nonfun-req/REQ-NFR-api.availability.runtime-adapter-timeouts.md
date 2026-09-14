[← REQ-NFR-api.availability.websocket-reconnect](REQ-NFR-api.availability.websocket-reconnect.md) · [Back to README](README.md) · [REQ-NFR-ops.observability.heartbeat-detection →](REQ-NFR-ops.observability.heartbeat-detection.md)

# REQ-NFR-api.availability.runtime-adapter-timeouts

**Приоритет:** P1
**Статус:** implemented
**Класс:** as is
**Источник:** G1 (бесперебойность конвейера); G7 (провайдер-независимость); P8 (vendor lock-in); A1 (доступность AI-провайдеров)
**Ключевая функция:** HF3, HF3.1
**Домен L1:** runtime

## Описание

Каждый вызов runtime-адаптера (Claude, Codex, OpenRouter) ограничен по времени. При превышении таймаута адаптер возвращает структурированную ошибку категории `timeout`. Таймауты конфигурируются раздельно для разных фаз выполнения: старт сессии, выполнение запроса, публикация плана.

## Критерии приёмки

| Метрика                    | Целевое значение                                                   | Способ проверки                               |
| -------------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| Таймаут старта сессии      | Не более значения API_RUNTIME_START_TIMEOUT_MS (60 с по умолчанию) | Тест: имитация зависания провайдера           |
| Таймаут выполнения запроса | Не более значения API_RUNTIME_RUN_TIMEOUT_MS (120 с по умолчанию)  | Тест: имитация долгого ответа провайдера      |
| Категоризация таймаута     | Ошибка таймаута классифицируется как `timeout` с кодом адаптера    | Проверка: error.category === "timeout"        |
| Конфигурируемость          | Все таймауты runtime изменяются через переменные окружения         | Проверка: установка, подтверждение применения |

## Связанные требования

- `BR-trigger.automation.failure-recovery`
- `REQ-NFR-integration.availability.runtime-provider-fallback`
- `REQ-NFR-ops.observability.error-categorization`
- `REQ-NFR-ops.observability.heartbeat-detection`

## See Also

- [REQ-NFR-integration.availability.runtime-provider-fallback](REQ-NFR-integration.availability.runtime-provider-fallback.md)
- [REQ-NFR-ops.observability.error-categorization](REQ-NFR-ops.observability.error-categorization.md)
- [REQ-NFR-ops.observability.heartbeat-detection](REQ-NFR-ops.observability.heartbeat-detection.md)
