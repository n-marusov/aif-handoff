[← REQ-NFR-ops.observability.log-level-config](REQ-NFR-ops.observability.log-level-config.md) · [Back to README](README.md) · [REQ-NFR-security.compliance.session-auth →](REQ-NFR-security.compliance.session-auth.md)

# REQ-NFR-api.compliance.request-validation

**Приоритет:** P1
**Статус:** implemented
**Класс:** as is
**Источник:** G2 (целостность данных через API); G3 (формальные гейты — детерминированные условия); P4 (отсутствие формальных гейтов)
**Ключевая функция:** HF2, HF1
**Домен L1:** api

## Описание

Каждый мутирующий API-эндпоинт защищён валидацией входящих данных через схемы zod. Некорректные запросы отклоняются на уровне маршрута с кодом 400 и структурированным описанием ошибки валидации. Состояние системы не изменяется при получении невалидных данных.

## Критерии приёмки

| Метрика                        | Целевое значение                                     | Способ проверки                                |
| ------------------------------ | ---------------------------------------------------- | ---------------------------------------------- |
| Покрытие мутирующих эндпоинтов | 100% POST/PUT/PATCH эндпоинтов имеют zod-валидацию   | Audit кода: проверка каждого маршрута          |
| Отклонение невалидных данных   | Запрос с нарушением схемы возвращает 400             | Тест для каждой схемы: невалидные данные       |
| Структура ошибки               | 400 содержит код и описание нарушения                | Проверка: error.code, error.message            |
| Idempotent rejection           | Состояние системы не меняется при невалидном запросе | Тест: невалидный запрос не создаёт запись в БД |

## Связанные требования

- `REQ-NFR-security.compliance.session-auth`
- `REQ-NFR-api.compliance.rate-limit-requests`
- `REQ-NFR-security.compliance.csrf-protection`

## See Also

- [REQ-NFR-security.compliance.session-auth](REQ-NFR-security.compliance.session-auth.md)
- [REQ-NFR-security.compliance.csrf-protection](REQ-NFR-security.compliance.csrf-protection.md)
- [REQ-NFR-api.compliance.rate-limit-requests](REQ-NFR-api.compliance.rate-limit-requests.md)
