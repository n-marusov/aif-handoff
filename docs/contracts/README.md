# Контракты — AIF Handoff: система автономного управления задачами

В этой директории хранятся машинно-читаемые описания контрактов системы **AIF Handoff — автономное управление задачами**
(`aif-handoff`): модульного монолита на Turborepo, реализующего hand-off-конвейер с AI-субагентами через подключаемые
runtime-адаптеры. Каталог предназначен для стабильной работы ИИ-агентов и автоматической валидации: каждый контракт
описывается в стандартном формате (TypeScript-типы, OpenAPI 3.1, структурированный YAML) и регистрируется в
машинно-читаемом реестре `INDEX.yaml`.

> **Статус:** каталог системный. В этом репозитории реализованы все компоненты модульного монолита —
> `shared`, `runtime`, `data`, `api`, `web`, `agent` — в едином монорепозитории на Turborepo.
> Каталог описывает контракты **между пакетами** (межмодульные интерфейсы, API, протоколы), а также контракты
> с внешними системами (AI-провайдеры, VCS-платформы). Актуально: `README.md` (реестр — в разделе «Контракты системы»),
> `INDEX.yaml` (машинно-читаемый реестр), `VERSIONING.md` (политика версий).

## Контракты системы (реестр)

Контракты, в которых система AIF Handoff участвует непосредственно (реализованы в этом репозитории как
`implemented`, либо целевые — как `planned`):

| id                       | Контракт                                  | type         | format        | Стороны (from → to)                              | Статус        | Версия              |
| ------------------------ | ----------------------------------------- | ------------ | ------------- | ------------------------------------------------ | ------------- | ------------------- |
| `contract-aif-runtime`   | RuntimeAdapter interface (`@aif/runtime`) | `typescript` | `ts-types`    | Агент (coordinator + subagent) → runtime-адаптер | `implemented` | 1.0.0               |
| `contract-aif-rest-api`  | REST API (Hono)                           | `rest`       | `openapi-3.1` | Веб-интерфейс / внешние клиенты → API-сервер     | `implemented` | 0.1.0 (планируется) |
| `contract-aif-ws`        | WebSocket real-time events                | `websocket`  | `custom-yaml` | API-сервер → веб-интерфейс                       | `implemented` | 1.0.0               |
| `contract-aif-data`      | Data-access layer (`@aif/data`)           | `typescript` | `ts-types`    | API / Agent → `@aif/data` → SQLite               | `implemented` | 1.0.0               |
| `contract-aif-db-schema` | SQLite schema (Drizzle ORM)               | `sql`        | `drizzle-orm` | `@aif/data` → better-sqlite3                     | `implemented` | 1.0.0               |
| `contract-aif-scheduler` | Coordinator polling protocol              | `schedule`   | `ts-types`    | Coordinator (node-cron) → БД + subagent          | `implemented` | 1.0.0               |
| `contract-aif-github`    | GitHub REST API integration               | `rest`       | `openapi-3.1` | Agent → GitHub.com                               | `implemented` | —                   |
| `contract-aif-gitlab`    | GitLab REST API integration               | `rest`       | `openapi-3.1` | Agent → GitLab.com                               | `implemented` | —                   |
| `contract-aif-worktree`  | Git worktree isolation                    | `git`        | `custom-yaml` | Coordinator → Git worktree                       | `implemented` | 1.0.0               |

### `contract-aif-runtime` — RuntimeAdapter interface (`@aif/runtime`)

Единственный порт к AI: слой абстракции с единым контрактом, через который coordinator и subagent-запросы
проходят к AI-провайдерам (Claude Agent SDK, Codex CLI/API, OpenRouter API).

- **Источник правды:** TypeScript-типы в `packages/runtime/src/types.ts`:
  - `RuntimeAdapter` — основной интерфейс адаптера (run, listModels, resume, forkSession, итд.)
  - `RuntimeCapabilities` — флаги возможностей (поддержка стриминга, резюме сессий, model discovery, итд.)
  - `RuntimeExecutionIntent` — параметры выполнения (лимиты, таймауты, колбэки)
  - `RuntimeRunResult` — результат выполнения (usage, tool use, события)
  - `RuntimeDescriptor` — мета-описание адаптера (идентификатор, отображаемое имя, поддерживаемые транспорты)
