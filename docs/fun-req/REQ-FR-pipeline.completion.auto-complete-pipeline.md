[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-pipeline.completion.auto-complete-pipeline: Автоматическое завершение конвейера с код-ревью

**Приоритет:** P0

**Ключевая функция:** HF1.6 Завершение конвейера

**Источник:** [UC-pipeline.completion.auto-complete-pipeline](../use-cases/UC-pipeline.completion.auto-complete-pipeline.md), BR-automation.pipeline, BR-automation.completion-commit, BR-automation.auto-review

**Статус:** proposed

**Класс:** as is

**Канал:** Agent (runtime adapter → AI provider, Git)

**Описание:** Coordinator запускает ревьюера (review-sidecar) для задачи в статусе `review`. Ревьюер выполняет код-ревью реализованного изменения с использованием легковесной модели (lightModel). При успехе Coordinator выполняет autoQueueCommit и переводит задачу в `done`. При обнаружении проблем задача возвращается на доработку.

**Критерии приёмки:**

1. Coordinator выбирает задачу в статусе `review`.
2. Coordinator запускает `runReviewer` — read-only sidecar-агент.
3. Ревьюер использует `lightModel` (легковесную модель для экономии затрат).
4. Загружает agent definition `review-sidecar`.
5. AI-провайдер выполняет код-ревью: анализ изменённых файлов, поиск дефектов, уязвимостей, нарушений стиля.
6. При успехе ревью:
   - Coordinator выполняет `autoQueueCommit` — gate-коммит с приведением к целевой ветке.
   - Задача переводится в `done`.
7. При обнаружении проблем задача возвращается в `implementing` с `reworkRequested=true`, инкрементируется `reviewIterationCount`.
8. Если `skipReview=true`, Coordinator пропускает review и переводит задачу из `verify` в `done` через `autoQueueCommit`.
9. При `autoQueueMode=true` после `done` задача автоматически переходит в `accepted`.
10. Результаты ревью сохраняются как `AutoReviewState` (findings, strategy, iteration).
11. При ошибке коммита задача блокируется с `blocked_external`.

## See Also

- [REQ-FR-pipeline.review-loop.iterate-review-feedback](REQ-FR-pipeline.review-loop.iterate-review-feedback.md) — цикл ревью
- [REQ-FR-vcs-auto.commit.auto-commit-before-completion](REQ-FR-vcs-auto.commit.auto-commit-before-completion.md) — auto-queue коммит
- [REQ-FR-pipeline.sidecar.run-read-only-review](REQ-FR-pipeline.sidecar.run-read-only-review.md) — sidecar-агенты
