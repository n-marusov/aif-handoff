# Пользовательские истории — AIF Handoff: система автономного управления задачами

В этой директории находятся пользовательские истории (User Stories) системы **AIF Handoff — автономное управление задачами** (`aif-handoff`) в формате Gherkin.

**Назначение US.** Пользовательские истории — **язык бизнеса** (первичный пользовательский артефакт): основа для E2E-проверок и для общения с представителями бизнеса. В этом каталоге оставлены только истории, которые напрямую трассируются на сквозные E2E GUI/API-сценарии из `docs/qa/e2e-gui-testing.md` и `docs/qa/e2e-api-testing.md`.

## Структура

- `README.md` — данный файл с описанием требований к разработке пользовательских историй
- `US-<domain>.<subdomain>.<action>.md` — отдельные файлы пользовательских историй с семантическими идентификаторами

## Семантическая классификация US

Идентификаторы пользовательских историй построены по иерархическому принципу, аналогично UC:

```
US-<domain>.<subdomain>.<action>
```

Домен (L1) и поддомен (L2) соответствуют доменам UC (`use-cases/README.md`) и функциям HF1–HF12 `vision.md` §2.2, что облегчает навигацию и трассировку (Vision → US → UC → FR). **Единый источник допустимых значений L1/L2** — `use-cases/README.md`; при введении новых поддоменов список расширяется там первым.

### Домены (L1)

| Домен (L1)    | Функция (vision.md)                          | Описание                                                                              | Пример US-ID                                   |
| ------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `pipeline`    | HF1 (hand-off-конвейер), HF5 (quality gates) | Конвейер обработки изменений: автоматическое продвижение и формальные гейты переходов | `US-pipeline.stage.auto-advance-task`          |
| `dashboard`   | HF2 (единый дашборд)                         | Kanban-доска, детали задачи и real-time обновления                                    | `US-dashboard.board.view-kanban-columns`       |
| `runtime`     | HF3 (подключаемые runtime-адаптеры)          | Настройка runtime-профиля проекта и переопределение профиля для задачи                | `US-runtime.profile.configure-project-runtime` |
| `vcs-auto`    | HF4 (VCS-автоматизация)                      | Публикация единого atomic MR / PR                                                     | `US-vcs-auto.mr.publish-atomic-merge-request`  |
| `accounting`  | HF6 (учёт использования и лимиты)            | Учёт вызовов runtime и блокировка при превышении лимитов                              | `US-accounting.tracking.record-runtime-call`   |
| `handoff`     | HF7 (роли и handoff)                         | Передача владения задачей между исполнителями                                         | `US-handoff.transfer.ownership-to-executor`    |
| `auth`        | HF9 (участники и аутентификация)             | Регистрация участников и назначение ролей                                             | `US-auth.registration.sign-up-participant`     |
| `audit`       | HF10 (аудит и наблюдаемость)                 | Иммутабельный аудит переходов стадий и heartbeat-статусы                              | `US-audit.logging.audit-state-transition`      |
| `integration` | HF11 (VCS-интеграция)                        | Синхронизация с Issues, публикация PR/MR и обработка решения ревью/слияния MR         | `US-integration.pr-mr.resolve-review-decision` |

> Домены, не соответствующие HF1–HF12 (например, `infrastructure`, `deployment`), не применяются — соответствующие истории ведутся в документации операционного развёртывания.

### Поддомены (L2)

Каждый домен L1 детализируется поддоменами L2, совпадающими с поддоменами UC (допустимые значения — `use-cases/README.md`, колонка L2):

