<a id="us-integration.pr-mr.rework-plan-on-mr-comment"></a>

# US-integration.pr-mr.rework-plan-on-mr-comment: Доработка плана по комментарию в MR (Plan Review → Improve)

```gherkin
@US-integration.pr-mr.rework-plan-on-mr-comment @HF11.2 @HF1.3 @HF5.1 @HF4.4 @UC-integration.pr-mr.resolve-review-decision @UC-pipeline.plan.refine-plan-second-pass @P1 @integration @pr-mr @agent
Feature: US-integration.pr-mr.rework-plan-on-mr-comment Доработка плана по комментарию в MR

  Background:
    Given проект подключён к GitLab через /api/projects/:id/gitlab
    And синхронизация GitLab Issues/MR включена
    And задача связана с опубликованным MR в режиме plan_review
    And для задачи действует Plan Review Gate
    And Coordinator выполняет poll-цикл по расписанию (канал Agent)
    And переходы статусов проходят через формальный state-machine gate

  Scenario: Комментарий с запросом изменений возвращает задачу Plan Review → Improve
    Given задача находится в plan_review и её план опубликован в MR
    And в MR появился комментарий ревьюера с запросом изменений плана
    When Coordinator синхронизирует решение ревью из MR
    Then задача переходит в improve с planReviewState=changes_requested
    And текст комментария сохраняется как planReviewFeedback
    And реализация не начинается, пока план не доработан

  Scenario: Improver дорабатывает план и возвращает задачу Improve → Plan Review
    Given задача находится в improve и получила planReviewFeedback
    When subagent improver завершает второй проход планирования
    Then план обновлён с учётом комментария ревьюера
    And задача переходит в plan_review
    And обновлённая версия плана публикуется в тот же MR

  Scenario: Повторная синхронизация того же решения не перезапускает доработку
    Given решение ревью по комментарию уже применено к задаче
    When Coordinator выполняет повторную синхронизацию без новых комментариев
    Then статус задачи не изменяется повторно
    And доработка плана не запускается заново по одному и тому же решению

  Scenario: Конкурирующие решения ревью — применяется более новое
    Given в MR присутствуют и одобрение, и запрос изменений плана
    And запрос изменений является более новым решением
    When Coordinator применяет действующее решение ревью
    Then задача переходит в improve
    And более старое одобрение не открывает реализацию
```

## Покрытие требований

| Шаг/сценарий | US-ID                                          | UC (основной)                                        | HF (vision §2.2)     | BR                                                                                  | ADR-переход               | Oracle (что проверять)                                                                                                                        |
| ------------ | ---------------------------------------------- | ---------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1            | US-integration.pr-mr.rework-plan-on-mr-comment | UC-integration.pr-mr.resolve-review-decision (Agent) | HF11.2, HF4.4, HF5.1 | BR-trigger.automation.plan-review-gate, BR-inference.git.review-decision-precedence | plan_review → improve     | `GET /api/tasks/:id = status=improve`; `planReviewState=changes_requested`; `planReviewFeedback` не пуст; E2E: L-10-full (plan-review контур) |
| 2            | US-integration.pr-mr.rework-plan-on-mr-comment | UC-pipeline.plan.refine-plan-second-pass (Agent)     | HF1.3                | BR-trigger.automation.plan-review-gate                                              | improve → plan_review     | `GET /api/tasks/:id = status=plan_review`; план обновлён; тот же `mrIid/mrUrl`                                                                |
| 3            | US-integration.pr-mr.rework-plan-on-mr-comment | UC-integration.pr-mr.resolve-review-decision (Agent) | HF11.2, HF5.1        | BR-trigger.automation.plan-review-gate                                              | (без повторного перехода) | повторный `POST sync` не меняет статус; improver не запускается снова                                                                         |
| 4            | US-integration.pr-mr.rework-plan-on-mr-comment | UC-integration.pr-mr.resolve-review-decision (Agent) | HF11.2, HF5.1        | BR-inference.git.review-decision-precedence                                         | plan_review → improve     | более новая заметка `requested changes` побеждает старое одобрение; задача в `improve`                                                        |

## Покрытие переходов ADR-IMPL.PROCESS.task-state-machine

- `plan_review → improve` — сценарии **1**, **4** (запрос изменений по комментарию в MR).
- `improve → plan_review` — сценарий **2** (завершение доработки improver).
- Повторное применение одного и того же решения (сценарий **3**) — не создаёт переход, статус не меняется.

## Требования к реальному прогону

- `GIT_PROVIDER=gitlab`, `AIF_GITLAB_ISSUE_MR_ENABLED=true`, валидные `GITLAB_WEB_URL`, `GITLAB_TOKEN`.
- Для контура с LLM: `AIF_LLM_INTEGRATION=1` и настроенный runtime-профиль (improver — реальный вызов модели).
- Для контура без LLM (детерминированный): задача выводится в `plan_review` через publish-plan, запрос изменений имитируется заметкой MR, статус проверяется через `GET /api/tasks/:id`.
- Внешний oracle: GitLab MR notes API (системная заметка `requested changes` + человеческий комментарий), `GET /api/projects/:id/gitlab`, `GET /api/tasks/:id`.
