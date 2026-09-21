# Test Cases — Rework-to-Improve / Rework-to-Implementing (E2E API)

Branch: `feature/missing-gates-and-makefile-integration`. Level: E2E API.
Stand: e2e стек (api :3009 + web :5180 + coordinator + GitLab CE :8929). Проект: изолированный e2e-проект (createIsolatedProject).

Global fixture rules:
- задачи создаются/импортируются через реальный API + GitLab; импорт создаёт `paused:true` (координатор не перехватывает);
- cleanup: `DELETE /tasks/:id`, `DELETE /projects/:id` (в `finally`);
- runner vars: `marker = runId()`; GitLab env: `GITLAB_TOKEN`, `GITLAB_WEB_URL`, `GIT_PROVIDER=gitlab`, `AIF_GITLAB_ISSUE_MR_ENABLED=true`;
- LLM-сценарий: гейт `AIF_LLM_INTEGRATION=1` + настроенный runtime-профиль; недопустим skip — ошибка стенда.

---

## TC-US2-01 done → implementing (request_changes), флаг rework

Trace: `US-pipeline.stage.done-to-implementing-rework` Sc.1; `UC-pipeline.review-loop.iterate-review-feedback`; `BR-constraint.task-lifecycle.transitions`.

| Step | Action | Expected |
| ---- | ------ | -------- |
| 1 | Create isolated project; create GitLab branch + commit; create Issue; create MR `Closes #<iid>` | 200/201 на страхующих API-звеньях |
| 2 | `PUT /projects/:id/gitlab` (enabled, labels:[label]); `POST /projects/:id/gitlab/sync` | проект подключён, sync 200 |
| 3 | poll task link (`GET /projects/:id/gitlab` → issue.taskId) | taskId не null; `mrIid` == созданному |
| 4 | poll `GET /tasks/:id` | `status=done` (краткий импорт) |
| 5 | `POST /tasks/:id/events {event:"request_changes"}` | 2xx; ответ `status=implementing` |
| 6 | `GET /tasks/:id` | `status=implementing`, `reworkRequested=true` |
| 7 | Повторный `POST /tasks/:id/events {event:"request_changes"}` | 409 (invalid_transition); `GET /tasks/:id` по-прежнему `implementing` |
| 8 | cleanup | `DELETE /tasks/:id`, `DELETE /projects/:id` (404 терпим) |

Negative: повторный `request_changes` из `implementing` отклоняется; одобрение `approve_done` из `implementing` тоже (вне сценария).

---

## TC-US2-02 done → implementing: отзыв человека является единственным основанием

Trace: `US-pipeline.stage.done-to-implementing-rework` Sc.1; `BR-inference.git.review-decision-precedence`.

| Step | Action | Expected |
| ---- | ------ | -------- |
| 1 | Повторить шаги 1–4 из TC-US2-01 | задача в `done` |
| 2 | Проверить `GET /tasks/:id` | `status=done`, `reworkRequested=false` до решения |
| 3 | Применить `request_changes` | задача в `implementing`, `reworkRequested=true` |
| 4 | Проверить `planReviewState` (если был published) | не `approved`; дерево/ветка задачи сохранены (`branchName` не пуст) |

Note: сценарий подтверждает, что только явное решение человека запускает доработку — «done по гейтам» само по себе не является основанием.

---

## TC-US1-01 plan_review → improve (LLM-контур), improver → plan_review

Trace: `US-integration.pr-mr.rework-plan-on-mr-comment` Sc.1+Sc.2; `UC-integration.pr-mr.resolve-review-decision`, `UC-pipeline.plan.refine-plan-second-pass`; `AIF_LLM_INTEGRATION=1`.

| Step | Action | Expected |
| ---- | ------ | -------- |
| 1 | Create isolated project; create Issue (без MR); connect GitLab; sync | задача в `backlog`, taskId получен |
| 2 | `PATCH /projects/:id/auto-queue-mode {enabled:true}` | 200; coordinator ведёт backlog → planning |
| 3 | poll `GET /projects/:id/gitlab` (entry.mrMode === "plan_review") | `planMrIid` не null; MR в режиме плана |
| 4 | `GET /tasks/:id/plan-file-status` | `exists=true` (план на диске) |
| 5 | `POST /tasks/:id/events {event:"request_plan_changes"}` | 2xx; задача переходит в `improve` |
| 6 | poll `GET /tasks/:id` | `status=improve` (переход зафиксирован) |
| 7 | Ждём improver (LLM) — poll `GET /tasks/:id` | `status=plan_review` (improve → plan_review) |
| 8 | Oracle | обновлённый план в том же MR (`listMergeRequestsForBranch` == 1) |
| 9 | cleanup | `DELETE /tasks/:id`, `DELETE /projects/:id` |

Note: `planReviewFeedback` через MR-note (`system:true` «requested changes») в GitLab CE публичным API не создаётся — фидбек-путь покрыт route-тестами (`gitlab.test.ts`), в e2e фиксируется переход статуса событием ревью.

Negative: `request_plan_changes` из не-participants-легаси статуса вне `plan_review` → 409.

---

## TC-US1-02 Идемпотентность решения ревью (без изменения статуса)

Trace: `US-integration.pr-mr.rework-plan-on-mr-comment` Sc.3; `BR-inference.git.review-decision-precedence`.

| Step | Action | Expected |
| ---- | ------ | -------- |
| 1 | Повторить шаги 1–6 TC-US1-01 | задача в `improve` |
| 2 | Повторный `POST /tasks/:id/events {event:"request_plan_changes"}` | 409 (не из `plan_review`); статус не меняется |
| 3 | Повторный sync (без новых заметок ревью) | статус не «отскакивает» (маркеры `lastReviewNoteId` уже обработаны) |
| 4 | Oracle | `GET /tasks/:id` — статус согласован между званием и событием |

---

## Эталонная приоритизация

| Пара | Приоритет | Покрытие |
| ---- | ---------- | -------- |
| TC-US2-01/02 | P0 | детерминированный e2e (реальный GitLab, без LLM) |
| TC-US1-01/02 | P1 | LLM-gated e2e (как L-10-full); без LLM недостижимо |

Реализация: `packages/web/e2e/api/gitlab-issue-to-accepted-full.spec.ts` — новые тесты L-10j / L-10k (см. комменты в спеке).