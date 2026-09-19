# Known Issues

> Сборник известных проблем и нерешённых хвостов, обнаруженных в ходе работы над проектом.
> Запись делается в момент, когда проблема найдена и задокументирована, даже если исправление
> отложено. Каждая запись содержит симптом, причину и статус.

## Agent: флейки git-тестов при полном параллельном прогоне (Windows)

- **Статус:** устранено 2026-09-19 (план feature/fix-known-issues-followups, Tasks 1–2)
- **Симптом (исторический):** при `npm run test --workspace=@aif/agent` (полный прогон, все файлы
  параллельно) произвольные 1–3 теста падали; между прогонами набор падающих тестов менялся:
  `gitlabPrepare.test.ts`, `gitConventions.test.ts`, `planReviewPublisher.test.ts`,
  `coordinator.test.ts`, `subagentQuery`, `taskWatchdog` и т.п.
- **Причина (историческая):** тесты работали с реальными git-репозиториями во временных каталогах
  (`os.tmpdir()`), и при параллельном запуске создавали файловые/портовые гонки; также
  `prepareRepository` писал в глобальный `~/.gitconfig`.
- **Что устранено:**
  - `packages/agent/src/__tests__/gitTestUtils.ts` — `createIsolatedGitConfig()` направляет
    `GIT_CONFIG_GLOBAL`/`HOME` на per-test временный каталог; mtime `~/.gitconfig` не меняется.
  - `createGitTestRoot()` — уникальные per-test корни для git-репозиториев +
    `assertIsolatedGitTestRoot` (тест сам проверяет, что работает внутри своего корня) +
    `cleanupGitTestRoots`.
  - Переведены на общие хелперы: `gitlabPrepare`, `gitBranch`, `gitConventions`,
    `planReviewPublisher`, `implementer`, `improver`.
  - Production-путь не менялся: `--global` для `credential.helper`/`safe.directory` остаётся
    намеренным (наследование submodule-клонов, комментарий в `repositoryPrepare.ts:283-285`).
- **Проверка:** `npm run test --workspace=@aif/agent` — 3 полных прогона подряд зелёные
  (519 тестов); `gitlabPrepare.test.ts` — 5/5 подряд с sandboxed-конфигом; mtime
  `C:/Users/*/.gitconfig` не изменяется после сьюта.
- **Действие:** новые git-тесты добавлять только через хелперы `gitTestUtils.ts` (sandbox-конфиг +
  уникальный корень); не использовать ad-hoc `mkdtempSync`/реальный глобальный конфиг.

## Корень репозитория: лишний файл `nul`

- **Статус:** косметика, не отслеживается git
- **Симптом:** в корне репозитория лежит файл `nul` (ASCII, 848 байт, дата 2026-09-18).
- **Причина:** артефакт Windows-шелла — команда, перенаправлявшая вывод в `nul` через Git Bash,
  создала обычный файл вместо nul-устройства (типичная проблема на Windows).
- **Действие:** файл не входит ни в один коммит (исключён из `git add`); можно удалить вручную:
  `rm nul` (в Git Bash) — никакой полезной информации в нём нет.

## Дублирование типов-проекций строк между `@aif/shared/presenters.ts` и `@aif/data`

- **Статус:** устранено 2026-09-19 (план feature/fix-known-issues-followups, Task 7)
- **Симптом (исторический):** типы `TaskListItemRow`, `TaskSummaryRow` объявлялись и в
  `packages/shared/src/presenters.ts`, и в `packages/data/src/tasks.ts`; тип
  `RuntimeProfileUsageState` — и в `packages/shared/src/presenters.ts`, и в
  `packages/data/src/usage.ts`.
- **Причина:** Task 14 перенёс презентационные мапперы в `@aif/shared`, а SQL-проекции остались
  в data-слое. Будучи структурно идентичными, типы совместимы, но изменение одной проекции без
  другой могло молча разойтись семантически.
