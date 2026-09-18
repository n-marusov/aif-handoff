# C4-диаграммы — AIF Handoff: система автономного управления задачами

В этой директории хранятся архитектурные диаграммы системы **AIF Handoff — автономное управление задачами** (`aif-handoff`) в нотации C4. Диаграммы уровня 3 (Components) и уровня 4 (Code) в актуальной `as is`-версии строятся по фактической реализации в `packages/`. AIF Handoff — модульный монолит на Turborepo из семи пакетов (`shared`, `runtime`, `data`, `api`, `web`, `agent`, `mcp`), который разворачивается как набор Docker-сервисов (compose dev/production).

## Уровни C4

| Уровень                                  | Назначение                                                                                                                                                                                                    | Аудитория                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **1. System Context**                    | Система и её внешние акторы: персоны (Developer, Технический лид, Product Owner, QA-инженер, Администратор, AI-агенты) и внешние системы — AI-провайдеры, VCS-платформы, целевые git-репозитории, MCP-клиенты | Бизнес, продукт                  |
| **2. Container**                         | Исполняемые блоки системы: контейнеры `web`, `api`, `agent`, `mcp` и БД SQLite; библиотечные модули (`shared`, `runtime`, `data`) исполняются внутри этих контейнеров                                         | Архитекторы, разработчики        |
| **3. Component**                         | Компоненты контейнеров и модулей: маршруты и сервисы `api`, конвейер координатора `agent`, компоненты SPA `web`, инструменты `mcp`, адаптеры `runtime`, репозитории `data`                                    | Разработчики                     |
| **4. Code**                              | Декомпозиция поведения до автоматов состояний: жизненный цикл задачи, цикл координатора, конвергенция review, жизненный цикл worktree, лимиты runtime                                                         | Разработчики (обычно опускается) |
| **Deployment** (отдельный тип диаграммы) | Физическое развёртывание: Docker-сервисы (dev/production compose), Angie-прокси, тома, self-hosted провайдеры и VCS в доверенной зоне                                                                         | DevOps, архитекторы              |

## Правила именования файлов

Файлы именуются по шаблону `<LEVEL>.md`, где `LEVEL` = `context` | `container` | `component` | `code` | `deployment`. При необходимости нескольких диаграмм одного уровня используется шаблон `<LEVEL>-<name>.md`, где `name` — короткая англоязычная метка в kebab-case. `deployment` — отдельный тип диаграммы (не уровень; уровень 4 — `code`).

### Примеры

| Файл                                                                                | Описание                                                                                                                |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `context.md`                                                                        | System Context: AIF Handoff, персоны и внешние системы (AI-провайдеры, VCS-платформы, целевые репозитории, MCP-клиенты) |
| `container.md`                                                                      | Container: контейнеры `web`, `api`, `agent`, `mcp` и БД SQLite; библиотечные модули `shared`, `runtime`, `data`         |
| `component-api.md`, `component-agent.md`, `component-web.md`, `component-mcp.md`    | Component: компоненты контейнеров по фактической реализации в `packages/`                                               |
| `component-runtime.md`, `component-data.md`                                         | Component: компоненты библиотечных модулей (`@aif/runtime`, `@aif/data`)                                                |
| `code-task-lifecycle.md`, `code-coordinator-cycle.md`, `code-worktree-lifecycle.md` | Code: автоматы поведения (стадии задачи, цикл координатора, жизненный цикл worktree)                                    |
| `deployment.md`                                                                     | Deployment: Docker-развёртывание (compose dev/production), Angie, тома, корпоративная топология                         |

## Формат описания

Каждый файл диаграммы содержит:

