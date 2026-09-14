[← REQ-NFR-security.compliance.csrf-protection](REQ-NFR-security.compliance.csrf-protection.md) · [Back to README](README.md) · [REQ-NFR-security.compliance.origin-validation →](REQ-NFR-security.compliance.origin-validation.md)

# REQ-NFR-security.compliance.password-storage

**Приоритет:** P1
**Статус:** implemented
**Класс:** to be (Фаза 2 — участники и аутентификация)
**Источник:** G2 (безопасность паролей); `BR-constraint.auth.credentials`
**Ключевая функция:** HF9, HF9.1
**Домен L1:** dashboard

## Описание

Пароли участников хешируются алгоритмом scrypt с индивидуальной криптографической солью перед сохранением в БД. Сравнение паролей при аутентификации выполняется через constant-time сравнение (timingSafeEqual). Несуществующие учётные записи обрабатываются через dummy-хеш для защиты от timing-атак.

## Критерии приёмки

| Метрика                 | Целевое значение                                                             | Способ проверки                                                      |
| ----------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Хеширование пароля      | Пароль не хранится в открытом виде                                           | Проверка: raw password не появляется в данных БД                     |
| Соль                    | Каждый хеш имеет уникальную соль                                             | Проверка: разные соли для разных паролей                             |
| Constant-time сравнение | Сравнение использует timingSafeEqual                                         | Ревью кода                                                           |
| Dummy-хеш               | Несуществующий пользователь не раскрывает факт отсутствия через время ответа | Тест: замер времени для существующего и несуществующего пользователя |
| Алгоритм                | Scrypt с параметрами N≥16384, r=8, p=1                                       | Ревью конфигурации хеширования                                       |

## Связанные требования

- `BR-constraint.auth.credentials`
- `REQ-NFR-security.compliance.session-auth`
- `REQ-NFR-security.compliance.login-rate-limit`
- `REQ-NFR-security.compliance.csrf-protection`

## See Also

- [REQ-NFR-security.compliance.session-auth](REQ-NFR-security.compliance.session-auth.md)
- [REQ-NFR-security.compliance.login-rate-limit](REQ-NFR-security.compliance.login-rate-limit.md)
- [REQ-NFR-security.compliance.csrf-protection](REQ-NFR-security.compliance.csrf-protection.md)
