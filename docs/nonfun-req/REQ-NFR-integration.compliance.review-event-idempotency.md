[← REQ-NFR-integration.availability.vcs-rate-limit-resilience](REQ-NFR-integration.availability.vcs-rate-limit-resilience.md) · [Back to README](README.md) · [REQ-NFR-integration.availability.runtime-provider-fallback →](REQ-NFR-integration.availability.runtime-provider-fallback.md)

# REQ-NFR-integration.compliance.review-event-idempotency

**Приоритет:** P1
**Статус:** implemented
**Класс:** as is
**Источник:** G3 (формальные гейты — детерминированные условия перехода); G4 (автоматизация VCS — бесперебойность); `BR-inference.git.review-decision-precedence`; `BR-trigger.automation.plan-review-gate`; реверс-инжиниринг реализации
**Ключевая функция:** HF11, HF11.1, HF11.2
**Домен L1:** integration

## Описание

Обработка решений ревью внешней VCS-системы идемпотентна и не теряет события. Каждое решение ревьюера (одобрение, отзыв одобрения, запрос изменений, слияние) применяется к задаче не более одного раза: отметка об обработанном решении сохраняется только после успешного перехода, поэтому повторные сверки не «отбрасывают» задачу назад и не применяют устаревшее решение. Если переход не удался из-за конкурентного изменения состояния задачи, решение остаётся необработанным и применяется при следующей сверке — событие не теряется.

## Критерии приёмки

| Метрика                   | Целевое значение                                                                                     | Способ проверки                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Однократность применения  | Повторная сверка с тем же решением ревьюера не меняет состояние задачи                               | Тест: две последовательные сверки с одним решением — состояние после второй совпадает с состоянием после первой |
| Отсутствие потери события | Решение, не применённое из-за конкурентного изменения состояния, применяется при следующей сверке    | Тест: имитация отвергнутого перехода — следующая сверка переводит задачу                                        |
| Порядок отметки           | Отметка об обработке решения сохраняется только после успешного перехода задачи                      | Тест: при отвергнутом переходе отметка не сохраняется                                                           |
| Наблюдаемость отказа      | Отказ применения решения фиксируется в журнале с текущим состоянием задачи и идентификатором решения | Проверка журнала (уровень error)                                                                                |

## Связанные требования

- `BR-inference.git.review-decision-precedence`
- `BR-trigger.automation.plan-review-gate`
- `REQ-NFR-data.compliance.task-transactional-consistency`
- `REQ-NFR-ops.observability.audit-trail-completeness`
- `REQ-NFR-integration.availability.vcs-rate-limit-resilience`
- `REQ-FR-integration.pr-mr.resolve-review-decision`

## See Also

- [REQ-NFR-data.compliance.task-transactional-consistency](REQ-NFR-data.compliance.task-transactional-consistency.md)
- [REQ-NFR-integration.availability.vcs-rate-limit-resilience](REQ-NFR-integration.availability.vcs-rate-limit-resilience.md)
- [REQ-FR-integration.pr-mr.resolve-review-decision](../fun-req/REQ-FR-integration.pr-mr.resolve-review-decision.md)
