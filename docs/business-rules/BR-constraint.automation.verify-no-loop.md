# BR-constraint.automation.verify-no-loop — Запрет циклических перезапусков Verify

> Verify-стадия не должна запускаться повторно без прохода через Implementing. Непрерывный цикл `verify → verify → verify` запрещён.

[← Каталог правил](README.md)

| Поле          | Value                                     |
| ------------- | ----------------------------------------- |
| **ID**        | `BR-constraint.automation.verify-no-loop` |
| **Тип**       | `constraint`                              |
| **Домен**     | `automation`                              |
| **Статус**    | Принято                                   |
| **Приоритет** | Высокий                                   |

## Правило

Verify-стадия может запускаться многократно для одной задачи — каждый раз, когда задача поступает в `verify` из `implementing` (по ADR: `implementing → verify → review` при успехе, `implementing → verify → implementing` при неудаче).

Однако **непрерывный цикл** `verify → verify → verify` (без прохода через `implementing`) запрещён. Если Verify завершился (с любым исходом), следующий запуск возможен только после того, как задача прошла стадию `implementing`.

## Детализация

- **Нормальный множественный запуск:** задача проходит `implementing → verify → implementing → verify → ...` — это разрешено и соответствует ADR-IMP.PROCESS.task-state-machine (переход `verify → implementing : verification failed`).
- **Запрещённый цикл:** ошибка или исключение в `runVerifier` не должны возвращать задачу в `verify` автоматически. Все нераспознанные ошибки классифицируются через `classifyStageError`: `RuntimeValidationError` (включая превышение лимита tool-call loop) → `blocked_external`; `StageManualBlockError` → `blocked_external`. Ни один из этих путей не приводит к `revert` (который оставил бы задачу в `verify`).
- **Принцип:** машина состояний (stateMachine.ts) и классификатор ошибок (stageErrorHandler.ts) — единственные источники истины для переходов. Никакие side-channel проверки (содержимое `reviewComments`, флаги в task fields) не должны блокировать или разрешать запуск Verify.

## Обоснование

Запрет цикла предотвращает «бесполезную занятость» системы — когда Verify перезапускается без новой имплементации, каждый раз находя одни и те же проблемы. При этом разрешён множественный запуск через Implementing: после доработки кода верификация должна проверить новый результат.

## Трассируемость

| Артефакт     | Ссылка                                                                                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Документация | [`docs/adr/ADR-IMPL.PROCESS.task-state-machine.md`](../adr/ADR-IMPL.PROCESS.task-state-machine.md) (граф переходов), [`docs/architecture.md`](../architecture.md) (Verify Stage, Stage Error Handler) |
| Реализация   | `packages/agent/src/stageErrorHandler.ts` (classifyStageError — все пути к blocked_external, ни один к revert для Verify), `packages/agent/src/subagents/verifier.ts` (runVerifier)                   |

## Связанные правила

- [`BR-constraint.task-lifecycle.transitions`](BR-constraint.task-lifecycle.transitions.md) — допустимые переходы статусов задачи
- [`BR-constraint.automation.implementation-commit`](BR-constraint.automation.implementation-commit.md) — автоматический коммит изменений реализации
