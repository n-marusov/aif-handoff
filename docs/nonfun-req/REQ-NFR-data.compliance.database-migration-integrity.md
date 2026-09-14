[← REQ-NFR-infra.performance.concurrency-limits](REQ-NFR-infra.performance.concurrency-limits.md) · [Back to README](README.md) · [REQ-NFR-api.compliance.rate-limit-requests →](REQ-NFR-api.compliance.rate-limit-requests.md)

# REQ-NFR-data.compliance.database-migration-integrity

**Приоритет:** P2
**Статус:** implemented
**Класс:** as is
**Источник:** §2.6 (ограничение 3 — единая БД проекта); A3 (восстановление состояния после перезапуска)
**Ключевая функция:** HF1
**Домен L1:** data

## Описание

Миграции схемы SQLite выполняются в append-only режиме: существующие миграции не изменяются и не перенумеровываются. Номер версии (PRAGMA user_version) монотонно возрастает. Пропущенные миграции не допускаются — если БД отстаёт, миграции выполняются последовательно. Ошибки миграции не повреждают пользовательские данные: ADD COLUMN для существующего столбца игнорируется без ошибки (дублирование столбца не крашит БД).

## Критерии приёмки

| Метрика                 | Целевое значение                                                | Способ проверки                                                         |
| ----------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Append-only             | Существующие миграции не редактируются после merge              | Политика: ревью кода, CI-проверка                                       |
| Монотонный номер версии | user_version увеличивается с каждой миграцией                   | Проверка: user_version N после миграции                                 |
| Последовательность      | Пропущенная миграция не скипается — выполняются все недостающие | Тест: БД с user_version=1, миграции до v=5, проверка всех промежуточных |
| Idempotent ADD COLUMN   | ADD COLUMN существующего столбца не вызывает ошибки             | Тест: повторный запуск миграции                                         |
| Отсутствие повреждения  | Ошибка миграции не оставляет БД в несогласованном состоянии     | Тест: имитация сбоя mid-migration                                       |

## Связанные требования

- `REQ-NFR-data.compliance.task-state-persistence`
- `BR-constraint.task-lifecycle.transitions`

## See Also

- [REQ-NFR-data.compliance.task-state-persistence](REQ-NFR-data.compliance.task-state-persistence.md)
- [REQ-NFR-data.compliance.task-transactional-consistency](REQ-NFR-data.compliance.task-transactional-consistency.md)
