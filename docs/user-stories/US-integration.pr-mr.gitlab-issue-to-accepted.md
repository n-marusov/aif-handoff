<a id="us-integration.pr-mr.gitlab-issue-to-accepted"></a>

# US-integration.pr-mr.gitlab-issue-to-accepted: Сквозной путь GitLab Issue → Accepted (единый MR, полный и краткий контуры)

```gherkin
@US-integration.pr-mr.gitlab-issue-to-accepted @HF11.1 @HF11.2 @HF1.1 @HF1.2 @HF1.3 @HF1.4 @HF1.5 @HF1.6 @HF3.1 @HF4.1 @HF4.3 @HF4.4 @HF5.1 @HF5.3 @HF5.4 @UC-integration.issues.bootstrap-project-sync-and-create-task @P0 @integration @issues @pr-mr
Feature: US-integration.pr-mr.gitlab-issue-to-accepted Сквозной путь GitLab Issue → Accepted

  Background:
    Given проект подключён к GitLab через /api/projects/:id/gitlab
    And синхронизация GitLab Issues/MR включена
    And для проекта включён autoQueueMode
    And для проекта настроен Effective Runtime Profile для planning/implementing/verify/review
    And Coordinator выполняет poll-цикл по расписанию (канал Agent)
    And в целевом репозитории определены Verify gates
    And переходы статусов проходят через формальный state-machine gate

  # ── Основной сквозной путь (полный AI-конвейер) ─────────────────────────────

  Scenario: 1. Sync импортирует GitLab Issue без MR в Backlog
    Given в GitLab создан новый Issue без связанного открытого MR
    When пользователь запускает Sync now
    Then в AIF Handoff создаётся Task в статусе backlog
    And GET /api/tasks/:id возвращает status=backlog и ссылку на внешний issue

  Scenario: 2. Auto-queue переводит задачу Backlog → Planning и создаёт git-ветку
    Given задача находится в backlog и eligible для auto-queue
    When Coordinator выполняет цикл автоочереди
    Then задача переходит в planning
    And для задачи создана отдельная git-ветка и task worktree

  Scenario: 3. Planner формирует план и публикует единый MR для plan review
    Given задача находится в planning и runtime доступен
    When subagent planner завершает планирование
    Then файл плана создан и не пуст
    And в GitLab создан один MR в режиме plan_review, связанный с задачей
    And задача переходит в plan_review

  Scenario: 4. Approve в GitLab MR переводит задачу Plan Review → Implementing
    Given задача находится в plan_review и связана с MR в GitLab
    When пользователь выполняет Approve в GitLab MR
    Then после следующего sync задача переходит в implementing

  Scenario: 5. Implementer выполняет изменения в изолированном контексте
    Given задача находится в implementing и план утверждён
    When subagent implementer завершает реализацию
    Then изменения закоммичены в ветку задачи
    And задача переходит в verify

  Scenario: 6. Verify прогоняет гейты и пишет отчёт в лог задачи
    Given задача находится в verify
    When Verify gates завершаются результатом pass или fail
    Then в лог задачи добавлен отчёт о прохождении/провале гейтов
    And при pass задача переходит в review
    And при fail задача переходит в implementing

  Scenario: 7. Review завершает проверку и переводит задачу в Done
    Given задача находится в review
    When reviewer возвращает pass без request changes
    Then задача переходит в done

  Scenario: 8. Используется один MR для plan review и итогового change set
    Given задача связана с MR, созданным на стадии plan_review
    When реализация завершена и изменения запушены в ветку задачи
    Then тот же MR содержит итоговый change set
    And новый отдельный completion MR не создаётся

  Scenario: 9. Merge единого MR переводит задачу Done → Accepted
    Given задача находится в done и связана с единым MR в GitLab
    When пользователь выполняет Merge MR
    Then после следующего sync задача автоматически переходит в accepted

  # ── Краткий интеграционный путь (MR уже есть до первого sync) ───────────────

  Scenario: 10. Issue со связанным MR импортируется сразу в Done
    Given в GitLab для Issue уже существует связанный открытый MR
    When пользователь запускает Sync now
    Then задача импортируется сразу в status=done
    And стадии planning/improve/plan_review/implementing/verify/review не выполняются

  Scenario: 11. Merge предсуществующего MR завершает Done → Accepted
    Given задача импортирована в done по краткому пути
    When пользователь выполняет Merge связанного MR
    Then после следующего sync задача переходит в accepted

  # ── Негативные и граничные сценарии ─────────────────────────────────────────

  Scenario: A1. Отклонение плана возвращает Plan Review → Improve
    Given задача находится в plan_review
    When ревьюер запрашивает изменения плана
    Then задача переходит в improve

  Scenario: A2. runPlanImprove переводит Planning → Improve
    Given задача находится в planning и runPlanImprove=true
    When планирование завершено
    Then задача переходит в improve

  Scenario: A3. Завершение Improve переводит Improve → Plan Review
    Given задача находится в improve
    When subagent improver завершает второй проход
    Then задача переходит в plan_review

  Scenario: A4. Fast fix в Plan Review даёт self-loop
    Given задача находится в plan_review
    When применяется fast_fix
    Then задача остаётся в plan_review

  Scenario: A5. Skip-review даёт переход Implementing → Done
    Given задача находится в implementing и skipReview=true
    When реализация завершена
    Then задача переходит в done

  Scenario: A6. No-op в Implementing даёт self-loop
    Given задача находится в implementing
    When реализация не создаёт изменений (no-op)
    Then задача остаётся в implementing

  Scenario: A7. Запрос доработок в Review возвращает Review → Implementing
    Given задача находится в review
    When reviewer запрашивает changes
    Then задача переходит в implementing

  Scenario: A8. Запрос доработок из Done возвращает Done → Implementing
    Given задача находится в done
    When по связанному MR приходит действующее решение changes requested
    Then задача переходит в implementing

  Scenario: A9. Закрытие MR без approve/merge не переводит задачу в Accepted
    Given задача находится в done и связана с MR в GitLab
    When пользователь закрывает MR без approve и без merge
    Then после следующего sync задача не переходит в accepted
    And задача переводится в paused (или эквивалентное приостановленное состояние)

  Scenario: A10. Внешний сбой переводит задачу в Blocked External
    Given задача находится в рабочей стадии выполнения
    When runtime или VCS временно недоступен
    Then задача переводится в blocked_external
    And у задачи сохранены blockedReason и retryAfter

  Scenario Outline: A11. Retry from blocked возвращает задачу в исходную стадию
    Given задача находится в blocked_external и помнит исходную стадию <originStage>
    When выполняется retry_from_blocked
    Then задача переходит в <originStage>

    Examples:
      | originStage   |
      | planning      |
      | improve       |
      | plan_review   |
      | implementing  |

  Scenario: A12. Ручной запуск переводит Backlog → Planning
    Given задача находится в backlog
    When пользователь выполняет ручной старт
    Then задача переходит в planning

  Scenario: A13. Scheduled trigger переводит Backlog → Planning
    Given задача находится в backlog и имеет scheduledAt
    When наступает scheduledAt
    Then задача переходит в planning
```

