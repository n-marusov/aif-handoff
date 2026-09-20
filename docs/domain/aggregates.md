# Агрегаты, сущности и объекты-значения — AIF Handoff

> Источники: `docs/domain/context-map.md`, `packages/shared/src/schema.ts`, `packages/shared/src/stateMachine.ts`, `packages/data/src/*`, `packages/runtime/src/types.ts`, `packages/api/src/use-cases/*`, `packages/agent/src/*`.

**Принципы:** агрегат — граница инвариантов и транзакции; внешние ссылки на агрегат — по ID; межконтекстная согласованность достигается событиями.

## 1. task-lifecycle (Core)

| Корень             | Состав                                                                                    | Инварианты                                                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Task`             | `TaskId`, `ProjectId`, `Stage`, `StatusFlags`, `OwnershipRef`, `PlanRef`, `ExecutionMeta` | Переходы только по state machine и через явные task events; `Accepted` — финальное состояние; `Done` терминально для automation, но может быть пересмотрен человеком; `manualReviewRequired` выставляется при несходимости auto-review |
| `TaskPlan`         | `PlanVersion`, `PlanBody`, `PlanMetadata`, `ReviewDecision`                               | План в БД и canonical file должен быть согласован; plan-review gate публикует только детерминированные изменения плана                                                                                                                 |
| `CoordinatorClaim` | `TaskId`, `Executor`, `Lease/Heartbeat`, `WorktreeRef`                                    | Одновременная обработка одной задачи не допускается; claim истекает/обновляется heartbeat-механизмом                                                                                                                                   |

**Value Objects:**

- `StageTransition` (`from`, `inProgress`, `onSuccess`, `onFailure`)
- `TaskExecutionRoot` (worktree vs project-root rule)
- `TaskStatusFlags` (`autoMode`, `manualReviewRequired`, `useSubagents`)

## 2. runtime-orchestration (Core)

| Корень               | Состав                                                                                                         | Инварианты                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `RuntimeProfile`     | `RuntimeId`, `ProviderId`, `Transport`, `ModelPolicy`, `CapabilityRequirements`, `Scope` (task/project/system) | Разрешение профиля следует цепочке fallback; профиль должен соответствовать capability-требованиям workflow |
| `RuntimeLimitPolicy` | `LimitKey`, `Threshold`, `Window`, `Action`                                                                    | Решение gate детерминировано и не зависит от текстов ошибок; limit-применение учитывает scope профиля       |

**Value Objects:**

- `ExecutionIntent` (workflow kind, reuse policy, required capabilities)
- `RuntimeCapabilities` (structured capability set)
- `RuntimeUsage` (tokens/cost/latency where available)

## 3. collaboration-governance (Supporting)

| Корень          | Состав                                                    | Инварианты                                                                                               |
| --------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Participant`   | `ParticipantId`, `Identity`, `RoleSet`, `CredentialState` | Всегда существует администратор-инвариант; роль определяет доступные операции                            |
| `TaskOwnership` | `TaskId`, `CurrentOwner`, `History`, `HandoffPolicy`      | Handoff атомарен: новый owner + запись истории + policy проверка; human/AI ownership не равен `autoMode` |

**Value Objects:**

- `ActorRef` (`type`, `id`, `display`)
- `RoleAssignment` (role + grant metadata)

## 4. integration-sync (Supporting)

| Корень                | Состав                                                      | Инварианты                                                                                                               |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ExternalSyncSession` | `TaskId`, `VcsRef` (branch/PR/MR), `McpRef`, `PublishState` | Публикация не должна менять бизнес-состояние без подтверждённого lifecycle transition; повторная публикация идемпотентна |

**Value Objects:**

- `VcsPublicationRef` (`provider`, `repo`, `branch`, `changeRequestId`)
- `McpToolRef` (`transport`, `serverId`, `toolName`)

## Сводная таблица агрегатов

| Контекст                 | Агрегаты                               | Тип        |
| ------------------------ | -------------------------------------- | ---------- |
| task-lifecycle           | `Task`, `TaskPlan`, `CoordinatorClaim` | Core       |
| runtime-orchestration    | `RuntimeProfile`, `RuntimeLimitPolicy` | Core       |
| collaboration-governance | `Participant`, `TaskOwnership`         | Supporting |
| integration-sync         | `ExternalSyncSession`                  | Supporting |

**Итого:** 8 агрегатов в 4 контекстах.

## Пробелы модели

1. Унификация событий API/WS/audit в единый event contract не полностью формализована.
2. `RuntimeUsage` в разных адаптерах имеет неоднородную полноту (`FULL`/`PARTIAL`/`NONE`) и требует аккуратной семантики на уровне аналитики.
3. Границы между `TaskPlan` и `ExternalSyncSession` (plan PR/MR публикация) определены архитектурно, но требуют формализованного доменного SLA по ретраям.

## Связанные артефакты

- [Карта контекстов](context-map.md)
- [Доменные события](domain-events.md)
- [Словарь данных](data-dictionary.md)
- [Contracts](../contracts/README.md)
- [Business Rules](../business-rules/README.md)
