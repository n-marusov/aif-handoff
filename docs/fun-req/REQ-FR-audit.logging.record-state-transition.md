[← Back to FUN-REQ-INDEX](README.md)

# REQ-FR-audit.logging.record-state-transition: Иммутабельный аудит действий системы

**Приоритет:** P0

**Ключевая функция:** HF10.1 Аудит действий

**Источник:** [UC-audit.logging.audit-state-transition](../use-cases/UC-audit.logging.audit-state-transition.md), BR-audit.immutable-trail, BR-audit.actor-identity, BR-audit.state-snapshot

**Статус:** proposed

**Класс:** as is

**Канал:** Agent / API (внутренний)

**Описание:** Каждое действие, изменяющее состояние системы, фиксируется в иммутабельной таблице `auditEvents`: действие, сущность, actor, snapshot состояния, метка времени. Записи никогда не удаляются и не изменяются.

**Критерии приёмки:**

1. Любое действие, изменяющее состояние системы (stage change, handoff, creation, comment), фиксируется через `createAuditEventValues`.
2. Audit-запись содержит:
   - `action` — тип действия (`TaskStageChanged`, `TaskCreated`, `TaskOwnershipTransferred`, etc.)
   - `entityType` / `entityId` — сущность
   - `actorKind` (coordinator/participant/anonymous), `actorId`, `actorDisplayNameSnapshot`
   - `statusSnapshot` — слепок статуса задачи на момент действия
   - `assigneesSnapshotJson` — слепок назначений
   - `metadataJson` — специфичные данные (ownershipRevision, fromStatus, toStatus)
   - `createdAt` — timestamp
3. Запись вставляется в `auditEvents` через INSERT, никогда не UPDATE и не DELETE.
4. `actorDisplayNameSnapshot` фиксируется на момент действия (защита от переименования).
5. Аудит-запись создаётся в той же транзакции, что и изменение состояния.

## See Also

- [REQ-FR-pipeline.stage.auto-advance-after-gate](REQ-FR-pipeline.stage.auto-advance-after-gate.md) — переходы стадий
- [REQ-FR-handoff.transfer.change-executor](REQ-FR-handoff.transfer.change-executor.md) — handoff
- [REQ-FR-audit.heartbeat.track-subagent-heartbeat](REQ-FR-audit.heartbeat.track-subagent-heartbeat.md) — хартбиты
