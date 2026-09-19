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

### GitHub / GitLab — VCS-привязки задач

GitHub и GitLab имеют зеркальный набор репозиториев (CRUD-функции).

**GitHub:**

```typescript
// Репозиторий (connection) — одна запись на проект
findGitHubRepository(projectId: string): GitHubRepositoryConnection | undefined
listEnabledGitHubRepositories(): GitHubRepositoryConnection[]
upsertGitHubRepository(input: { projectId, owner, name, webUrl, defaultBranch, tokenEnvVar, eligibility, enabled, gitPreparedAt? }): GitHubRepositoryConnection
deleteGitHubRepository(projectId: string): boolean
recordGitHubRepositorySync(projectId: string, error: string | null): void

// Иммутабельная привязка задачи к Issue
importGitHubIssueTask(input: { projectId, owner, repository, issueNumber, state, sourceUpdatedAt, snapshot, mergeRequest?, ... }): { issue: GitHubIssueLink, taskId: string, created: boolean }
findGitHubIssue(projectId: string, issueNumber: number): GitHubIssueLink | undefined
findGitHubIssueByTaskId(taskId: string): GitHubIssueLink | undefined
listGitHubIssues(projectId: string): GitHubIssueLink[]
markGitHubIssueUnavailable(projectId: string, issueNumber: number, reason: string): void

// PR state and review decision persistence
updateGitHubPullRequest(input: { projectId, issueNumber, prNumber, prUrl, prState, reviewState, prChecksStatus?, reviewFingerprint?, lastReviewId? }): GitHubIssueLink | undefined
updateGitHubPullRequestLastReviewId(input: { projectId, issueNumber, lastReviewId }): void
updateGitHubPullRequestMode(projectId: string, issueNumber: number, mode: PullRequestMode): void

// Review fingerprint (dedup для auto-review)
getGitHubIssueReviewFingerprint(projectId: string, issueNumber: number): { fingerprint: string } | null
```

**GitLab:**

```typescript
// Репозиторий (connection) — одна запись на проект
findGitLabRepository(projectId: string): GitLabRepositoryConnection | undefined
listEnabledGitLabRepositories(): GitLabRepositoryConnection[]
upsertGitLabRepository(input: { projectId, namespace, name, webUrl, defaultBranch, tokenEnvVar, eligibility, enabled, gitPreparedAt? }): GitLabRepositoryConnection
deleteGitLabRepository(projectId: string): boolean
recordGitLabRepositorySync(projectId: string, error: string | null): void

// Иммутабельная привязка задачи к Issue
importGitLabIssueTask(input: { projectId, namespace, repository, iid, globalId, state, sourceUpdatedAt, snapshot, mergeRequest?, ... }): { issue: GitLabIssueLink, taskId: string, created: boolean }
findGitLabIssue(projectId: string, iid: number): GitLabIssueLink | undefined
findGitLabIssueByTaskId(taskId: string): GitLabIssueLink | undefined
listGitLabIssues(projectId: string): GitLabIssueLink[]
markGitLabIssueUnavailable(projectId: string, iid: number, reason: string): void

// MR state, review decision, and note-id marker
updateGitLabMergeRequest(input: { projectId, iid, mrIid, mrUrl, mrState, mrChecksStatus?, reviewState?, reviewFingerprint?, lastReviewNoteId? }): GitLabIssueLink | undefined
updateGitLabMergeRequestLastReviewNoteId(input: { projectId, iid, lastReviewNoteId }): GitLabIssueLink | undefined
updateGitLabMergeRequestMode(projectId: string, iid: number, mode: PullRequestMode): void

// Review fingerprint (dedup для auto-review)
getGitLabIssueReviewFingerprint(projectId: string, iid: number): { fingerprint: string } | null
```

**REQ-FR-integration.pr-mr.resolve-review-decision (критерии 11–12):** маркер `lastReviewNoteId` / `lastReviewId` записывается отдельным целенаправленным вызовом (`updateGitLabMergeRequestLastReviewNoteId`, `updateGitHubPullRequestLastReviewId`) только после успешного перехода задачи — повторная синхронизация не теряет решение при транзакционном конфликте.

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

### Projection types — single source in `@aif/shared`

`TaskListItemRow`, `TaskSummaryRow` и `RuntimeProfileUsageState` определены один раз в
`@aif/shared/presenters.ts`. `@aif/data` импортирует их и реэкспортирует как result-shapes
(`TaskSummaryRow`; `ListTaskListItemRow = TaskListItemRow & { assignees }`), но больше не
переобъявляет `Pick<TaskRow, ...>`-проекции. Это устраняет риск молчаливого расхождения формы
ответа между слоями (known-issue: «Дублирование типов-проекций строк между
`@aif/shared/presenters.ts` и `@aif/data`»).

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