| Поддомен                 | Соответствующая функция (vision.md) | Описание                                                            | Примеры US                                          |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| `stage`                  | HF1.1, HF1.6, HF5.1                 | Автоматическое продвижение по стадиям                               | `US-pipeline.stage.auto-advance-task`               |
| `manual-override`        | HF1.7, HF5.2                        | Ручное вмешательство в стадию задачи с контролем гейтов             | `US-pipeline.manual-override.intervene-task-stage`  |
| `gate`                   | HF5.1–HF5.3                         | Формальные гейты переходов                                          | `US-pipeline.gate.enforce-stage-transition-gate`    |
| `board`                  | HF2.1                               | Просмотр колонок Kanban и карточек задач                            | `US-dashboard.board.view-kanban-columns`            |
| `detail`                 | HF2.3                               | Просмотр деталей задачи                                             | `US-dashboard.detail.view-task-details`             |
| `realtime`               | HF2.4                               | Получение live-обновлений статусов                                  | `US-dashboard.realtime.receive-live-status-updates` |
| `profile`                | HF3.1                               | Настройка runtime-профиля проекта                                   | `US-runtime.profile.configure-project-runtime`      |
| `override`               | HF3.2                               | Переопределение runtime-профиля на уровне задачи                    | `US-runtime.override.override-profile-for-task`     |
| `mr`                     | HF4.3                               | Публикация единого atomic MR / PR                                   | `US-vcs-auto.mr.publish-atomic-merge-request`       |
| `tracking`               | HF6.1                               | Учёт вызовов runtime                                                | `US-accounting.tracking.record-runtime-call`        |
| `blocking`               | HF6.3                               | Блокировка выполнения при превышении лимита                         | `US-accounting.blocking.block-on-limit-exceeded`    |
| `transfer`               | HF7.1                               | Передача владения задачей                                           | `US-handoff.transfer.ownership-to-executor`         |
| `registration` / `roles` | HF9.1 / HF9.2                       | Регистрация участников и назначение ролей                           | `US-auth.registration.sign-up-participant`          |
| `logging` / `heartbeat`  | HF10.1 / HF10.2                     | Аудит переходов стадий и heartbeat                                  | `US-audit.logging.audit-state-transition`           |
| `issues` / `pr-mr`       | HF11.1 / HF11.2                     | Синхронизация Issues, публикация PR/MR и реакция на review decision | `US-integration.pr-mr.resolve-review-decision`      |

## Формат описания

Все пользовательские истории оформлены единым Gherkin-шаблоном. Один сценарий — один пользовательский результат (гейт `G1-GHERKIN`):

```gherkin
@US-<domain>.<subdomain>.<action> @HF{1..12}.{1..N} @UC-... @P...
Feature: US-<domain>.<subdomain>.<action> <краткое название>

  Background:
    Given <общие предусловия>

  Scenario: <основной пользовательский результат>
    Given <контекст>
    When <действие пользователя или системы>
    Then <ожидаемый результат>
```

### Теги

Каждая история содержит теги:

- `@US-<domain>.<subdomain>.<action>` — семантический идентификатор пользовательской истории
- `@HF{1..12}.{1..N}` — функция `vision.md` §2.2, из которой выведена история (например, `@HF1.1`)
- `@UC-...` — идентификатор прецедента использования (UC) — артефакта анализа данной истории
- `@P0`/`@P1`/`@P2` — приоритет (P0 — критический, P1 — важный, P2 — желательный)
- Дополнительные теги для фильтрации по домену: `@pipeline`, `@dashboard`, `@runtime`, `@vcs-auto`, `@accounting`, `@handoff`, `@auth`, `@audit`, `@integration`; по поддомену: `@stage`, `@manual-override`, `@gate`, `@board`, `@detail`, `@realtime`, `@profile`, `@override`, `@mr`, `@tracking`, `@blocking`, `@transfer`, `@registration`, `@roles`, `@logging`, `@heartbeat`, `@issues`, `@pr-mr`.

## Текущее состояние

На дату актуализации (2026-09-20) каталог содержит **20 пользовательских историй** — только E2E-релевантный срез для подтверждения бизнес-пользы в сквозных GUI/API-путях.

Оставленные US:

- `US-pipeline.stage.auto-advance-task`
- `US-pipeline.manual-override.intervene-task-stage`
- `US-pipeline.gate.enforce-stage-transition-gate`
- `US-dashboard.board.view-kanban-columns`
- `US-dashboard.detail.view-task-details`
- `US-dashboard.realtime.receive-live-status-updates`
- `US-handoff.transfer.ownership-to-executor`
- `US-runtime.profile.configure-project-runtime`
- `US-runtime.override.override-profile-for-task`
- `US-accounting.tracking.record-runtime-call`
- `US-accounting.blocking.block-on-limit-exceeded`
- `US-auth.registration.sign-up-participant`
- `US-auth.roles.assign-participant-role`
- `US-audit.logging.audit-state-transition`
- `US-audit.heartbeat.receive-agent-heartbeat`
- `US-integration.issues.sync-github-issue`
- `US-integration.issues.bootstrap-project-sync-and-create-task`
- `US-integration.pr-mr.publish-github-pr`
- `US-integration.pr-mr.resolve-review-decision`
- `US-vcs-auto.mr.publish-atomic-merge-request`