## Покрытие требований

| Шаг/сценарий | US-ID                                         | UC (основной)                                                        | HF (vision §2.2)     | BR                                                                                    | ADR-переход                                                  | Oracle (что проверять)                                                                                                  |
| ------------ | --------------------------------------------- | -------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 1            | US-integration.pr-mr.gitlab-issue-to-accepted | UC-integration.issues.bootstrap-project-sync-and-create-task (Mixed) | HF11.1               | BR-fact.git.vcs-workflow                                                              | import → backlog                                             | `POST /api/projects/:id/gitlab/sync`; `GET /api/tasks/:id=status=backlog`; WS `task:created`; E2E: L-10 (trace-context) |
| 2            | US-integration.pr-mr.gitlab-issue-to-accepted | UC-pipeline.stage.auto-advance-task (Agent)                          | HF1.1, HF4.1         | BR-trigger.automation.auto-queue, BR-constraint.git.worktree-isolation                | backlog → planning                                           | `GET /api/tasks/:id=status=planning`; наличие task branch/worktree в Git-инфраструктуре; E2E: новый L-10c               |
| 3            | US-integration.pr-mr.gitlab-issue-to-accepted | UC-pipeline.plan.generate-change-plan (Agent)                        | HF1.2, HF4.4, HF11.2 | BR-constraint.automation.plan-validation-gate, BR-trigger.automation.plan-review-gate | planning → plan_review                                       | `GET /api/tasks/:id/plan` (не пуст); `GET /api/projects/:id/gitlab` (mrLink/taskId); E2E: новый L-10d                   |
| 4            | US-integration.pr-mr.gitlab-issue-to-accepted | UC-integration.pr-mr.resolve-review-decision (Schedule/Agent)        | HF4.4, HF11.2        | BR-inference.git.review-decision-precedence, BR-trigger.automation.plan-review-gate   | plan_review → implementing                                   | approve в GitLab + `POST sync`; `GET /api/tasks/:id=status=implementing`; E2E: новый L-10e                              |
| 5            | US-integration.pr-mr.gitlab-issue-to-accepted | UC-pipeline.implementation.execute-change-in-isolation (Agent)       | HF1.4, HF4.1         | BR-constraint.git.worktree-isolation, BR-constraint.automation.implementation-commit  | implementing → verify                                        | commit в ветке задачи; `GET /api/tasks/:id=status=verify`; E2E: новый L-10f                                             |
| 6            | US-integration.pr-mr.gitlab-issue-to-accepted | UC-pipeline.verification.verify-change-result (Agent)                | HF1.5, HF5.1, HF5.4  | BR-trigger.automation.pipeline                                                        | verify → review (pass), verify → implementing (fail)         | task log содержит gate report (pass/fail); `GET /api/tasks/:id` статус согласован; E2E: новый L-10g                     |
| 7            | US-integration.pr-mr.gitlab-issue-to-accepted | UC-pipeline.completion.auto-complete-pipeline (Agent)                | HF1.6, HF5.3         | BR-trigger.automation.auto-review, BR-trigger.automation.completion-commit            | review → done                                                | `GET /api/tasks/:id=status=done`; review findings сохранены; E2E: новый L-10h                                           |
| 8            | US-integration.pr-mr.gitlab-issue-to-accepted | UC-vcs-auto.mr.publish-atomic-merge-request (Agent)                  | HF4.3, HF11.2        | BR-fact.git.vcs-workflow                                                              | (без обязательной смены стадии)                              | тот же `mrIid/mrUrl` до и после реализации; отсутствие второго MR; E2E: новый L-10i                                     |
| 9            | US-integration.pr-mr.gitlab-issue-to-accepted | UC-integration.pr-mr.resolve-review-decision (Schedule/Agent)        | HF1.6, HF11.2        | BR-trigger.automation.done-to-accepted-approval                                       | done → accepted                                              | merge MR + `POST sync`; `GET /api/tasks/:id=status=accepted`; E2E: L-10                                                 |
| 10           | US-integration.pr-mr.gitlab-issue-to-accepted | UC-integration.issues.bootstrap-project-sync-and-create-task (Mixed) | HF11.1, HF11.2       | BR-fact.git.vcs-workflow                                                              | import shortcut → done                                       | `GET /api/tasks/:id=status=done`; E2E: L-10                                                                             |
| 11           | US-integration.pr-mr.gitlab-issue-to-accepted | UC-integration.pr-mr.resolve-review-decision (Schedule/Agent)        | HF1.6, HF11.2        | BR-trigger.automation.done-to-accepted-approval                                       | done → accepted                                              | merge existing MR + sync; E2E: L-10                                                                                     |
| A1           | US-integration.pr-mr.gitlab-issue-to-accepted | UC-pipeline.plan.refine-plan-second-pass (Agent)                     | HF1.3                | BR-trigger.automation.plan-review-gate                                                | plan_review → improve                                        | `GET /api/tasks/:id=status=improve`; feedback сохранён                                                                  |
| A2           | US-integration.pr-mr.gitlab-issue-to-accepted | UC-pipeline.plan.refine-plan-second-pass (Agent)                     | HF1.3                | BR-trigger.automation.pipeline                                                        | planning → improve                                           | `GET /api/tasks/:id=status=improve`                                                                                     |
| A3           | US-integration.pr-mr.gitlab-issue-to-accepted | UC-pipeline.plan.refine-plan-second-pass (Agent)                     | HF1.3                | BR-trigger.automation.pipeline                                                        | improve → plan_review                                        | `GET /api/tasks/:id=status=plan_review`; plan updated                                                                   |
| A4           | US-integration.pr-mr.gitlab-issue-to-accepted | UC-pipeline.gate.enforce-stage-transition-gate (Agent)               | HF5.1                | BR-constraint.task-lifecycle.transitions                                              | plan_review → plan_review                                    | статус не меняется после `fast_fix`                                                                                     |
| A5           | US-integration.pr-mr.gitlab-issue-to-accepted | UC-pipeline.completion.auto-complete-pipeline (Agent)                | HF1.6                | BR-trigger.task-lifecycle.skip-review                                                 | implementing → done                                          | `GET /api/tasks/:id=status=done`; verify/review пропущены                                                               |
| A6           | US-integration.pr-mr.gitlab-issue-to-accepted | UC-pipeline.stage.auto-advance-task (Agent)                          | HF1.1, HF5.1         | BR-constraint.automation.verify-no-loop                                               | implementing → implementing                                  | статус остаётся implementing                                                                                            |
| A7           | US-integration.pr-mr.gitlab-issue-to-accepted | UC-pipeline.review-loop.iterate-review-feedback (Agent)              | HF5.3                | BR-trigger.automation.auto-review                                                     | review → implementing                                        | `reviewIterationCount` увеличен; `status=implementing`                                                                  |
| A8           | US-integration.pr-mr.gitlab-issue-to-accepted | UC-integration.pr-mr.resolve-review-decision (Schedule/Agent)        | HF11.2, HF5.3        | BR-inference.git.review-decision-precedence                                           | done → implementing                                          | `POST sync`; `GET /api/tasks/:id=status=implementing`                                                                   |
| A9           | US-integration.pr-mr.gitlab-issue-to-accepted | UC-integration.pr-mr.resolve-review-decision (Schedule/Agent)        | HF11.2               | BR-fact.git.vcs-workflow                                                              | done (не accepted) / paused                                  | закрыт MR без approve/merge; `GET /api/tasks/:id` не `accepted`; E2E: L-10b (расширение)                                |
| A10          | US-integration.pr-mr.gitlab-issue-to-accepted | UC-pipeline.gate.enforce-stage-transition-gate (Agent)               | HF5.1, HF6.3         | BR-trigger.task-lifecycle.blocked, BR-trigger.automation.failure-recovery             | \* → blocked_external                                        | `status=blocked_external`, `blockedReason`, `retryAfter`                                                                |
| A11          | US-integration.pr-mr.gitlab-issue-to-accepted | UC-pipeline.stage.auto-advance-task (Agent)                          | HF1.1                | BR-trigger.task-lifecycle.blocked                                                     | blocked_external → planning/improve/plan_review/implementing | `status` равен `originStage`                                                                                            |
| A12          | US-integration.pr-mr.gitlab-issue-to-accepted | UC-pipeline.manual-override.intervene-task-stage (GUI/API)           | HF1.7                | BR-constraint.task-lifecycle.transitions                                              | backlog → planning                                           | `POST /api/tasks/:id/transition`; `status=planning`                                                                     |
| A13          | US-integration.pr-mr.gitlab-issue-to-accepted | UC-pipeline.stage.auto-advance-task (Schedule/Agent)                 | HF1.1                | BR-trigger.task-lifecycle.scheduling                                                  | backlog → planning                                           | после `scheduledAt` статус `planning`                                                                                   |

