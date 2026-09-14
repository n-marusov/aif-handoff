[← UC-auth.roles.assign-participant-role](UC-auth.roles.assign-participant-role.md) · [Back to README](../README.md) · [UC-audit.heartbeat.receive-agent-heartbeat →](UC-audit.heartbeat.receive-agent-heartbeat.md)

# UC-audit.logging.audit-state-transition: Иммутабельный аудит действий системы

**Актор:** Coordinator / API / Agent

**Приоритет:** P0

**Ключевая функция:** HF10.1 Аудит действий

**Канал:** Agent / API (внутренний)

**Описание:** Каждое действие, изменяющее состояние системы, фиксируется в иммутабельной таблице `auditEvents`: действие, сущность, actor, snapshot состояния, метка времени. Записи никогда не удаляются и не изменяются.

**Диаграмма последовательности:**

```mermaid
sequenceDiagram
  participant Actor as Actor (Coordinator/API)
  participant DB as Database
  participant Audit as AuditEventsTbl

  Actor->>DB: update task status
  DB-->>Actor: success
  Actor->>Audit: INSERT auditEvents (immutable)
  Note over Actor,Audit: - action (TaskStageChanged)<br/>- entityType: task<br/>- entityId: taskId<br/>- actorKind: coordinator | participant<br/>- statusSnapshot<br/>- assigneesSnapshot<br/>- metadata<br/>- createdAt: timestamp
  Audit-->>Actor: written
```

**Основной поток:**

1. Любое действие, изменяющее состояние (stage change, handoff, creation, comment), фиксируется.
2. Audit-запись содержит:
   - `action` — тип действия (TaskStageChanged, TaskCreated, TaskOwnershipTransferred, etc.).
   - `entityType` / `entityId` — сущность.
   - `actorKind` (coordinator/participant/anonymous), `actorId`, `actorDisplayNameSnapshot`.
   - `statusSnapshot` — слепок статуса задачи на момент действия.
   - `assigneesSnapshotJson` — слепок назначений.
   - `metadataJson` — специфичные для действия данные (ownershipRevision, fromStatus, toStatus).
   - `createdAt` — timestamp.
3. Запись вставляется в `auditEvents` через `createAuditEventValues`.

**Альтернативные потоки:**

- **A1. TaskEvent action:** `TaskStageChanged` — прохождение гейта; `TaskCreated` — создание задачи; `TaskOwnershipTransferred` — handoff.
- **A2. Actor identity:** фиксируется `actorDisplayNameSnapshot` — имя актора на момент действия (защита от переименования).

**Постусловия:** Аудит-запись создана. История изменений доступна для прослеживаемости.

**Источник требований:** HF10.1 Аудит действий, BR-constraint.audit.immutable-trail, BR-fact.audit.actor-identity, BR-constraint.audit.state-snapshot
