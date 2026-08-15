[← GitLab Demo](gitlab-demo.md) · [Back to README](../README.md)

# Демонстрационный сценарий (dev + GUI): GitLab.com + router.ai (полный цикл «Issue → MR»)

> **Цель демо:** показать, как AIF Handoff в **локальном dev-окружении** (`npm run dev`,
> без Docker) в автономном режиме забирает задачу из Issue на gitlab.com, самостоятельно
> планирует, реализует и ревьюит её (через router.ai), публикует Merge Request и доводит
> задачу до статуса `verified` после того, как человек одобрил и смёрджил MR.
>
> **Окружение:** нативный dev-стек (Node + Turborepo, Web UI на `:5180`, API на `:3009`),
> LLM-бэкенд — router.ai (OpenAI-совместимый, через Codex CLI), репозиторий — gitlab.com.
>
> **Способ настройки:** почти всё делается **через Web UI**. В `.env` выносится только то,
> что GUI не хранит (секреты и флаги включения GitLab-режима). Git remote/credentials/
> главная ветка настраиваются **автоматически** агентом при Connect/Sync now.
>
> **Формат шагов:** `Действие` → `Смысл` → `Проверяемый результат`. Никаких скрытых
> шагов: всё, что нужно сделать «руками», перечислено явно.

```
┌────────────┐   Issue    ┌────────────┐   sync 60s   ┌────────────────┐
│  gitlab.com│───────────▶│  AIF API   │◀─────────────│  AIF Agent     │
│  (Issues)  │            │  :3009     │              │ (host process) │
└────────────┘            └─────┬──────┘              └───────┬────────┘
        ▲                       │                             │ router.ai
        │      MR / push        │                             │ (Codex CLI)
        └───────────────────────┼─────────────────────────────┘
                                │
                         ┌──────▼──────┐
                         │  Web UI     │
                         │  :5180      │  ← человек настраивает и наблюдает
                         └─────────────┘
```

**Матрица настройки «что где конфигурируется»:**

| Настройка                                   | Где настраивается в dev-сценарии                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| Включить GitLab-режим                       | `.env`: `GIT_PROVIDER=gitlab` + `AIF_GITLAB_ISSUE_MR_ENABLED=true`             |
| Токен GitLab                                | `.env`: `GITLAB_TOKEN` (в GUI хранится только **имя** переменной)              |
| Токен/endpoint router.ai                    | `.env`: `OPENAI_API_KEY`, `CODEX_BASE_URL` (секреты/дефолты)                   |
| Runtime-профиль router.ai                   | авто-посев из `.env` (`AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED`), просмотр в GUI |
| Проверка связи с LLM                        | GUI: кнопка **Validate** у профиля                                             |
| Дефолты стадий (plan/implement/review/chat) | авто-посев из `.env`; проверка в **Global Settings**                           |
| Создать проект + Root Path                  | GUI: **проект → New project**                                                  |
| GitLab-репозиторий + eligibility            | GUI: **Edit Project → GitLab Issue-to-MR → Connect**                           |
| Авто-очередь (auto-queue)                   | GUI: **Create/Edit Project → Auto-Queue Mode**                                 |
| `origin` и git-credentials локального repo  | автоматически: агент при **Connect / Sync now** (шаг 4.2–4.4)                  |
| Git-идентичность коммитов (bot-атрибуция)   | `.env`: `AIF_GIT_BOT_NAME` / `AIF_GIT_BOT_EMAIL` (опционально)                 |

**Что делает человек по ходу демо (только эти действия):**

1. Пишет `.env` (флаги GitLab + секреты) и запускает `npm run dev`.
2. В Web UI проверяет авто-посеянный профиль router.ai и связь (`Validate`).
3. В Web UI создаёт проект, подключает GitLab-репозиторий и включает Auto-Queue.
4. Создаёт Issue на gitlab.com и жмёт **Sync now** в Web UI.
5. Следит за прогрессом на доске, затем одобряет и мерджит MR.

Всё остальное делает система — включая настройку `origin`, git-credentials,
извлечение главной ветки и инициализацию AI Factory файлов (шаг 4, автоматически).

---

## 0. Подготовка (входные данные)

