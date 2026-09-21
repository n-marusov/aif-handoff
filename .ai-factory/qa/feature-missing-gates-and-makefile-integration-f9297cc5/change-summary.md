# Change Summary — Rework-to-Improve / Rework-to-Implementing (новые US)

- Branch: `feature/missing-gates-and-makefile-integration`
- Date: 2026-09-21
- Scope: e2e-покрытие двух новых пользовательских историй:
  - `US-integration.pr-mr.rework-plan-on-mr-comment` — доработка плана из `plan_review` в `improve` по решению ревью (MR-комментарий).
  - `US-pipeline.stage.done-to-implementing-rework` — доработка из `done` в `implementing` по решению человека (скилл `$aif-fix`).

## What changed (фактическое состояние контура после коммита)

- `markTaskPlanChangesRequested` (`packages/data/src/taskTransitions.ts`) теперь возвращает задачу из `plan_review` в **`improve`** (было `planning`) — приведено к `ADR-IMPL.PROCESS.task-state-machine` (`done --> implementing : request_changes (rework; skill $aif-fix)`).
- Обновлены доки: `docs/api.md`, `docs/configuration.md`, `docs/contracts/rest/aif-api.md`, ADR VCS-workflow, `US-integration.pr-mr.resolve-review-decision` (sequence), demo-ранбуки.
- Добавлены две US в `docs/user-stories/` + индекс каталога (21 → 23).
- `docs/known-issues.md`: 2 записи (generic implementer вместо `$aif-fix`; `$aif-evolve` после 5+ патчей).

## Реальная достижимость сценариев на стенде (важно для TC)

| Сценарий | Достижимость в e2e | Причина |
| -------- | ------------------ | ------- |
| `done → implementing` (US-2, Sc.1) | ✅ детерминированно | краткий импорт Issue+MR → `done`; событие `request_changes` (legacy) → `implementing` + `reworkRequested=true` |
| `$aif-fix`-направленность доработки (US-2, Sc.2) | ⚠️ только LLM-контур | промпт доработки формирует actor; в детерминированном режиме проверяем переход и флаг |
| Повторная синхронизация не перезапускает доработку (US-2/1, идемпотентность) | ✅ детерминированно | повторное `request_changes` из `implementing` → 409; статус не меняется |
| `plan_review → improve` (US-1, Sc.1) | ⚠️ только LLM-контур | `plan_review` недостижим без планировщика в legacy (participants disabled → `mark_plan_ready` недоступен) |
| Improver → `plan_review` (US-1, Sc.2) | ⚠️ только LLM-контур | improver — реальный вызов runtime |
| MR-note `requested changes` → improve | ❌ non-deterministic по API | GitLab CE не создаёт `system:true` заметку «requested changes» через публичный API; покрыто route-тестами |

## Risks / mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Coordinator перехватывает тестовую задачу | импорт создаёт `paused:true`; держим `paused` до конца теста |
| LLM-контур дорогой/нестабильный | гейт `AIF_LLM_INTEGRATION=1` (как L-10-full); таймауты ×10–30 мин; детерминированные тесты не требуют LLM |
| GitLab-стенд недоступен | гейт `ensureGitLabIssueMrFeature` (skip) |
| Правки в общий spec | тесты добавляются в существующий `gitlab-issue-to-accepted-full.spec.ts` (те же хелперы) |

## Priority mapping

- US-2 `done → implementing` — P0-контур (возврат задачи на доработку человеком) — детерминированный e2e.
- US-1 `plan_review → improve` — P1 (доработка плана) — LLM-gated e2e + route-уровень.