- **Что устранено:** `TaskListItemRow`, `TaskSummaryRow` и `RuntimeProfileUsageState` определены
  единожды в `@aif/shared/src/presenters.ts`; `@aif/data` импортирует их и **реэкспортирует как
  result-shape** (`export type { TaskSummaryRow }` в `tasks.ts`, `export type { RuntimeProfileUsageState }` в `usage.ts`) — решение Task 16 сохранено: типы остаются в публичном
  контракте data, но определение одно. `TASK_LIST_COLUMNS` по-прежнему удовлетворяет импортированный
  `TaskListItemRow` (включая обязательный `hasPlan`).
- **Проверка:** `packages/data/src/__tests__/projectionTypes.test.ts` — compile-time равенство
  экспортированных data-типов определениям shared + source-level проверка отсутствия
  повторных `Pick<TaskRow, …>`; сьюты data/shared/api/mcp зелёные.
- **Действие:** новые проекции списков/суммари определять только в `@aif/shared/presenters.ts`;
  data-слой импортирует и (при необходимости) реэкспортирует, но не переобъявляет.

## `parseTaskCurrentTool` — транзитный реэкспорт из `@aif/data`

- **Статус:** устранено 2026-09-19 (план feature/fix-known-issues-followups, Task 6)
- **Симптом (исторический):** `packages/agent/src/notifier.ts` импортировал `parseTaskCurrentTool`
  из `@aif/data`, поэтому `packages/data/src/tasks.ts` реэкспортировал его из `@aif/shared`
  (`export { parseTaskCurrentTool } from "@aif/shared"`).
- **Причина:** функция — разбор JSON-колонки (общая утилита), переехала в shared, но потребитель
  (агент) не был переключён.
- **Что устранено:** `notifier.ts` импортирует `parseTaskCurrentTool` напрямую из `@aif/shared`;
  реэкспорт из data убран; мок в `stageErrorHandler.test.ts` переключён (ключ парсера убран,
  стабы `findTaskById`/`appendTaskActivityLog` сохранены).
- **Проверка:** `packages/data/src/__tests__/publicSurface.test.ts` — репродуктор: парсер
  резолвится из `@aif/shared`, а `@aif/data` больше его не экспортирует; импортов
  `parseTaskCurrentTool` из `@aif/data` в production = 0 (grep-проверка).
- **Действие:** общие парсеры импортировать из `@aif/shared`; транзитные реэкспорты в data не
  вводить без необходимости.

## Логгер `component` для перенесённых парсеров сменился с `"data"` на `"shared"`

- **Статус:** принято (осознанное следствие переноса)
- **Симптом:** предупреждения «Malformed persisted runtime-limit snapshot/window» и
  «Malformed persisted auto-review payload» теперь пишутся с `component: "shared"` вместо
  `"data"`.
- **Причина:** парсеры (`parseRuntimeLimitSnapshot`, `parseRuntimeObject`, `parseAutoReviewState`…)
  переехали в `@aif/shared/src/presenters.ts` (Task 14) вместе с мапперами; логгер модуля теперь
  создаётся с компонентом `"shared"`. Текст сообщений и поля не изменились.
- **Действие:** при поиске этих предупреждений в логах учитывать оба компонента. Если нужна точная
  операционная паритетность — передавать компонент в парсер параметром (высокая цена, пока не нужно).

## `[FIX]`-префиксы в DEBUG-логах `github.ts` / `gitlab.ts`

- **Статус:** устранено 2026-09-19 (план feature/fix-known-issues-followups, Tasks 4–5)
- **Симптом (исторический):** DEBUG-строки `"[FIX] GitHub/GitLab sync skipped unchanged task row…"`
  в `packages/data/src/github.ts` и `packages/data/src/gitlab.ts` выглядели как временные маркеры
  тикетов, а по правилу проекта в логах не должно быть билетных префиксов.
- **Причина (исправлено):** строки исторические. Прежнее обоснование «Task 8-сьюты закрепили их
  текст» неточно: grep-проверка подтвердила, что ни один тест не закреплял текст этих маркеров
  (проверено при подготовке плана, 2026-09-19).
- **Что устранено:** тексты заменены на нейтральные — `"Sync skipped unchanged task row to avoid
masking stale-claim recovery"` — с сохранением полей `{ projectId, issueNumber|iid, taskId }`
  и уровня DEBUG. То же в `packages/data/src/projects.ts` (`[FIX:147]`).
