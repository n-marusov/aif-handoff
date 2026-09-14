# ADR-IMPL.PROCESS.task-state-machine

**Статус:** ПРИНЯТО
**Дата:** 2026-09-14
**Контекст:** Задачи в AIF Handoff проходят через конвейер стадий: от создания (backlog) до завершения (done/accepted). Без формальной модели состояний каждый переход обрабатывался бы ad-hoc — статусы разрастались бы, условия переходов дублировались, и система стала бы непредсказуемой. Для AI-управляемого конвейера нужна детерминированная машина состояний с явными правилами, действиями и защитами.

**Требование-источник:** `vision.md` §1.3 HF-1–HF-7, `vision.md` §2 (границы конвейера), `docs/architecture.md` §Task State Machine

## Решение: Машина состояний в `packages/shared/src/stateMachine.ts` с централизованной функцией `computeTransition(action, task, context)`, возвращающей `TransitionResult` с патчем или ошибкой. Полный граф переходов (Mermaid state diagram):

```mermaid
stateDiagram-v2
    direction LR

    backlog --> planning : start_ai / start_human_work / scheduledAt

    planning --> plan_ready : plan completed / mark_plan_ready
    planning --> improve : runPlanImprove flag

    improve --> plan_ready : improve completed

    plan_ready --> implementing : start_implementation / autoMode
    plan_ready --> improve : request_replanning
    plan_ready --> plan_ready : fast_fix
    plan_ready --> plan_review : publish_plan (plan_review gate)

    plan_review --> implementing : approve_plan
    plan_review --> improve : request_plan_changes (PR/MR feedback)

    implementing --> done : skipReview flag
    implementing --> verify : implementation completed

    verify --> review : verification passed
    verify --> implementing : verification failed

    review --> done : review accepted / complete_review
    review --> implementing : request_changes / request_review_changes (rework)

    done --> accepted : approve_done
    done --> implementing : request_changes (rework)

    blocked_external --> planning : retry_from_blocked
    blocked_external --> plan_ready : retry_from_blocked
    blocked_external --> implementing : retry_from_blocked
```

Статусы: `backlog → planning → improve → plan_ready → plan_review → implementing → verify → review → done → accepted`. Ключевые принципы:

- **Actor-aware:** каждое действие знает, кто его выполняет (ai/human/system), и участник, если Participants Mode включён.
- **Skill-mode флаги:** `runPlanImprove` (вставка improve), `skipReview` (пропустить verify и review), `useSubagents` (subagent vs skills-mode).
- **AutoMode:** когда `true`, координатор автоматически проводит задачу по всем стадиям с auto-review gate.
- **Blocked external:** при недоступности рантайма задача переходит в `blocked_external` с `retryAfter` и автоматическим возвратом.
- **Action codes:** каждое возвращаемое действие имеет код (`action_not_allowed`, `actor_not_authorized` и т.д.) для однозначной обработки в API и UI.

**Рассмотренные альтернативы:**

- **XState / state machines as code** — внешняя библиотека для формальной машины. Отвергнуто: избыточно для текущей сложности, дополнительная зависимость, простые таблицы переходов читаются легче.
- **Статусы как enum без формальных правил** — `TaskStatus` + `if`-проверки по всему коду. Отвергнуто: дублирование правил, риск незаконного перехода.
- **State machine per pipeline stage** — отдельные автоматы для планирования, реализации, ревью. Отвергнуто: сложность согласования переходов между автоматами.

**Последствия:**

- **Положительные:** все правила в одном файле; `TransitionResult` с кодом ошибки даёт однозначную обратную связь API; actor-aware позволяет совмещать AI и human execution в одном автомате; флаги (skipReview, autoMode, scheduleAt) компонуются без раздувания переходов.
- **Отрицательные:** функция `computeTransition` — единая точка сложности; рост числа флагов увеличивает размер таблицы; hard-code mapping действий на статусы затрудняет добавление новых стадий без изменения ядра.
- **Смягчение:** `TransitionPatch` типизирован и расширяется через объединение типов; новые действия/флаги добавляются точечно, без переписывания существующих переходов.
