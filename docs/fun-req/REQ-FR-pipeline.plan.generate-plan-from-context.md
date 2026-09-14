[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-pipeline.plan.generate-plan-from-context: Генерация плана изменения AI-планировщиком

**Приоритет:** P0

**Ключевая функция:** HF1.2 Планирование изменения AI

**Источник:** [UC-pipeline.plan.generate-change-plan](../use-cases/UC-pipeline.plan.generate-change-plan.md), BR-trigger.automation.pipeline, BR-constraint.git.worktree-isolation

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (runtime adapter → AI provider)

**Описание:** Coordinator запускает AI-планировщика (plan-coordinator) для задачи в статусе `planning`. Планировщик анализирует описание задачи, контекст проекта, генерирует Change Plan и сохраняет его в БД и файловой системе (worktree). Задача переходит в `plan_review` (или `improve` при `runPlanImprove=true`).

**Критерии приёмки:**

1. Coordinator выбирает задачу в статусе `planning` и захватывает её (`claimTask`).
2. Coordinator инициализирует Git worktree для задачи (изолированная ветка от base branch).
3. Coordinator запускает `runPlanner` — субагент-планировщик с agent definition `plan-coordinator`.
4. Планировщик разрешает runtime-профиль: для `planning` стадии используется `planRuntimeProfileId` из проекта или системы.
5. AI-провайдер через runtime-адаптер выполняет промпт планировщика, анализируя задачу, код проекта и зависимости.
6. Сгенерированный Change Plan сохраняется в БД (`persistTaskPlanForTask`) — поля `planPath`, `planDocs`.
7. План сохраняется в файл `plan.md` в worktree задачи.
8. Планировщик фиксирует снапшот лимитов runtime (`persistTaskRuntimeLimitSnapshot`).
9. Coordinator переводит задачу в следующий статус: `plan_review` (обычный режим) или `improve` (при `runPlanImprove=true`).
10. При ошибке AI-провайдера ErrorClassifier определяет категорию; Coordinator блокирует задачу с указанием причины и `retryAfter`.
11. Для fast-fix сценария (`isFix=true`) Coordinator использует упрощённый промпт без глубокого анализа.

## See Also

- [REQ-FR-pipeline.plan.refine-plan-second-pass](REQ-FR-pipeline.plan.refine-plan-second-pass.md) — второй проход Improve
- [REQ-FR-vcs-auto.isolation.create-worktree](../vcs-auto/REQ-FR-vcs-auto.isolation.create-worktree.md) — изоляция worktree
- [REQ-FR-audit.errors.classify-runtime-error](REQ-FR-audit.errors.classify-runtime-error.md) — классификация ошибок