Критерий включения: у истории есть прямой trace в каталоге E2E-сценариев (`docs/qa/e2e-gui-testing.md` §12 и/или `docs/qa/e2e-api-testing.md` §12).

## Требования к разработке пользовательских историй

### 1. Структура и именование

- Каждый файл содержит одну пользовательскую историю или один сквозной сценарий.
- Имя файла соответствует семантическому идентификатору: `US-<domain>.<subdomain>.<action>.md`.
- Файл начинается с заголовка первого уровня (`#`) с полным идентификатором и названием.
- Теги Gherkin указываются в первой строке сценария.
- Идентификатор вешается якорем (`<a id="us-<domain>.<subdomain>.<action>"></a>`) перед заголовком для кросс-ссылок.

### 2. Содержание

- **Background** описывает общие предусловия для всех сценариев истории.
- **Scenario** описывает один конкретный пользовательский результат.
- Шаги `Given` задают контекст и предварительные условия.
- Шаги `When` описывают действие пользователя или системы.
- Шаги `Then` проверяют ожидаемый результат.
- Для проверки альтернативных потоков (негативные сценарии) используется отдельный Scenario.

### 3. Язык

- Все пользовательские истории пишутся **на русском языке**.
- Названия сущностей, свойств и технические идентификаторы — на английском (например, `Task`, `Project`, `Runtime Profile`, `Coordinator`, `Subagent`, `Worktree`, `Gate`, `Sidecar`, `Handoff`, `WebSocket`).
- Сообщения об ошибках, возвращаемые системой, указываются в кавычках на языке системы (английский).

### 4. Приоритеты

- **P0** — критические сценарии, без которых MVP невозможен (например, автоматическое прохождение стадий конвейера — HF1, формальные гейты переходов — HF5, единый atomic MR — HF4.3).
- **P1** — важные сценарии, закрывающие ключевые потребности пользователей (например, дашборд с real-time обновлениями — HF2, handoff владения — HF7, управление runtime-профилями — HF3).
- **P2** — желательные сценарии внутри E2E-среза, которые не блокируют основной сквозной поток, но повышают управляемость и наблюдаемость (например, heartbeat-аудит и отдельные интеграционные шаги публикации в VCS).

Приоритет US **согласуется с приоритетом породившего UC** (см. `use-cases/USE-CASES-INDEX.md`).

### 5. Связи

- US — **язык бизнеса**: каждая история описывает пользовательскую ценность на языке, понятном бизнесу, и восходит к функции HF1–HF12 из `vision.md` §2.2.
- UC — артефакт анализа: прецедент детализирует историю (акторы, каналы, основной/альтернативные потоки, постусловия); каждый UC выводится из US и трассируется на неё (поле «Источник требований»).
- FR детализируют UC: на FR история трассируется через UC (Vision → US → UC → FR); US напрямую FR не порождают.
- Каждая история должна иметь назначенный приоритет и ссылку на породившую функцию `HF{1..12}.{1..N}`.

### 6. Специфика проекта

