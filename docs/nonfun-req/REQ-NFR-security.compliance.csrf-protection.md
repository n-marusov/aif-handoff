[← REQ-NFR-security.compliance.session-auth](REQ-NFR-security.compliance.session-auth.md) · [Back to README](README.md) · [REQ-NFR-security.compliance.password-storage →](REQ-NFR-security.compliance.password-storage.md)

# REQ-NFR-security.compliance.csrf-protection

**Приоритет:** P1
**Статус:** implemented
**Класс:** to be (Фаза 2 — участники и аутентификация)
**Источник:** G2 (безопасность); `BR-constraint.auth.sessions` (CSRF-защита сессий)
**Ключевая функция:** HF9
**Домен L1:** dashboard

## Описание

Все мутирующие HTTP-запросы (POST, PUT, PATCH, DELETE) от браузерных клиентов защищены CSRF-токеном, привязанным к сессии. Токен передаётся в заголовке `x-csrf-token` и верифицируется на сервере. CSRF-токен детерминировано выводится из session-токена (HMAC) и не требует отдельного хранения.

## Критерии приёмки

| Метрика                         | Целевое значение                                       | Способ проверки                                     |
| ------------------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| CSRF-защита mutation            | POST/PUT/PATCH/DELETE без CSRF-токена возвращают 403   | Тест: mutation без CSRF — 403                       |
| Вывод из сессии                 | CSRF-токен детерминировано выводится из session-токена | Проверка: одинаковый CSRF для одного session-токена |
| Разные токены для разных сессий | Разные session-токены дают разные CSRF-токены          | Проверка: уникальность                              |
| GET без защиты                  | GET-запросы не требуют CSRF-токена                     | Тест: GET без CSRF — 200                            |

## Связанные требования

- `BR-constraint.auth.sessions`
- `REQ-NFR-security.compliance.session-auth`
- `REQ-NFR-security.compliance.origin-validation`
- `REQ-NFR-api.compliance.request-validation`

## See Also

- [REQ-NFR-security.compliance.session-auth](REQ-NFR-security.compliance.session-auth.md)
- [REQ-NFR-security.compliance.origin-validation](REQ-NFR-security.compliance.origin-validation.md)
- [REQ-NFR-api.compliance.request-validation](REQ-NFR-api.compliance.request-validation.md)
