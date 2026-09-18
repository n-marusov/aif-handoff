# Прецеденты использования — AIF Handoff: система автономного управления задачами

В этой директории находятся отдельные файлы прецедентов использования (Use Cases) системы **AIF Handoff — автономное управление задачами** (`aif-handoff`): модульного монолита на Turborepo, реализующего hand-off-конвейер с AI-субагентами через подключаемые runtime-адаптеры. Каждый файл соответствует одному UC и назван по шаблону `<UC-ID>.md`.

UC описывают поведение системы AIF Handoff на стороне ядра (api + agent + coordinator). **Место UC в модели требований:** US (`vision.md` §2.2) — язык бизнеса (пользовательские истории); UC — артефакт анализа: каждый UC выводится из одной или нескольких пользовательских историй и трассируется на них (поле `**Источник требований:**`), детализируя поведение до акторов, каналов, потоков и постусловий. FR детализируют UC. AI-провайдеры (Claude, Codex, OpenRouter) и внешние VCS (GitHub, GitLab) — внешние системы; их внутренние функции в UC не описываются.

---

## Формат идентификатора UC

```
UC-<L1>.<L2>.<L3>
```

Где:

| Часть  | Описание                                                        | Допустимые значения                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L1** | Домен (соответствует функциям HF1–HF12 `vision.md` §2.2)        | `pipeline` · `dashboard` · `runtime` · `vcs-auto` · `accounting` · `handoff` · `chat` · `auth` · `audit` · `integration` · `warmup`                                                                                                                                                                                                                                                                                                          |
| **L2** | Поддомен (соответствует подфункциям HF{1..12}.{1..N})           | `stage` · `plan` · `implementation` · `verification` · `completion` · `manual-override` · `gate` · `sidecar` · `review-loop` · `board` · `profile` · `isolation` · `commit` · `mr` · `plan-review` · `tracking` · `limits` · `transfer` · `escalation` · `history` · `diagnostics` · `project-context` · `task-context` · `registration` · `roles` · `logging` · `heartbeat` · `errors` · `issues` · `pr-mr` · `ci-status` · `preheat` и др. |
| **L3** | Семантический англоязычный тег в kebab-case, отражающий суть UC | Свободная семантическая метка (не ограничена глаголами)                                                                                                                                                                                                                                                                                                                                                                                      |

### Правила именования

1. Только **kebab-case**, без цифр и индексов.
2. **L1** — строго из списка доменов. Домены, не соответствующие HF1–HF12 (например, `infrastructure`, `deployment`), не применяются — соответствующие UC ведутся в документации операционного развёртывания.
3. **L3** — свободная семантическая метка, отражающая конкретный сценарий.
4. UC моделируют не только GUI-сценарии: допустимы GUI (веб-интерфейс), API (REST Hono + WebSocket), Agent (node-cron coordinator + subagent), Schedule/Job (cron, warmup).
5. Для каждого UC рекомендуется указывать метаданные `**Канал:** GUI | API | Agent | Schedule | Mixed`.

### Примеры

| ✅ Корректно                                   | ❌ Некорректно                                               |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `UC-pipeline.stage.auto-advance-task`          | `UC-pipeline.stage.1` (содержит цифру)                       |
| `UC-pipeline.plan.generate-change-plan`        | `UC-pipeline.plan.generateChangePlan` (camelCase)            |
| `UC-dashboard.board.view-kanban-columns`       | `UC-dashboard.board.view` (L3 слишком короткий)              |
| `UC-runtime.profile.configure-project-runtime` | `UC-runtime.profile.1` (содержит цифру)                      |
| `UC-handoff.transfer.ownership-to-executor`    | `UC-handoff.escalation` (L2 не указан)                       |
| `UC-integration.pr-mr.publish-github-pr`       | `UC-integration.GitHub.publishPR` (camelCase, не kebab-case) |

---

## Формат описания UC

Каждый файл UC содержит следующие секции:

