<a id="us-integration.pr-mr.gitlab-pipeline-run"></a>

# US-integration.pr-mr.gitlab-pipeline-run: Полный конвейер GitLab Issue → Accepted

> Декомпозиция прежней `US-integration.pr-mr.gitlab-issue-to-accepted`
> (сценарии 1, 2, 5, 6, 7, 8, 9, A5, A6, A7, A10–A13).
> Совместимость: прежние якоря 1/2/5/6/7/8/9/A5/A6/A7/A10/A11/A12/A13 остаются валидными.

```gherkin
@US-integration.pr-mr.gitlab-pipeline-run @HF1.1 @HF1.2 @HF1.4 @HF1.5 @HF1.6 @HF4.1 @HF4.3 @HF5.1 @HF5.3 @HF5.4 @HF11.1 @HF11.2 @UC-integration.issues.bootstrap-project-sync-and-create-task @UC-pipeline.stage.auto-advance-task @UC-pipeline.implementation.execute-change-in-isolation @UC-pipeline.verification.verify-change-result @UC-pipeline.completion.auto-complete-pipeline @UC-vcs-auto.mr.publish-atomic-merge-request @P0 @integration @pr-mr @core-e2e
Feature: US-integration.pr-mr.gitlab-pipeline-run Полный конвейер Issue → Accepted

  Background:
    Given проект подключён к GitLab через /api/projects/:id/gitlab
    And для проекта включён autoQueueMode
    And для проекта настроен Effective Runtime Profile для planning/implementing/verify/review
    And Coordinator выполняет poll-цикл по расписанию (канал Agent)
    And в целевом репозитории определены Verify gates

  Scenario: 1. Sync импортирует GitLab Issue без MR в Backlog
    Given в GitLab создан новый Issue без связанного открытого MR
    When пользователь запускает Sync now
    Then в AIF Handoff создаётся Task в статусе backlog
    And GET /api/tasks/:id возвращает status=backlog и ссылку на внешний issue
    And владелец задачи соответствует autoQueueMode проекта на момент импорта

  Scenario: 2. Auto-queue переводит задачу Backlog → Planning и создаёт git-ветку
    Given задача находится в backlog и eligible для auto-queue
    When Coordinator выполняет цикл автоочереди
    Then задача переходит в planning
    And для задачи создана отдельная git-ветка и task worktree

  Scenario: 3. Implementer выполняет изменения в изолированном контексте
    Given задача находится в implementing и план утверждён
    When subagent implementer завершает реализацию
    Then изменения закоммичены в ветку задачи
    And задача переходит в verify

  Scenario: 4. Verify прогоняет гейты и пишет отчёт в лог задачи
    Given задача находится в verify
    When Verify gates завершаются результатом pass или fail
    Then в лог задачи добавлен отчёт о прохождении/провале гейтов
    And при pass задача переходит в review
    And при fail задача переходит в implementing

  Scenario: 5. Review завершает проверку и переводит задачу в Done
    Given задача находится в review
    When reviewer возвращает pass без request changes
    Then задача переходит в done

  Scenario: 6. Используется один MR для plan review и итогового change set
    Given задача связана с MR, созданным на стадии plan_review
    When реализация завершена и изменения запушены в ветку задачи
    Then тот же MR содержит итоговый change set
    And новый отдельный completion MR не создаётся

  Scenario: 7. Merge единого MR переводит задачу Done → Accepted
    Given задача находится в done и связана с единым MR в GitLab
    When пользователь выполняет Merge MR
    Then после следующего sync задача автоматически переходит в accepted

  Scenario: 8. Skip-review даёт переход Implementing → Done
    Given задача находится в implementing и skipReview=true
    When реализация завершена
    Then задача переходит в done

  Scenario: 9. No-op в Implementing даёт self-loop
    Given задача находится в implementing
    When реализация не создаёт изменений (no-op)
    Then задача остаётся в implementing

  Scenario: 10. Запрос доработок в Review возвращает Review → Implementing
    Given задача находится в review
    When reviewer запрашивает changes
    Then задача переходит в implementing

  Scenario: 11. Внешний сбой переводит задачу в Blocked External
    Given задача находится в рабочей стадии выполнения
    When runtime или VCS временно недоступен
    Then задача переводится в blocked_external
    And у задачи сохранены blockedReason и retryAfter

  Scenario Outline: 12. Retry from blocked возвращает задачу в исходную стадию
    Given задача находится в blocked_external и помнит исходную стадию <originStage>
    When выполняется retry_from_blocked
    Then задача переходит в <originStage>

    Examples:
      | originStage   |
      | planning      |
      | improve       |
      | plan_review   |
      | implementing  |

  Scenario: 13. Ручной запуск переводит Backlog → Planning
    Given задача находится в backlog
    When пользователь выполняет ручной старт
    Then задача переходит в planning

  Scenario: 14. Scheduled trigger переводит Backlog → Planning
    Given задача находится в backlog и имеет scheduledAt
    When наступает scheduledAt
    Then задача переходит в planning
```

