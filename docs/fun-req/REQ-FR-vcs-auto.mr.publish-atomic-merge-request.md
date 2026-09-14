[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-vcs-auto.mr.publish-atomic-merge-request: Создание единого atomic MR/PR

**Приоритет:** P2

**Ключевая функция:** HF4.3 Единый atomic MR

**Источник:** [UC-vcs-auto.mr.publish-atomic-merge-request](../use-cases/UC-vcs-auto.mr.publish-atomic-merge-request.md), BR-git.vcs-workflow

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (Git push + VCS API — GitHub/GitLab)

**Описание:** Coordinator создаёт единый Merge Request / Pull Request на GitHub или GitLab, объединяющий все изменения задачи в одну ветку. MR публикуется с описанием и связью с Issue. PR Mode может быть `plan_review` (план для утверждения) или `completion` (готовое изменение).

**Критерии приёмки:**

1. После auto-commit Coordinator выполняет `git push` ветки задачи в remote.
2. Coordinator создаёт PR/MR через REST API GitHub (`createPR`) или GitLab (`createMR`).
3. PR/MR включает: заголовок (название задачи), описание (Change Plan summary), assignees.
4. Для задач с `planReviewState=published` PR/MR публикуется в режиме plan review (Draft-режим).
5. Ссылка на PR/MR сохраняется в БД (`prUrl`, `prNumber`).
6. При ошибке VCS задача блокируется.

## See Also

- [REQ-FR-vcs-auto.plan-review.publish-plan-for-approval](REQ-FR-vcs-auto.plan-review.publish-plan-for-approval.md) — Plan Review Gate
- [REQ-FR-integration.pr-mr.publish-github-pr](REQ-FR-integration.pr-mr.publish-github-pr.md) — публикация PR
- [REQ-FR-vcs-auto.commit.auto-commit-before-completion](REQ-FR-vcs-auto.commit.auto-commit-before-completion.md) — коммит изменений
