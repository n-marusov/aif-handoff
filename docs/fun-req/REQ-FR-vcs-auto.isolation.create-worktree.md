[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-vcs-auto.isolation.create-worktree: Изолированное выполнение задачи в Git worktree

**Приоритет:** P0

**Ключевая функция:** HF4.1 Изолированное выполнение

**Источник:** [UC-vcs-auto.isolation.execute-task-in-worktree](../use-cases/UC-vcs-auto.isolation.execute-task-in-worktree.md), BR-constraint.git.worktree-isolation, BR-constraint.git.branch-naming

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (Git worktree)

**Описание:** Coordinator создаёт изолированный Git worktree для каждой задачи: отдельная ветка от base branch, собственное рабочее дерево. Параллельные задачи не создают конфликтов. Worktree очищается при завершении задачи. Stale worktree-ы обнаруживаются и очищаются.

**Критерии приёмки:**

1. Coordinator определяет `branchName` на основе project conventions и taskId.
2. Coordinator создаёт Git worktree: `git worktree add {worktreePath} {baseBranch}`.
3. В worktree создаётся новая ветка от base branch.
4. `worktreePath` и `branchName` сохраняются в БД на задаче.
5. Subagent-Implementer работает внутри worktree (изолирован от других задач).
6. По завершении задачи (done + accepted) Coordinator очищает worktree (`git worktree remove`).
7. Для проектов с `parallelEnabled=false` используется общая ветка и последовательное выполнение.
8. Для autoQueue-проектов используется единый worktree с общим auto-queue коммитом.
9. `worktreeReconcile.ts` и `worktreeLifecycle.ts` находят и очищают осиротевшие worktree-ы (stash-before-remove).
10. `isFix=true` может использовать общую ветку с быстрым коммитом.
11. Если `config.base_branch = "main"` не существует локально, Coordinator определяет базовую ветку по цепочке fallback: `origin/HEAD → "master" → getCurrentBranch() (HEAD)`. При неудаче всех шагов задача блокируется с `blocked_external` и кодом `base_branch_unavailable`.

## See Also

- [REQ-FR-pipeline.implementation.execute-change-in-isolation](REQ-FR-pipeline.implementation.execute-change-in-isolation.md) — реализация в worktree
- [REQ-FR-vcs-auto.commit.auto-commit-before-completion](REQ-FR-vcs-auto.commit.auto-commit-before-completion.md) — auto-queue коммит
- [REQ-FR-vcs-auto.plan-review.publish-plan-for-approval](REQ-FR-vcs-auto.plan-review.publish-plan-for-approval.md) — Plan Review Gate