- **Проверка:** `npm run ai:log-markers` — 0 нарушений (скан `packages/*/src/**` без
  `__tests__`/`fixtures`, паттерн `/\[FIX(?:\]|:)/i`); `grep -rn "\[FIX" packages/data/src` = 0;
  DEBUG-вывод не изменился, кроме текста сообщения.
- **Действие:** не возвращать билетные префиксы; рецидивы ловит репозиторный guard
  `scripts/check-log-markers.mjs` (вшит в `ai:validate` как `ai:log-markers`).

## `startQaRun` (use case): дефолт `lockDurationMs = 60s` расходится с маршрутным значением

- **Статус:** устранено 2026-09-19 (план feature/fix-known-issues-followups, Task 8)
- **Симптом (исторический):** в `packages/api/src/use-cases/qaRun.ts` дефолт длительности QA-лока
  был 60 секунд, а маршрут `routes/tasks.ts` всегда передавал `QA_LOCK_DURATION_MS` =
  `Math.max(AGENT_STAGE_RUN_TIMEOUT_MS, 60_000) + 5*60*1000` (добавка 5 минут к таймауту стадии).
  Реальный вызов всегда шёл с явным значением, поэтому расхождение было скрыто.
- **Причина (историческая):** при переносе логики из маршрута константа осталась маршрутной,
  а use case получил параметр с «безопасным» дефолтом.
- **Что устранено:** применён вариант «derivation stays in exactly one place» —
  `resolveQaLockDurationMs()` в use case (`Math.max(getEnv().AGENT_STAGE_RUN_TIMEOUT_MS, 60_000) + 5*60*1000`); маршрут больше не держит вторую копию формулы и не передаёт значение; параметр
  `lockDurationMs` убран из `StartQaRunInput`. Добавлен DEBUG-лог `{ useCase: "startQaRun", taskId,
lockDurationMs, source: "env" }`.
- **Проверка:** `packages/api/src/__tests__/useCases.contract.test.ts` — репродуктор: resolved
  duration равен env-формуле и не может разойтись с caller-дефолтом; api-сьют 580 зелёных.
- **Действие:** при изменении формулы длительности QA-лока править только
  `resolveQaLockDurationMs()` в `use-cases/qaRun.ts`.

## `schema.ts` в `@aif/shared`: 0% покрытия в собственном отчёте shared после переноса сьютов в data

- **Статус:** принято; покрытие пакета держится выше 70% (79.9/78.5/77.0/75.0)
- **Симптом:** после переноса `schema.test.ts`/`db.test.ts`/`taskPlan.test.ts` в `@aif/data` (Task 17)
  behavioural-проверки схемы выполняются только в data-сьютах, и в `packages/shared/coverage`
  `schema.ts` показывает 0% lines/functions/statements.
- **Причина:** поведенческие тесты схемы требуют живого драйвера, который живёт теперь в data;
  shared-прогон не импортирует `schema.ts` напрямую (другие shared-сьюты идут через index/типы).
  Схема осталась pure-контрактом shared — её выполнение происходит при импорте, но в shared-прогоне
  ничего её не импортирует.
- **Действие:** если понадобится «честное» покрытие схемы в shared — добавить лёгкий контрактный тест
  (таблицы/колонки через drizzle-метаданные без драйвера). Пока не требуется: гейт 70% соблюдён,
  реальное поведение схемы проверяется в data.

## E2E perf-гейт (`ai:perf`) капризен на локальных машинах (Windows)