- **Mermaid-диаграмму** в блоке ` ```mermaid `
- **Контекст** — что именно моделируется
- **Фактические компоненты** — с привязкой к пакетам/файлам реализации
- **Примечания по соответствию коду** — ключевые расхождения со старой или целевой моделью
- **Трассируемость** — ссылки на бизнес-правила (`BR-*`), прецеденты (`UC-*`) и требования (`REQ-FR-*` / `REQ-NFR-*`), если элемент модели ими управляется

## Текущее состояние

| Файл                             | Уровень            | Статус                                                                                          |
| -------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `README.md`                      | индекс             | актуален (этот файл)                                                                            |
| [`context.md`](context.md)       | 1 — System Context | актуален: персоны, внешние системы, функции HF1–HF12 и ключевые сценарии для AIF Handoff        |
| [`container.md`](container.md)   | 2 — Container      | актуален: контейнеры `web`, `api`, `agent`, `mcp` и БД SQLite, их интерфейсы и связи            |
| `component-*.md`                 | 3 — Component      | планируется                                                                                     |
| `code-*.md`                      | 4 — Code           | планируется                                                                                     |
| [`deployment.md`](deployment.md) | Deployment         | актуален: развёртывание по окружениям (development compose, production compose, MCP stdio mode) |

> Уровни 1–2 и Deployment ([context.md](context.md), [container.md](container.md), [deployment.md](deployment.md)) синхронизированы с фактической реализацией в `packages/` и compose-конфигурациями.

Каталог уровней 3–4 создаётся по мере описания: сначала контейнеры ядра (`api`, `agent`), затем остальные. Исходная диаграмма системного контекста (уровень 1) также представлена в [vision.md §3.3](../vision.md).

## Уровень 3. Компоненты (мастер-индекс)

Документация уровня 3 описывает компоненты контейнеров и библиотечных модулей; по контейнеру — один файл. Файлы уровня ведутся в формате reverse-engineering и должны отражать фактическую реализацию (`as-is`) в `packages/`.

| Документ               | Контейнер / модуль                                                                     | Компоненты                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `component-web.md`     | `web` — React SPA (`packages/web`)                                                     | Роутинг и корень (`App`, `main`), Kanban (`Board`, `Column`, `TaskCard`, `AddTaskForm`), задача (`TaskDetail`, ownership/handoff, `ExecutorTimeline`), чат, участники, проекты (`ProjectSelector`, `ProjectRuntimeSettings`), настройки (`RuntimeProfileForm`), layout (`Header`, `CommandPalette`), хуки (`useTasks`, `useProjects`, `useWebSocket`, `useRuntimeProfiles`), `lib/api.ts`                                                                                                                                                                                                                                                                                                                |
| `component-api.md`     | `api` — Hono REST + WebSocket (`packages/api`)                                         | Bootstrap (`serverBootstrap`, `shutdown`), маршруты (`tasks`, `projects`, `participants`, `auth`, `chat`, `github`, `gitlab`, `runtimeProfiles`, `settings`, `codexAuth`), middleware (session, CSRF, RBAC, rate limit, internal broadcast auth), сервисы (`runtime`, `codexIndex`, `fastFix`, `commitGeneration`, `roadmapGeneration`, `qaRunner`, `github`, `gitlab`, `agentInternal`, `gitPrepareBridge`), WebSocket (`ws.ts`)                                                                                                                                                                                                                                                                        |
| `component-agent.md`   | `agent` — координатор и субагенты (`packages/agent`)                                   | Цикл координатора (`coordinator`, `pollScheduler`, `wakeChannel`, `taskWatchdog`), субагенты (`planner`, `improver`, `planChecker`, `implementer`, `verifier`, `reviewer`, `doneChecker`), гейты (`reviewGate`, `reviewContract`, `autoReviewHandler`), VCS-воркфлоу (`githubWorkflow`, `gitlabWorkflow`, `githubPrepare`, `gitlabPrepare`, `gitConventions`), изоляция (`worktreeLifecycle`, `worktreeReconcile`, `gitOperationLock`, `repositoryPrepare`, `submoduleSync`), завершение (`autoQueueCommit`, `planReviewCommit`, `planReviewPublisher`), внутренний HTTP-API (`internalApi`), уведомления (`notifier`), устойчивость (`stageAbort`, `stageErrorHandler`, `loopGuard`, `errorClassifier`) |
| `component-runtime.md` | `runtime` — слой runtime-адаптеров (`packages/runtime`), исполняется в `api` и `agent` | Реестр и загрузка модулей (`registry`, `bootstrap`, `module`), разрешение профилей (`resolution`), гейтинг возможностей (`capabilities`, `workflowSpec`, `promptPolicy`), лимиты и учёт (`limitState`, `limitEvents`, `openaiRateLimits`, `usageSink`, `toolEvents`), discovery моделей (`modelDiscovery`, `modelEffort`), ошибки (`errors`), безопасность (`shellSafety`, `trust`, `timeouts`), адаптеры (`claude`, `codex`, `opencode`, `openrouter`)                                                                                                                                                                                                                                                  |
| `component-data.md`    | `data` — слой доступа к БД (`packages/data`), исполняется в `api`, `agent`, `mcp`      | Репозитории: `participants`, `authSessions`, `taskOwnership`, `taskTransitions`, `audit`, `github`, `gitlab`, `normalizeBacklogPositions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `component-mcp.md`     | `mcp` — MCP-сервер (`packages/mcp`)                                                    | Транспорты (`server`, `stdioEnv`, `env`), инструменты `handoff_*` (`createTask`, `getTask`, `listTasks`, `listProjects`, `searchTasks`, `updateTask`, `pushPlan`, `annotatePlan`, `syncStatus`), middleware (`errorHandler`, `rateLimit`), синхронизация (`sync/conflictResolver`), уведомления и формат ответов (`notifier`, `utils/broadcast`, `utils/compactResponse`)                                                                                                                                                                                                                                                                                                                                |

