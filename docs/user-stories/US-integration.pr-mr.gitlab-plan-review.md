<a id="us-integration.pr-mr.gitlab-plan-review"></a>

# US-integration.pr-mr.gitlab-plan-review: Plan Review решения в GitLab (Plan → MR → Approve/Changes)

> Декомпозиция прежней `US-integration.pr-mr.gitlab-issue-to-accepted`
> (сценарии 3, 4, A1, A2, A3, A4).
> Совместимость: прежние якоря 3/4/A1/A2/A3/A4 остаются валидными.

```gherkin
@US-integration.pr-mr.gitlab-plan-review @HF1.2 @HF1.3 @HF4.4 @HF11.2 @UC-pipeline.plan.generate-change-plan @UC-pipeline.plan.refine-plan-second-pass @UC-integration.pr-mr.resolve-review-decision @P0 @integration @pr-mr @core-e2e
Feature: US-integration.pr-mr.gitlab-plan-review Plan Review решения в GitLab

  Background:
    Given задача находится в planning или plan_review (VCS-привязка GitLab)
    And для проекта настроен Effective Runtime Profile для планирования
    And публикация MR плана включена (AIF_PLAN_REVIEW_PR_ENABLED=true)

  Scenario: 1. Planner формирует план и публикует единый MR для plan review
    Given задача находится в planning и runtime доступен
    When subagent planner завершает планирование
    Then файл плана создан и не пуст
    And в GitLab создан один MR в режиме plan_review, связанный с задачей
    And задача переходит в plan_review

  Scenario: 2. Approve в GitLab MR переводит задачу Plan Review → Implementing
    Given задача находится в plan_review и связана с MR в GitLab
    When пользователь выполняет Approve в GitLab MR
    Then после следующего sync задача переходит в implementing

  Scenario: 3. Отклонение плана возвращает Plan Review → Improve
    Given задача находится в plan_review
    When ревьюер запрашивает изменения плана
    Then задача переходит в improve

  Scenario: 4. runPlanImprove переводит Planning → Improve
    Given задача находится в planning и runPlanImprove=true
    When планирование завершено
    Then задача переходит в improve

  Scenario: 5. Завершение Improve переводит Improve → Plan Review
    Given задача находится в improve
    When subagent improver завершает второй проход
    Then задача переходит в plan_review

  Scenario: 6. Fast fix в Plan Review даёт self-loop
    Given задача находится в plan_review
    When применяется fast_fix
    Then задача остаётся в plan_review
```

## Покрытие требований

| Шаг/сценарий | US-ID                                   | UC (основной)                                                 | HF (vision §2.2)     | BR                                          | ADR-переход                | Oracle (что проверять)                                                                                           |
| ------------ | --------------------------------------- | ------------------------------------------------------------- | -------------------- | ------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1            | US-integration.pr-mr.gitlab-plan-review | UC-pipeline.plan.generate-change-plan (Agent)                 | HF1.2, HF4.4, HF11.2 | BR-trigger.automation.plan-review-gate      | planning → plan_review     | `GET /tasks/:id/plan` не пуст; `GET /projects/:id/gitlab` mrLink/mrMode=plan_review; E2E: L-10d (API), L-10-full |
| 2            | US-integration.pr-mr.gitlab-plan-review | UC-integration.pr-mr.resolve-review-decision (Schedule/Agent) | HF4.4, HF11.2        | BR-inference.git.review-decision-precedence | plan_review → implementing | approve + sync; `status=implementing`; E2E: L-10-full (API/GUI, llm)                                             |
| 3            | US-integration.pr-mr.gitlab-plan-review | UC-pipeline.plan.refine-plan-second-pass (Agent)              | HF1.3                | BR-trigger.automation.plan-review-gate      | plan_review → improve      | `status=improve`; feedback сохранён; E2E: L-10k (API, llm)                                                       |
| 4            | US-integration.pr-mr.gitlab-plan-review | UC-pipeline.plan.refine-plan-second-pass (Agent)              | HF1.3                | BR-trigger.automation.pipeline              | planning → improve         | `status=improve` (unit)                                                                                          |
| 5            | US-integration.pr-mr.gitlab-plan-review | UC-pipeline.plan.refine-plan-second-pass (Agent)              | HF1.3                | BR-trigger.automation.pipeline              | improve → plan_review      | `status=plan_review`, plan updated; E2E: L-10k                                                                   |
| 6            | US-integration.pr-mr.gitlab-plan-review | UC-pipeline.gate.enforce-stage-transition-gate (Agent)        | HF5.1                | BR-constraint.task-lifecycle.transitions    | plan_review → plan_review  | статус не меняется после fast_fix (unit)                                                                         |

## Требования к реальному прогону

1. Обязательные env/флаги: `GIT_PROVIDER=gitlab`, `AIF_GITLAB_ISSUE_MR_ENABLED=true`,
   `AIF_PLAN_REVIEW_PR_ENABLED=true`, `GITLAB_WEB_URL`, `GITLAB_TOKEN`.
2. Для полного approve-цикла (Sc.2) требуется настроенный runtime-профиль и
   Coordinator poll (E2E: `@requires-llm` L-10-full).
3. Детерминированная часть (Sc.1 — publish-plan маршрутом) — `@core-e2e` L-10d.

## Primary E2E layer

- **Primary: API** — publish-plan маршрут и state-переходы (L-10d детерминированно;
  L-10k полный loop при LLM).
- **Secondary smoke: GUI** — L-10-full (connect/sync/approve через UI в llm-контуре).
- Capability: `@core-e2e` (Sc.1, Sc.4–Sc.6 unit), `@requires-llm` (Sc.2, Sc.3, Sc.5
  полный improver-цикл в L-10k).

## Совместимость с прежней US

| Прежний сценарий | Новая история/сценарий |
| ---------------- | ---------------------- |
| 3                | gitlab-plan-review: 1  |
| 4                | gitlab-plan-review: 2  |
| A1               | gitlab-plan-review: 3  |
| A2               | gitlab-plan-review: 4  |
| A3               | gitlab-plan-review: 5  |
| A4               | gitlab-plan-review: 6  |
