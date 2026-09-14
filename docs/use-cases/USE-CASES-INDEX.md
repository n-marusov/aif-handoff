# Каталог прецедентов использования — AIF Handoff

> Этот файл — индекс всех UC. Поддерживается актуальным при добавлении/изменении UC.

## Фильтрация

| Критерий       | Значения                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Домен (L1)** | `pipeline` · `dashboard` · `runtime` · `vcs-auto` · `accounting` · `handoff` · `chat` · `auth` · `audit` · `integration` · `warmup` |
| **Приоритет**  | `P0` (критичный) · `P1` (высокий) · `P2` (средний)                                                                                  |
| **Канал**      | `GUI` · `API` · `Agent` · `Schedule` · `Mixed`                                                                                      |
| **Статус**     | `as is` (реализовано) · `to be` (целевое состояние)                                                                                 |

---

## pipeline — Конвейер обработки изменений (HF1 + HF5)

| UC-ID                                                                                                                     | Приоритет | Канал   | Статус  |
| ------------------------------------------------------------------------------------------------------------------------- | --------- | ------- | ------- |
| [UC-pipeline.stage.auto-advance-task](UC-pipeline.stage.auto-advance-task.md)                                             | P0        | Agent   | `as is` |
| [UC-pipeline.plan.generate-change-plan](UC-pipeline.plan.generate-change-plan.md)                                         | P0        | Agent   | `as is` |
| [UC-pipeline.plan.refine-plan-second-pass](UC-pipeline.plan.refine-plan-second-pass.md)                                   | P1        | Agent   | `as is` |
| [UC-pipeline.implementation.execute-change-in-isolation](UC-pipeline.implementation.execute-change-in-isolation.md)       | P0        | Agent   | `as is` |
| [UC-pipeline.verification.verify-change-result](UC-pipeline.verification.verify-change-result.md)                         | P1        | Agent   | `as is` |
| [UC-pipeline.completion.auto-complete-pipeline](UC-pipeline.completion.auto-complete-pipeline.md)                         | P0        | Agent   | `as is` |
| [UC-pipeline.manual-override.intervene-task-stage](UC-pipeline.manual-override.intervene-task-stage.md)                   | P1        | GUI/API | `as is` |
| [UC-pipeline.gate.enforce-stage-transition-gate](UC-pipeline.gate.enforce-stage-transition-gate.md)                       | P0        | Agent   | `as is` |
| [UC-pipeline.sidecar.review-with-sidecar-agent](UC-pipeline.sidecar.review-with-sidecar-agent.md)                         | P0        | Agent   | `as is` |
| [UC-pipeline.review-loop.iterate-review-feedback](UC-pipeline.review-loop.iterate-review-feedback.md)                     | P1        | Agent   | `as is` |
| [UC-pipeline.independent-verification.verify-independently](UC-pipeline.independent-verification.verify-independently.md) | P1        | Agent   | `as is` |
| [UC-pipeline.escalation.escalate-after-exhausted-retries](UC-pipeline.escalation.escalate-after-exhausted-retries.md)     | P1        | Agent   | `as is` |

## dashboard — Единый дашборд изменений (HF2)

| UC-ID                                                                                                     | Приоритет | Канал    | Статус  |
| --------------------------------------------------------------------------------------------------------- | --------- | -------- | ------- |
| [UC-dashboard.board.view-kanban-columns](UC-dashboard.board.view-kanban-columns.md)                       | P0        | GUI      | `as is` |
| [UC-dashboard.gate-status.view-gate-results](UC-dashboard.gate-status.view-gate-results.md)               | P1        | GUI      | `as is` |
| [UC-dashboard.detail.view-task-details](UC-dashboard.detail.view-task-details.md)                         | P0        | GUI      | `as is` |
| [UC-dashboard.realtime.receive-live-status-updates](UC-dashboard.realtime.receive-live-status-updates.md) | P1        | GUI (WS) | `as is` |
| [UC-dashboard.search.find-task-by-query](UC-dashboard.search.find-task-by-query.md)                       | P2        | GUI      | `as is` |

## runtime — Подключаемые runtime-адаптеры (HF3)

| UC-ID                                                                                                           | Приоритет | Канал   | Статус  |
| --------------------------------------------------------------------------------------------------------------- | --------- | ------- | ------- |
| [UC-runtime.profile.configure-project-runtime](UC-runtime.profile.configure-project-runtime.md)                 | P0        | GUI/API | `as is` |
| [UC-runtime.override.override-profile-for-task](UC-runtime.override.override-profile-for-task.md)               | P1        | GUI/API | `as is` |
| [UC-runtime.external-adapter.register-external-module](UC-runtime.external-adapter.register-external-module.md) | P2        | API     | `as is` |

## vcs-auto — VCS-автоматизация (HF4)

