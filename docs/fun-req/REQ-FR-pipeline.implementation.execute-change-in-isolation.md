[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-pipeline.implementation.execute-change-in-isolation: Реализация изменения в изолированном контексте

**Приоритет:** P0

**Ключевая функция:** HF1.4 Реализация изменения AI, HF4.1 Изолированное выполнение

**Источник:** [UC-pipeline.implementation.execute-change-in-isolation](../use-cases/UC-pipeline.implementation.execute-change-in-isolation.md), BR-constraint.git.worktree-isolation, BR-trigger.automation.completion-commit

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (runtime adapter → AI provider, Git worktree)

**Описание:** Coordinator запускает AI-реализатора (implement-coordinator) для задачи в статусе `plan_review` или `implementing`. Реализатор выполняет код изменения в изолированном Git worktree согласно утверждённому плану, сохраняет лог выполнения и снапшот лимитов. Перед переходом в `verify` выполняется gate-коммит.

**Критерии приёмки:**

1. Coordinator выбирает задачу в статусе `plan_review` (первичный запуск) или `implementing` (rework).
2. Coordinator проверяет Git worktree задачи: если отсутствует — создаёт (`git worktree add` с веткой от base branch).
3. Coordinator запускает `runImplementer` — субагент-реализатор с agent definition `implement-coordinator`.
4. Реализатор читает план задачи, разрешает runtime-профиль.
5. AI-провайдер через runtime-адаптер выполняет реализацию: читает/изменяет файлы, запускает команды в worktree.
6. Реализатор сохраняет лог выполнения и снапшот лимитов (`persistTaskRuntimeLimitSnapshot`).
7. Coordinator выполняет `ensureCommitBeforeTerminalStatus` — gate-коммит всех изменений перед переходом в `verify`.
8. Coordinator переводит задачу в статус `verify`.
9. Coordinator отправляет WS-событие `task:stageChanged`.
10. Для fast-fix (`isFix=true`) Coordinator использует ускоренный промпт без полного plan review.
11. При rework Coordinator устанавливает `reworkRequested=true`, инкрементирует `reviewIterationCount`.
12. Если `scheduledAt` в будущем, задача ожидает на `implementing` до наступления времени.
13. При ошибке выполнения ErrorClassifier (rate_limit, tool_error, auth) — Coordinator инкрементирует `retryCount` и блокирует задачу.

## See Also

- [REQ-FR-vcs-auto.isolation.create-worktree](REQ-FR-vcs-auto.isolation.create-worktree.md) — изоляция worktree
- [REQ-FR-pipeline.verification.verify-change-result](REQ-FR-pipeline.verification.verify-change-result.md) — верификация результата
- [REQ-FR-vcs-auto.commit.auto-commit-before-completion](REQ-FR-vcs-auto.commit.auto-commit-before-completion.md) — gate-коммит
