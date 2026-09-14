[← REQ-NFR-api.compliance.request-validation](REQ-NFR-api.compliance.request-validation.md) · [Back to README](README.md) · [REQ-NFR-security.compliance.csrf-protection →](REQ-NFR-security.compliance.csrf-protection.md)

# REQ-NFR-security.compliance.session-auth

**Приоритет:** P1
**Статус:** implemented
**Класс:** to be (Фаза 2 — участники и аутентификация)
**Источник:** G2 (безопасность доступа); P4 (отсутствие формальных гейтов доступа); `BR-constraint.auth.sessions`; `BR-fact.auth.roles`
**Ключевая функция:** HF9, HF9.1
**Домен L1:** dashboard

## Описание

100% API-запросов к задачам, проектам и настройкам требуют аутентификации (сессионная cookie для браузера, bearer-токен для MCP/машинного доступа). Неаутентифицированный доступ возвращает 401. Анонимный доступ разрешён только к /health. Исключения явно конфигурируются в middleware.

## Критерии приёмки

| Метрика            | Целевое значение                                        | Способ проверки                                   |
| ------------------ | ------------------------------------------------------- | ------------------------------------------------- |
| Аутентификация API | 100% запросов к задачам/проектам требуют аутентификации | Audit middleware chain: проверка каждого маршрута |
| Ответ 401          | Неаутентифицированный запрос возвращает 401             | Тест: запрос без cookie/token                     |
| Исключение /health | /health доступен без аутентификации                     | Тест: GET /health без auth — 200                  |
| Session TTL        | Сессия истекает через PARTICIPANT_SESSION_TTL_SECONDS   | Тест: использование сессии после TTL — 401        |
| Отзыв сессии       | Отозванная сессия перестаёт действовать немедленно      | Тест: login → revoke → запрос — 401               |

## Связанные требования

- `BR-constraint.auth.sessions`
- `BR-fact.auth.roles`
- `BR-constraint.auth.credentials`
- `REQ-NFR-security.compliance.csrf-protection`
- `REQ-NFR-security.compliance.password-storage`
- `REQ-NFR-security.compliance.login-rate-limit`
- `REQ-NFR-security.compliance.origin-validation`

## See Also

- [REQ-NFR-security.compliance.csrf-protection](REQ-NFR-security.compliance.csrf-protection.md)
- [REQ-NFR-security.compliance.password-storage](REQ-NFR-security.compliance.password-storage.md)
- [REQ-NFR-security.compliance.login-rate-limit](REQ-NFR-security.compliance.login-rate-limit.md)
- [REQ-NFR-api.availability.websocket-reconnect](REQ-NFR-api.availability.websocket-reconnect.md)
