[← README](../README.md)

# Data Access Layer Contract (`@aif/data`)

> Источник правды: `packages/data/src/`
> Версия: 1.0.0
> Статус: `implemented`

## Описание

Централизованный слой доступа к данным (Data Access Layer). Единственный способ чтения и записи БД
для пакетов `api`, `agent` и `runtime`. Lint-правила блокируют прямой импорт `@aif/shared/src/db`
из этих пакетов — доступ к данным только через `@aif/data`.

## Принципы

1. **Единая точка входа**: все операции с данными — через экспорты `@aif/data`
2. **Атомарность**: каждая функция выполняет одну логическую операцию
3. **Типизация**: все входы и выходы типизированы через TypeScript
4. **Аудит**: операции, изменяющие состояние, принимают `AuditActor`
5. **Изоляция**: прямой SQL из api/agent/runtime запрещён линтером

## API Surface

### Tasks — Управление задачами

```typescript
// Чтение
findTaskById(id: string): HydratedTaskRow | undefined
listTasks(projectId?: string, ownershipFilters?: TaskOwnershipFilters): HydratedTaskRow[]
listTaskListItems(projectId: string, ...): TaskListItem[]
listTasksPaginated(options: { projectId, status, limit, offset }): PaginatedResult<TaskSummaryRow>
searchTasksPaginated(options: { query, projectId, limit, offset }): PaginatedResult<TaskSummaryRow>

// Создание и обновление
createTask(input: { projectId, title, description, attachments?, priority?, autoMode?, executionOwner?, assigneeIds?, actor?, isFix?, ... }): TaskRow
updateTask(id: string, fields: TaskFieldsUpdate): TaskRow | undefined
setTaskFields(id: string, fields: TaskFieldsPatch): void
deleteTask(id: string): void

// Позиционирование (drag-drop)
getMinBacklogPosition(projectId: string): number | null
getMaxBacklogPosition(projectId: string): number | null
updateTaskPositionOnly(id: string, position: number): void

// План
updateTaskPlan(id: string, planContent: string): void
syncTaskPlanFromFile(id: string): string | null
getTaskPlanFileStatus(id: string): { exists, modifiedAt, ... }

// QA
tryStartQaRun(id: string): boolean
resetStaleQaRuns(): number

// Runtime limits
persistTaskRuntimeLimitSnapshot(taskId: string, snapshot: RuntimeLimitSnapshot, ...): TaskRow | undefined
clearTaskRuntimeLimitSnapshot(taskId: string, ...): TaskRow | undefined
```

### Task Ownership — Владение и handoff

```typescript
claimTask(taskId: string, revision: number, ...): boolean
releaseTaskClaim(taskId: string, ...): void
getTaskOwnership(taskId: string): TaskOwnership | null
handoffTaskExecution(taskId: string, ...): void
listTaskExecutorHistory(taskId: string, ...): TaskExecutorHistoryRow[]
findParticipantById(id: string): ParticipantRow | undefined
```

### Task Transitions — Переходы стадий

```typescript
// Атомарные транзишены с учётом актора и аудита
// (детали в packages/data/src/taskTransitions.ts)
```

### Participants — Участники

```typescript
// CRUD участников
// Управление ролями
// Активация/деактивация
```

### Auth Sessions — Сессии аутентификации

```typescript
resolveParticipantSession(token: string): ParticipantSession | null
isParticipantSessionActive(sessionId: string, now?: Date): boolean
// Создание, обновление, отзыв сессий
```

### Audit — Аудит

```typescript
// Иммутабельная запись событий аудита
// Чтение истории аудита
```

### Projects — Проекты

```typescript
findProjectById(id: string): Project | undefined
// CRUD проектов
```

### Runtime Profiles

```typescript
resolveEffectiveRuntimeProfile(taskId: string, ...): RuntimeProfile | null
resolveEffectiveRuntimeProfilesForTasks(projectId: string): ...
```

### GitHub / GitLab

```typescript
findGitHubIssueByTaskId(taskId: string): GitHubIssueLink | undefined
// CRUD GitHub/GitLab-подключений
```

## Типизированные ответы

### Task (гидратированная)

```typescript
interface HydratedTaskRow {
  id: string;
  projectId: string;
  title: string;
  description: string;
  attachments: unknown[];
  status: TaskStatus;
  executionOwner: ExecutionOwner;
  autoMode: boolean;
  assignees: TaskAssigneeSummary[];
  tags: string[];
  // ... все поля из schema.ts
}
```

### PaginatedResult

```typescript
interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
```

## Проверки и консистентность

- `tryStartQaRun()` использует optimistic lock (проверка `executionOwner === "ai"` и `qaStatus !== "running"`)
- `claimTask()` использует `ownershipRevision` для предотвращения конфликтов handoff
- Аудит иммутабелен и не удаляется

## See Also

- [REST API](../rest/aif-api.md) — HTTP-эндпоинты системы
- [WebSocket Events](../websocket/events.md) — real-time протокол
- [RuntimeAdapter](../adapter/runtime-adapter.md) — AI-адаптеры и контракт выполнения
- [README](../README.md) — реестр контрактов

## Трассируемость

- **Все UC** с операциями с данными
- **ADR-DES.API.data-access-boundary** — архитектурное решение о границе данных
- **BR-ownership.***, BR-audit.***, BR-task-lifecycle.***