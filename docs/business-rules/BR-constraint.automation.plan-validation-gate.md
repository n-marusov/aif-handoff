# BR-constraint.automation.plan-validation-gate — Валидация плана перед Plan Review

> Задача не переводится в `plan_review`, если файл плана пуст или отсутствует. После planning — повторная попытка; после improve — возврат в planning.

[← Каталог правил](README.md)

| Поле          | Значение                                        |
| ------------- | ----------------------------------------------- |
| **ID**        | `BR-constraint.automation.plan-validation-gate` |
| **Тип**       | `constraint`                                    |
| **Домен**     | `automation`                                    |
| **Статус**    | Принято                                         |
| **Приоритет** | Высокий                                         |

## Правило

Coordinator не переводит задачу в статус `plan_review`, если файл плана (`.ai-factory/plans/<task>.md`) отсутствует или его содержимое пусто после завершения стадии `planning` или `improve`.

- Если план пуст после `planning` — задача остаётся в `planning`. Следующий poll cycle повторит генерацию плана.
- Если план пуст после `improve` — задача переводится в `planning`. Планировщик сгенерирует новый план.
- Ни при каких обстоятельствах задача не должна попасть в `plan_review` с пустым планом.

## Детализация

- **Проверка:** после завершения субагента (`runPlanner` / `runImprover`) coordinator читает файл плана с диска и проверяет, что `content.trim().length > 0`.
- **Пустой план:** если файл отсутствует, пуст или содержит только пробельные символы — план считается невалидным.
- **Fast retry:** при пустом плане после `planning` счётчик retry не сбрасывается — координатор повторяет стадию на следующем цикле.
- **Improve → planning:** при пустом плане после `improve` все поля задачи сбрасываются (`CLEAN_STATE_RESET`), задача возвращается в `planning` для полной перегенерации.

## Обоснование

Пустой план — следствие ошибок upstream-провайдера (обрыв стрима, h2 protocol error, пустой ответ модели). Публикация пустого плана в PR/MR ведёт к потере времени ревьюверов и множественным циклическим перезапускам стадий. Валидация на границе `planning → plan_review` предотвращает эту потерю.

## Трассируемость

| Артефакт     | Ссылка                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Документация | [`docs/adr/ADR-IMPL.PROCESS.task-state-machine.md`](../adr/ADR-IMPL.PROCESS.task-state-machine.md) (Plan Validation Gate) |
| Реализация   | `packages/agent/src/coordinator.ts` (блоки `stage.label === "planner"` и `stage.label === "improver"` в `processOneTask`) |

## Связанные правила

- [`BR-constraint.automation.verify-no-loop`](BR-constraint.automation.verify-no-loop.md) — запрет циклических перезапусков Verify
- [`BR-constraint.task-lifecycle.transitions`](BR-constraint.task-lifecycle.transitions.md) — допустимые переходы статусов задачи
