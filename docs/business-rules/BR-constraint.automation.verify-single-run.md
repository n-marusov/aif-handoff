# BR-constraint.automation.verify-single-run — Единичный прогон Verify-стадии

> Verify-стадия конвейера выполняется ровно один раз за проход задачи. Повторный запуск Verify на одной и той же задаче запрещён.

[← Каталог правил](README.md)

| Поле          | Значение                                     |
| ------------- | -------------------------------------------- |
| **ID**        | `BR-constraint.automation.verify-single-run` |
| **Тип**       | `constraint`                                 |
| **Домен**     | `automation`                                 |
| **Статус**    | Принято                                      |
| **Приоритет** | Высокий                                      |

## Правило

Verify-стадия (`verify`) запускает субагент `/aif-verify` для проверки реализованных изменений и выносит вердикт (`pass` / `fail`). Данная стадия выполняется ровно один раз для каждой задачи. Ни при каких обстоятельствах Verify не должен запускаться повторно:

- При `revert`-ошибке (например, `RuntimeValidationError` из tool-call loop) задача не возвращается в `verify`.
- При ручном `retry_from_blocked` из `blocked_external` Verify не запускается заново.
- При наличии сохранённого результата предыдущей Verify-проверки (`reviewComments` с секцией `## Verification`) субагент пропускается.

## Детализация

- **Первый запуск:** субагент `/aif-verify` выполняется штатно. Результат (`aif-gate-result`) сохраняется в `reviewComments` задачи.
- **Повторный вход:** если задача снова оказывается в статусе `verify` (например, из-за `revert` или `retry_from_blocked`), `runVerifier` проверяет наличие секции `## Verification` в `reviewComments` И отсутствие флага `reworkRequested`. Если секция есть и `reworkRequested` = false, субагент не вызывается — стадия считается пройденной, задача переводится в `review`.
- **После rework:** если задача была отправлена на доработку (`reworkRequested = true`), guard не срабатывает — верификатор запускается заново на новом раунде имплементации.
- **Блокирующий результат:** если Verify вернул `status: "fail"` или `blocking: true`, задача переводится в `blocked_external` и НЕ возвращается в `verify` автоматически.
- **Защита от tool-call loop:** при превышении лимита инструментальных вызовов в `executeSubagentQuery` (20 шагов) ошибка классифицируется как `blocked_external`, а не `revert` — задача не зависает в `verify`.

## Обоснование

Verify — финальная проверка качества перед отправкой на review. Повторный запуск бессмыслен: результат не изменится без новой имплементации. Циклические перезапуски Verify маскируют реальные проблемы (зависшие tool-call loops, неверную классификацию ошибок) и создают ложное впечатление, что система «занята делом», хотя на самом деле она застряла в бесконечном перезапуске одной и той же стадии.

## Трассируемость

| Артефакт     | Ссылка                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Документация | [`docs/architecture.md`](../architecture.md) (Verify Stage, Single-Run Guard), [`docs/vision.md`](../vision.md) §2.2 (HF4) |
| Реализация   | `packages/agent/src/subagents/verifier.ts` (guard на `reviewComments?.includes("## Verification")`)                        |

## Связанные правила

- [`BR-constraint.automation.implementation-commit`](BR-constraint.automation.implementation-commit.md) — автоматический коммит изменений реализации
- [`BR-trigger.automation.completion-commit`](BR-trigger.automation.completion-commit.md) — коммит перед завершающим статусом
- [`BR-constraint.task-lifecycle.transitions`](BR-constraint.task-lifecycle.transitions.md) — допустимые переходы статусов задачи