## Уровень 4. Code (поведение)

Документация уровня 4 описывает автоматы состояний (поведение) компонентов по фактической реализации в `packages/`. Файлы уровня ведутся в формате reverse-engineering и должны отражать фактическую реализацию (`as-is`).

| Документ                     | Модуль                                        | Поведение                                                                                                                                                                                |
| ---------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code-task-lifecycle.md`     | `shared` — автомат стадий (`stateMachine.ts`) | Жизненный цикл задачи: Backlog → Planning → Improve → Plan Review → Implementing → Verify → Review → Done → Accepted; боковое состояние `blocked_external`, ручные переходы и auto-queue |
| `code-coordinator-cycle.md`  | `agent` — координатор                         | Цикл опроса: двойной триггер (cron 30 с + wake по WebSocket), двухуровневый параллелизм (проекты/задачи), FIFO-распределение слотов, single-flight и дебаунс повторов                    |
| `code-review-convergence.md` | `agent` — гейт автоматического ревью          | Конвергенция review-loop: лимит итераций, гейт на `lightModel`, условия остановки и эскалации                                                                                            |
| `code-worktree-lifecycle.md` | `agent` — git-изоляция                        | Жизненный цикл worktree: создание под задачу, stash-before-remove при очистке, реконсиляция БД ↔ файловая система                                                                        |
| `code-runtime-limit.md`      | `runtime` — лимиты провайдеров                | Нормализация снимков лимитов (`runtimeLimitSnapshot`), упреждающая блокировка работы и авто-возобновление по reset-времени провайдера                                                    |

## Уровень Deployment

| Документ        | Что описывает                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deployment.md` | Docker-развёртывание: сервисы `api`, `web`, `agent`, `mcp`; тома `db-data`, `projects`, `claude-auth`, `codex-auth`, `ssl-certs`; Angie-прокси; dev- и production-конфигурации; корпоративная топология (доверенная зона без DMZ, self-hosted LLM) |

## Ключевые связи между контейнерами

- `web` (React SPA) общается с `api` по HTTP REST и WebSocket; других импортов между ними нет — только сетевые вызовы.
- `api` и `agent` читают и пишут БД SQLite **только** через `@aif/data` (lint guard); прямые SQL-импорты из `@aif/shared` запрещены, поэтому связь «контейнер → БД» на диаграммах показывается как in-process SQL за границей `@aif/data`.
- `api` и `agent` используют `@aif/runtime` для выбора профиля и запуска адаптеров; провайдеры (Claude Agent SDK, Codex, OpenCode, OpenRouter) остаются внешними системами.
- `agent → api` — HTTP-вызовы для broadcast-уведомлений (`notifier.ts`), best-effort.
- `api → agent` — HTTP-вызовы внутреннего API агента (`AGENT_INTERNAL_URL`, порт 3010: подготовка git-репозитория, очистка worktree, Codex login broker).
- `mcp → data` — MCP-сервер работает с задачами через тот же слой `@aif/data`; внешние MCP-клиенты (Claude Code, Codex, редакторы) подключаются по stdio или HTTP.
- `agent → GitHub/GitLab` — синхронизация Issue, публикация ветки и PR/MR (REST + git push); режим включается `GIT_PROVIDER` и rollout-флагами провайдера.
- `agent → целевые репозитории` — работа в git worktree под задачу в каталоге `PROJECTS_DIR` (в контейнерах — `PROJECTS_MOUNT`).