- **Реализация (as is):** встроенные адаптеры в `packages/runtime/src/adapters/` (claude, codex, openrouter);
  внешние подключаются через `AIF_RUNTIME_MODULES`.
- **Методы RuntimeAdapter:** `run()`, `listModels()`, `getSession()`, `listSessions()`, `resume()`,
  `forkSession()`, `listSessionEvents()`.
- **Трассируемость:** HF3 (Подключаемые runtime-адаптеры), `UC-runtime.*`, `UC-pipeline.*`.

### `contract-aif-rest-api` — REST API (Hono)

HTTP REST API сервера (порт 3009) для управления задачами, проектами, участниками, runtime-профилями и чатом.

- **Транспорт:** HTTP/1.1 поверх TCP (Hono + @hono/node-server).
- **Ресурсы API:**
  - `GET/POST /api/tasks` — CRUD задач
  - `GET/PUT/PATCH /api/tasks/:id` — детали и обновление задачи
  - `POST /api/tasks/:id/transition` — ручной переход стадии
  - `POST /api/tasks/:id/handoff` — передача владения
  - `GET/POST /api/projects` — проекты
  - `GET/PUT /api/projects/:id/runtime-profile` — runtime-профиль проекта
  - `POST /api/chat` — AI-ассистент в контексте проекта/задачи
  - `POST /api/auth/login`, `POST /api/auth/logout` — аутентификация
  - `POST /api/auth/signup` — регистрация участника
  - `GET/PUT/PATCH /api/settings` — настройки
- **Аутентификация:** session-based (csrf-токен), `BR-auth.sessions`.
- **Реализация (as is):** `packages/api/src/routes/*.ts`.
- **Трассируемость:** HF2, `UC-dashboard.*`, `UC-auth.*`, `UC-chat.*`.

### `contract-aif-ws` — WebSocket real-time events

Двунаправленный WebSocket-канал для real-time обновлений дашборда (статусы задач, прохождение гейтов, handoff).

- **Транспорт:** WebSocket (ws) поверх HTTP, порт 3009.
- **События (broadcast):** `TaskStageChanged`, `TaskGatePassed`, `TaskGateFailed`,
  `TaskOwnershipTransferred`, `TaskEscalated`, `HeartbeatReceived`, `LimitExceeded`.
- **Реализация (as is):** `packages/api/src/ws.ts`.
- **Трассируемость:** HF2.4 (Обновления в реальном времени), `UC-dashboard.realtime.*`.

### `contract-aif-data` — Data-access layer (`@aif/data`)

Централизованный слой доступа к данным. Единственный способ чтения и записи БД для `api`, `agent` и `runtime`.
Lint-правила блокируют прямой импорт `@aif/shared/src/db` из этих пакетов.

- **Источник правды:** TypeScript-типы в `packages/data/src/index.ts`:
  - Repositories: `participants`, `authSessions`, `taskOwnership`, `taskTransitions`, `audit`
  - Каждая операция — атомарная функция, принимающая `db` из `@aif/shared/server`
- **Реализация (as is):** `packages/data/src/*.ts`.
- **Трассируемость:** архитектурное правило (ADR-DES.API.data-access-boundary), все UC с операциями с данными.

### `contract-aif-db-schema` — SQLite schema (Drizzle ORM)

Физическая схема SQLite-БД, определённая через Drizzle ORM с миграциями.

- **Источник правды:** `packages/shared/src/schema.ts` — таблицы: `tasks`, `projects`, `participants`,
  `auth_sessions`, `task_ownership_history`, `audit_events`, `runtime_profiles`, и др.
- **Миграции:** `MIGRATIONS` в `packages/shared/src/db.ts` — append-only, версионируются через `PRAGMA user_version`.
- **Трассируемость:** все UC с персистентностью данных.

## Как пользоваться каталогом (инструкция для ИИ-агентов)