| Секция                              | Обязательность | Описание                                                                                                                                         |
| ----------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `### <UC-ID>: <Название>`           | Обязательно    | Заголовок с идентификатором и кратким названием на русском                                                                                       |
| `**Актор:**` / `**Акторы:**`        | Обязательно    | Роль(и) пользователя, инициирующего прецедент (роли из `vision.md` §3.1)                                                                         |
| `**Приоритет:**`                    | Обязательно    | `P0` (критичный), `P1` (высокий), `P2` (средний)                                                                                                 |
| `**Ключевая функция:**`             | Обязательно    | Ссылка на функции из `vision.md` (HF1–HF12)                                                                                                      |
| `**Канал:**`                        | Рекомендуется  | `GUI` / `API` (REST) / `Agent` (coordinator) / `Schedule` / `Mixed`                                                                              |
| `**Описание:**`                     | Обязательно    | Краткое описание прецедента                                                                                                                      |
| `**Диаграмма последовательности:**` | Рекомендуется  | Mermaid `sequenceDiagram`: основной поток 1:1 с шагами и ключевые альтернативы (`alt`/`opt`); размещается после «Описание»                       |
| `**Основной поток:**`               | Обязательно    | Нумерованный список шагов основного сценария                                                                                                     |
| `**Альтернативные потоки:**`        | Рекомендуется  | Варианты (A1, A2, ...) с описанием отклонений                                                                                                    |
| `**Постусловия:**`                  | Обязательно    | Состояние системы после успешного выполнения UC                                                                                                  |
| `**Источник требований:**`          | Рекомендуется  | Ссылка на породившую пользовательскую историю (`HF{1..12}.{1..N}` из `vision.md` §2.2) и вышестоящие требования (`vision.md`, `glossary.md`, BR) |

### Диаграмма последовательности

Каждый UC может содержать Mermaid-диаграмму `sequenceDiagram`, размещаемую сразу после `**Описание:**`. Правила оформления:

1. **Расположение:** секция `**Диаграмма последовательности:**` — после `**Описание:**`, перед `**Основной поток:**`.
2. **Участники:** `participant ID as <Русское название>`; ID — короткий латинский, название — логический модуль из текста UC (Coordinator, Subagent-Planner, Subagent-Implementer, Subagent-Reviewer, RuntimeAdapter, Git Worktree, WebSocket Server).
3. **Сообщения:** `->>` — запрос, `-->>` — ответ; сообщения соответствуют шагам `**Основной поток:**` 1:1.
4. **Разделители глав:** комментарий `%% --- N. Заголовок ---`; заголовок секции при необходимости — `Note over X: заголовок`.
5. **Альтернативные потоки:** `alt`/`else` — взаимоисключающие ветки, `opt` — отклонение в точке; ветки помечаются кодом A-потока (`A1`/`A2`/`A3`).
6. **Внутренние действия** (генерация, проверка, применение): `Note over X: описание`.
7. **Целевое состояние:** диаграммы `to be`-UC отражают целевую capability — внешние runtime-адаптеры (Claude, Codex, OpenRouter) и VCS-платформы (GitHub, GitLab) показываются как внешние участники; под диаграммой ставится пометка о классе UC и фазе roadmap (`vision.md` §2.5).
8. **Синтаксис:** стандартный Mermaid `sequenceDiagram`.

---

## Домены UC

| Домен (L1)    | Функция (vision.md)                          | Описание                                                                                       | Пример UC-ID                                   |
| ------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `pipeline`    | HF1 (hand-off-конвейер), HF5 (quality gates) | Конвейер обработки изменений: планирование, реализация, формальные гейты, независимая проверка | `UC-pipeline.stage.auto-advance-task`          |
| `dashboard`   | HF2 (единый дашборд)                         | Визуализация изменений, статусы гейтов, детали, поиск, real-time обновления                    | `UC-dashboard.board.view-kanban-columns`       |
| `runtime`     | HF3 (подключаемые runtime-адаптеры)          | Настройка профилей провайдеров, переопределение для задачи, подключение внешних адаптеров      | `UC-runtime.profile.configure-project-runtime` |
| `vcs-auto`    | HF4 (VCS-автоматизация)                      | Изолированные worktree, автоматические коммиты, atomic MR, plan review gate                    | `UC-vcs-auto.mr.publish-atomic-merge-request`  |
| `accounting`  | HF6 (учёт использования и лимиты)            | Учёт вызовов runtime, лимиты на проект, блокировка при превышении                              | `UC-accounting.tracking.record-runtime-call`   |
| `handoff`     | HF7 (роли, handoff и эскалация)              | Передача владения задачей, эскалация вне правил, история исполнителей, диагностика             | `UC-handoff.transfer.ownership-to-executor`    |
| `chat`        | HF8 (чат с AI-ассистентом)                   | Диалог в контексте проекта или изменения                                                       | `UC-chat.project-context.consult-ai-assistant` |
| `auth`        | HF9 (участники и аутентификация)             | Регистрация, вход, разграничение ролей и прав                                                  | `UC-auth.registration.sign-up-participant`     |
| `audit`       | HF10 (аудит и наблюдаемость)                 | Иммутабельный аудит, хартбиты выполнения, категоризация ошибок                                 | `UC-audit.logging.audit-state-transition`      |
| `integration` | HF11 (VCS-интеграция)                        | Синхронизация с Issues GitHub/GitLab, публикация PR/MR, проверка CI-статусов                   | `UC-integration.pr-mr.publish-github-pr`       |
| `warmup`      | HF12 (разогрев сессий)                       | Предварительный прогрев сессий runtime для ускорения старта                                    | `UC-warmup.preheat.warmup-runtime-session`     |

