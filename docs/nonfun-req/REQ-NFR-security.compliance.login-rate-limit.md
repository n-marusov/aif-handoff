[← REQ-NFR-security.compliance.origin-validation](REQ-NFR-security.compliance.origin-validation.md) · [Back to README](README.md) · [REQ-NFR-integration.availability.vcs-rate-limit-resilience →](REQ-NFR-integration.availability.vcs-rate-limit-resilience.md)

# REQ-NFR-security.compliance.login-rate-limit

**Приоритет:** P1
**Статус:** implemented
**Класс:** to be (Фаза 2 — участники и аутентификация)
**Источник:** G2 (безопасность); `BR-constraint.auth.sessions` (ограничение частоты попыток входа); `BR-constraint.auth.credentials`
**Ключевая функция:** HF9, HF9.1
**Домен L1:** dashboard

## Описание

Попытки входа в систему участников ограничены по частоте: не более N неудачных попыток за временное окно. Окно и лимит конфигурируются через переменные окружения. После превышения лимита новые попытки временно блокируются.

## Критерии приёмки

| Метрика                     | Целевое значение                                                    | Способ проверки                          |
| --------------------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| Лимит неудачных попыток     | Не более PARTICIPANT_LOGIN_RATE_LIMIT_MAX (10 по умолчанию) за окно | Тест: N+1 неудачных попыток — блокировка |
| Временное окно              | Окно PARTICIPANT_LOGIN_RATE_LIMIT_WINDOW_MS (60 с по умолчанию)     | Проверка: значение по умолчанию          |
| Конфигурируемость           | Лимит и окно изменяются через переменные окружения                  | Проверка: установка, подтверждение       |
| Сброс после успешного входа | После успешного входа счётчик сбрасывается                          | Тест: N-1 неудачных + успешный = сброс   |

## Связанные требования

- `BR-constraint.auth.sessions`
- `BR-constraint.auth.credentials`
- `REQ-NFR-security.compliance.session-auth`
- `REQ-NFR-security.compliance.password-storage`

## See Also

- [REQ-NFR-security.compliance.session-auth](REQ-NFR-security.compliance.session-auth.md)
- [REQ-NFR-security.compliance.password-storage](REQ-NFR-security.compliance.password-storage.md)
- [REQ-NFR-api.compliance.rate-limit-requests](REQ-NFR-api.compliance.rate-limit-requests.md)
