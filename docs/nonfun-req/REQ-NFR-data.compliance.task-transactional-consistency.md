[← REQ-NFR-ops.observability.audit-trail-completeness](REQ-NFR-ops.observability.audit-trail-completeness.md) · [Back to README](README.md) · [REQ-NFR-api.availability.coordinator-resilience →](REQ-NFR-api.availability.coordinator-resilience.md)

# REQ-NFR-data.compliance.task-transactional-consistency

**Приоритет:** P0
**Статус:** implemented
**Класс:** as is
**Источник:** G3 (формальные гейты — детерминированные условия перехода); G1 (hand-off-конвейер); `BR-constraint.task-lifecycle.transitions`; `BR-constraint.ownership.handoff`
**Ключевая функция:** HF1, HF1.1
**Домен L1:** pipeline

## Описание

Все переходы задач между стадиями конвейера выполняются атомарно: обновление статуса, фиксация события аудита и применение сопутствующих изменений происходят в одной транзакции. Конкурентные изменения статуса защищены: если статус изменился между чтением и записью, операция прерывается. Handoff-операции защищены от lost-update при параллельных передачах владения.

## Критерии приёмки

| Метрика             | Целевое значение                                                      | Способ проверки                                      |
| ------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| Атомарность         | Статус задачи и запись аудита всегда согласованы                      | Проверка: нет перехода без записи аудита             |
| Детекция конфликта  | Конкурентный переход с устаревшим статусом отвергается                | Тест: два параллельных перехода — второй отвергается |
| Lost-update handoff | Handoff с неактуальной версией владения отвергается                   | Тест: параллельные handoff — только один успешен     |
| Откат при ошибке    | При ошибке в любой части перехода транзакция откатывает все изменения | Тест: имитация сбоя, проверка согласованности        |

## Связанные требования

- `BR-constraint.task-lifecycle.transitions`
- `BR-constraint.ownership.handoff`
- `BR-constraint.audit.immutable-trail`
- `REQ-NFR-data.compliance.task-state-persistence`
- `REQ-NFR-ops.observability.audit-trail-completeness`

## See Also

- [REQ-NFR-data.compliance.task-state-persistence](REQ-NFR-data.compliance.task-state-persistence.md)
- [REQ-NFR-ops.observability.audit-trail-completeness](REQ-NFR-ops.observability.audit-trail-completeness.md)
- [REQ-NFR-api.availability.coordinator-resilience](REQ-NFR-api.availability.coordinator-resilience.md)