### Маппинг функций vision.md (HF1–HF12) → домены UC (для трассируемости)

> Цепочка трассируемости: `Vision (HF1–HF12) → US (§2.2) → UC → FR → ADR → COMP → TEST`. Внешние артефакты ссылаются на функции HF1–HF12.

| Функция (vision.md §2.2)                                | L1/L2                               | Пример UC-ID                                                |
| ------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------- |
| HF1.1 Автоматическое прохождение стадий                 | `pipeline.stage`                    | `UC-pipeline.stage.auto-advance-task`                       |
| HF1.2 Планирование изменения AI                         | `pipeline.plan`                     | `UC-pipeline.plan.generate-change-plan`                     |
| HF1.3 Уточнение плана (Improve)                         | `pipeline.plan`                     | `UC-pipeline.plan.refine-plan-second-pass`                  |
| HF1.4 Реализация изменения AI                           | `pipeline.implementation`           | `UC-pipeline.implementation.execute-change-in-isolation`    |
| HF1.5 Верификация результата                            | `pipeline.verification`             | `UC-pipeline.verification.verify-change-result`             |
| HF1.6 Завершение конвейера                              | `pipeline.completion`               | `UC-pipeline.completion.auto-complete-pipeline`             |
| HF1.7 Ручное управление движением                       | `pipeline.manual-override`          | `UC-pipeline.manual-override.intervene-task-stage`          |
| HF2.1 Просмотр изменений по стадиям                     | `dashboard.board`                   | `UC-dashboard.board.view-kanban-columns`                    |
| HF2.2 Статус формальных гейтов                          | `dashboard.gate-status`             | `UC-dashboard.gate-status.view-gate-results`                |
| HF2.3 Детали изменения                                  | `dashboard.detail`                  | `UC-dashboard.detail.view-task-details`                     |
| HF2.4 Обновления в реальном времени                     | `dashboard.realtime`                | `UC-dashboard.realtime.receive-live-status-updates`         |
| HF2.5 Поиск по проектам и изменениям                    | `dashboard.search`                  | `UC-dashboard.search.find-task-by-query`                    |
| HF3.1 Настройка runtime-профиля для проекта             | `runtime.profile`                   | `UC-runtime.profile.configure-project-runtime`              |
| HF3.2 Переопределение профиля для конкретного изменения | `runtime.override`                  | `UC-runtime.override.override-profile-for-task`             |
| HF3.3 Подключение внешних адаптеров                     | `runtime.external-adapter`          | `UC-runtime.external-adapter.register-external-module`      |
| HF4.1 Изолированное выполнение                          | `vcs-auto.isolation`                | `UC-vcs-auto.isolation.execute-task-in-worktree`            |
| HF4.2 Автоматические коммиты                            | `vcs-auto.commit`                   | `UC-vcs-auto.commit.auto-commit-before-completion`          |
| HF4.3 Единый atomic MR                                  | `vcs-auto.mr`                       | `UC-vcs-auto.mr.publish-atomic-merge-request`               |
| HF4.4 Plan Review Gate                                  | `vcs-auto.plan-review`              | `UC-vcs-auto.plan-review.publish-plan-for-approval`         |
| HF5.1 Формальные гейты переходов                        | `pipeline.gate`                     | `UC-pipeline.gate.enforce-stage-transition-gate`            |
| HF5.2 Sidecar-агенты (read-only)                        | `pipeline.sidecar`                  | `UC-pipeline.sidecar.review-with-sidecar-agent`             |
| HF5.3 Автоматическое ревью с итерациями                 | `pipeline.review-loop`              | `UC-pipeline.review-loop.iterate-review-feedback`           |
| HF5.4 Независимая верификация                           | `pipeline.independent-verification` | `UC-pipeline.independent-verification.verify-independently` |
| HF5.5 Эскалация при исчерпании попыток                  | `pipeline.escalation`               | `UC-pipeline.escalation.escalate-after-exhausted-retries`   |
| HF6.1 Учёт каждого вызова runtime                       | `accounting.tracking`               | `UC-accounting.tracking.record-runtime-call`                |
| HF6.2 Лимиты на уровне проекта                          | `accounting.limits`                 | `UC-accounting.limits.configure-project-limits`             |
| HF6.3 Блокировка при превышении                         | `accounting.blocking`               | `UC-accounting.blocking.block-on-limit-exceeded`            |
| HF7.1 Передача владения изменением                      | `handoff.transfer`                  | `UC-handoff.transfer.ownership-to-executor`                 |
| HF7.2 Эскалация решений вне правил                      | `handoff.escalation`                | `UC-handoff.escalation.escalate-unresolvable-decision`      |
| HF7.3 История исполнителей                              | `handoff.history`                   | `UC-handoff.history.view-executor-timeline`                 |
| HF7.4 Диагностика эскалации                             | `handoff.diagnostics`               | `UC-handoff.diagnostics.receive-escalation-diagnostics`     |
| HF8.1 Диалог в контексте проекта                        | `chat.project-context`              | `UC-chat.project-context.consult-ai-assistant`              |
| HF8.2 Диалог в контексте изменения                      | `chat.task-context`                 | `UC-chat.task-context.discuss-task-with-ai`                 |
| HF9.1 Регистрация и вход                                | `auth.registration`                 | `UC-auth.registration.sign-up-participant`                  |
| HF9.2 Разграничение ролей                               | `auth.roles`                        | `UC-auth.roles.assign-participant-role`                     |
| HF10.1 Аудит действий                                   | `audit.logging`                     | `UC-audit.logging.audit-state-transition`                   |
| HF10.2 Хартбиты выполнения                              | `audit.heartbeat`                   | `UC-audit.heartbeat.receive-agent-heartbeat`                |
| HF10.3 Категоризация ошибок                             | `audit.errors`                      | `UC-audit.errors.classify-runtime-error`                    |
| HF11.1 Синхронизация с Issues                           | `integration.issues`                | `UC-integration.issues.sync-github-issue`                   |
| HF11.2 Публикация PR/MR                                 | `integration.pr-mr`                 | `UC-integration.pr-mr.publish-github-pr`                    |
| HF11.3 Проверка CI-статусов                             | `integration.ci-status`             | `UC-integration.ci-status.check-pipeline-status`            |
| HF12.1 Предварительный прогрев сессий                   | `warmup.preheat`                    | `UC-warmup.preheat.warmup-runtime-session`                  |

