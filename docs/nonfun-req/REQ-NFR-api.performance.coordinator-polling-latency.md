[← REQ-NFR-api.availability.coordinator-resilience](REQ-NFR-api.availability.coordinator-resilience.md) · [Back to README](README.md) · [REQ-NFR-api.availability.websocket-reconnect →](REQ-NFR-api.availability.websocket-reconnect.md)

# REQ-NFR-api.performance.coordinator-polling-latency

**Приоритет:** P1
**Статус:** implemented
**Класс:** as is
**Источник:** G1 (своевременность обнаружения задач в конвейере); A3 (непрерывная работа)
**Ключевая функция:** HF1, HF1.1
**Домен L1:** pipeline

## Описание

Координатор опрашивает БД по расписанию с конфигурируемым интервалом (по умолчанию 30 с). Задача, готовая к переходу, должна быть обнаружена и начать обрабатываться не более чем за один полный цикл опроса. Время обработки цикла не должно превышать интервал опроса при типовой нагрузке.

## Критерии приёмки

| Метрика                           | Целевое значение                                                  | Способ проверки                                                                 |
| --------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Максимальная задержка обнаружения | Не более 30 с (POLL_INTERVAL_MS)                                  | Интеграционный тест: создать готовую задачу, измерить время до первого действия |
| Конфигурируемость интервала       | Интервал опроса изменяется через переменную окружения             | Проверка: установка другого значения, подтверждение изменения частоты           |
| Время цикла при типовой нагрузке  | Не превышает интервал опроса                                      | Нагрузочный тест: 5 проектов, 12 задач                                          |
| Отсутствие пропуска циклов        | Каждый цикл запускается с интервалом не более 2× POLL_INTERVAL_MS | Мониторинг: отсутствие пропусков в логе                                         |

## Связанные требования

- `BR-trigger.automation.pipeline`
- `BR-trigger.automation.auto-queue`
- `REQ-NFR-api.availability.coordinator-resilience`
- `REQ-NFR-infra.performance.concurrency-limits`

## See Also

- [REQ-NFR-api.availability.coordinator-resilience](REQ-NFR-api.availability.coordinator-resilience.md)
- [REQ-NFR-infra.performance.concurrency-limits](REQ-NFR-infra.performance.concurrency-limits.md)
- [REQ-NFR-api.availability.websocket-reconnect](REQ-NFR-api.availability.websocket-reconnect.md)