## Покрытие требований

| Шаг/сценарий | US-ID                                    | UC (основной)                                                        | HF (vision §2.2)    | BR                                              | ADR-переход                                          | Oracle (что проверять)                                           |
| ------------ | ---------------------------------------- | -------------------------------------------------------------------- | ------------------- | ----------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| 1            | US-integration.pr-mr.gitlab-pipeline-run | UC-integration.issues.bootstrap-project-sync-and-create-task (Mixed) | HF11.1              | BR-fact.git.vcs-workflow                        | import → backlog                                     | `GET /api/tasks/:id=status=backlog`; E2E: L-10c                  |
| 2            | US-integration.pr-mr.gitlab-pipeline-run | UC-pipeline.stage.auto-advance-task (Agent)                          | HF1.1, HF4.1        | BR-trigger.automation.auto-queue                | backlog → planning                                   | `status=planning`; E2E: L-10-full (llm); unit: autoQueue.test.ts |
| 3            | US-integration.pr-mr.gitlab-pipeline-run | UC-pipeline.implementation.execute-change-in-isolation (Agent)       | HF1.4, HF4.1        | BR-constraint.git.worktree-isolation            | implementing → verify                                | commit в ветке; `status=verify`; E2E: L-10-full                  |
| 4            | US-integration.pr-mr.gitlab-pipeline-run | UC-pipeline.verification.verify-change-result (Agent)                | HF1.5, HF5.1, HF5.4 | BR-trigger.automation.pipeline                  | verify → review (pass), verify → implementing (fail) | task log содержит gate report; E2E: L-10-full                    |
| 5            | US-integration.pr-mr.gitlab-pipeline-run | UC-pipeline.completion.auto-complete-pipeline (Agent)                | HF1.6, HF5.3        | BR-trigger.automation.auto-review               | review → done                                        | `status=done`; E2E: L-10-full                                    |
| 6            | US-integration.pr-mr.gitlab-pipeline-run | UC-vcs-auto.mr.publish-atomic-merge-request (Agent)                  | HF4.3, HF11.2       | BR-fact.git.vcs-workflow                        | (без смены стадии)                                   | тот же `mrIid`; один MR; E2E: L-10d/L-10-full                    |
| 7            | US-integration.pr-mr.gitlab-pipeline-run | UC-integration.pr-mr.resolve-review-decision (Schedule/Agent)        | HF1.6, HF11.2       | BR-trigger.automation.done-to-accepted-approval | done → accepted                                      | merge + sync; `status=accepted`; E2E: L-10g/L-10                 |
| 8            | US-integration.pr-mr.gitlab-pipeline-run | UC-pipeline.completion.auto-complete-pipeline (Agent)                | HF1.6               | BR-trigger.task-lifecycle.skip-review           | implementing → done                                  | `status=done`, verify/review пропущены (unit)                    |
| 9            | US-integration.pr-mr.gitlab-pipeline-run | UC-pipeline.stage.auto-advance-task (Agent)                          | HF1.1, HF5.1        | BR-constraint.automation.verify-no-loop         | implementing → implementing                          | статус остаётся implementing (unit)                              |
| 10           | US-integration.pr-mr.gitlab-pipeline-run | UC-pipeline.review-loop.iterate-review-feedback (Agent)              | HF5.3               | BR-trigger.automation.auto-review               | review → implementing                                | `reviewIterationCount` увеличен (unit)                           |
| 11           | US-integration.pr-mr.gitlab-pipeline-run | UC-pipeline.gate.enforce-stage-transition-gate (Agent)               | HF5.1, HF6.3        | BR-trigger.task-lifecycle.blocked               | \* → blocked_external                                | `status=blocked_external`, reason, retryAfter (unit)             |
| 12           | US-integration.pr-mr.gitlab-pipeline-run | UC-pipeline.stage.auto-advance-task (Agent)                          | HF1.1               | BR-trigger.task-lifecycle.blocked               | blocked_external → origin                            | `status=originStage` (unit)                                      |
| 13           | US-integration.pr-mr.gitlab-pipeline-run | UC-pipeline.manual-override.intervene-task-stage (GUI/API)           | HF1.7               | BR-constraint.task-lifecycle.transitions        | backlog → planning                                   | `POST /tasks/:id/transition` (E2E-API-003)                       |
| 14           | US-integration.pr-mr.gitlab-pipeline-run | UC-pipeline.stage.auto-advance-task (Schedule/Agent)                 | HF1.1               | BR-trigger.task-lifecycle.scheduling            | backlog → planning                                   | после scheduledAt `status=planning` (unit: scheduler)            |

