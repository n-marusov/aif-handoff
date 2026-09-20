# Словарь данных — AIF Handoff

> **Назначение:** единый каталог ключевых доменных данных AIF Handoff: сущности, поля, их семантика, источники в коде и владельцы контекстов.

> **Источники:** `packages/shared/src/schema.ts`, `packages/shared/src/types.ts`, `packages/shared/src/stateMachine.ts`, `packages/data/src/*`, `packages/runtime/src/types.ts`, `packages/api/src/schemas.ts`.

## Условные обозначения

| Метка | Значение                                                   |
| ----- | ---------------------------------------------------------- |
| ✅    | Формализовано и явно поддерживается в коде                 |
| ⚠️    | Частично формализовано или зависит от контекста исполнения |
| ❌    | Концепт модели, не закреплённый как явный контракт         |

## 1. task-lifecycle (Core)

| Элемент                | Тип      | Обязат. | Описание                                                                                                                                            | Источник                                | Владелец       | Статус |
| ---------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------- | ------ |
| `taskId`               | `string` | да      | Уникальный идентификатор задачи                                                                                                                     | `schema.ts`, `tasks.ts`                 | task-lifecycle | ✅     |
| `projectId`            | `string` | да      | Принадлежность задачи проекту                                                                                                                       | `schema.ts`, `projects.ts`              | task-lifecycle | ✅     |
| `stage`                | `enum`   | да      | Текущая стадия: `Backlog/Planning/Improve/Plan Review/Implementing/Verify/Review/Done/Accepted` (+ `Blocked (External)` как состояние приостановки) | `stateMachine.ts`, `taskTransitions.ts` | task-lifecycle | ✅     |
| `status`               | `enum`   | да      | Статус выполнения внутри стадии                                                                                                                     | `schema.ts`, `tasks.ts`                 | task-lifecycle | ✅     |
| `manualReviewRequired` | `bool`   | нет     | Признак необходимости ручного ревью после несходимости auto-review                                                                                  | `tasks.ts`, UI task detail              | task-lifecycle | ✅     |
| `planBody`             | `text`   | нет     | Канонический план задачи                                                                                                                            | `taskPlan.ts`                           | task-lifecycle | ✅     |
| `planVersion`          | `int`    | нет     | Версия ревизии плана                                                                                                                                | `taskPlan.ts`                           | task-lifecycle | ⚠️     |

## 2. runtime-orchestration (Core)

| Элемент                | Тип              | Обязат. | Описание                                 | Источник                                 | Владелец              | Статус |
| ---------------------- | ---------------- | ------- | ---------------------------------------- | ---------------------------------------- | --------------------- | ------ |
| `runtimeId`            | `string`         | да      | Идентификатор runtime (claude/codex/...) | `runtime/types.ts`, `runtimeProfiles.ts` | runtime-orchestration | ✅     |
| `providerId`           | `string`         | да      | Идентификатор провайдера                 | `runtime/types.ts`, `runtimeProfiles.ts` | runtime-orchestration | ✅     |
| `transport`            | `enum`           | да      | Канал выполнения (sdk/cli/api/...)       | `RuntimeTransport`, профили              | runtime-orchestration | ✅     |
| `requiredCapabilities` | `json`           | нет     | Требования workflow к runtime            | `workflowSpec.ts`, `capabilities.ts`     | runtime-orchestration | ✅     |
| `usage`                | `json \| null`   | нет     | Метрики потребления runtime              | `RuntimeRunResult.usage`                 | runtime-orchestration | ⚠️     |
| `errorCategory`        | `enum`           | нет     | Категория ошибки выполнения              | `runtime/errors.ts`                      | runtime-orchestration | ✅     |
| `adapterCode`          | `string \| null` | нет     | Адаптер-специфичный код ошибки           | adapter `errors.ts`                      | runtime-orchestration | ✅     |

## 3. collaboration-governance (Supporting)

| Элемент            | Тип      | Обязат. | Описание                         | Источник                            | Владелец                 | Статус |
| ------------------ | -------- | ------- | -------------------------------- | ----------------------------------- | ------------------------ | ------ |
| `participantId`    | `string` | да      | Идентификатор участника          | `participants.ts`                   | collaboration-governance | ✅     |
| `username`         | `string` | да      | Логин участника                  | `participants.ts`, auth routes      | collaboration-governance | ✅     |
| `role`             | `enum`   | да      | Роль (admin/member/...)          | `participants.ts`, policy use-cases | collaboration-governance | ✅     |
| `ownerType`        | `enum`   | да      | Владелец задачи: human/ai/system | `taskOwnership.ts`                  | collaboration-governance | ✅     |
| `ownershipHistory` | `json`   | нет     | История handoff                  | `taskOwnership.ts`, `audit.ts`      | collaboration-governance | ✅     |
| `sessionId`        | `string` | да      | Идентификатор auth-сессии        | `authSessions.ts`                   | collaboration-governance | ✅     |

## 4. integration-sync (Supporting)

| Элемент           | Тип             | Обязат. | Описание                                     | Источник                                 | Владелец         | Статус |
| ----------------- | --------------- | ------- | -------------------------------------------- | ---------------------------------------- | ---------------- | ------ |
| `branchName`      | `string`        | нет     | Рабочая ветка задачи                         | `gitConventions.ts`, workflow modules    | integration-sync | ✅     |
| `changeRequestId` | `string \| int` | нет     | PR/MR идентификатор                          | `githubWorkflow.ts`, `gitlabWorkflow.ts` | integration-sync | ✅     |
| `mcpToolName`     | `string`        | нет     | Название MCP инструмента                     | `packages/mcp/src/tools/*`               | integration-sync | ✅     |
| `syncDirection`   | `enum`          | нет     | Направление синхронизации (inbound/outbound) | MCP/API flow                             | integration-sync | ⚠️     |

## 5. Расхождения «модель ↔ реализация»

| #   | Элемент                             | Модель                                 | Реализация                                                          | Статус |
| --- | ----------------------------------- | -------------------------------------- | ------------------------------------------------------------------- | ------ |
| 1   | Единый event envelope               | Общий формат для всех контуров событий | API/WS/audit/adapter diagnostics имеют частично разные payload      | ⚠️     |
| 2   | `planVersion` как жёсткий инвариант | Явная версия в каждом изменении плана  | В отдельных потоках упор на содержимое и timestamp, версия вторична | ⚠️     |
| 3   | `syncDirection`                     | Строгое enum-поле в домене             | Часто выводится из контекста вызова, а не хранится явно             | ⚠️     |
| 4   | `usage` унификация                  | Единая полная метрика across runtimes  | Поддержка зависит от адаптера (`FULL/PARTIAL/NONE`)                 | ⚠️     |

## 6. Источники для верификации

- `packages/shared/src/schema.ts`
- `packages/shared/src/stateMachine.ts`
- `packages/data/src/tasks.ts`, `taskTransitions.ts`, `taskOwnership.ts`, `participants.ts`, `runtimeProfiles.ts`, `runtimeLimits.ts`, `audit.ts`
- `packages/runtime/src/types.ts`, `workflowSpec.ts`, `capabilities.ts`, `errors.ts`
- `packages/agent/src/coordinator.ts`, `planReviewPublisher.ts`, `githubWorkflow.ts`, `gitlabWorkflow.ts`

## Связанные артефакты

- [Карта контекстов](context-map.md)
- [Агрегаты](aggregates.md)
- [Доменные события](domain-events.md)
- [Contracts](../contracts/README.md)
