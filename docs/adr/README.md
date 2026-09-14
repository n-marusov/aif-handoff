# Архитектурные решения (ADR) — AIF Handoff: система автономного управления задачами

В этой директории хранятся записи архитектурных решений (Architecture Decision Records) проекта **AIF Handoff** — системы автономного управления задачами с Kanban-доской и AI-субагентами. Задачи проходят стадии автоматически: **Backlog → Planning → Plan Review → Implementing → Review → Done**, каждая обрабатывается субагентами через плагируемый слой рантаймов (`@aif/runtime`).

Проект реализован как Turborepo-монорепозиторий с семью пакетами (`shared`, `runtime`, `data`, `api`, `web`, `agent`, `mcp`). Каждый пакет — независимый модуль со своей сборкой, тестами и зависимостями, но все развёртываются и работают как единая система (Modular Monolith). Выполнение субагентов идёт через адаптеры рантаймов (Claude Agent SDK, Codex CLI/API, OpenRouter API), подключаемые через общий реестр и контракты в `packages/runtime`.

> **Статус:** на уровне требований зафиксировано: видение продукта — `docs/vision.md`; архитектура — `docs/architecture.md`, `.ai-factory/ARCHITECTURE.md`; C4-модель — если есть, в `docs/c4/`; глоссарий — `docs/glossary.md`. ADR в этой директории зафиксированы по фактической реализации (as-is) — см. [реестр](#реестр-adr-проекта) ниже.

## Применяемые архитектурные решения (внутренний реестр)

Ключевые архитектурные решения проекта зафиксированы в [.ai-factory/ARCHITECTURE.md](../.ai-factory/ARCHITECTURE.md) и [docs/architecture.md](architecture.md). Ниже — сводка решений, действующих на весь проект.

| Решение                                     | Описание                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modular Monolith (Turborepo)                | Семь пакетов с независимой сборкой, но единым развёртыванием. Пакетная структура отражает доменные границы.                                          |
| Единый слой доступа к данным (`@aif/data`)  | Все операции с SQLite — только через `@aif/data`. Прямые импорты DB-хелперов из `@aif/shared` и SQL-конструкции заблокированы ESLint.                |
| Плагируемый слой рантаймов (`@aif/runtime`) | Единый реестр адаптеров, профили (задача/проект/система), resolution + capability checks. Встроенные адаптеры: Claude, Codex, OpenRouter, OpenCode.  |
| State Machine для задач                     | Стадии `backlog → planning → plan_review → implementing → review → done`. Управляется через `packages/shared/src/stateMachine.ts`.                   |
| Поддержка нескольких runtime-адаптеров      | Каждый адаптер реализует `RuntimeAdapter` с транспортами (sdk/cli/api). Реестр поддерживает регистрацию внешних модулей через `AIF_RUNTIME_MODULES`. |
| Hono API + WebSocket                        | REST-эндпоинты и WebSocket для real-time обновлений Kanban. Порт 3009.                                                                               |
| React + Vite + TailwindCSS 4                | Web UI с Kanban-доской, управлением задачами, чатом. Порт 5180.                                                                                      |

## Реестр ADR проекта

Решения оформляются отдельными файлами `<ADR-ID>.md` в этой директории и заносятся в таблицу ниже.

| ID                                               | Решение                                                                                         | Статус  | Дата       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------- | ---------- |
| `ADR-DES.STACK.modular-monolith-adoption`        | Modular Monolith на Turborepo: 7 пакетов, strict dependency rules                               | ПРИНЯТО | 2026-09-14 |
| `ADR-DES.API.data-access-boundary`               | Централизованный слой данных `@aif/data` с ESLint-запретом прямых SQL-импортов                  | ПРИНЯТО | 2026-09-14 |
| `ADR-DES.API.runtime-adapter-pattern`            | Плагируемые runtime-адаптеры через `RuntimeAdapter` + registry + resolution + capability checks | ПРИНЯТО | 2026-09-14 |
| `ADR-IMPL.PROCESS.task-state-machine`            | Формальная state machine: `computeTransition()` с action codes и actor-aware переходов          | ПРИНЯТО | 2026-09-14 |
| `ADR-DES.API.hono-websocket-adoption`            | Hono для REST+WebSocket на одном порту, real-time обновления Kanban                             | ПРИНЯТО | 2026-09-14 |
| `ADR-IMPL.UI.react-vite-tailwind-adoption`       | React 19 + Vite + TailwindCSS 4, reusable UI-примитивы                                          | ПРИНЯТО | 2026-09-14 |
| `ADR-IMPL.DATA.sqlite-drizzle-adoption`          | SQLite (better-sqlite3) + Drizzle ORM, синхронные транзакции, WAL mode                          | ПРИНЯТО | 2026-09-14 |
| `ADR-IMPL.DATA.migration-append-only`            | Версии миграций append-only: коллизии на merge разрешаются новым номером                        | ПРИНЯТО | 2026-09-14 |
| `ADR-IMPL.INFRA.worktree-parallel-execution`     | Git worktree isolation для параллельного выполнения задач                                       | ПРИНЯТО | 2026-09-14 |
| `ADR-DES.SECURITY.auth-session-model`            | Трёхуровневая аутентификация: Basic Auth + session+CSRF + MCP Bearer Token                      | ПРИНЯТО | 2026-09-14 |
| `ADR-DES.INTEGRATION.github-gitlab-vcs-workflow` | Двунаправленная синхронизация с GitHub/GitLab: Issue → ветка → PR/MR                            | ПРИНЯТО | 2026-09-14 |
| `ADR-IMPL.PROCESS.auto-queue-advancement`        | Автоматическое наполнение пайплайна: sequential/parallel fill, FIFO, commit gate                | ПРИНЯТО | 2026-09-14 |
| `ADR-IMPL.PROCESS.coordinator-pipeline-pattern`  | Pipeline stages + dual-trigger + claim-lease + error recovery                                   | ПРИНЯТО | 2026-09-14 |

### Трассируемость ADR → бизнес-правила (BR-\*)

Решения трассируются на политики продукта из каталога [Business Rules](../business-rules/README.md):

| ADR-ID                                           | Связанные BR-\*                                                                                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADR-DES.STACK.modular-monolith-adoption`        | Бизнес-правила не затрагивает (архитектурный выбор)                                                                                                                                                                                         |
| `ADR-DES.API.data-access-boundary`               | [BR-audit.immutable-trail](../business-rules/BR-audit.immutable-trail.md)                                                                                                                                                                   |
| `ADR-DES.API.runtime-adapter-pattern`            | [BR-project.runtime-profiles](../business-rules/BR-project.runtime-profiles.md)                                                                                                                                                             |
| `ADR-IMPL.PROCESS.task-state-machine`            | [BR-task-lifecycle.stages](../business-rules/BR-task-lifecycle.stages.md), [BR-task-lifecycle.transitions](../business-rules/BR-task-lifecycle.transitions.md), [BR-task-lifecycle.blocked](../business-rules/BR-task-lifecycle.blocked.md) |
| `ADR-DES.API.hono-websocket-adoption`            | [BR-audit.observability](../business-rules/BR-audit.observability.md)                                                                                                                                                                       |
| `ADR-IMPL.UI.react-vite-tailwind-adoption`       | Бизнес-правила не затрагивает (UI-стек)                                                                                                                                                                                                     |
| `ADR-IMPL.DATA.sqlite-drizzle-adoption`          | [BR-audit.immutable-trail](../business-rules/BR-audit.immutable-trail.md)                                                                                                                                                                   |
| `ADR-IMPL.DATA.migration-append-only`            | Бизнес-правила не затрагивает (эксплуатация схемы)                                                                                                                                                                                          |
| `ADR-IMPL.INFRA.worktree-parallel-execution`     | [BR-git.worktree-isolation](../business-rules/BR-git.worktree-isolation.md), [BR-automation.concurrency](../business-rules/BR-automation.concurrency.md)                                                                                    |
| `ADR-DES.SECURITY.auth-session-model`            | [BR-auth.roles](../business-rules/BR-auth.roles.md), [BR-auth.credentials](../business-rules/BR-auth.credentials.md), [BR-auth.sessions](../business-rules/BR-auth.sessions.md)                                                             |
| `ADR-DES.INTEGRATION.github-gitlab-vcs-workflow` | [BR-git.vcs-workflow](../business-rules/BR-git.vcs-workflow.md), [BR-automation.plan-review-gate](../business-rules/BR-automation.plan-review-gate.md)                                                                                      |
| `ADR-IMPL.PROCESS.auto-queue-advancement`        | [BR-automation.auto-queue](../business-rules/BR-automation.auto-queue.md), [BR-automation.completion-commit](../business-rules/BR-automation.completion-commit.md)                                                                          |
| `ADR-IMPL.PROCESS.coordinator-pipeline-pattern`  | [BR-automation.pipeline](../business-rules/BR-automation.pipeline.md), [BR-automation.failure-recovery](../business-rules/BR-automation.failure-recovery.md), [BR-ownership.assignment](../business-rules/BR-ownership.assignment.md)       |

## Правила именования файлов

Файлы именуются по шаблону `<ADR-ID>.md`, где `ADR-ID` — уникальный идентификатор решения.

**Формат идентификатора:**

```
ADR-<LEVEL>.<AREA>.<semantic-tag>
```

Где:

- `LEVEL` = `BIZ` | `DES` | `IMPL`
- `AREA` = `API` | `DATA` | `INFRA` | `SECURITY` | `UI` | `PROCESS` | `INTEGRATION` | `STACK` | `OPS` | `DOC`
- `semantic-tag` — короткая англоязычная метка в kebab-case (2–5 слов), отражающая суть выбора

## Структура ADR

Каждый ADR должен содержать следующие обязательные поля:

- **Статус:** `[ЧЕРНОВИК | ПРЕДЛОЖЕНО | ПРИНЯТО | УСТАРЕЛО | ЗАМЕНЕНО]`
- **Дата:** `ГГГГ-ММ-ДД`
- **Контекст:** описание контекста проблемы
- **Требование-источник:** ссылки на файлы или ID требований (`vision.md`, `BR-*`, `UC-*`, NFR); для as-is решений — evidence-пути в коде (`packages/*`) и архитектурные документы
- **Решение:** краткое описание выбора (должно соответствовать semantic-tag)
- **Рассмотренные альтернативы:** перечисление рассмотренных вариантов (если применимо)
- **Последствия:** положительные и отрицательные последствия + способы смягчения

## Паттерны semantic-tag

| Паттерн                                | Описание                             | Пример                            |
| -------------------------------------- | ------------------------------------ | --------------------------------- |
| `-vs-` / `-vs-...-vs-`                 | Выбор между альтернативами           | `postgres-vs-sqlite`              |
| `-or-`                                 | Равнозначные варианты                | `hono-or-express`                 |
| `-tradeoff`                            | Компромисс между качествами          | `latency-vs-consistency-tradeoff` |
| `-adoption`                            | Внедрение технологии без альтернатив | `turborepo-adoption`              |
| `-mandate`                             | Вынужденное решение                  | `sqlite-mandate`                  |
| `-strategy` / `-approach` / `-pattern` | Выбор подхода                        | `state-machine-pattern`           |
| `-evolution` / `-migration`            | Изменение существующего              | `runtime-adapter-evolution`       |
| `-scope` / `-boundary`                 | Определение границ                   | `data-access-boundary`            |

## Правила

1. **Уникальность ID** — каждый `ADR-ID` уникален в рамках каталога и не пересекается с ID других ADR
2. **LEVEL соответствует типу решения:** `BIZ` — бизнес-решения, `DES` — проектные, `IMPL` — реализационные
3. **Максимальная длина semantic-tag** — 40 символов
4. **Запрещены пробелы** в ID, только дефисы и точки
5. **Перед созданием нового ADR** проверьте существующие ADR и `ARCHITECTURE.md` на пересечение темы; при расхождении с решением из `ARCHITECTURE.md` — сначала изменение архитектурного документа, затем фиксация исключения в ADR
6. **Изменения принятых ADR** оформляются через обновление статуса (заменено/устарело) и создание нового ADR

## Специфика проекта

- **Монорепозиторий Turborepo с семью пакетами**: `shared` (контракты/схема/автомат), `runtime` (адаптеры/реестр), `data` (слой БД), `api` (Hono REST+WS), `web` (React Kanban), `agent` (координатор+субагенты), `mcp` (MCP-инструменты). ADR фиксируют решения в границах этих пакетов и межпакетных контрактов.
- **Runtime-адаптеры**: Claude (Agent SDK), Codex (SDK/CLI/API/App Server), OpenRouter (API), OpenCode. Каждый адаптер реализует единый `RuntimeAdapter` интерфейс с поддержкой опциональных транспортов. ADR уровня `IMPL.STACK` фиксируют решения о расширении/замене адаптеров.
- **БД**: SQLite через better-sqlite3 + drizzle-orm. Все миграции — append-only (см. RULES.md). ADR уровня `DATA` фиксируют решения о схеме, миграциях и доступе.
- **Технологический стек**: TypeScript (ES2022, ESNext), Turborepo (npm workspaces), Hono, React 19, TailwindCSS 4, better-sqlite3, drizzle-orm, Pino, Vitest. Решения о замене/расширении стека — ADR уровня `IMPL.STACK`.
- **Архитектура развёртывания**: Docker compose (dev/production), Angie reverse proxy. См. `.docker/` и `docker-compose*.yml`. ADR уровня `INFRA` фиксируют решения о топологии сервисов и инфраструктуре.
- **Data Access Layer**: все SQL-операции — только через `@aif/data`. Прямые SQL-конструкции и импорты DB-хелперов из `@aif/shared` запрещены ESLint. ADR уровня `DATA.ACCESS` фиксируют изменения политик доступа.
- **Безопасность**: аутентификация Basic Auth + session-токены + CSRF. ADR уровня `SECURITY` фиксируют модель защиты, если она выходит за пределы заданного в `vision.md`.

## Связанные артефакты

- [Видение продукта](../vision.md) — продуктовая концепция и функции
- [Глоссарий](../glossary.md) — терминология предметной области
- [Архитектура (docs)](architecture.md) — описание архитектуры для разработчиков
- [Архитектура (.ai-factory)](../.ai-factory/ARCHITECTURE.md) — архитектурные решения для AI-агентов
- [Документация API](api.md) — REST-эндпоинты и WebSocket-события
- [Прецеденты использования](../use-cases/README.md) — спецификация UC
- [Business Rules](../business-rules/README.md) — каталог бизнес-правил продукта (`BR-*`)
- [Провайдеры и рантаймы](providers.md) — описание runtime-профилей и адаптеров
- C4-модель (если есть): `docs/c4/`
- [Правила проекта](../.ai-factory/RULES.md) — правила и конвенции