- **Статус:** открыто (не связано с clean-architecture рефакторингом; web/ не менялся)
- **Симптом:** `npm run ai:perf` (Playwright E2E против живых dev-серверов, `packages/web/e2e/perf/*`) иногда падает на бюджетах: `dashboard-load` («renders kanban shell within LCP/DOM-ready budgets») и `chat-sessions-endpoint` («cold and warm reads stay under budgets»). Типичная ошибка — `waitForSelector` не находит `Backlog|Planning|Implementing|Projects overview|No projects yet` в 30s или `domContentLoadedMs/LCP` превышают `PERF_BUDGETS`. При этом на повторном прогоне тот же/другой spec может пройти — набор падающих тестов между прогонами меняется.
- **Причина:** измерение времени против cold-start dev-серверов на локальном железе: пустая база perf-окружения, прогретость Vite/API, загрузка машины, кеша браузера. Бюджеты жёсткие (LCP/DOM-ready), а budget-тесты недетерминированны по определению.
- **Проверка:** перезапустить `npm run perf --workspace=@aif/web`; прогон обычно проходит целиком на следующем запуске.
- **Действие:** не трактовать красный perf-гейт как поломку `web/` кода; для CI рассматривать soft-fail на бюджетные прогоны или усреднение по нескольким запускам. В детерминированном гейте `ai:validate` (план feature/fix-known-issues-followups) `ai:perf`/`ai:load` не блокирующие — отчёт отдельный, со ссылкой на эту запись.

## Общие операции задач живут в `@aif/data`, а не в use-case фреймворке API

- **Статус:** принято (архитектурное решение Task 21, Variant A)
- **Симптом:** плановый «use cases as API, shared with MCP» невозможен буквально: `@aif/mcp`
  разворачивается независимо от `@aif/api` (Docker-стадия mcp копирует только data/runtime/mcp;
  зависимости mcp по package.json — только `@aif/data` + `@aif/shared`). Импорт `@aif/api` из MCP
  утянул бы весь HTTP-сервер в рантайм MCP (hono, WebSocket, api-сервисы) + потребовал бы изменения
  Docker/turbo/coverage/eslint.
- **Причина:** Layer-модель проекта: application-операции, нужные нескольким доставкам, обязаны жить
  ниже обеих точек доставки. `@aif/data` уже содержит политические композиты (`handoffTaskExecution`,
  `transitionTaskStatus`, лимиты), поэтому «управляемые» операции задач добавлены туда
  (`packages/data/src/taskOperations.ts`): `createTaskManaged`, `updateTaskManaged`,
  `setTaskPlanContentManaged`, `validateProjectScopedRuntimeProfileSelections`.
- **Действие:** при добавлении новой общей операции задачи расширять `taskOperations.ts`, а не
  дублировать правило в api- и mcp-коде. API use-cases остаются оркестраторами (участковая
  авторизация, вложения, файлы плана); MCP-инструменты зовут те же операции напрямую.

## `pushPlan` (MCP) пишет план в поле задачи, а не в файл плана

- **Статус:** принято (сохранение контракта инструмента)
- **Симптом:** `handoff_push_plan` (MCP) записывает `plan` в колонку задачи
  (`setTaskPlanContentManaged` → `setTaskFields`), тогда как API `updateTaskPlan` пишет канонический
  файл плана (`.ai-factory/PLAN.md`) через `persistTaskPlanForTask`. До рефакторинга MCP делал те же
  `setTaskFields`; Task 21 не менял это поведение.
- **Причина:** push-plan доставляет план из внешней системы (Handoff) в поле, а не в файл; клиенты
  MCP рассчитывают на компактный ответ без файловых операций. Это осознанное расхождение двух
  контрактов записи плана.
- **Действие:** если требуется единый «источник правды» плана — синхронизировать pushPlan с
  файловым путём (как `updateTaskPlan`) и согласовать с MCP-клиентами, либо документировать поле vs
  файл как разные контракты.

## Текст ошибок валидации runtime-профиля в MCP сменился на общий

- **Статус:** принято (общий контракт правит сообщениями; код ошибки не изменился)
- **Симптом:** `handoff_create_task`/`handoff_update_task` при невалидном выборе runtime-профиля
  раньше бросали `validationError` с MCP-локальными текстами («does not belong to project»,
  «Runtime profile is disabled»); теперь — с текстом общего контракта
  («Invalid runtime profile selection» + fieldErrors). Семантика и код `-32602` сохранены.
- **Причина:** Task 21 (Variant A) централизовал правило в `@aif/data`
  (`validateProjectScopedRuntimeProfileSelections`); MCP-инструменты маппят возвращённый
  `invalid_runtime_profile` в валидационную ошибку MCP.