1. **Начинайте с этого README** — точка входа и реестр контрактов системы; машинно-читаемый реестр — `INDEX.yaml`.
2. **Читайте спецификацию контракта:** для TypeScript-контрактов — типы в `packages/*/src/`; для REST API —
   OpenAPI-спецификация (в разработке). Спецификация — источник правды по конкретному контракту.
3. **Соблюдайте версии:** версионирование и депрекация — SemVer, additive-only (политика — [VERSIONING.md](VERSIONING.md)).
4. **Не выдумывайте** детали, отсутствующие в спецификации и в источниках реализации (`packages/`, `docs/`,
   `business-rules/`): каталог описывает фактическое состояние (`as is`), расхождения фиксируются пометками.
5. **Трассируйте** контракт на требования: функции HF1–HF12 ([vision.md](../vision.md) §2.2), прецеденты
   `UC-*` ([use-cases/](../use-cases/README.md)), доменную модель `domain/`.

## Структура каталога

```
docs/contracts/                 # каталог контрактов системы AIF Handoff
├── README.md                  # этот файл — точка входа и реестр
├── INDEX.yaml                 # машинно-читаемый реестр контрактов
├── VERSIONING.md              # политика версионирования и депрекации (SemVer, additive-only)
├── schemas/
│   ├── README.md              # указатели на общие схемы каталога
│   └── common.json            # переиспользуемые JSON Schema 2020-12 (типы/форматы/статусы/SemVer)
├── rest/
│   └── aif-api.openapi.yaml   # OpenAPI 3.1 спецификация REST API (планируется)
├── websocket/
│   └── events.yaml            # спецификация WebSocket событий и форматов (планируется)
└── adapter/
    └── runtime-adapter.yaml   # профиль RuntimeAdapter интерфейса (планируется)
```

Файлы спецификаций создаются по мере описания контрактов (принцип `as is`); источник правды TypeScript-контрактов —
код пакетов `packages/`, в этом каталоге типы не дублируются.

## Конвенции именования файлов

| Тип контракта         | Суффикс файла                                       | Формат                 |
| --------------------- | --------------------------------------------------- | ---------------------- |
| TypeScript interfaces | `*.ts` (источник — `packages/*/src/`)               | TypeScript             |
| REST                  | `<name>.openapi.yaml`                               | OpenAPI 3.1            |
| WebSocket             | `<name>.yaml`                                       | структурированный YAML |
| SQL schema            | `*.ts` (источник — `packages/shared/src/schema.ts`) | Drizzle ORM            |
| Профиль/протокол      | `<name>.yaml`                                       | структурированный YAML |

Имя файла — краткий slug контракта (`runtime-adapter`, `aif-api`, `events`).

## Форматы (стандарты)

- **TypeScript** — контракты RuntimeAdapter и Data-access layer (источник правды: код пакетов `packages/runtime/src/`,
  `packages/data/src/`; в этом каталоге — указатели).
- **OpenAPI 3.1** — REST API (планируется).
- **Структурированный YAML** — WebSocket-протокол, git worktree-протокол, профили адаптеров.
- **Drizzle ORM** — SQLite-схема (источник правды: `packages/shared/src/schema.ts`).

## Реестр `INDEX.yaml`

`INDEX.yaml` — машинно-читаемый реестр контрактов системы (актуальная редакция — [INDEX.yaml](INDEX.yaml)). Схема записи (поля):

```yaml
- id: contract-<slug> # стабильный идентификатор
  name: <название>
  type: typescript|rest|websocket|sql|schedule|git
  format: ts-types|openapi-3.1|custom-yaml|drizzle-orm
  version: <SemVer>
  from: <инициатор> # например: agent, coordinator, web-ui
  to: <получатель> # например: runtime-adapter, api-server, sqlite
  status: implemented|planned
  spec_path: docs/contracts/... # путь к спецификации от корня репозитория (отсутствует у planned)
  source_paths: [...] # источники реализации (as is) от корня репозитория, например packages/runtime/src/types.ts
  traceability: [...] # HF/UC/domain-связи, например [HF3, UC-runtime.profile.*, domain/RuntimeProfile]
```

## Статусы контрактов