### Покрытие всех переходов ADR-IMPL.PROCESS.task-state-machine

- `backlog → planning` — **2**, **A12**, **A13**.
- `planning → plan_review` — **3**.
- `planning → improve` — **A2**.
- `improve → plan_review` — **A3**.
- `plan_review → implementing` — **4**.
- `plan_review → improve` — **A1**.
- `plan_review → plan_review` — **A4**.
- `implementing → done` — **A5**.
- `implementing → verify` — **5**.
- `implementing → implementing` — **A6**.
- `verify → review` — **6** (ветка pass).
- `verify → implementing` — **6** (ветка fail).
- `review → done` — **7**.
- `review → implementing` — **A7**.
- `done → accepted` — **9**, **11**.
- `done → implementing` — **A8**.
- `blocked_external → planning` — **A11** (`originStage=planning`).
- `blocked_external → improve` — **A11** (`originStage=improve`).
- `blocked_external → plan_review` — **A11** (`originStage=plan_review`).
- `blocked_external → implementing` — **A11** (`originStage=implementing`).

Непокрытых переходов ADR нет.

## Требования к реальному прогону

### 1) Обязательные env/флаги

- `GIT_PROVIDER=gitlab`
- `AIF_GITLAB_ISSUE_MR_ENABLED=true`
- валидные `GITLAB_WEB_URL`, `GITLAB_TOKEN`
- runtime-ключи для выбранного профиля (`OPENAI_API_KEY` и связанные переменные)
- включён Coordinator poll cycle
- доступен WebSocket `/ws`