- **Действие:** если MCP-клиенты парсят текст ошибок — обновить ожидания; рекомендуемый контракт —
  матчинг по структурному полю `code`, а не по тексту.

## Usage-broadcast после Task 24 привязан к внедрённому реестру (consequence)

- **Статус:** предложение от /aif-review (Task 24; не блокирует)
- **Симптом:** субагентские фазы, исполняемые вне штатного entry point агента (например, будущие
  встраиваемые вызовы `executeSubagentQuery`), больше не рассылают `task:usage_updated`/лимитные
  broadcast, если не внедрён реестр с usage-sink'ом. Раньше subagentQuery поднимал свой собственный
  sink с `notifyRuntimeUsageRefresh`; после Task 24 уведомления об usage делает исключительно sink
  композиционного корня (`packages/agent/src/index.ts`) при `bootstrapRuntimeRegistry`.
- **Причина:** единый владелец порта (Task 24): реестр + `createDbUsageSink` создаются один раз в
  composition root и внедряются через `setRuntimeRegistry`; `subagentQuery` читает только
  `requireRuntimeRegistry()`. Для штатного пути это поведение-эквивалентно, но любой обходной запуск
  без инъекции молча теряет broadcast'и usage/лимитов.
- **Действие:** при добавлении новых точек запуска субагентов вне координатора — либо внедрять
  реестр с sink'ом явно, либо документировать отсутствие broadcast'ов как ожидаемое поведение.

## Загрузчик scope-правил зависит от cwd (Task 25)

- **Статус:** устранено 2026-09-19 (план feature/fix-known-issues-followups, Task 9)
- **Симптом (исторический):** `packages/agent/src/agentScopeRules.ts` искал
  `.claude/agents/plan-coordinator.md` по `AIF_AGENT_DEFINITIONS_DIR`, иначе по `<cwd>/.claude/agents`.
  При запуске агента не из корня репозитория (например, `node dist/index.js` из `packages/agent/`)
  дефолт не находил файл, и scope-правила деградировали в пустые строки (правило опционально,
  запуск не ломается).
- **Причина (историческая):** cwd не зафиксирован контрактом; в docker агент стартует из `/app`,
  в turbo dev — из корня репозитория, но это не гарантировано для будущих деплойментов.
- **Что устранено:** порядок кандидатов: env-оверрайд (`AIF_AGENT_DEFINITIONS_DIR`) → module-anchor
  (`../../../.claude/agents` от `import.meta.url` — `packages/agent/src|dist` → корень репо) → cwd
  (последний фолбэк); DEBUG-лог `{ source: "env"|"module-anchor"|"cwd", resolvedPath }`; WARN только
  когда все стратегии не нашли файл; процесс-кэш и `resetAgentScopeRulesCache()` сохранены.
- **Проверка:** `agentScopeRules.test.ts` — репродуктор: загрузка с чужим cwd (temp dir) и без env —
  правила резолвятся через module-anchor; env-оверрайд побеждает; сброс кэша работает.
  `docs/configuration.md` обновлён.
- **Действие:** при изменении путей определений править `definitionsCandidates()` в
  `agentScopeRules.ts`; тесты — через `resetAgentScopeRulesCache()`.

## ESLint runtime-core: запрет adapters завязан на явный список файлов (Task 27)

- **Статус:** устранено 2026-09-19 (план feature/fix-known-issues-followups, Task 10)
- **Симптом (исторический):** правило «runtime core не импортирует adapters/\*\*» применялось к явному
  списку ядра в `eslint.config.mjs`; новый файл ядра без добавления в этот список не получал
  проверку.
- **Причина:** ESLint не умеет «исключить поддерево» в flat-config `files`, поэтому выбран точный
  список вместо glob-выражения, которое зацепило бы и сами adapters/.
- **Что устранено:** список ядра вынесен в единый модуль `eslint/runtimeCoreFiles.mjs`
  (`RUNTIME_CORE_FILES`), который импортируют и `eslint.config.mjs`, и guard-тест
  `packages/runtime/src/__tests__/runtimeCoreGuard.test.ts` — новый top-level core-файл без записи в
  список падает на guard-тесте (список и диск не могут разойтись). Семантика и тексты
  no-restricted-imports не менялись. При ревизии списка удалена stale-запись `readiness.ts`
  (файл удалён из репозитория, `git log --diff-filter=D` → `adbd5c4`).
