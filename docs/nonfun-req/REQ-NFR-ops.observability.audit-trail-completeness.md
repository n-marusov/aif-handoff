[← REQ-NFR-data.compliance.task-state-persistence](REQ-NFR-data.compliance.task-state-persistence.md) · [Back to README](README.md) · [REQ-NFR-data.compliance.task-transactional-consistency →](REQ-NFR-data.compliance.task-transactional-consistency.md)

# REQ-NFR-ops.observability.audit-trail-completeness

**Приоритет:** P0
**Статус:** implemented
**Класс:** as is
**Источник:** G3 (проверяемость действий); `BR-constraint.audit.immutable-trail`; `BR-fact.audit.actor-identity`
**Ключевая функция:** HF10, HF10.1
**Домен L1:** dashboard

## Описание

100% переходов задач между стадиями конвейера и все авторизованные действия участников фиксируются в иммутабельном журнале аудита. Каждая запись содержит актора, тип действия, затронутую сущность, снимок состояния задачи на момент действия и временную метку. Записи аудита не редактируются и не удаляются через API.

## Критерии приёмки

| Метрика                    | Целевое значение                                           | Способ проверки                                                   |
| -------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| Полнота фиксации переходов | 100% переходов статуса записаны в аудит                    | Сквозной тест: выполнить N переходов, проверить N записей         |
| Полнота фиксации действий  | 100% авторизованных действий записаны                      | Тест на каждое действие                                           |
| Атрибуция актора           | Каждая запись содержит валидного актора                    | Проверка: отсутствие записей с пустым актором в штатных сценариях |
| Иммутабельность            | Запись аудита не может быть изменена или удалена через API | Тест: попытка удалить запись через API возвращает ошибку          |

## Связанные требования

- `BR-constraint.audit.immutable-trail`
- `BR-fact.audit.actor-identity`
- `BR-constraint.audit.state-snapshot`
- `BR-fact.audit.observability`
- `REQ-NFR-data.compliance.task-transactional-consistency`
- `REQ-NFR-ops.observability.error-categorization`

## See Also

- [REQ-NFR-data.compliance.task-transactional-consistency](REQ-NFR-data.compliance.task-transactional-consistency.md)
- [REQ-NFR-ops.observability.error-categorization](REQ-NFR-ops.observability.error-categorization.md)
- [REQ-NFR-ops.observability.heartbeat-detection](REQ-NFR-ops.observability.heartbeat-detection.md)
