[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-vcs-auto.plan-review.publish-plan-for-approval: Публикация плана для утверждения (Plan Review Gate)

**Приоритет:** P1

**Ключевая функция:** HF4.4 Plan Review Gate

**Источник:** [UC-vcs-auto.plan-review.publish-plan-for-approval](../use-cases/UC-vcs-auto.plan-review.publish-plan-for-approval.md), BR-trigger.automation.plan-review-gate, BR-fact.git.vcs-workflow

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (Git + VCS API)

**Описание:** Coordinator публикует Change Plan задачи как отдельный commit + PR/MR для утверждения человеком. Plan Review Gate встраивается между `plan_review` и `implementing`: задача ждёт approval или feedback через VCS-интерфейс или UI.

**Критерии приёмки:**

1. Coordinator обнаруживает задачу с `planReviewState=pending` в статусе `plan_review`.
2. Coordinator запускает `runPlanReviewPublisher`.
3. `planReviewCommit.ts` создаёт commit только с планом (без кода реализации).
4. `planReviewPublisher.ts` пушит ветку и создаёт PR/MR в Draft-режиме (WIP).
5. Сохраняется `planReviewPublishedAt`, `planReviewCommitSha`.
6. Coordinator ожидает: Plan Review Gate проверяет `planReviewState` на каждом poll-цикле.
7. При `planReviewState=approved` (через `markTaskPlanApproved` или UI/VCS-webhook) задача переходит в `implementing`.
8. При `planReviewState=changes_requested` задача возвращается в `planning`/`improve`.
9. Если `planReviewState=null` — задача переходит в `implementing` без gate.
10. Reviewer может оставлять комментарии в PR/MR; `planReviewFeedback` сохраняется.

## See Also

- [REQ-FR-pipeline.plan.generate-plan-from-context](REQ-FR-pipeline.plan.generate-plan-from-context.md) — генерация плана
- [REQ-FR-vcs-auto.commit.auto-commit-before-completion](REQ-FR-vcs-auto.commit.auto-commit-before-completion.md) — gate-коммит
- [REQ-FR-integration.pr-mr.publish-github-pr](REQ-FR-integration.pr-mr.publish-github-pr.md) — публикация PR