---

## Маппинг доменов UC → бизнес-правила (BR-\*)

Домены UC трассируются на политики продукта из каталога [Business Rules](../business-rules/README.md):

| Домен UC (L1) | Связанные BR-\*                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline`    | [BR-trigger.automation.pipeline](../business-rules/BR-trigger.automation.pipeline.md), [BR-fact.task-lifecycle.stages](../business-rules/BR-fact.task-lifecycle.stages.md), [BR-constraint.task-lifecycle.transitions](../business-rules/BR-constraint.task-lifecycle.transitions.md), [BR-trigger.task-lifecycle.skip-review](../business-rules/BR-trigger.task-lifecycle.skip-review.md), [BR-trigger.automation.auto-review](../business-rules/BR-trigger.automation.auto-review.md), [BR-trigger.automation.qa](../business-rules/BR-trigger.automation.qa.md)                                                   |
| `dashboard`   | [BR-fact.audit.observability](../business-rules/BR-fact.audit.observability.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `runtime`     | [BR-fact.project.runtime-profiles](../business-rules/BR-fact.project.runtime-profiles.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `vcs-auto`    | [BR-constraint.git.branch-naming](../business-rules/BR-constraint.git.branch-naming.md), [BR-constraint.git.commit-conventions](../business-rules/BR-constraint.git.commit-conventions.md), [BR-inference.git.convention-resolution](../business-rules/BR-inference.git.convention-resolution.md), [BR-constraint.git.worktree-isolation](../business-rules/BR-constraint.git.worktree-isolation.md), [BR-trigger.automation.completion-commit](../business-rules/BR-trigger.automation.completion-commit.md), [BR-trigger.automation.plan-review-gate](../business-rules/BR-trigger.automation.plan-review-gate.md) |
| `accounting`  | [BR-trigger.automation.runtime-limit-gate](../business-rules/BR-trigger.automation.runtime-limit-gate.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `handoff`     | [BR-fact.ownership.assignment](../business-rules/BR-fact.ownership.assignment.md), [BR-constraint.ownership.handoff](../business-rules/BR-constraint.ownership.handoff.md), [BR-constraint.ownership.executor-history](../business-rules/BR-constraint.ownership.executor-history.md), [BR-fact.ownership.assignee](../business-rules/BR-fact.ownership.assignee.md), [BR-inference.ownership.automation-eligibility](../business-rules/BR-inference.ownership.automation-eligibility.md), [BR-trigger.task-lifecycle.blocked](../business-rules/BR-trigger.task-lifecycle.blocked.md)                               |
| `chat`        | `TBD` — правила чата не выделены                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `auth`        | [BR-fact.auth.roles](../business-rules/BR-fact.auth.roles.md), [BR-fact.auth.admin-privileges](../business-rules/BR-fact.auth.admin-privileges.md), [BR-constraint.auth.member-scope](../business-rules/BR-constraint.auth.member-scope.md), [BR-constraint.auth.task-isolation](../business-rules/BR-constraint.auth.task-isolation.md), [BR-constraint.auth.credentials](../business-rules/BR-constraint.auth.credentials.md), [BR-constraint.auth.sessions](../business-rules/BR-constraint.auth.sessions.md)                                                                                                     |
| `audit`       | [BR-constraint.audit.immutable-trail](../business-rules/BR-constraint.audit.immutable-trail.md), [BR-fact.audit.actor-identity](../business-rules/BR-fact.audit.actor-identity.md), [BR-constraint.audit.state-snapshot](../business-rules/BR-constraint.audit.state-snapshot.md), [BR-fact.audit.observability](../business-rules/BR-fact.audit.observability.md)                                                                                                                                                                                                                                                   |
| `integration` | [BR-fact.git.vcs-workflow](../business-rules/BR-fact.git.vcs-workflow.md), [BR-inference.git.review-decision-precedence](../business-rules/BR-inference.git.review-decision-precedence.md), [BR-trigger.automation.plan-review-gate](../business-rules/BR-trigger.automation.plan-review-gate.md)                                                                                                                                                                                                                                                                                                                    |
| `warmup`      | `TBD` — правила разогрева не выделены                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

---

## Специфика проекта

- **Ядро — контекст исполнения**: UC описывают поведение системы AIF Handoff на стороне ядра (api + agent + coordinator). Система работает как модульный монолит: HTTP-сервер (Hono, порт 3009), React SPA (Vite, порт 5180), agent-coordinator (node-cron, цикл 30 с) и WebSocket-сервер для real-time обновлений. Внешние AI-провайдеры (Claude Agent SDK, Codex, OpenRouter) — внешние системы; их внутренние функции в UC не описываются.

- **Runtime — единственный порт к AI**: все вызовы AI-провайдеров проходят через `@aif/runtime` — слой абстракции с единым контрактом (`RuntimeAdapter`), реестром (`RuntimeRegistry`) и системой разрешения профилей (`runtime.resolution.ts`). Взаимодействие с runtime моделируется как ACL. Задача использует Effective Runtime Profile — результат слияния профилей задачи, проекта, системы и переменных окружения.

- **Координатор — единственный оркестратор**: Coordinator (node-cron, `packages/agent/src/coordinator.ts`) опрашивает БД каждые 30 секунд, выбирает задачи, готовые к переходу, и запускает соответствующих субагентов (planner, implementer, reviewer) через выбранный runtime-адаптер. Субагенты работают в изолированных Git worktree — каждый со своей веткой.

- **Функция, а не механизм**: по принципу `vision.md` §2.2 UC — результаты, ценные для пользователя (роли из §3.1), а не каналы. Worktree, node-cron, drizzle-orm, Hono, WebSocket, `@aif/runtime`, `@aif/data` — механизмы; они указываются метаданными `**Канал:**`, а не становятся доменами.

- **Готовые компоненты**: VCS-интеграция (GitHub REST API, GitLab REST API) — готовые клиенты в `packages/agent/src/githubWorkflow.ts` и `gitlabWorkflow.ts`; UC описывают поведение системы как интегратора, а не разработку этих клиентов.

- **События предметной области**: `TaskCreated`, `TaskStageChanged`, `TaskGatePassed`, `TaskGateFailed`, `TaskOwnershipTransferred`, `TaskEscalated`, `RuntimeCallRecorded`, `LimitExceeded`, `HeartbeatReceived` — триггеры каскадов в системе (например, прохождение гейта → `TaskGatePassed` → `TaskStageChanged` (Implementing → Review) → WebSocket broadcast). UC должны явно описывать эти каскады. Каталог событий — `domain/domain-events.md`.

- **Канал** для автоматических сценариев (опрос координатора, авто-коммит, ротация, warmup) — `Schedule` / `Agent`, не `GUI`.

- **Архитектурная изоляция**: данные проходят через `@aif/data` — централизованный слой доступа к БД. Lint-правила блокируют прямой импорт `@aif/shared/src/db` из api/agent/runtime. Web-интерфейс общается с API только через HTTP/WebSocket, никогда через прямой импорт пакетов.

### Классификация UC: `as is` vs целевое состояние (`to be`)

Каждый UC относится к одному из двух классов по фактическому наличию функции в системе:

- **`as is` (функция реализована полностью или частично)** — UC описывает фактическое поведение системы: реальные каналы, компоненты и статусы. Если реализация беднее целевой модели, UC фиксирует текущее поведение, а расширения выносятся в явные target-примечания (не в основной поток).
- **Целевое состояние (`to be`, функция не реализована)** — UC описывает целевую capability, явно помеченную `to be`/target, со ссылкой на `vision.md` и корректную фазу roadmap (`vision.md` §2.5). Такой UC не подгоняется под отсутствующую реализацию; он проверяется на здравый смысл и соответствие видению.

Правила:

1. Для `as is`-UC диаграмма последовательности и основной поток соответствуют фактическим компонентам и каналам; в `**Источник требований:**` указываются породившая US (`vision.md` §2.2, пользовательские истории HF{1..12}.{1..N}) и файлы требований (`vision.md`, `glossary.md`).
2. Для `to be`-UC обязательна пометка целевого состояния и фазы roadmap; формулировки не должны выдавать целевую модель за текущую реализацию.
3. Неподтверждённые фактическим поведением гарантии не указываются как основной поток `as is`-UC — при необходимости они выносятся в target-примечания. На дату актуализации к ним относятся: интеграция VCS-платформ (Фаза 2), SSH-управление, RBAC с кастомными ролями, расширенный аудит, warmup-механизм, эскалация с автоматическим созданием правил, rate-limit на уровне адаптера.

---

## Связанные артефакты

- [Видение продукта](../vision.md) — функции HF1–HF12 (§2.2), декомпозиция на US (§2.2), роли (§3.1), roadmap (§2.5), диаграмма дерева функций (§2.3)
- [Глоссарий](../glossary.md) — термины: задача, проект, статус задачи, runtime-адаптер, coordinator, субагент, worktree, handoff, гейт, sidecar, аудит
- [Business Rules](../business-rules/README.md) — каталог бизнес-правил продукта (`BR-*`), трассируемый из доменов UC
- [Архитектура](../architecture.md) — модульный монолит, структура пакетов, правила зависимостей
- [USE-CASES-INDEX.md](USE-CASES-INDEX.md) — каталог всех UC с фильтрацией по домену, актору, приоритету и статусу (`as is` / `to be`)
- [Карта ограниченных контекстов](../domain/context-map.md) — контексты `task-pipeline`, `runtime-provisioning`, `git-isolation`, `audit-log`, `auth-session` и их трассировка к UC
- [Агрегаты и сущности](../domain/aggregates.md) — тактический DDD-дизайн (`Task`, `Participant`, `RuntimeProfile`, `AuditEvent`)
- [Доменные события](../domain/domain-events.md) — каталог событий и каскады
- [Словарь данных](../domain/data-dictionary.md) — атрибуты сущностей и расхождения модели и реализации

> Связанные каталоги: [C4-диаграммы](../c4/README.md) — контекст, контейнеры, компоненты; [ADR](../adr/README.md) — архитектурные решения; [Открытые вопросы](../open-questions.md) — лакуны и `TBD` по UC.