## Требования к реальному прогону

1. Обязательные env/флаги: `GIT_PROVIDER=gitlab`, `AIF_GITLAB_ISSUE_MR_ENABLED=true`,
   `GITLAB_WEB_URL`, `GITLAB_TOKEN`, Coordinator poll, WebSocket `/ws`.
2. Для сценариев 2–7 (автоконтур) требуется включённый `autoQueueMode` ДО импорта
   (контракт владения P0.2) и настроенный runtime-профиль (E2E `@requires-llm`).
3. Детерминированные сценарии (1, 13, 14 и единый-MR 6) — `@core-e2e`.

## Primary E2E layer

- **Primary: API** — import/ownership (`L-10c`), single-MR (`L-10d`, `L-10-full`),
  done→accepted (`L-10g`), ревью-цикл (`L-10k`, `L-10j`).
- **Secondary smoke: GUI** — L-10 (UI sync/merge), L-10-full (llm, UI connect/sync).
- Capability: `@core-e2e` для детерминированных частей, `@requires-llm` для сценариев
  2–7, 10 (полный LLM-loops L-10-full/L-10k).

## Совместимость с прежней US

| Прежний сценарий | Новая история/сценарий  |
| ---------------- | ----------------------- |
| 1                | gitlab-pipeline-run: 1  |
| 2                | gitlab-pipeline-run: 2  |
| 5                | gitlab-pipeline-run: 3  |
| 6                | gitlab-pipeline-run: 4  |
| 7                | gitlab-pipeline-run: 5  |
| 8                | gitlab-pipeline-run: 6  |
| 9                | gitlab-pipeline-run: 7  |
| A5               | gitlab-pipeline-run: 8  |
| A6               | gitlab-pipeline-run: 9  |
| A7               | gitlab-pipeline-run: 10 |
| A10              | gitlab-pipeline-run: 11 |
| A11              | gitlab-pipeline-run: 12 |
| A12              | gitlab-pipeline-run: 13 |
| A13              | gitlab-pipeline-run: 14 |