## Специфика проекта

- **As-is vs target**: уровни 3–4 описывают фактическое состояние `packages/`. Возможности, не найденные в коде, помечаются `planned`/`target` со ссылкой на фазу roadmap ([vision.md](../vision.md) §2.5).
- **C4-контейнер ≠ npm-пакет**: `shared`, `runtime`, `data` — библиотеки, исполняемые внутри процессов `api`, `agent`, `mcp`; отдельными контейнерами они не являются. Для них компонентные документы (`component-runtime.md`, `component-data.md`) описывают модуль, но не отдельный узел развёртывания.
- **C4-контейнер ≠ Docker-сервис**: `mcp` в stdio-режиме запускается клиентом как дочерний процесс и портов не слушает; в HTTP-режиме это отдельный сервис на порту 3100 с Bearer-токеном.
- **БД не сетевой сервис**: SQLite-файл (`DATABASE_URL`, том `db-data`), доступ — in-process. Сетевые связи к БД на диаграммах не рисуются.
- **AI-провайдеры — внешние системы**: адаптеры `claude`, `codex`, `opencode`, `openrouter` исполняются внутри `api`/`agent` (SDK, CLI-процессы, HTTP-API), но сами провайдеры вне контура системы. Контракт — `RuntimeAdapter` (`packages/runtime/src/types.ts`, `contract-aif-runtime`).
- **VCS-платформы — внешние системы**: GitHub и GitLab (REST + git transport), включаются `GIT_PROVIDER` и флагами `AIF_GITHUB_ISSUE_PR_ENABLED` / `AIF_GITLAB_ISSUE_MR_ENABLED`; на диаграммах связи с ними помечаются как gated.
- **Порты**: `api` — 3009 (REST + WS), `web` — 5180 в dev и 80/443 под Angie в production, `agent` — 3010 (только внутри compose-сети), `mcp` — 3100.
- **Изоляция изменений**: каждое изменение задачи выполняется в отдельном git worktree целевого проекта; прямая работа в основном рабочем дереве не моделируется.
- **Аутентификация**: session-токены + CSRF для `api`, Bearer-токен для MCP HTTP-транспорта (`MCP_AUTH_TOKEN`), опциональный `INTERNAL_BROADCAST_TOKEN` для внутренних вызовов агента.
- **Диаграммы — Mermaid C4**: синтаксис и параметры — в [справочнике Mermaid C4](../../.ai-factory/references/mermaid-c4-diagrams.md); для переноса длинных подписей используется обёртка `%%{init: {"wrap": true, "c4": {...}}}%%`.
- **Корпоративная топология**: решение «доверенная зона без DMZ, self-hosted LLM» зафиксировано в [RESEARCH.md](../../.ai-factory/RESEARCH.md) (сессия 2026-08-13) и должно найти отражение в `deployment.md`.

## Связанные артефакты

- [Видение продукта](../vision.md) — функции HF1–HF12, роли, roadmap и диаграмма системного контекста (§3.3)
- [Архитектура](../architecture.md) — пакеты, правила зависимостей, конвейер агента, автомат стадий
- [Архитектура (.ai-factory)](../../.ai-factory/ARCHITECTURE.md) — архитектурные решения для AI-агентов
- [Контракты](../contracts/README.md) — межпакетные интерфейсы, REST API, WebSocket, адаптеры
- [ADR](../adr/README.md) — архитектурные решения проекта
- [Прецеденты использования](../use-cases/README.md) — UC с каналами GUI/API/Agent/Schedule
- [Функциональные требования](../fun-req/README.md) и [нефункциональные требования](../nonfun-req/README.md)
- [Бизнес-правила](../business-rules/README.md) — каталог `BR-*`
- [Глоссарий](../glossary.md) — термины предметной области
- [Провайдеры](../providers.md) — runtime-профили, адаптеры, матрица возможностей
- [MCP Sync](../mcp-sync.md) — инструменты, транспорты и аутентификация MCP
