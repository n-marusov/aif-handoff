[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-pipeline.plan.refine-plan-second-pass: Уточнение плана вторым проходом (Improve)

**Приоритет:** P1

**Ключевая функция:** HF1.3 Уточнение плана (Improve)

**Источник:** [UC-pipeline.plan.refine-plan-second-pass](../use-cases/UC-pipeline.plan.refine-plan-second-pass.md), BR-trigger.automation.pipeline, BR-constraint.task-lifecycle.transitions

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (runtime adapter → AI provider)

**Описание:** Если задача настроена с `runPlanImprove=true`, Coordinator запускает второй проход (improver) для проверки плана на полноту, противоречия и реализуемость. Improver читает текущий план и при необходимости генерирует уточнённую версию.

**Критерии приёмки:**

1. Coordinator выбирает задачу в статусе `improve`. Переход из `planning` в `improve` происходит только если `runPlanImprove=true`.
2. Coordinator запускает `runImprover` — субагент, реализующий второй проход планирования.
3. Improver читает текущий план из БД и контекст задачи (описание, attachments, теги).
4. Improver загружает agent definition `plan-improver` и выполняет промпт проверки плана.
5. AI-провайдер анализирует план на: полноту покрытия требований, противоречия между шагами и целевым состоянием, реализуемость с учётом архитектуры проекта.
6. При находке проблем Improver генерирует уточнённый план и сохраняет его через `persistTaskPlanForTask`.
7. Если план признан корректным, Improver фиксирует `passed` в результате без изменения плана.
8. Coordinator переводит задачу в `plan_review`.
9. Если `runPlanImprove=false` (Skills Mode), задача переходит из `planning` сразу в `plan_review` без запуска improver.
10. При ошибке AI-провайдера ErrorClassifier определяет категорию; Coordinator блокирует задачу.

## See Also

- [REQ-FR-pipeline.plan.generate-plan-from-context](REQ-FR-pipeline.plan.generate-plan-from-context.md) — первичная генерация плана
- [REQ-FR-pipeline.sidecar.run-read-only-review](REQ-FR-pipeline.sidecar.run-read-only-review.md) — sidecar-агенты
- [REQ-FR-audit.errors.classify-runtime-error](REQ-FR-audit.errors.classify-runtime-error.md) — классификация ошибок