| Что                                       | Как получить / какой формат                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js + npm                             | Node `20.19+` или `22.12+` (Vite 8; Node 21 не поддерживается), npm `10+`. См. `.nvmrc`.                                                                                                                                                                                                                                                                                                                        |
| Codex CLI (локально)                      | Для transport `cli` бинарь `codex` должен быть в `PATH` (или укажите `CODEX_CLI_PATH`). Установка/версия — см. [Providers](providers.md#codex-cli-transport).                                                                                                                                                                                                                                                   |
| `git` + `ai-factory`                      | `git` должен быть в `PATH`; `ai-factory` ставится автоматически через `npm install` (root `package.json`).                                                                                                                                                                                                                                                                                                      |
| Репозиторий на gitlab.com                 | Готовый репозиторий с веткой по умолчанию `main` (не пустой — например, README). Путь: `NAMESPACE/PROJECT` (вложенные группы поддерживаются: `group/subgroup/project`).                                                                                                                                                                                                                                         |
| Personal Access Token (PAT)               | GitLab → _Settings → Access Tokens_. Скоупы: **`api`** (REST: issues, MR, approvals) + **`write_repository`** (git push). Роль на репозитории — не ниже Developer.                                                                                                                                                                                                                                              |
| router.ai: base URL                       | OpenAI-совместимый endpoint, например `https://<tenant>.router.ai/v1` — точное значение из личного кабинета router.ai.                                                                                                                                                                                                                                                                                          |
| router.ai: модель                         | ID модели с поддержкой **function calling / tool use** (иначе пайплайн планирования/реализации не отработает).                                                                                                                                                                                                                                                                                                  |
| router.ai: API key                        | Секретный ключ из личного кабинета.                                                                                                                                                                                                                                                                                                                                                                             |
| **Предусловие (не проверяется системой)** | router.ai должен поддерживать **Responses API** (`POST /v1/responses`) — именно его использует Codex CLI (transport `cli`); REST-only `/chat/completions` НЕ подходит. Модель — с поддержкой tool use. Автоконфигурация `config.toml` (`wire_api = "responses"`) выполняется адаптером автоматически из `baseUrl` профиля. Проверка связи делается на шаге 3; если она не пройдена, демо останавливается здесь. |

> Дальше `<NAMESPACE>`, `<PROJECT>`, `<profile-id>`, `<project-id>`, `<LOCAL_ROOT>` —
> плейсхолдеры, которые нужно заменить реальными значениями, полученными по ходу шагов.
> `<LOCAL_ROOT>` — абсолютный локальный путь к рабочему репозиторию проекта
> (например, `$HOME/projects/demo`).

---

## Шаг 1 — Файл `.env`

**Действие.** В корне проекта `aif-handoff` создайте (или дополните) файл `.env`:

```dotenv
# ── GitLab ──────────────────────────────────────────────
GIT_PROVIDER=gitlab
AIF_GITLAB_ISSUE_MR_ENABLED=true
GITLAB_TOKEN=<PAT: api + write_repository>

# ── router.ai (OpenAI-совместимый) через Codex CLI ──
OPENAI_API_KEY=<router.ai key>
CODEX_BASE_URL=<router.ai base URL>
# OPENAI_MODEL=<router.ai model id>  # необязательно: модель зададим в GUI (шаг 3)

# ── Режим работы (значение по умолчанию уже false, но фиксируем явно) ──
AGENT_USE_SUBAGENTS=false

# ── Авто-посев runtime-профиля router.ai (шаги 3.1+3.3) ──
# Профиль и app-wide дефолты создадутся сами при старте API (как в прод-сценарии);
# в GUI останется только проверка связи (Validate) и просмотр.
AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED=true

# ── Git-идентичность коммитов (опционально, bot-атрибуция) ──
# Если заданы оба — коммиты агента атрибутируются боту (user.name/user.email)
# AIF_GIT_BOT_NAME=AIF Bot
# AIF_GIT_BOT_EMAIL=bot@example.com
```

> ℹ️ **Авто-посев профиля работает и в dev** — API читает `.env` при старте (`npm run dev`),
> поэтому `AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED=true` создаст профиль router.ai и
> app-wide дефолты автоматически, как в прод-сценарии. GUI остаётся для проверки связи
> (**Validate**) и просмотра профиля, а не для ручного создания.

**Смысл.**

| Переменная                                   | Что делает                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GIT_PROVIDER=gitlab`                        | Селектор провайдера репозитория. GitLab-режим активен **только** когда `GIT_PROVIDER=gitlab` **и** `AIF_GITLAB_ISSUE_MR_ENABLED=true`. По умолчанию `github`.       |
| `AIF_GITLAB_ISSUE_MR_ENABLED=true`           | Ролл-аут-флаг GitLab Issue→MR. Без него роуты GitLab отдают `403 feature_disabled`, а блок **GitLab Issue-to-MR** не показывается в Edit Project.                   |
| `GITLAB_TOKEN`                               | PAT. Читается REST-клиентом (`tokenFor()`) и credential-helper для git push. GUI хранит только имя переменной (`GITLAB_TOKEN`), а не само значение.                 |
| `OPENAI_API_KEY`                             | Ключ router.ai. Профиль ссылается на него через `apiKeyEnvVar=OPENAI_API_KEY`; Codex CLI получает ключ только при явном opt-in профиля (`apiKeyEnvVar`).            |
| `CODEX_BASE_URL`                             | Base URL для локальных транспортов Codex (CLI/SDK/App Server). Не валидируется env-схемой, но используется нижележащими слоями Codex.                               |
| `OPENAI_MODEL`                               | (Опционально) модель по умолчанию из env. В GUI можно задать `defaultModel` профиля — тогда эта переменная не обязательна.                                          |
| `AGENT_USE_SUBAGENTS=false`                  | Skills-режим: у Codex нет нативных agent definitions, поэтому запускаем саб-агентов как навыки. По умолчанию и так `false`, но для наглядности демо фиксируем явно. |
| `AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED=true` | Включает авто-посев глобального профиля router.ai и app-wide дефолтов при старте API (как в прод-сценарии). Без него профиль придётся создавать вручную в GUI.      |
| `AIF_GIT_BOT_NAME` / `AIF_GIT_BOT_EMAIL`     | (Опционально) git-идентичность коммитов агента (bot-атрибуция). Применяются как глобальные `user.name`/`user.email` при старте агента.                              |

**Проверяемый результат.** Проверяем сам файл `.env` на хосте:

```bash
grep -E '^(GIT_PROVIDER|AIF_GITLAB_ISSUE_MR_ENABLED|GITLAB_TOKEN|OPENAI_API_KEY|CODEX_BASE_URL|AGENT_USE_SUBAGENTS|AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED)=' .env
# → все строки присутствуют и непустые
```

> `npm run dev` (скрипт `scripts/dev.mjs`) сам читает корневой `.env` в процесс-окружение
> dev-лаунчера, откуда Turbo пробрасывает его в `api`/`agent`. Дополнительно сами
> пакеты `api` и `agent` тоже читают `.env` (`.env.local` перекрывает) — см. [Configuration](configuration.md).

---

## Шаг 2 — Установка и запуск dev-стека

**Действие.**

```bash
cd aif-handoff
nvm use            # Node 20.19+ / 22.12+ (см. .nvmrc)
npm install
npm run init       # = npm run db:setup: создаёт data/aif.sqlite + применяет миграции
npm run dev
```

**Смысл.** `npm run dev` через Turborepo запускает три процесса: `@aif/api` (`:3009`),
`@aif/web` (`:5180`, Vite dev-сервер) и `@aif/agent` (координатор в фоне). Если в `.env`
задан валидный `MCP_PORT`, добавляется четвёртый процесс `@aif/mcp`. Никакого Docker.

**Проверяемый результат.** В терминале поднимаются логи `api`/`web`/`agent`, и:

```bash
curl -s http://localhost:3009/health   # API (Hono) → JSON-ответ об успехе
```

Откройте в браузере Web UI: **http://localhost:5180**. Vite проксирует REST/WebSocket-запросы
на API автоматически, поэтому отдельно адрес API в UI не настраивается.

> Если переключали версию Node между запусками — выполните `npm rebuild better-sqlite3`.
> Несовместимый нативный бинарь падает с `ERR_DLOPEN_FAILED` и выглядит как **502 Bad Gateway**
> в UI; `npm run dev` с недавних версий ловит этот случай сам и печатает нужную команду.

---

## Шаг 3 — Runtime-профиль router.ai + проверка связи

### 3.1. Runtime-профиль (авто-посев при старте API)

**Действие.** Профиль уже создан — при старте API (шаг 2) сработал env-bootstrap
(`AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED=true` из шага 1). Проверяем в GUI:

1. В Web UI нажмите иконку **⚙ Global Settings** в шапке.
2. В блоке **Global Runtime Profiles** найдите профиль `Bootstrap (Codex CLI)`.
3. Проверьте его поля (для справки):

| Поле            | Значение (из авто-посева)    |
| --------------- | ---------------------------- |
| Name            | `Bootstrap (Codex CLI)`      |
| Runtime         | `Codex (codex)`              |
| Transport       | `CLI`                        |
| Base URL        | `CODEX_BASE_URL` (из `.env`) |
| API key env var | `OPENAI_API_KEY`             |
| Default model   | `OPENAI_MODEL` (из `.env`)   |
| Enabled         | вкл                          |

**Смысл.** API при старте вызывает `seedBootstrapRuntimeProfile()` и автоматически:

- создаёт **глобальный** профиль `Bootstrap (Codex CLI)` (`runtimeId=codex`, `providerId=openai`, `transport=cli`, `apiKeyEnvVar=OPENAI_API_KEY`);
- `baseUrl` наследуется из `AIF_BOOTSTRAP_BASE_URL` → `CODEX_BASE_URL`, модель — из `AIF_BOOTSTRAP_DEFAULT_MODEL` → `OPENAI_MODEL`;
- назначает профиль app-wide дефолтом для task/plan/review/chat (это заменяет ручной шаг 3.3);
- повторные старты идемпотентны; `AIF_BOOTSTRAP_FORCE_UPDATE=true` включает upsert.

Ключевые поля профиля (важно понимать независимо от способа создания):

- `runtimeId: "codex"` — адаптер Codex;
- `transport: "cli"` — локальный агентный транспорт. ⚠️ НЕ `api`: API-транспорт Codex — это разовый вызов `/chat/completions` без tool-calling и не может вести пайплайн «планирование → реализация → ревью»;
- `baseUrl` — endpoint router.ai (в профиле имеет приоритет над `CODEX_BASE_URL`);
- `apiKeyEnvVar: "OPENAI_API_KEY"` — имя переменной, из которой берётся ключ.

**Проверяемый результат.** В **Global Settings → Global Profiles** есть профиль
`Bootstrap (Codex CLI)` со строкой `transport=cli model=<...>` и без пометки `disabled`.

> 💡 **Без авто-посева (флаг выключен)** — создать профиль вручную:
> **+ New Global Profile** с полями из таблицы выше (Name можно любой, например
> `router.ai (Codex CLI)`), затем на шаге 3.3 назначить его в дефолты.

### 3.2. Проверить связь с router.ai

**Действие.** У созданного профиля нажмите кнопку **Validate**.

**Смысл.** Это GUI-эквивалент `POST /runtime-profiles/validate`: реальная проверка
подключения к LLM (коннект к endpoint, список моделей, ключ). Самый ранний «стоп-кран» демо.

**Проверяемый результат.** Сообщение об успешной валидации. Если связь не установлена —
проверьте `baseUrl`, `OPENAI_API_KEY`, совместимость с Codex-протоколом и поддержку tool use
моделью. **Демо останавливается здесь** — дальше идти не нужно, пока связь не поднимется.

### 3.3. Назначить app-wide дефолты стадий (автоматически)

**Действие.** Дефолты уже назначены авто-посевом — проверяем в **Global Settings**:

- **Implementation / Planning / Review / Chat** → показывают `Bootstrap (Codex CLI)`.

**Смысл.** При `AIF_BOOTSTRAP_SET_DEFAULTS=true` (по умолчанию) авто-посев сам назначает
созданный профиль дефолтом для всех стадий пайплайна и чата — отдельный ручной шаг не нужен.

**Проверяемый результат.** Все четыре выпадающих списка показывают созданный профиль.

> 💡 **Без авто-посева** — назначить вручную: выбрать профиль в каждом из четырёх списков
> и нажать **Save Runtime Defaults**.

### 3.4. Готовность системы

**Действие.** Убедитесь, что в **Global Settings** есть хотя бы один включённый профиль
(без `disabled`) и он назначен в дефолтах. Для машиночитаемой проверки:

```bash
curl -s http://localhost:3009/settings
```

**Смысл.** Блок `runtimeReadiness` показывает, что адаптеры зарегистрированы и есть
включённый профиль.

**Проверяемый результат.** В ответе:

```json
"runtimeReadiness": { "availableRuntimeCount": 4, "runtimeProfileCount": 1, "enabledRuntimeProfileCount": 1 }
```

(`availableRuntimeCount` — число зарегистрированных встроенных адаптеров: Claude, Codex,
OpenCode, OpenRouter) и `"gitProvider": "gitlab"`, `"gitlabIssueMrEnabled": true`.

> ⚠️ Примечание. Отдельного роута `GET /agent/readiness` нет. Готовность LLM проверяется
> кнопкой **Validate** (или `POST /runtime-profiles/validate`), а состояние системы —
> `GET /settings` (блок `runtimeReadiness`). Подробнее — в [GitLab Demo](gitlab-demo.md), Приложение А.

---

## Шаг 4 — Проект + git remote

### 4.1. Создать проект

**Действие.**

1. В левом верхнем углу откройте селектор проектов → **New project**.
2. Заполните:

| Поле                            | Значение                         |
| ------------------------------- | -------------------------------- |
| Name                            | `demo`                           |
| Root Path                       | `<LOCAL_ROOT>` (абсолютный путь) |
| Auto-Queue Mode                 | вкл (или включите на шаге 6)     |
| Остальные поля (бюджеты и т.п.) | оставьте пустыми                 |

3. Нажмите **Create**.

**Смысл.** Создаёт запись проекта в БД и инициализирует директорию `<LOCAL_ROOT>` на хосте:

- `git init` + начальный коммит `"init: project scaffold"` (пустой);
- `ai-factory init` — скаффолд `.ai-factory/` в корне проекта.

⚠️ **Важно понимать:** локальный репозиторий — **не клон** gitlab.com. Это отдельный
рабочий репозиторий, из которого агент пушит ветки в `origin`. Содержимое ветки `main`
на gitlab.com он не видит (поэтому ниже — рекомендуемый шаг 4.4 «зеркалирование»).

**Проверяемый результат.** Проект появился в селекторе. Проверка локального репозитория:

```bash
git -C <LOCAL_ROOT> status
# → на ветке main (или master), работает чисто
```

### 4.2–4.4. Git remote, credentials, главная ветка — автоматически ✅

> Эти шаги **больше не нужно выполнять вручную**. При подключении репозитория через
> **Connect** (и повторно при **Sync now**) агент сам выполняет `prepareGitLabRepository()`
> в корне проекта:
>
> 1. `git remote add origin <webUrl>.git` (если `origin` отсутствует);
> 2. `git config credential.helper` (токен из `$GITLAB_TOKEN` в окружении агента);
> 3. `git config --global --add safe.directory <root>` (идемпотентно — устраняет
>    `dubious ownership`);
> 4. `git fetch origin`;
> 5. извлекает **главную ветку** по имени из `connection.defaultBranch`
>    (`main`/`master`/`develop`/... — как сообщает GitLab; fallback `origin/HEAD`);
>    если на GitLab веток нет — остаётся локальная ветка и пушит скаффолд как
>    стартовый `defaultBranch`;
> 6. `initProject()` — инициализирует AI Factory файлы (`.ai-factory/`, `.claude/`,
>    `.codex/`, ...), если их ещё нет (идемпотентно);
> 7. коммитит скаффолд (`chore: ai-factory scaffold`), если появились файлы.
>
> **Проверяемый результат:** после Connect/Sync now в `<LOCAL_ROOT>` настроен `origin`,
> локальная ветка = главная ветка репозитория, AI Factory скаффолд закоммичен.
> Если подготовка не удалась (например, неверный токен) — **Sync now вернёт ошибку
> сразу** (`gitlab_prepare_*`), задача не импортируется и остаётся `blocked`.

> ⚠️ Про чистоту MR: `ai-factory init` создаёт в корне `.ai-factory/` (не входит в
> глобальный `.gitignore`). Если задача «закоммитит всё» (`git add -A`), скаффолд-файлы
> могут попасть в MR. Для чистого демо либо добавьте `.ai-factory/` в `.gitignore`
> репозитория, либо дайте задачу, которая добавляет только свой файл.

---

## Шаг 5 — Подключение GitLab-репозитория (GUI)

**Действие.**

1. В селекторе проектов наведите курсор на проект `demo` и нажмите иконку **Edit** (карандаш).
2. Найдите блок **GitLab Issue-to-MR** (он виден, потому что `GIT_PROVIDER=gitlab` и
   `AIF_GITLAB_ISSUE_MR_ENABLED=true`).
3. Заполните:

| Поле                 | Значение                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Repository           | Полный URL проекта: `https://gitlab.com/<NAMESPACE>/<PROJECT>` (или `https://gitlab.example.com/...` для self-hosted) |
| Required labels      | _(пусто)_                                                                                                             |
| Assignee (optional)  | _(пусто)_                                                                                                             |
| Milestone (optional) | _(пусто)_                                                                                                             |

> ℹ️ Поле `Token env var` в GUI **отсутствует** — в режиме `GIT_PROVIDER=gitlab` токен
> всегда читается из `GITLAB_TOKEN`. Полный URL принимается и для корпоративного GitLab
> (host автоматически срезается, остаётся `namespace/project`). При повторном открытии
> диалога поле Repository предзаполняется сохранённым URL проекта.

4. Нажмите **Connect**.

**Смысл.** Сохраняет связку «локальный проект ↔ репозиторий gitlab.com» (то же, что
`PUT /projects/:id/gitlab`). При этом:

- вызывается GitLab API (`GET /projects/<ns>/<project>`) — токен из `GITLAB_TOKEN` должен быть валиден и иметь скоуп `api`; иначе `400 gitlab_authentication` (нет/неверен токен) или `403 gitlab_forbidden` (недостаточно скоупов/прав, GitLab: `insufficient_granular_scope`);
- фиксируются `namespace`, `name`, `defaultBranch`, `webUrl`;
- `eligibility` — фильтр входящих Issues (пустой = берутся все открытые);
- токен в БД не хранится — только имя переменной окружения.

**Проверяемый результат.** Бейдж блока меняется на **Connected**, появляются кнопки
**Sync now** и **Disconnect**. Вложенные группы задаются полным путём
(`group/subgroup/project`).

---

## Шаг 6 — Включить авто-очередь (Auto-Queue Mode) — обязательный шаг

**Действие.** Если не включили при создании проекта: **Edit Project → Auto-Queue Mode** →
переключатель в положение «вкл» → **Save**.

**Смысл.** Импортированная из Issue задача попадает в статус `backlog` с `autoMode=true`,
но координатор **двигает дальше только проекты с `autoQueueMode=true`**. Без этого шага
задача навсегда останется в `backlog`.

**Проверяемый результат.** В **Edit Project** переключатель **Auto-Queue Mode** включён;
после сохранения проект автономно продвигает задачи из `backlog`.

---

## Шаг 7 — Issue → задача

**Действие.**

1. Создайте на gitlab.com открытый Issue с осмысленным описанием задачи.
   Рекомендация для чистого демо: задача «добавить файл» или «добавить README-секцию» —
   что-то, что реализуется одним-двумя коммитами без внешних зависимостей.
   Пример: _«Добавить файл CHANGELOG-DEMO.md в корень репозитория с описанием
   демонстрационного релиза»_.
2. В Web UI откройте **Edit Project → GitLab Issue-to-MR** и нажмите **Sync now**
   (или дождитесь авто-синхронизации ≤ 60 с).

**Смысл.** Синхронизация забирает все открытые Issues репозитория, прошедшие
`eligibility`, и импортирует их как задачи: `autoMode=true`, `executionOwner="ai"`,
статус `backlog`, в заголовке карточки — `#<iid> <title>`. Синхронизация идемпотентна:
повторный запуск не создаёт дубликатов.

**Проверяемый результат.** На доске появилась карточка с бейджем `GITLAB`, статус
`backlog`. Запускать её вручную не нужно — авто-очередь (шаг 6) подхватит её в течение
ближайшего цикла поллинга (30 с).

---

## Шаг 8 — Пайплайн → MR

**Действие.** Наблюдайте за прогрессом:

- на Kanban-доске в Web UI (карточка меняет статусы);
- в терминале, где запущен `npm run dev` (логи `api`/`agent`).

**Смысл.** Координатор гонит задачу по стадиям. В skills-режиме (`AGENT_USE_SUBAGENTS=false`)
стандартный маршрут:

```
backlog ──▶ planning ──▶ plan_ready ──▶ implementing ──▶ review ──▶ done
```

(Стадии `improve`/`verify` подключаются только если у задачи выставлены флаги
`runPlanImprove`/`runPostVerify` — для демо они не нужны.)

Ключевые моменты в логах:

- `planner` создаёт ветку `feature/<slug>-<id>` (перед этим — `git pull --ff-only origin main`);
- `implementer` после реализации вызывает `publishGitLabTask` → `git push` ветки + создание/обновление MR;
- `reviewer` прогоняет автоматическое ревью и снова публикует MR. Исход ревью: `accepted` → `done`, `rework_requested` → возврат в `implementing`, `manual_review_required` → передача человеку.

**Проверяемый результат.** В gitlab.com появляется открытый MR из ветки задачи в `main`:

- заголовок = название задачи;
- описание начинается с `Closes #<iid>`;
- в описании — разделы «Implementation» и «Test evidence»;
- финальная строка: `_AIF never merges this merge request; a human owns the final decision._`.

В Web UI статус задачи дошёл до `review` (и затем `done`). В логах агента —
строки `GitLab merge request synchronized`.

---

## Шаг 9 — Ревью и merge → verified

**Действие.**

1. Откройте MR на gitlab.com, ознакомьтесь с диффом и заметкой авто-ревью (отмечается маркером `<!-- aif-gitlab-review -->`).
2. Одобрите MR (кнопка **Approve**).
3. Смёрджите MR в `main` (можно с удалением ветки).
4. Дождитесь следующего цикла синхронизации (≤ 60 с) — можно ускорить, нажав **Sync now**
   в **Edit Project → GitLab Issue-to-MR**.

**Смысл.** Агент видит `mrState: "merged"` и переводит задачу `done → verified`.
Слияние всегда выполняет человек — система никогда не мерджит сама.

Сводка переходов при синхронизации (из кода `routes/gitlab.ts`):

| Состояние MR на gitlab.com                     | Действие системы                          |
| ---------------------------------------------- | ----------------------------------------- |
| `merged` + задача `done`                       | задача → `verified`                       |
| `closed`                                       | задача → `paused`                         |
| `open`                                         | ждёт человека (никаких изменений статуса) |
| MR «Closes #<iid>» найден у задачи в `backlog` | задача → `done` (задача уже реализована)  |

**Проверяемый результат.** В Web UI задача получила статус `verified`.

---

## Шаг 10 — Приёмка (контрольный список)

| #   | Проверка                               | Ожидание                                                                                           |
| --- | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | `curl -s http://localhost:3009/health` | сервис жив                                                                                         |
| 2   | **Validate** у профиля (шаг 3.2)       | успех — router.ai совместим и поддерживает tool use                                                |
| 3   | `GET /settings` → `runtimeReadiness`   | `availableRuntimeCount ≥ 1`, `enabledRuntimeProfileCount = 1`; дефолты стадий указывают на профиль |
| 4   | Повторный **Sync now**                 | импорт идемпотентен, дубликатов нет                                                                |
| 5   | Задача в Web UI                        | прошла `backlog → ... → done` без ручного старта                                                   |
| 6   | MR на gitlab.com                       | в `main`, описание начинается с `Closes #<iid>`                                                    |
| 7   | После Approve + Merge                  | задача → `verified`                                                                                |
| 8   | Логи `npm run dev` (agent)             | нет `StageManualBlockError`, `gitlab_*` ошибок, ошибок аутентификации                              |

---

## Сводная таблица «Действие → Смысл → Результат»

| Шаг | Действие                                                               | Смысл                                            | Проверяемый результат                                                                    |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 1   | Заполнить `.env`                                                       | Включить GitLab-режим + router.ai + skills-режим | `grep ... .env` → все строки на месте                                                    |
| 2   | `npm install && npm run init && npm run dev`                           | Поднять нативный dev-стек                        | Web UI `:5180`, `GET /health` `:3009` → 200                                              |
| 3   | Авто-посев профиля (`.env` + старт API), Validate                      | Подключить router.ai как LLM                     | Профиль `Bootstrap (Codex CLI)` в Global Settings; `Validate` успешен; дефолты назначены |
| 4   | New project (git remote/credentials/ветка — автоматически при Connect) | Рабочий репозиторий + origin                     | Бейдж **Connected**; агент сам настроил `origin`, главную ветку и AI Factory скаффолд    |
| 5   | Edit Project → GitLab Issue-to-MR → Connect                            | Связать проект с репозиторием                    | Бейдж **Connected**, появились **Sync now**/**Disconnect**                               |
| 6   | Edit Project → Auto-Queue Mode → Save                                  | Разрешить авто-продвижение задач                 | Переключатель включён                                                                    |
| 7   | Создать Issue + **Sync now**                                           | Импортировать Issue как задачу                   | Карточка `GITLAB #<iid>` в `backlog`                                                     |
| 8   | Наблюдать доску и логи `npm run dev`                                   | Пайплайн планирования/реализации/ревью           | Задача прошла до `done`; MR `Closes #<iid>` в gitlab.com                                 |
| 9   | Approve + Merge на gitlab.com                                          | Человек принимает решение                        | Задача `verified`                                                                        |
| 10  | Контрольный список                                                     | Приёмка                                          | все пункты зелёные                                                                       |

---

## Тайминги (что и когда происходит)

| Событие                                    | Задержка                                           |
| ------------------------------------------ | -------------------------------------------------- |
| Синхронизация Issues (агент → API)         | каждые **60 с** (`SYNC_INTERVAL_MS`)               |
| Поллинг координатора (новая стадия задачи) | каждые **30 с** (`POLL_INTERVAL_MS`, по умолчанию) |
| Вручную запустить синхронизацию            | **Sync now** в Edit Project — мгновенно            |
| От `done` до `verified` после merge        | ≤ 60 с (следующая синхронизация)                   |

---

## Приложение А — Чем dev+GUI отличается от прод+curl

| Прод-сценарий (`gitlab-demo.md`)                                 | Dev + GUI (этот документ)                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `docker compose -f docker-compose.production.yml up -d`          | `npm run dev` (нативный стек, Web `:5180`, API `:3009`)            |
| Авто-посев профиля через `AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED` | то же (авто-посев из `.env`); GUI — только **Validate** и просмотр |
| `POST /runtime-profiles/validate`                                | кнопка **Validate** у профиля                                      |
| `PUT /settings/runtime-defaults`                                 | авто-посев; проверка в **Global Settings**                         |
| `POST /projects` через curl                                      | **New project** (диалог с Name/Root Path/Auto-Queue)               |
| `PUT /projects/:id/gitlab` через curl                            | **Edit Project → GitLab Issue-to-MR → Connect**                    |
| `PATCH /projects/:id/auto-queue-mode`                            | **Create/Edit Project → Auto-Queue Mode** (переключатель)          |
| `POST /projects/:id/gitlab/sync`                                 | **Edit Project → GitLab Issue-to-MR → Sync now**                   |
| `docker compose ... exec agent git ...`                          | `git -C <LOCAL_ROOT> ...` (на хосте)                               |
| `docker compose ... logs -f agent`                               | терминал с `npm run dev`                                           |

Единственные места, где GUI не заменяет CLI/`.env`:

1. **`.env`** — секреты (`GITLAB_TOKEN`, `OPENAI_API_KEY`) и флаги включения
   (`GIT_PROVIDER`, `AIF_GITLAB_ISSUE_MR_ENABLED`). GUI хранит только имена env-переменных.
2. **git remote + credentials** — настраиваются **автоматически** агентом при
   **Connect / Sync now** (шаг 4.2–4.4); вручную нужны только если вы отключили
   автоматику или используете SSH-кредиты.

---

## Приложение Б — Траблшутинг

| Симптом                                             | Причина / что смотреть                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curl :3009` не отвечает                            | Процесс `api` не поднялся; смотрите вывод `npm run dev`.                                                                                                                                                                                                   |
| Блок **GitLab Issue-to-MR** не виден в Edit Project | `GIT_PROVIDER` ≠ `gitlab` или `AIF_GITLAB_ISSUE_MR_ENABLED=false`, либо `npm run dev` не перезапущен после правки `.env`.                                                                                                                                  |
| **Connect** → ошибка `gitlab_authentication`        | `GITLAB_TOKEN` не задан/неверен; у PAT нет скоупа `api`.                                                                                                                                                                                                   |
| **Connect** → ошибка `gitlab_forbidden`             | Токен валиден, но GitLab вернул `insufficient_granular_scope` — у fine-grained PAT нет `Project: Read` (или роли Developer) на целевом проекте. Используйте классический PAT со скоупами `api` + `write_repository`, либо выдайте fine-grained разрешения. |
| **Connect** → ошибка `gitlab_upstream` (502)        | Сетевой сбой при вызове GitLab API: чаще всего транзиентный DNS (`getaddrinfo EAI_AGAIN`). GitLab-клиент теперь ретраит такие ошибки автоматически; если повторяется — проверьте сеть/DNS хоста (VPN, корпоративный DNS).                                  |
| **Validate** → ошибка                               | router.ai недоступен/несовместим с Codex-протоколом; неверный ключ; модель без tool use.                                                                                                                                                                   |
| Задача застряла в `backlog`                         | Не включена авто-очередь (**Auto-Queue Mode**, шаг 6).                                                                                                                                                                                                     |
| `git push` в логах агента падает                    | Нет credential-helper (шаг 4.3) или SSH-ключей; `GITLAB_TOKEN` не в окружении `npm run dev`; у PAT нет `write_repository`; роль ниже Developer.                                                                                                            |
| Ветка задачи не появляется на gitlab.com            | Смотрите логи агента: ошибка будет `StageManualBlockError("GitLab branch push failed...")`.                                                                                                                                                                |
| MR не создаётся                                     | Проверьте, что ветка запушена, а `defaultBranch` репозитория — `main`.                                                                                                                                                                                     |
| MR создан, но diff огромный                         | Локальный репозиторий не зеркалирован с gitlab.com (шаг 4.4).                                                                                                                                                                                              |
| Задача не переходит в `verified` после merge        | Дождитесь синхронизации (≤ 60 с) или нажмите **Sync now**; проверьте, что MR действительно `merged`, а не `closed`.                                                                                                                                        |
| **502 Bad Gateway** в Web UI при старте dev         | Нативный модуль `better-sqlite3` несовместим с текущим Node; выполните `npm rebuild better-sqlite3`.                                                                                                                                                       |

---

## Приложение В — Где это в коде (для проверяющего)

| Что                                                        | Файл                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Диалог Create/Edit Project, GitLab Issue-to-MR, Auto-Queue | `packages/web/src/components/project/ProjectSelector.tsx`                               |
| Global Settings (профили + app-дефолты + MCP + config)     | `packages/web/src/components/layout/GlobalSettingsDialog.tsx`                           |
| Форма runtime-профиля (поля + Validate)                    | `packages/web/src/components/settings/RuntimeProfileForm.tsx`                           |
| Project-scope профили и дефолты (кнопка RUNTIME)           | `packages/web/src/components/project/ProjectRuntimeSettings.tsx`                        |
| Dev-лаунчер (`npm run dev`, чтение `.env`)                 | `scripts/dev.mjs`                                                                       |
| Ветки, base pull, создание feature-ветки                   | `packages/shared/src/gitIsolation.ts` (`ensureFeatureBranch`)                           |
| Синхронизация + импорт Issue + переходы статусов           | `packages/api/src/routes/gitlab.ts`                                                     |
| GitLab REST-клиент (approvals, statuses, MR, notes)        | `packages/api/src/services/gitlab.ts`                                                   |
| Push ветки + публикация MR из агента                       | `packages/agent/src/gitlabWorkflow.ts` (`publishGitLabTask`, `SYNC_INTERVAL_MS=60_000`) |
| Пайплайн стадий                                            | `packages/agent/src/coordinator.ts` (`PIPELINE`, авто-очередь)                          |
| Авто-ревью гейт                                            | `packages/agent/src/reviewGate.ts`                                                      |
| Импорт задачи (autoMode/backlog)                           | `packages/data/src/gitlab.ts` (`importGitLabIssueTask`)                                 |
| Env-переменные                                             | `packages/shared/src/env.ts`                                                            |
| Codex CLI transport (env-курирование, key opt-in)          | `packages/runtime/src/adapters/codex/cli.ts`                                            |

---

## See Also

- [GitLab Demo](gitlab-demo.md) — тот же сценарий в прод-Docker-окружении с настройкой через curl
- [Providers](providers.md) — адаптеры рантайма, транспорт CLI и профили
- [Configuration](configuration.md) — переменные окружения (GIT_PROVIDER, GITLAB_TOKEN, CODEX_BASE_URL)