### 2) Обязательные данные

- тестовый GitLab-репозиторий доступен токену;
- Verify gates присутствуют в репозитории;
- для полного контура: Issue создаётся **без MR**;
- для краткого контура: Issue создаётся **с уже существующим MR**.

### 3) Полный AI-конвейер vs краткий интеграционный

- **Полный AI-конвейер:**
  `Issue без MR → backlog → planning → (improve) → plan_review (MR создан) → implementing → verify → review → done → merge того же MR → accepted`.

- **Краткий интеграционный:**
  `Issue с MR → импорт сразу в done → merge/sync → accepted`.

### 4) Единый MR (single-MR policy)

- MR создаётся на стадии plan review;
- после реализации обновляется **тот же** MR;
- создание второго completion MR считается нарушением данного US.

### 5) Негативные исходы для MR

- `changes requested` в plan review: `plan_review → improve`;
- `changes requested` в done/review: возврат в `implementing`;
- `close without merge/approve`: задача **не** становится `accepted`, ожидается `paused`/приостановка.

### 6) Внешний oracle (обязателен)

- REST: `GET /api/tasks`, `GET /api/tasks/:id`, `GET /api/tasks/:id/plan`, `GET /api/projects/:id/gitlab`, `POST /api/projects/:id/gitlab/sync`;
- WS: `task:created`, `task:updated`, `task:activity` (при наличии);
- GitLab: MR state (`open/merged/closed`), approvals, review notes;
- артефакты прогона: trace/логи API и Coordinator, подтверждение negative веток.

### 7) Примечание по E2E trace IDs (§5.3)

- Текущие сценарии каталога: `L-10`, `L-10b`.
- Для полного конвейера (ветка с planning/implementing/verify/review) требуется добавить новые `L-*` (предложение: `L-10c...L-10i`) с первой trace-строкой на основной UC.