| UC-ID                                                                                                     | Приоритет | Канал | Статус  |
| --------------------------------------------------------------------------------------------------------- | --------- | ----- | ------- |
| [UC-vcs-auto.isolation.execute-task-in-worktree](UC-vcs-auto.isolation.execute-task-in-worktree.md)       | P0        | Agent | `as is` |
| [UC-vcs-auto.commit.auto-commit-before-completion](UC-vcs-auto.commit.auto-commit-before-completion.md)   | P0        | Agent | `as is` |
| [UC-vcs-auto.mr.publish-atomic-merge-request](UC-vcs-auto.mr.publish-atomic-merge-request.md)             | P2        | Agent | `as is` |
| [UC-vcs-auto.plan-review.publish-plan-for-approval](UC-vcs-auto.plan-review.publish-plan-for-approval.md) | P1        | Agent | `as is` |

## accounting — Учёт использования и лимиты (HF6)

| UC-ID                                                                                               | Приоритет | Канал     | Статус  |
| --------------------------------------------------------------------------------------------------- | --------- | --------- | ------- |
| [UC-accounting.tracking.record-runtime-call](UC-accounting.tracking.record-runtime-call.md)         | P0        | Agent/API | `as is` |
| [UC-accounting.limits.configure-project-limits](UC-accounting.limits.configure-project-limits.md)   | P1        | GUI/API   | `as is` |
| [UC-accounting.blocking.block-on-limit-exceeded](UC-accounting.blocking.block-on-limit-exceeded.md) | P1        | Agent     | `as is` |

## handoff — Роли, handoff и эскалация (HF7)

| UC-ID                                                                                                             | Приоритет | Канал     | Статус  |
| ----------------------------------------------------------------------------------------------------------------- | --------- | --------- | ------- |
| [UC-handoff.transfer.ownership-to-executor](UC-handoff.transfer.ownership-to-executor.md)                         | P0        | API/Agent | `as is` |
| [UC-handoff.escalation.escalate-unresolvable-decision](UC-handoff.escalation.escalate-unresolvable-decision.md)   | P1        | Agent     | `as is` |
| [UC-handoff.history.view-executor-timeline](UC-handoff.history.view-executor-timeline.md)                         | P2        | GUI/API   | `as is` |
| [UC-handoff.diagnostics.receive-escalation-diagnostics](UC-handoff.diagnostics.receive-escalation-diagnostics.md) | P1        | Agent     | `as is` |

## chat — Чат с AI-ассистентом (HF8)

| UC-ID                                                                                           | Приоритет | Канал    | Статус  |
| ----------------------------------------------------------------------------------------------- | --------- | -------- | ------- |
| [UC-chat.project-context.consult-ai-assistant](UC-chat.project-context.consult-ai-assistant.md) | P1        | GUI (WS) | `as is` |
| [UC-chat.task-context.discuss-task-with-ai](UC-chat.task-context.discuss-task-with-ai.md)       | P1        | GUI (WS) | `as is` |

## auth — Участники и аутентификация (HF9)

| UC-ID                                                                                   | Приоритет | Канал   | Статус  |
| --------------------------------------------------------------------------------------- | --------- | ------- | ------- |
| [UC-auth.registration.sign-up-participant](UC-auth.registration.sign-up-participant.md) | P1        | GUI/API | `as is` |
| [UC-auth.roles.assign-participant-role](UC-auth.roles.assign-participant-role.md)       | P1        | GUI/API | `as is` |

## audit — Аудит и наблюдаемость (HF10)

| UC-ID                                                                                       | Приоритет | Канал     | Статус  |
| ------------------------------------------------------------------------------------------- | --------- | --------- | ------- |
| [UC-audit.logging.audit-state-transition](UC-audit.logging.audit-state-transition.md)       | P0        | Agent/API | `as is` |
| [UC-audit.heartbeat.receive-agent-heartbeat](UC-audit.heartbeat.receive-agent-heartbeat.md) | P1        | Agent     | `as is` |
| [UC-audit.errors.classify-runtime-error](UC-audit.errors.classify-runtime-error.md)         | P1        | Agent     | `as is` |

## integration — VCS-интеграция GitHub/GitLab (HF11)

| UC-ID                                                                                               | Приоритет | Канал          | Статус  |
| --------------------------------------------------------------------------------------------------- | --------- | -------------- | ------- |
| [UC-integration.issues.sync-github-issue](UC-integration.issues.sync-github-issue.md)               | P2        | Schedule/Agent | `as is` |
| [UC-integration.pr-mr.publish-github-pr](UC-integration.pr-mr.publish-github-pr.md)                 | P2        | Agent          | `as is` |
| [UC-integration.ci-status.check-pipeline-status](UC-integration.ci-status.check-pipeline-status.md) | P2        | Schedule/Agent | `as is` |

## warmup — Разогрев сессий (HF12)

| UC-ID                                                                                   | Приоритет | Канал          | Статус  |
| --------------------------------------------------------------------------------------- | --------- | -------------- | ------- |
| [UC-warmup.preheat.warmup-runtime-session](UC-warmup.preheat.warmup-runtime-session.md) | P2        | Schedule/Agent | `as is` |

---

> Всего UC: **42**. Статус UC должен актуализироваться по мере развития системы. `to be`-UC помечаются фазой roadmap.