- **Ядро — контекст исполнения**: истории описывают поведение системы AIF Handoff на стороне ядра (api + agent + coordinator). Система работает как модульный монолит: HTTP-сервер (Hono, порт 3009), React SPA (Vite, порт 5180), agent-coordinator (node-cron, цикл 30 с) и WebSocket-сервер для real-time обновлений. Внешние AI-провайдеры (Claude Agent SDK, Codex, OpenRouter) и VCS-платформы (GitHub, GitLab) — внешние системы; их внутренние функции истории не описывают.
- **Runtime — единственный порт к AI**: все вызовы AI-провайдеров проходят через `@aif/runtime` — слой абстракции с единым контрактом (`RuntimeAdapter`), реестром (`RuntimeRegistry`) и системой разрешения профилей. Задача использует Effective Runtime Profile — результат слияния профилей задачи, проекта, системы и переменных окружения. Взаимодействие с runtime моделируется как ACL.
- **Координатор — единственный оркестратор**: Coordinator (node-cron, `packages/agent/src/coordinator.ts`) опрашивает БД каждые 30 секунд, выбирает задачи, готовые к переходу, и запускает соответствующих субагентов (planner, implementer, reviewer) через выбранный runtime-адаптер. Субагенты работают в изолированных Git worktree — каждый со своей веткой.
- **Функция, а не механизм**: по принципу `vision.md` §2.2 истории — результаты, ценные для пользователя (роли из §3.1), а не каналы. Worktree, node-cron, drizzle-orm, Hono, WebSocket, `@aif/runtime`, `@aif/data` — механизмы; они указываются метаданными `@tag`/каналом, а не становятся доменами.
- **Готовые компоненты**: VCS-интеграция (GitHub REST API, GitLab REST API) — готовые клиенты в `packages/agent/src/githubWorkflow.ts` и `gitlabWorkflow.ts`; истории описывают поведение системы как интегратора, а не разработку этих клиентов.
- **События предметной области**: `TaskCreated`, `TaskStageChanged`, `TaskGatePassed`, `TaskGateFailed`, `TaskOwnershipTransferred`, `TaskEscalated`, `RuntimeCallRecorded`, `LimitExceeded`, `HeartbeatReceived` — триггеры каскадов в системе (например, прохождение гейта → `TaskGatePassed` → `TaskStageChanged` (Implementing → Review) → WebSocket broadcast). Истории должны явно описывать эти каскады. Каталог событий — `domain/domain-events.md` (целевое состояние).
- **Каналы**: истории моделируют не только GUI-сценарии: допустимы GUI (веб-интерфейс), API (REST Hono + WebSocket) и Agent (node-cron coordinator + subagent). Для автоматических сценариев канал — `Agent`, не `GUI`.
- **Архитектурная изоляция**: данные проходят через `@aif/data` — централизованный слой доступа к БД. Lint-правила блокируют прямой импорт `@aif/shared/src/db` из api/agent/runtime. Web-интерфейс общается с API только через HTTP/WebSocket, никогда через прямой импорт пакетов.
- **Классификация `as is` vs `to be`**: `as is`-истории описывают фактическое поведение системы; `to be`-истории описывают целевую capability и помечаются фазой roadmap (`vision.md` §2.5). В текущем E2E-срезе используются истории с прямой трассировкой на исполнимые сквозные сценарии GUI/API.

### 7. Accessibility (доступность)

- Доступность веб-интерфейса (React SPA: Kanban-доска, карточки задач, админ-диалоги) — сквозное требование качества: фиксируется как **NFR** в [nonfun-req/](../nonfun-req/README.md), а не как отдельный домен US.
- Отдельный домен `a11y` **не заводится**; сценарии для пользователей вспомогательных технологий (screen reader, keyboard-only навигация) оформляются внутри историй соответствующего домена (например, `US-dashboard.*`, `US-auth.*`) при наличии соответствующих NFR.

## Связанные артефакты

- [Видение продукта](../vision.md) — функции HF1–HF12 (§2.2), US-формулировки, роли (§3.1), roadmap (§2.5), диаграмма дерева функций (§2.3)
- [Прецеденты использования](../use-cases/README.md) — UC (анализ пользовательских историй; выводятся из US); домены L1/L2 и классификация `as is`/`to be` — единый источник допустимых значений
- [Каталог UC](../use-cases/USE-CASES-INDEX.md) — индекс UC с фильтрацией по домену, актору, приоритету и статусу
- [Функциональные требования](../fun-req/README.md) — FR (детализация UC; на FR истории трассируются через UC)
- [Нефункциональные требования](../nonfun-req/README.md) — NFR (границы качества, включая доступность веб-интерфейса)
- [Бизнес-правила](../business-rules/README.md) — `BR-*`: политики и ограничения, на которые ссылаются истории
- [Глоссарий](../glossary.md) — термины: задача, проект, статус задачи, runtime-адаптер, coordinator, субагент, worktree, handoff, гейт, sidecar, аудит
- [Контроль качества](../qa/README.md) — матрица качества FR → тесты, вывод E2E-кейсов из UC/US
- [Доменные события](../domain/domain-events.md) — каталог событий и каскады (целевое состояние)
- [Архитектура](../architecture.md) — модульный монолит, структура пакетов, правила зависимостей
- [Известные проблемы](../known-issues.md) — реестр `KI-*`: дефекты и расхождения модели и реализации
