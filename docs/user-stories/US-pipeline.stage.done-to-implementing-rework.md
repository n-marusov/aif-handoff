<a id="us-pipeline.stage.done-to-implementing-rework"></a>

# US-pipeline.stage.done-to-implementing-rework: Доработка задачи из Done в Implementing по решению человека (скилл $aif-fix)

```gherkin
@US-pipeline.stage.done-to-implementing-rework @HF1.6 @HF5.3 @HF11.2 @UC-pipeline.review-loop.iterate-review-feedback @UC-integration.pr-mr.resolve-review-decision @P1 @pipeline @stage @agent
Feature: US-pipeline.stage.done-to-implementing-rework Доработка задачи из Done в Implementing

  Background:
    Given задача находится в done и прошла все формальные гейты (verify/review)
    And реализация ожидает подтверждения человека (approve_done / auto-approve)
    And переходы статусов проходят через формальный state-machine gate
    And Coordinator выполняет poll-цикл по расписанию (канал Agent)

  Scenario: Решение человека возвращает задачу Done → Implementing с reworkRequested
    Given человек явно указывает, что реализация выполнена неправильно
    When к задаче применяется решение request_changes (ручное действие или changes requested по связанному PR/MR)
    Then задача переходит в implementing
    And у задачи установлен флаг reworkRequested=true
    And комментарий человека фиксируется как основание доработки
    And предыдущее решение approve_done не считается принятием результата

  Scenario: Доработка запускается через скилл $aif-fix, а не как обычная реализация
    Given задача находится в implementing и reworkRequested=true
    When Coordinator запускает стадию доработки
    Then вызывается скилл $aif-fix для исправления замечаний человека
    And исправление направлено ровно на указанные человеком проблемы
    And формальные гейты, уже пройденные ранее, не считаются основанием «всё готово»

  Scenario: Завершённая доработка возвращает задачу в цикл проверки
    Given скилл $aif-fix завершил исправление
    When доработка фиксируется в задаче
    Then задача переходит в verify/review для повторной проверки
    And повторный проход гейтов выполняется заново по фактическому результату
```

## Покрытие требований

| Шаг/сценарий | US-ID                                         | UC (основной)                                                                                                           | HF (vision §2.2)     | BR                                                                                    | ADR-переход           | Oracle (что проверять)                                                                            |
| ------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| 1            | US-pipeline.stage.done-to-implementing-rework | UC-pipeline.review-loop.iterate-review-feedback (Agent) / UC-integration.pr-mr.resolve-review-decision (Schedule/Agent) | HF1.6, HF5.3, HF11.2 | BR-constraint.task-lifecycle.transitions, BR-inference.git.review-decision-precedence | done → implementing   | `GET /api/tasks/:id = status=implementing`; `reworkRequested=true`; основание доработки сохранено |
| 2            | US-pipeline.stage.done-to-implementing-rework | UC-pipeline.review-loop.iterate-review-feedback (Agent)                                                                 | HF5.3                | BR-trigger.automation.auto-review                                                     | (внутри implementing) | стадия доработки запускает скилл `$aif-fix` (to-be); исправление адресует замечания человека      |
| 3            | US-pipeline.stage.done-to-implementing-rework | UC-pipeline.review-loop.iterate-review-feedback (Agent)                                                                 | HF1.6, HF5.3         | BR-trigger.automation.pipeline                                                        | implementing → verify | повторный проход гейтов по фактическому результату после `$aif-fix`                               |

## Покрытие переходов ADR-IMPL.PROCESS.task-state-machine

- `done → implementing` — сценарий **1** (решение человека `request_changes`, rework).
- Повторный цикл проверки после `$aif-fix` — сценарий **3** (`implementing → verify` и далее по конвейеру).
- `done → accepted` (одобрение) — вне рамок данной истории, фиксируется `US-integration.pr-mr.gitlab-issue-to-accepted`.

## Требования к реальному прогону

- Для детерминированного контура без LLM: задача доводится до `done`, затем `request_changes` (ручное действие или changes-requested по PR/MR) → проверяется `status=implementing`, `reworkRequested=true`.
- Для контура с LLM (`AIF_LLM_INTEGRATION=1`): стадия доработки должна вызывать скилл `$aif-fix`; проверяется, что промпт доработки адресует замечания человека, а не «переделывает всё заново».
- Внешний oracle: `GET /api/tasks/:id`, лог стадии доработки, PR/MR review decision (при VCS-канале), `docs/known-issues.md` (фиксация расхождения реализации и требования).