- `implemented` — контракт реализован (в этом репозитории — `RuntimeAdapter`, REST API, WebSocket, схема БД;
  спецификации `docs/contracts/` появляются по мере описания).
- `planned` — целевой контракт (to be), реализация и/или спецификация впереди.

## Политика версионирования

Версионирование, правила совместимости (additive-only) и процедура депрекации соответствуют политике каталога
контрактов; локальная копия — [VERSIONING.md](VERSIONING.md). Версии TypeScript-контрактов фиксируются
в реестре и в спецификациях. Для контрактов, реализованных в коде (`RuntimeAdapter`, схема БД), версия
соответствует SemVer-версии пакета.

## Как добавить новый контракт

1. Определите формат по типу контракта (таблица «Конвенции именования файлов»).
2. Создайте спецификацию в соответствующем подкаталоге, следуя образцам каталога.
3. Зарегистрируйте контракт в `INDEX.yaml` (id, type, format, version, стороны, статус, source_paths, traceability).
4. Переиспользуйте общие схемы через `$ref` (`schemas/common.json`).
5. Укажите `source_paths` — файлы реализации, из которых контракт выведен (принцип `as is`).
6. Прогоните валидацию (см. ниже).

## Валидация

Структурная валидация каталога: синтаксис YAML/JSON, обязательные поля, согласованность `INDEX.yaml` со
спецификациями, SemVer-версии. Команды валидации добавляются по мере готовности скрипта.

## Специфика проекта

- **Система — контекст исполнения**: каталог описывает контракты AIF Handoff — модульного монолита на Turborepo.
  Пакеты: `shared`, `runtime`, `data`, `api`, `web`, `agent`. Внутренние функции AI-провайдеров (Claude,
  Codex, OpenRouter) — вне контура системы; их контракты в этом каталоге не описываются.

- **Runtime — единственный порт к AI**: все вызовы AI-провайдеров проходят через `@aif/runtime` — слой абстракции
  с единым контрактом `RuntimeAdapter`. Взаимодействие с runtime моделируется как ACL. `contract-aif-runtime`
  фиксирует этот контракт.

- **Data-access — единственный порт к данным**: данные проходят через `@aif/data`. Lint-правила блокируют
  прямой импорт БД из api/agent/runtime. `contract-aif-data` фиксирует границу.

- **Coordinator — единый оркестратор**: Coordinator (node-cron) опрашивает БД каждые 30 секунд и запускает
  subagent-запросы через RuntimeAdapter. `contract-aif-scheduler` фиксирует протокол этого цикла.

- **As-is vs target**: записи описывают фактическое состояние `packages/`; планируемые контракты (например,
  OpenAPI-спецификация, формальные WebSocket event schemas) помечаются статусом `planned`.

- **Граница каталога**: каталог описывает только контракты системы AIF Handoff. Внешние API (GitHub REST,
  GitLab REST, Anthropic API, OpenRouter API) ведутся как контракты-ссылки с пометкой «внешняя система»;
  их полные спецификации не дублируются.

## Связанные артефакты

- [domain/data-dictionary.md](../domain/data-dictionary.md) — словарь данных: атрибуты сущностей и расхождения
  модели и реализации
- [domain/context-map.md](../domain/context-map.md) — карта ограниченных контекстов: `task-pipeline`,
  `runtime-provisioning`, `git-isolation`, `audit-log`, `auth-session`
- [business-rules/README.md](../business-rules/README.md) и файлы `BR-*`: `BR-auth.sessions`,
  `BR-audit.immutable-trail`, `BR-automation.pipeline`, `BR-git.worktree-isolation`
- [vision.md](../vision.md) §2.2 — функции HF1–HF12
- [use-cases/README.md](../use-cases/README.md) — `UC-*` по всем доменам
- [glossary.md](../glossary.md) — термины (задача, проект, runtime-адаптер, coordinator, субагент, worktree)
- [ADR](../adr/README.md) — архитектурные решения: `ADR-DES.API.data-access-boundary`,
  `ADR-DES.STACK.modular-monolith-adoption`, `ADR-IMPL.INFRA.worktree-parallel-execution`
- [Известные проблемы](../known-issues.md) — известные ограничения и расхождения
