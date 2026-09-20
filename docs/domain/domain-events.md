# Доменные события — AIF Handoff

> Источники: `packages/shared/src/stateMachine.ts`, `packages/shared/src/taskLifecycle.ts`, `packages/api/src/use-cases/taskEvents.ts`, `packages/agent/src/coordinator.ts`, `packages/agent/src/*Workflow.ts`, `packages/data/src/audit.ts`.

## 1. Каталог событий

| Событие (PascalCase)           | Триггер                                                                | Producer (контекст)      | Consumer                      | Эскиз payload                                |
| ------------------------------ | ---------------------------------------------------------------------- | ------------------------ | ----------------------------- | -------------------------------------------- |
| `TaskCreated`                  | Создание задачи через API/MCP                                          | task-lifecycle           | collaboration, runtime        | `{taskId, projectId, title, createdBy}`      |
| `TaskStageTransitionRequested` | Запрос перехода стадии                                                 | task-lifecycle           | task-lifecycle                | `{taskId, from, to, actor}`                  |
| `TaskStageTransitionApplied`   | Переход подтверждён state machine                                      | task-lifecycle           | runtime, integration          | `{taskId, fromStage, toStage, at}`           |
| `TaskAssigned`                 | Назначен исполнитель                                                   | collaboration-governance | task-lifecycle                | `{taskId, owner}`                            |
| `TaskOwnershipTransferred`     | Handoff human↔AI                                                       | collaboration-governance | task-lifecycle, audit         | `{taskId, fromOwner, toOwner, reason}`       |
| `TaskPlanGenerated`            | Сформирован план                                                       | task-lifecycle           | integration, review           | `{taskId, planVersion}`                      |
| `TaskPlanReviewed`             | Решение план-ревью                                                     | task-lifecycle           | runtime, integration          | `{taskId, decision, reviewer}`               |
| `TaskImplementationStarted`    | Старт implement stage                                                  | runtime-orchestration    | task-lifecycle                | `{taskId, runtimeProfileId, worker}`         |
| `TaskImplementationCompleted`  | Завершение implementation                                              | runtime-orchestration    | task-lifecycle                | `{taskId, result}`                           |
| `TaskVerifyStarted`            | Старт verify stage                                                     | runtime-orchestration    | task-lifecycle                | `{taskId, runtimeProfileId}`                 |
| `TaskVerifyCompleted`          | Завершение verify                                                      | runtime-orchestration    | task-lifecycle                | `{taskId, passed, findings}`                 |
| `TaskReviewStarted`            | Старт review                                                           | runtime-orchestration    | task-lifecycle                | `{taskId, strategy}`                         |
| `TaskReviewConverged`          | Auto-review сошёлся                                                    | runtime-orchestration    | task-lifecycle                | `{taskId, iterations}`                       |
| `TaskReviewEscalatedToManual`  | Несходимость auto-review или новые блокеры при closure-first стратегии | runtime-orchestration    | task-lifecycle, collaboration | `{taskId, manualReviewRequired: true}`       |
| `RuntimeProfileResolved`       | Выбран эффективный профиль                                             | runtime-orchestration    | runtime-orchestration         | `{taskId, scope, runtimeId, providerId}`     |
| `RuntimeExecutionFailed`       | Ошибка адаптера/транспорта                                             | runtime-orchestration    | task-lifecycle, audit         | `{taskId, category, adapterCode, retryable}` |
| `PlanReviewPublished`          | Публикация plan PR/MR                                                  | integration-sync         | collaboration                 | `{taskId, provider, changeRequestId}`        |
| `TaskSyncedViaMcp`             | Синхронизация через MCP                                                | integration-sync         | task-lifecycle                | `{taskId, tool, direction}`                  |

## 2. Матрица каскадов

| Исходное событие                                  | Последующие события                                                                                                                 | Контекст                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `TaskCreated`                                     | → `TaskStageTransitionRequested` (`Backlog → Planning`) → `TaskStageTransitionApplied`                                              | task-lifecycle                         |
| `TaskStageTransitionApplied` (`Planning/Improve`) | → `TaskPlanGenerated` → `TaskPlanReviewed`                                                                                          | task-lifecycle                         |
| `TaskPlanReviewed` (approved)                     | → `TaskStageTransitionApplied` (`Plan Review → Implementing`) → `TaskImplementationStarted`                                         | task-lifecycle → runtime-orchestration |
| `TaskImplementationCompleted`                     | → `TaskStageTransitionApplied` (`Implementing → Verify`) → `TaskVerifyStarted` → `TaskVerifyCompleted`                              | runtime-orchestration                  |
| `TaskVerifyCompleted` (passed)                    | → `TaskStageTransitionApplied` (`Verify → Review`) → `TaskReviewStarted` → (`TaskReviewConverged` \| `TaskReviewEscalatedToManual`) | runtime-orchestration                  |
| `TaskReviewConverged`                             | → `TaskStageTransitionApplied` (`Review → Done`)                                                                                    | runtime-orchestration                  |
| `TaskReviewEscalatedToManual`                     | → `TaskAssigned` (human owner)                                                                                                      | runtime-orchestration → collaboration  |
| `PlanReviewPublished`                             | → внешняя обратная связь PR/MR → `TaskStageTransitionRequested`                                                                     | integration-sync                       |
| `RuntimeExecutionFailed`                          | → retry / fallback / ручная эскалация                                                                                               | runtime-orchestration + collaboration  |

## 3. Интеграционные представления

| Ключ представления            | Соответствующее событие       | Канал                     |
| ----------------------------- | ----------------------------- | ------------------------- |
| `task.plan.review.published`  | `PlanReviewPublished`         | GitHub/GitLab API         |
| `task.review.manual-required` | `TaskReviewEscalatedToManual` | UI/WebSocket notification |
| `task.sync.mcp`               | `TaskSyncedViaMcp`            | MCP transport             |

> Внешние представления должны быть идемпотентными: повторная отправка не должна менять доменное состояние при неизменном `taskId + stage + changeRequestId/eventKey`.

## 4. Внешние триггеры

| Событие                      | Producer (внеш.) | Consumer              | Канал                   |
| ---------------------------- | ---------------- | --------------------- | ----------------------- |
| `GitPullRequestCommented`    | GitHub/GitLab    | integration-sync      | Webhook/API polling     |
| `McpToolInvocationRequested` | MCP client       | integration-sync      | MCP protocol            |
| `RuntimeProviderRateLimited` | Runtime provider | runtime-orchestration | SDK/API/CLI diagnostics |

## Связанные артефакты

- [Карта контекстов](context-map.md)
- [Агрегаты](aggregates.md)
- [Словарь данных](data-dictionary.md)
- [API Reference](../api.md)
- [MCP Sync](../mcp-sync.md)
