# BR-trigger.automation.done-to-accepted-approval — Автоматическое принятие задачи после одобрения PR/MR

> Задача в статусе `done` автоматически переходит в `accepted` при обнаружении одобрения или слияния связанного PR/MR, а также при наличии команды `/approve` в комментариях VCS.

[← Каталог правил](README.md)

| Поле          | Значение                                          |
| ------------- | ------------------------------------------------- |
| **ID**        | `BR-trigger.automation.done-to-accepted-approval` |
| **Тип**       | `trigger`                                         |
| **Домен**     | `automation`                                      |
| **Статус**    | Принято                                           |
| **Приоритет** | Высокий                                           |

## Правило

Когда задача находится в статусе `done` и имеет связанный Pull Request (GitHub) или Merge Request (GitLab), координатор периодически проверяет статус PR/MR. При наступлении любого из следующих событий задача автоматически переводится в `accepted`:

1. **PR/MR слит** (`prState = "merged"` / `mrState = "merged"`) — ветка принята в целевую.
2. **PR/MM ревью одобрено** (`reviewState = "approved"`) — код получил approve в VCS.
3. **Комментарий `/approve`** — команда `/approve` в комментариях к PR/MR или в `reviewComments` задачи.

Переход выполняется без участия человека, но запись об автоматическом принятии фиксируется в activity log.

## Детализация

- **Периодичность:** проверка выполняется на каждом poll-цикле координатора через стадию `done-checker` (self-loop в PIPELINE).
- **PR/MR статус:** данные берутся из записи GitHub/GitLab issue link в БД, которая обновляется через `synchronizeGitHubProjects` / `synchronizeGitLabProjects`.
- **Комментарий `/approve`:** проверяется в полях `planReviewFeedback` и `reviewComments` задачи (заполняются при синхронизации VCS).
- **Только AI-задачи:** автоматическое принятие работает только для задач под владением AI (`executionOwner === "ai"`). Human-owned задачи остаются в `done` до ручного одобрения.
- **Activity log:** при переходе в `accepted` в лог задачи записывается причина: "PR/MR merged", "PR/MR review approved" или "/approve comment detected".
- **Без PR/MR:** если у задачи нет связанного VCS issue link, `done-checker` ничего не делает — задача остаётся в `done`.

## Обоснование

Без автоматического принятия задачи после слияния PR/MR пайплайн останавливается на `done`, требуя ручного клика «Accept» в UI. Если PR/MR уже одобрен и слит, дополнительное ручное подтверждение избыточно. Автоматизация сокращает время прохождения задачи до терминального статуса.

## Трассируемость

| Артефакт     | Ссылка                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Документация | [`docs/adr/ADR-IMPL.PROCESS.task-state-machine.md`](../adr/ADR-IMPL.PROCESS.task-state-machine.md) (Done → Accepted)                            |
| Реализация   | `packages/agent/src/subagents/doneChecker.ts` (функция `runDoneChecker`), `packages/agent/src/coordinator.ts` (PIPELINE, стадия `done-checker`) |

## Связанные правила

- [`BR-constraint.task-lifecycle.transitions`](BR-constraint.task-lifecycle.transitions.md) — допустимые переходы статусов задачи
- [`BR-constraint.automation.verify-no-loop`](BR-constraint.automation.verify-no-loop.md) — запрет циклических перезапусков Verify
