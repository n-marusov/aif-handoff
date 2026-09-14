[← REQ-NFR-api.performance.coordinator-polling-latency](REQ-NFR-api.performance.coordinator-polling-latency.md) · [Back to README](README.md) · [REQ-NFR-api.availability.runtime-adapter-timeouts →](REQ-NFR-api.availability.runtime-adapter-timeouts.md)

# REQ-NFR-api.availability.websocket-reconnect

**Приоритет:** P1
**Статус:** implemented
**Класс:** as is
**Источник:** G2 (прозрачность состояния в реальном времени); P3 (отсутствие прозрачности состояния)
**Ключевая функция:** HF2, HF2.4
**Домен L1:** dashboard

## Описание

При временном разрыве WebSocket-соединения между клиентом и сервером состояние дашборда не теряется. После восстановления соединения клиент получает актуальный статус всех отслеживаемых изменений. Команды и события не дублируются при повторном подключении.

## Критерии приёмки

| Метрика                                 | Целевое значение                                                           | Способ проверки                                                       |
| --------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Восстановление после временного разрыва | Клиент автоматически переподключается и получает актуальные данные         | E2E-тест: разрыв соединения, ожидание восстановления, проверка данных |
| Отсутствие дублирования                 | Команды и события не дублируются при reconnect                             | E2E-тест: verify no duplicate events                                  |
| Graceful shutdown                       | При остановке сервера все WebSocket-клиенты корректно завершают соединение | Тест: SIGTERM, проверка закрытия соединений                           |
| Очистка невалидных сессий               | Сессии с истёкшим сроком или отозванные автоматически отключаются          | Тест: отзыв сессии, проверка отключения клиента                       |

## Связанные требования

- `BR-fact.audit.observability`
- `BR-constraint.auth.sessions`
- `REQ-NFR-security.compliance.session-auth`
- `REQ-NFR-ui.availability.real-time-updates`

## See Also

- [REQ-NFR-security.compliance.session-auth](REQ-NFR-security.compliance.session-auth.md)
- [REQ-NFR-ui.availability.real-time-updates](REQ-NFR-ui.availability.real-time-updates.md)
- [REQ-NFR-api.availability.runtime-adapter-timeouts](REQ-NFR-api.availability.runtime-adapter-timeouts.md)
