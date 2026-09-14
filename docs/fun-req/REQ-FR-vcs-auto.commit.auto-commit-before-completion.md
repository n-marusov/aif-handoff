[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-vcs-auto.commit.auto-commit-before-completion: Автоматический коммит изменений перед завершением

**Приоритет:** P0

**Ключевая функция:** HF4.2 Автоматические коммиты

**Источник:** [UC-vcs-auto.commit.auto-commit-before-completion](../use-cases/UC-vcs-auto.commit.auto-commit-before-completion.md), BR-constraint.git.commit-conventions, BR-trigger.automation.completion-commit, BR-inference.git.convention-resolution

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (Git)

**Описание:** Перед переходом задачи в терминальную стадию (done/accepted) Coordinator выполняет auto-queue коммит всех изменений в worktree. Gate-коммит проверяет, что все изменения закоммичены, и создаёт commit с сообщением по конвенциям проекта. Отдельный gate для плана (`planReviewCommit.ts`).

**Критерии приёмки:**

1. Перед переходом задачи в `done` Coordinator вызывает `ensureCommitBeforeTerminalStatus`.
2. Проверяет `autoQueueCommitStatus` — если уже committed, пропускает.
3. Выполняет `git add .` и `git commit -m {message}` в worktree задачи.
4. Сообщение коммита генерируется по конвенциям проекта (Conventional Commits, Gitmoji).
5. `commitSha` и `autoQueueCommitBaseSha` (текущая база) сохраняются в задаче.
6. При ошибке коммита задача блокируется с `blocked_external`.
7. `scheduledTaskHasDirtyAutoQueueWorktree` проверяет, что нет незакоммиченных изменений от предыдущих задач.
8. `planReviewCommit.ts` — отдельный gate-коммит плана перед публикацией PR/MR для plan review.

## See Also

- [REQ-FR-vcs-auto.plan-review.publish-plan-for-approval](REQ-FR-vcs-auto.plan-review.publish-plan-for-approval.md) — Plan Review Gate
- [REQ-FR-vcs-auto.isolation.create-worktree](REQ-FR-vcs-auto.isolation.create-worktree.md) — изоляция worktree
- [REQ-FR-vcs-auto.mr.publish-atomic-merge-request](REQ-FR-vcs-auto.mr.publish-atomic-merge-request.md) — публикация MR/PR
