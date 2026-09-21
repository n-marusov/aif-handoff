# Test Plan — Rework-to-Improve / Rework-to-Implementing (E2E API)

- Branch: `feature/missing-gates-and-makefile-integration`
- Level: E2E API (`packages/web/e2e/api/`, Playwright + real dev stack + GitLab CE)
- Stand: docker-compose e2e-стек (api :3009 + web :5180 + agent-координатор + GitLab CE :8929) или dev-стек
- Trace: `US-integration.pr-mr.rework-plan-on-mr-comment`, `US-pipeline.stage.done-to-implementing-rework` (новые US)

## Scenario cards

### S-1. done → implementing rework (детерминированный, US-2 Sc.1 + Sc.3)

**Trace:** `US-pipeline.stage.done-to-implementing-rework`; `UC-pipeline.review-loop.iterate-review-feedback`; `HF1.6/HF5.3`; `BR-constraint.task-lifecycle.transitions`
**Priority:** P0

Preconditions:
- GitLab-стенд + `AIF_GITLAB_ISSUE_MR_ENABLED=true`; изолированный проект; Issue + открытый MR (Closes #iid).

Steps:
1. GitLab shortcut-импорт → задача в `done`.
2. `POST /tasks/:id/events {event:"request_changes"}`.
3. Assert: `status=implementing`, `reworkRequested=true`.
4. Повторный `request_changes` → 409 (не 200), статус не меняется.
5. Oracle: `GET /tasks/:id`.

Expected: переход `done → implementing` с флагом доработки; идемпотентность (повтор не срабатывает).

### S-2. plan_review → improve → plan_review (LLM-контур, US-1 Sc.1 + Sc.2)

**Trace:** `US-integration.pr-mr.rework-plan-on-mr-comment`; `UC-integration.pr-mr.resolve-review-decision`, `UC-pipeline.plan.refine-plan-second-pass`; `HF11.2/HF1.3/HF5.1`; `BR-trigger.automation.plan-review-gate`
**Priority:** P1 (гейт `AIF_LLM_INTEGRATION=1`)

Preconditions:
- LLM-runtime настроен; GitLab-стенд; autoQueueMode у проекта.

Steps:
1. Импорт Issue (без MR) → backlog; auto-queue → planning.
2. Ждём публикацию plan-MR (`mrMode=plan_review`), план-файл существует.
3. `POST /tasks/:id/events {event:"request_plan_changes"}` → assert `status=improve`.
4. Ждём improver → poll `status=plan_review`.
5. Oracle: `GET /tasks/:id`, GitLab MR state.

Expected: `plan_review → improve` по решению ревью; improver дорабатывает план и возвращает `plan_review`.

### S-3. Регрессия одобрения плана (контроль, чтобы покрытие US-1 не сломало approve-путь)

**Trace:** `US-integration.pr-mr.gitlab-issue-to-accepted`; `HF4.4`; `BR-trigger.automation.plan-review-gate`
**Priority:** P1 (LLM-контур, опционально)

Лёгкая проверка: тот же план, но `approve` → `implementing` (не ломаем существующий путь). Покрыт существующим `L-10-full`; отдельный тест не требуется.

## Contract references

- REST: `GET /tasks/:id`, `POST /tasks/:id/events`, `/projects/:id/gitlab`, `POST /projects/:id/gitlab/sync`
- GitLab: Issues/MRs/notes API (внешний oracle через `packages/web/e2e/shared/gitlab.ts`)
- US/UC/BR: новые US, `UC-pipeline.review-loop.iterate-review-feedback`, `UC-integration.pr-mr.resolve-review-decision`, `UC-pipeline.plan.refine-plan-second-pass`