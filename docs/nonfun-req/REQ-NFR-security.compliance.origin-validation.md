[← REQ-NFR-security.compliance.password-storage](REQ-NFR-security.compliance.password-storage.md) · [Back to README](README.md) · [REQ-NFR-security.compliance.login-rate-limit →](REQ-NFR-security.compliance.login-rate-limit.md)

# REQ-NFR-security.compliance.origin-validation

**Приоритет:** P1
**Статус:** implemented
**Класс:** to be (Фаза 2 — участники и аутентификация)
**Источник:** G2 (безопасность); `BR-constraint.auth.sessions`
**Ключевая функция:** HF9
**Домен L1:** dashboard

## Описание

HTTP-запросы и WebSocket-апгрейды проверяются на допустимость origin-заголовка. Допустимые origin задаются через `PARTICIPANT_ALLOWED_ORIGINS`. Запросы с недопустимым origin отвергаются с кодом 403. Для API-доступа без браузера (MCP) защита не требуется.

## Критерии приёмки

| Метрика                    | Целевое значение                                               | Способ проверки                                       |
| -------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| Валидация origin HTTP      | Запрос с недопустимым Origin возвращает 403                    | Тест: Origin=http://evil.com — 403                    |
| Валидация origin WebSocket | WebSocket upgrade с недопустимым Origin отвергается            | Тест: WS upgrade с недопустимым Origin — 403          |
| Конфигурируемость          | Список допустимых origin изменяется через переменную окружения | Проверка: установка, подтверждение                    |
| Разрешённые origin         | Не менее одного origin разрешён                                | Проверка: значение по умолчанию http://localhost:5180 |

## Связанные требования

- `BR-constraint.auth.sessions`
- `REQ-NFR-security.compliance.session-auth`
- `REQ-NFR-security.compliance.csrf-protection`
- `REQ-NFR-api.availability.websocket-reconnect`

## See Also

- [REQ-NFR-security.compliance.session-auth](REQ-NFR-security.compliance.session-auth.md)
- [REQ-NFR-security.compliance.csrf-protection](REQ-NFR-security.compliance.csrf-protection.md)
- [REQ-NFR-api.availability.websocket-reconnect](REQ-NFR-api.availability.websocket-reconnect.md)