- **Проверка:** `npm run lint` — зелёный (0 errors; pre-existing warnings не связаны с этим
  списком); guard-тест падает, если core-файл отсутствует в списке, и падает, если список
  расходится с диском.
- **Действие:** при добавлении нового файла в ядро runtime — дописать его в `RUNTIME_CORE_FILES`
  в `eslint/runtimeCoreFiles.mjs`; при удалении файла ядра — убрать запись из списка.

## `ai:validate`: флейк agent-сьюта из-за записи в глобальный git config

- **Статус:** устранено 2026-09-19 (план feature/fix-known-issues-followups, Task 1)
- **Симптом (исторический):** `npm run ai:validate` падал в `@aif/agent` на
  `gitlabPrepare.test.ts` с ошибкой: `RepositoryPrepareError: git config credential.helper failed`
  и системным хвостом `error: could not write config file C:/Users/*/.gitconfig: Permission denied`.
- **Причина (историческая):** тестовый сценарий `prepareRepository` использовал
  `git config --global credential.helper ...`; при параллельном прогоне/ограничениях окружения
  доступ к `~/.gitconfig` мог быть недоступен, что ломало тест независимо от бизнес-логики.
- **Что устранено:** `createIsolatedGitConfig()` в `gitTestUtils.ts` направляет
  `GIT_CONFIG_GLOBAL`/`HOME` на per-test временный каталог — тесты `prepareRepository` больше не
  пишут в реальный глобальный конфиг; production-путь (`--global` в `repositoryPrepare.ts`)
  не менялся (намеренный, opt-in резервный режим через env не вводился — not needed).
- **Проверка:** `gitlabPrepare.test.ts` — 5/5 подряд с sandboxed-конфигом; mtime
  `C:/Users/*/.gitconfig` не изменяется после сьюта; полный agent-сьют 3 раза подряд зелёный.
- **Действие:** git-конфиг в тестах изолировать только через sandbox-хелпер; не возвращать
  запись в реальный `~/.gitconfig`.

## `[FIX]`/`[FIX:*]` маркеры остаются в production-логах coordinator

- **Статус:** устранено 2026-09-19 (план feature/fix-known-issues-followups, Tasks 3 и 5)
- **Симптом (исторический):** в `packages/agent/src/coordinator.ts` оставались сообщения с
  временными префиксами: `"[FIX] Approved plan was not implemented; ..."`,
  `"[FIX] Implementation produced no files ..."`, `"[FIX:149] Failed to release coordinator task
claim"`.
- **Причина (исправлено):** строки исторические и не были частью целей рефакторинга, но файл
  затрагивался в Phase 5/6. Маркеры встречались и за пределами coordinator: `subagentQuery.ts`,
  `subagents/implementer.ts` (включая lowercase `[fix]`), `subagents/planner.ts`, `workspaceTools.ts`,
  а также `api`, `runtime` и `web` (вычищены как часть Task 5, чтобы guard прошёл).
- **Что устранено:** тексты заменены на нейтральные стабильные события: `"Approved plan was not
implemented; scheduling another implementation attempt"`, `"Implementation produced no files after
corrective retry; keeping task in implementing"`, `"Failed to release coordinator task claim"`;
  severity (`warn`/`error` с ключом `err`) и структурированные поля `{ taskId, stage }` не менялись.
- **Проверка:** `npm run ai:log-markers` (guard, сканирует `packages/*/src/**` без `__tests__`) — 0
  нарушений; `grep -rn "\[FIX" packages/agent/src packages/data/src packages/api/src
packages/runtime/src packages/web/src` (без `__tests__`) = 0. Регрессионный тест в
  `coordinator.test.ts` закрепляет нейтральный текст с полями `{ taskId, stage, err }` и отсутствие
  маркеров в исходнике.
- **Действие:** не возвращать тикетные префиксы в production-логи; рецидивы ловит
  `scripts/check-log-markers.mjs` (вшит в `ai:validate` между `lint` и `test`).
