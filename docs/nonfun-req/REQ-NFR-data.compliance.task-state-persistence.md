[← Back to README](README.md)

# REQ-NFR-data.compliance.task-state-persistence

**Приоритет:** P0
**Статус:** implemented
**Класс:** as is
**Источник:** G5 (доступность состояния после сбоя); §2.6 (ограничение 3 — единая БД проекта); A3 (восстановление состояния после перезапуска)
**Ключевая функция:** HF1, HF10
**Домен L1:** pipeline

## Описание

Состояние задачи и её статус не теряются при перезапуске API-сервера, coordinator или веб-интерфейса. База данных восстанавливается в согласованном состоянии после любого штатного или аварийного завершения. Система не использует in-memory кэш как источник истины.

## Критерии приёмки

| Метрика                                           | Целевое значение                                                                          | Способ проверки                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Сохранность состояния при перезапуске API         | 100% задач сохраняют актуальный статус после перезапуска                                  | Сквозной тест: создать задачу, перезапустить сервер, проверить статус |
| Сохранность состояния при перезапуске coordinator | 100% задач сохраняют актуальный статус после остановки coordinator                        | Интеграционный тест                                                   |
| Восстановление незавершённых задач                | Задачи в промежуточных стадиях восстанавливаются в корректное состояние после перезапуска | Интеграционный тест: имитация аварийного завершения                   |

## Связанные требования

- `BR-constraint.task-lifecycle.transitions`
- `BR-trigger.task-lifecycle.blocked`
- `REQ-NFR-data.compliance.task-transactional-consistency`
- `REQ-NFR-api.availability.coordinator-resilience`

## See Also

- [REQ-NFR-data.compliance.task-transactional-consistency](REQ-NFR-data.compliance.task-transactional-consistency.md)
- [REQ-NFR-api.availability.coordinator-resilience](REQ-NFR-api.availability.coordinator-resilience.md)
- [REQ-NFR-ops.observability.audit-trail-completeness](REQ-NFR-ops.observability.audit-trail-completeness.md)
