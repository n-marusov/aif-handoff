[← MCP Sync](mcp-sync.md) · [Back to README](../README.md) · [Dev GUI Demo →](dev-gui-demo.md)

# Демонстрационный сценарий: GitLab.com + router.ai (полный цикл «Issue → MR»)

> **Цель демо:** показать, как AIF Handoff в автономном режиме забирает задачу из Issue
> на gitlab.com, самостоятельно планирует, реализует и ревьюит её (через router.ai),
> публикует Merge Request в репозиторий и доводит задачу до статуса `verified` после
> того, как человек одобрил и смёрджил MR.
>
> **Окружение:** прод-стек в `docker-compose.production.yml`, LLM-бэкенд — router.ai
> (OpenAI-совместимый), репозиторий — gitlab.com.
>
> **Формат шагов:** `Действие` → `Смысл` → `Проверяемый результат`. Никаких скрытых
> шагов: всё, что нужно сделать «руками», перечислено явно.

```
┌────────────┐   Issue    ┌───────────┐   sync 60s   ┌────────────────┐
│  gitlab.com│───────────▶│  AIF API  │◀─────────────│  AIF Agent     │
│  (Issues)  │            │  :3009    │              │  (координатор) │
└────────────┘            └─────┬─────┘              └───────┬────────┘
        ▲                       │                            │
        │      MR / push        │                            │ router.ai
        └───────────────────────┼────────────────────────────┘ (Codex CLI)
                                 │
                          ┌──────▼──────┐
                          │  Web UI     │
                          │  :80        │  ← человек видит задачи и MR
                          └─────────────┘
```

**Что делает человек по ходу демо (только 4 действия):**

1. Создаёт Issue на gitlab.com.
2. Проверяет/запускает синхронизацию (или ждёт 60 с).
3. Открывает Web UI и следит за прогрессом задачи.
4. Одобряет и мерджит MR.

Всё остальное делает система.

---

## 0. Подготовка (входные данные)

| Что                                       | Как получить / какой формат                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Репозиторий на gitlab.com                 | Готовый репозиторий с веткой по умолчанию `main` (не пустой — например, README). Путь: `NAMESPACE/PROJECT` (вложенные группы поддерживаются: `group/subgroup/project`).                          |
| Personal Access Token (PAT)               | GitLab → _Settings → Access Tokens_. Скоупы: **`api`** (REST: issues, MR, approvals) + **`write_repository`** (git push). Роль на репозитории — не ниже Developer.                               |
| router.ai: base URL                       | OpenAI-совместимый endpoint, например `https://<tenant>.router.ai/v1` — точное значение из личного кабинета router.ai.                                                                           |
| router.ai: модель                         | ID модели с поддержкой **function calling / tool use** (иначе пайплайн планирования/реализации не отработает).                                                                                   |
| router.ai: API key                        | Секретный ключ из личного кабинета.                                                                                                                                                              |
| **Предусловие (не проверяется системой)** | router.ai должен быть совместим с протоколом Codex CLI (transport `cli`), а модель — поддерживать tool use. Проверка связи делается на шаге 3; если она не пройдена, демо останавливается здесь. |

> Дальше `<NAMESPACE>`, `<PROJECT>`, `<profile-id>`, `<project-id>` — плейсхолдеры,
> которые нужно заменить реальными значениями, полученными по ходу шагов.

---

## Шаг 1 — Файл `.env`

**Действие.** В корне проекта `aif-handoff` создайте (или дополните) файл `.env`:

```dotenv
# ── GitLab ──────────────────────────────────────────────
GIT_PROVIDER=gitlab
AIF_GITLAB_ISSUE_MR_ENABLED=true
AIF_GITLAB_BASE_URL=https://gitlab.com/api/v4
GITLAB_TOKEN=<PAT: api + write_repository>

# ── router.ai (OpenAI-совместимый) через локальный Codex ──
OPENAI_API_KEY=<router.ai key>
OPENAI_MODEL=<router.ai model id>
CODEX_BASE_URL=<router.ai base URL>

# ── Режим работы ────────────────────────────────────────
AGENT_USE_SUBAGENTS=false

# ── Автоматический посев runtime-профиля (шаги 3.1+3.3) ──
# Профиль router.ai и app-wide дефолты создадутся сами при старте API
# (см. шаг 3.1). Шаг 3.2 (validate) всё равно нужен — это стоп-кран.
AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED=true
```

**Смысл.**

| Переменная                                   | Что делает                                                                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GIT_PROVIDER=gitlab`                        | Селектор провайдера репозитория. Режим GitLab активен **только** когда `GIT_PROVIDER=gitlab` **и** `AIF_GITLAB_ISSUE_MR_ENABLED=true`. По умолчанию `github` — без этой строки GitLab-режим не включится. |
| `AIF_GITLAB_ISSUE_MR_ENABLED=true`           | Ролл-аут-флаг GitLab Issue→MR. Без него роуты GitLab отдают `403 feature_disabled`, и агент ничего не синхронизирует.                                                                                     |
| `AIF_GITLAB_BASE_URL`                        | Базовый URL REST API v4 (переопределяется только для self-hosted инстансов).                                                                                                                              |
| `GITLAB_TOKEN`                               | PAT; читается из окружения контейнера (передаётся через `env_file`), используется и REST-клиентом, и credential-helper для git push.                                                                      |
| `OPENAI_API_KEY`                             | Ключ router.ai. Codex-адаптер берёт его по имени переменной, указанному в профиле (`apiKeyEnvVar=OPENAI_API_KEY`).                                                                                        |
| `OPENAI_MODEL`                               | Модель по умолчанию для Codex (используется и при авто-посеве профиля).                                                                                                                                   |
| `CODEX_BASE_URL`                             | Base URL для локальных транспортов Codex (SDK/CLI/App Server). При авто-посеве становится `baseUrl` профиля.                                                                                              |
| `AGENT_USE_SUBAGENTS=false`                  | Skills-режим: у Codex нет нативных agent definitions, поэтому запускаем саб-агентов как навыки.                                                                                                           |
| `AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED=true` | Включает авто-посев глобального профиля при старте API. Подробности — в шаге 3.1.                                                                                                                         |

**Проверяемый результат.** Контейнеры ещё не запущены (они поднимутся на шаге 2), поэтому проверяем сам файл `.env` на хосте:

```bash
grep -E '^(GIT_PROVIDER|AIF_GITLAB_ISSUE_MR_ENABLED|GITLAB_TOKEN|OPENAI_API_KEY|OPENAI_MODEL|CODEX_BASE_URL|AGENT_USE_SUBAGENTS|AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED)=' .env
# → все 8 строк присутствуют и непустые
```

> Проверка внутри контейнера — на шаге 2, после запуска стека:
> `docker compose -f docker-compose.production.yml exec api printenv GIT_PROVIDER` → `gitlab`.

---

## Шаг 2 — Сборка и запуск прод-композа

**Действие.**

```bash
cd aif-handoff
docker compose -f docker-compose.production.yml build
docker compose -f docker-compose.production.yml up -d
```

**Смысл.** Собирает 4 сервиса (`api`, `web`, `agent`, `mcp`) и запускает их в фоне.
Первый билд долгий (установка зависимостей + сборка пакетов). Контейнеры `api` и `agent`
читают `.env` автоматически (`env_file: .env`).

**Проверяемый результат.**

```bash
docker compose -f docker-compose.production.yml ps
# все сервисы Up, api/web/mcp — (healthy)
```

Проверка, что `.env` подхватился контейнером:

```bash
docker compose -f docker-compose.production.yml exec api printenv GIT_PROVIDER
# → gitlab
docker compose -f docker-compose.production.yml exec api printenv AIF_GITLAB_ISSUE_MR_ENABLED
# → true
```

Health-проверки (у каждого сервиса свой порт):

```bash
curl -s http://localhost:3009/health   # API (Hono) → JSON-ответ об успехе
curl -s http://localhost:3100/health   # MCP HTTP → JSON-ответ об успехе
curl -s http://localhost/health        # Web (Angie :80) → SPA (index.html, HTTP 200)
```

> ⚠️ **Web на `:80` отдаёт SPA напрямую для localhost/127.0.0.1** — это сделано
> специально: для `DOMAIN=localhost` Let's Encrypt не выдаёт сертификат, поэтому
> HTTPS на `:443` локально недоступен, и редирект `:80 → https` увёл бы в тупик.
> Открывайте Web UI по адресу `http://localhost/` (порт 80).
> Для реального домена (`DOMAIN=example.com`) Angie форсирует HTTPS:
> `:80` → `301 https://$host$request_uri`, а контейнерный healthcheck проверяет
> `HTTP/1.1 200` на `127.0.0.1:80` (netcat-проба, см. патч `2026-08-14-web-healthcheck-ipv6.md`).

Порт `:80` — Web UI. Дополнительно задеплоен HTTPS `:443`.

---

## Шаг 3 — Профиль рантайма для router.ai + проверка связи

### 3.1. Создать runtime-профиль (авто-посев при старте API)

**Действие.** Профиль уже создан — при старте API (шаг 2) сработал env-bootstrap:

```bash
# Профиль создаётся сам при старте API; проверяем, что он на месте:
curl -s http://localhost:3009/runtime-profiles | grep -o '"name":"Bootstrap (Codex CLI)"'
# → "name":"Bootstrap (Codex CLI)"

# ID профиля — из настроек (он же назначен дефолтом для всех стадий):
curl -s http://localhost:3009/settings | grep -o '"resolvedDefaultTaskRuntimeProfileId":"[^"]*"'
# → "resolvedDefaultTaskRuntimeProfileId":"<profile-id>"
```

Запомните `<profile-id>` (используется ниже только для справки — дефолты уже назначены).

**Смысл.** Если в `.env` задан `AIF_BOOTSTRAP_RUNTIME_PROFILE_ENABLED=true` (Шаг 1), API при
старте вызывает `seedBootstrapRuntimeProfile()` (`packages/api/src/services/profileBootstrap.ts`)
и автоматически:

- создаёт **глобальный** профиль `Bootstrap (Codex CLI)` (`runtimeId=codex`, `providerId=openai`, `transport=cli`, `apiKeyEnvVar=OPENAI_API_KEY`);
- `baseUrl` профиля наследуется из `AIF_BOOTSTRAP_BASE_URL` → `CODEX_BASE_URL`, модель — из `AIF_BOOTSTRAP_DEFAULT_MODEL` → `OPENAI_MODEL`;
- назначает профиль app-wide дефолтом для task/plan/review/chat (это заменяет ручной шаг 3.3);
- повторные старты идемпотентны: профиль с тем же именем не дублируется; `AIF_BOOTSTRAP_FORCE_UPDATE=true` включает upsert из env;
- в БД хранится только **имя** env-переменной ключа, не само значение.

Ключевые поля профиля (важно понимать независимо от способа создания):

- `runtimeId: "codex"` — адаптер Codex;
- `transport: "cli"` — локальный агентный транспорт. ⚠️ НЕ `api`: API-транспорт Codex — это разовый вызов `/chat/completions` без tool-calling и не может вести пайплайн «планирование → реализация → ревью»;
- `baseUrl` — endpoint router.ai (в профиле имеет приоритет над `CODEX_BASE_URL`);
- `apiKeyEnvVar: "OPENAI_API_KEY"` — имя переменной, из которой берётся ключ.

**Проверяемый результат.** Профиль присутствует в `GET /runtime-profiles`,
`resolvedDefaultTaskRuntimeProfileId` в `GET /settings` непустой.

> 💡 **Без авто-посева (флаг выключен)** — создать профиль вручную:
> `POST /runtime-profiles` с телом `{ "name":"router.ai (Codex CLI)", "runtimeId":"codex", "providerId":"openai", "transport":"cli", "baseUrl":"<router.ai base URL>", "apiKeyEnvVar":"OPENAI_API_KEY", "defaultModel":"<router.ai model id>", "enabled":true }` → HTTP `201` с полем `id`. Тогда ручной шаг 3.3 тоже остаётся обязательным.

### 3.2. Проверить связь с router.ai

**Действие.**

```bash
curl -s -X POST http://localhost:3009/runtime-profiles/validate \
  -H "Content-Type: application/json" \
  -d '{ "profile": { "runtimeId":"codex", "providerId":"openai", "transport":"cli", "baseUrl":"<router.ai base URL>", "apiKeyEnvVar":"OPENAI_API_KEY", "defaultModel":"<router.ai model id>" } }'
```

**Смысл.** Реальная проверка подключения к LLM: коннект к endpoint, список моделей,
проверка ключа. Это самый ранний «стоп-кран» демо.

**Проверяемый результат.**

```json
{ "ok": true, "message": "...", "details": {...} }
```

Если `ok: false` — router.ai недоступен, несовместим с Codex-протоколом или ключ неверный.
**Демо останавливается здесь** — дальше идти не нужно, пока связь не поднимется.

### 3.3. Назначить профиль по умолчанию (автоматически при авто-посеве)

**Действие.** Дефолты уже назначены авто-посевом — проверяем:

```bash
curl -s http://localhost:3009/settings/runtime-defaults
# → "resolvedDefaultTaskRuntimeProfileId": "<profile-id>",
#    "resolvedDefaultPlanRuntimeProfileId": "<profile-id>",
#    "resolvedDefaultReviewRuntimeProfileId": "<profile-id>",
#    "resolvedDefaultChatRuntimeProfileId": "<profile-id>"
```

**Смысл.** При `AIF_BOOTSTRAP_SET_DEFAULTS=true` (по умолчанию) авто-посев сам
назначает созданный профиль дефолтом для всех стадий пайплайна (планирование,
реализация, ревью) и чата — отдельный ручной шаг не нужен.

**Проверяемый результат.** Все `resolvedDefault*RuntimeProfileId` = `<profile-id>`.

> 💡 **Без авто-посева** — назначить вручную:
> `PUT /settings/runtime-defaults` с телом `{ "defaultTaskRuntimeProfileId":"<profile-id>", "defaultPlanRuntimeProfileId":"<profile-id>", "defaultReviewRuntimeProfileId":"<profile-id>", "defaultChatRuntimeProfileId":"<profile-id>" }` → HTTP `200`, в ответе все `resolvedDefault*RuntimeProfileId` = `<profile-id>`.

### 3.4. Готовность системы

**Действие.**

```bash
curl -s http://localhost:3009/settings
```

**Смысл.** Обзор настроек; блок `runtimeReadiness` показывает, что адаптеры
зарегистрированы и есть включённый профиль.

**Проверяемый результат.** В ответе:

```json
"runtimeReadiness": { "availableRuntimeCount": 4, "runtimeProfileCount": 1, "enabledRuntimeProfileCount": 1 }
```

(`availableRuntimeCount` — число зарегистрированных встроенных адаптеров: Claude, Codex, OpenCode, OpenRouter) и `"gitProvider": "gitlab"`, `"gitlabIssueMrEnabled": true`.

> ⚠️ Примечание. В RESEARCH.md упоминался `GET /agent/readiness` — **такого роута нет**.
> Его заменяют две проверки: `POST /runtime-profiles/validate` (связь с LLM) и
> `GET /settings` (блок `runtimeReadiness`). Подробнее — в Приложении А.

---

## Шаг 4 — Проект + git remote

### 4.1. Создать проект

**Действие.**

```bash
curl -s -X POST http://localhost:3009/projects \
  -H "Content-Type: application/json" \
  -d '{ "name":"demo", "rootPath":"/home/www/demo" }'
```

**Смысл.** Создаёт запись проекта в БД и инициализирует директорию `/home/www/demo`
(том `projects`):

- `git init` + начальный коммит `"init: project scaffold"` (пустой);
- `ai-factory init` — скаффолд `.ai-factory/` в корне проекта.

⚠️ **Важно понимать:** локальный репозиторий — **не клон** gitlab.com. Это отдельный
рабочий репозиторий, из которого агент пушит ветки в `origin`. Содержимое ветки `main`
на gitlab.com он не видит (поэтому ниже — рекомендуемый шаг 4.4 «зеркалирование»).

**Проверяемый результат.** HTTP `201`, в ответе — проект с полем `id`.
Запомните его как `<project-id>`. Проверка локального репозитория:

```bash
docker compose -f docker-compose.production.yml exec agent git -C /home/www/demo status
# → на ветке main (или master), работает чисто
```

### 4.2. Настроить origin

**Действие.**

```bash
docker compose -f docker-compose.production.yml exec agent git -C /home/www/demo remote add origin https://gitlab.com/<NAMESPACE>/<PROJECT>.git
```

**Смысл.** Подключает gitlab.com как удалённый репозиторий, в который агент будет
пушить ветки задач.

**Проверяемый результат.** Команда завершается без ошибок (пустой вывод = успех).

### 4.3. Настроить credential-helper для неинтерактивного push

**Действие.**

```bash
docker compose -f docker-compose.production.yml exec agent git -C /home/www/demo config credential.helper '!f() { echo username=GITLAB_USERNAME; echo password=$GITLAB_TOKEN; }; f'
```

**Смысл.** git не должен спрашивать логин/пароль при `git push`. Helper берёт токен из
переменной окружения `$GITLAB_TOKEN` (она есть в контейнере агента через `env_file: .env`).
Логин (`username=...`) GitLab.com при PAT-авторизации игнорирует — важна только
последовательность «логин:токен».

**Проверяемый результат.**

```bash
docker compose -f docker-compose.production.yml exec agent git -C /home/www/demo remote -v
# → origin  https://gitlab.com/<NAMESPACE>/<PROJECT>.git (fetch)
# → origin  https://gitlab.com/<NAMESPACE>/<PROJECT>.git (push)
```

### 4.4. (Рекомендуется) Синхронизировать локальный репозиторий с main gitlab.com

**Действие.**

```bash
docker compose -f docker-compose.production.yml exec agent sh -c 'cd /home/www/demo && git fetch origin && git checkout -B main origin/main'
```

**Смысл.** Заменяет пустой скаффолд-репозиторий содержимым реального `main` с gitlab.com.
Тогда ветка задачи создаётся от настоящего кода, а MR показывает **только** изменения
задачи, а не «новый файл в пустом репозитории». Агент сам делает `git pull --ff-only
origin main` перед созданием ветки — но в нестрогом режиме сбой этого pull является
best-effort (предупреждение в логах, работа продолжается с локальной базы). Зеркалирование
делает демо детерминированным.

**Проверяемый результат.**

```bash
docker compose -f docker-compose.production.yml exec agent sh -c 'cd /home/www/demo && git log --oneline -1'
# → последний коммит вашего main на gitlab.com
```

> ⚠️ Про чистоту MR: `ai-factory init` создаёт в корне `.ai-factory/` (не входит в
> глобальный `.gitignore`). Если задача «закоммитит всё» (`git add -A`), скаффолд-файлы
> могут попасть в MR. Для чистого демо либо добавьте `.ai-factory/` в `.gitignore`
> репозитория, либо дайте задачу, которая добавляет только свой файл.

---

## Шаг 5 — Подключение GitLab-репозитория

**Действие.**

```bash
curl -s -X PUT http://localhost:3009/projects/<project-id>/gitlab \
  -H "Content-Type: application/json" \
  -d '{ "repository":"<NAMESPACE>/<PROJECT>", "tokenEnvVar":"GITLAB_TOKEN", "enabled":true, "eligibility":{"labels":[],"assignee":null,"milestone":null} }'
```

**Смысл.** Сохраняет связку «локальный проект ↔ репозиторий gitlab.com». При этом:

- вызывается GitLab API (`GET /projects/<ns>/<project>`) — токен из `GITLAB_TOKEN` должен быть валиден и иметь скоуп `api`; иначе `400 gitlab_authentication` (нет/неверен токен) или `403 gitlab_forbidden` (недостаточно скоупов/прав, GitLab: `insufficient_granular_scope`);
- фиксируются `namespace`, `name`, `defaultBranch`, `webUrl`;
- `eligibility` — фильтр входящих Issues (пустой = берутся все открытые);
- без включённого флага (шаг 1) и `GIT_PROVIDER=gitlab` роут отдал бы `403 feature_disabled`.

**Проверяемый результат.** HTTP `200`, в ответе — запись подключения
(`namespace`, `name`, `defaultBranch: "main"`, `enabled: true`). Подтверждение:

```bash
curl -s http://localhost:3009/projects/<project-id>/gitlab
# → { "connection": {...}, "issues": [] }
```

---

## Шаг 6 — Включить авто-очередь (auto-queue) — обязательный шаг

**Действие.**

```bash
curl -s -X PATCH http://localhost:3009/projects/<project-id>/auto-queue-mode \
  -H "Content-Type: application/json" \
  -d '{ "enabled": true }'
```

**Смысл.** Импортированная из Issue задача попадает в статус `backlog` с `autoMode=true`,
но координатор **двигает дальше только проекты с `autoQueueMode=true`**. Без этого шага
задача навсегда останется в `backlog`. (В RESEARCH.md этот шаг пропущен — см. Приложение А.)

**Проверяемый результат.**

```bash
curl -s http://localhost:3009/projects/<project-id>/auto-queue-mode
# → { "enabled": true }
```

---

## Шаг 7 — Issue → задача

**Действие.**

1. Создайте на gitlab.com открытый Issue с осмысленным описанием задачи.
   Рекомендация для чистого демо: задача «добавить файл» или «добавить README-секцию» —
   что-то, что реализуется одним-двумя коммитами без внешних зависимостей.
   Пример: _«Добавить файл CHANGELOG-DEMO.md в корень репозитория с описанием
   демонстрационного релиза»_.
2. Запустите синхронизацию вручную (не ждать 60 с):

```bash
curl -s -X POST http://localhost:3009/projects/<project-id>/gitlab/sync \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Смысл.** Синхронизация забирает все открытые Issues репозитория, прошедшие
`eligibility`, и импортирует их как задачи:
`autoMode=true`, `executionOwner="ai"`, статус `backlog`, в заголовке карточки — `#<iid> <title>`.
Синхронизация идемпотентна: повторный запуск не создаёт дубликатов (в ответе `imported: 0`).

**Проверяемый результат.**

```json
{ "imported": 1, "updated": 0, "skipped": 0, "issues": [ ... ] }
```

И в Web UI (`http://localhost/`): на доске появилась карточка с бейджем `GITLAB`,
статус `backlog`. Запускать её вручную не нужно — авто-очередь (шаг 6) подхватит её
в течение ближайшего цикла поллинга (30 с).

---

## Шаг 8 — Пайплайн → MR

**Действие.** Наблюдайте за прогрессом:

```bash
docker compose -f docker-compose.production.yml logs -f agent
```

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
- `reviewer` прогоняет автоматическое ревью (стратегия по умолчанию `full_re_review`) и снова публикует MR. Исход ревью: `accepted` → `done`, `rework_requested` → возврат в `implementing`, `manual_review_required` → передача человеку.

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
4. Дождитесь следующего цикла синхронизации (≤ 60 с) — можно ускорить вручную:

```bash
curl -s -X POST http://localhost:3009/projects/<project-id>/gitlab/sync -H "Content-Type: application/json" -d '{}'
```

**Смысл.** Агент видит `mrState: "merged"` и переводит задачу `done → verified`.
Слияние всегда выполняет человек — система никогда не мерджит сама.

Сводка переходов при синхронизации (из кода `routes/gitlab.ts`):
| Состояние MR на gitlab.com | Действие системы |
| -------------------------- | ---------------- |
| `merged` + задача `done` | задача → `verified` |
| `closed` | задача → `paused` |
| `open` | ждёт человека (никаких изменений статуса) |
| MR «Closes #<iid>» найден у задачи в `backlog` | задача → `done` (задача уже реализована) |

**Проверяемый результат.** В Web UI задача получила статус `verified`.
В `GET /projects/<project-id>/gitlab` у Issue заполнены `mrState: "merged"` и `reviewState: "approved"`.

---

## Шаг 10 — Приёмка (контрольный список)

| #   | Проверка                                    | Ожидание                                                                                                                          |
| --- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `curl -s http://localhost:3009/health`      | сервис жив                                                                                                                        |
| 2   | `POST /runtime-profiles/validate` (шаг 3.2) | `{ "ok": true }` — router.ai совместим и поддерживает tool use                                                                    |
| 3   | `GET /settings` → `runtimeReadiness`        | `availableRuntimeCount ≥ 1`, `enabledRuntimeProfileCount = 1`; `runtimeDefaults.app.resolvedDefaultTaskRuntimeProfileId` непустой |
| 4   | Повторный `POST /projects/:id/gitlab/sync`  | `imported: 0` — импорт идемпотентен, дубликатов нет                                                                               |
| 5   | Задача в Web UI                             | прошла `backlog → ... → done` без ручного старта                                                                                  |
| 6   | MR на gitlab.com                            | в `main`, описание начинается с `Closes #<iid>`                                                                                   |
| 7   | После Approve + Merge                       | задача → `verified`                                                                                                               |
| 8   | Логи агента                                 | нет `StageManualBlockError`, `gitlab_*` ошибок, ошибок аутентификации                                                             |

---

## Сводная таблица «Действие → Смысл → Результат»

| Шаг | Действие                                                         | Смысл                                            | Проверяемый результат                                                                                      |
| --- | ---------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 1   | Заполнить `.env`                                                 | Включить GitLab-режим + router.ai + skills-режим | `printenv GIT_PROVIDER` → `gitlab`                                                                         |
| 2   | `docker compose -f docker-compose.production.yml build && up -d` | Поднять прод-стек                                | `ps` → все `Up`, health-проверки проходят                                                                  |
| 3   | Авто-посев профиля (`.env` + старт API), validate                | Подключить router.ai как LLM                     | `validate` → `{ok:true}`; профиль `Bootstrap (Codex CLI)` в `GET /runtime-profiles`; дефолты в `/settings` |
| 4   | POST `/projects`, remote add, credential helper                  | Рабочий репозиторий + origin                     | `remote -v` показывает gitlab.com; `git log` — ваш main (после 4.4)                                        |
| 5   | PUT `/projects/:id/gitlab`                                       | Связать проект с репозиторием                    | `GET /projects/:id/gitlab` → `connection` с `defaultBranch: main`                                          |
| 6   | PATCH `/projects/:id/auto-queue-mode`                            | Разрешить авто-продвижение задач                 | `{ enabled: true }`                                                                                        |
| 7   | Создать Issue + `POST .../gitlab/sync`                           | Импортировать Issue как задачу                   | `imported: 1`; карточка `GITLAB #<iid>` в `backlog`                                                        |
| 8   | Наблюдать `logs -f agent`                                        | Пайплайн планирования/реализации/ревью           | Задача прошла до `done`; MR `Closes #<iid>` в gitlab.com                                                   |
| 9   | Approve + Merge на gitlab.com                                    | Человек принимает решение                        | Задача `verified`                                                                                          |
| 10  | Контрольный список                                               | Приёмка                                          | все пункты зелёные                                                                                         |

---

## Тайминги (что и когда происходит)

| Событие                                    | Задержка                                           |
| ------------------------------------------ | -------------------------------------------------- |
| Синхронизация Issues (агент → API)         | каждые **60 с** (`SYNC_INTERVAL_MS`)               |
| Поллинг координатора (новая стадия задачи) | каждые **30 с** (`POLL_INTERVAL_MS`, по умолчанию) |
| Вручную запустить синхронизацию            | `POST /projects/:id/gitlab/sync` — мгновенно       |
| От `done` до `verified` после merge        | ≤ 60 с (следующая синхронизация)                   |

---

## Приложение А — Расхождения с `RESEARCH.md` (проверено по коду)

Документ собран на основе runbook из `.ai-factory/RESEARCH.md`, но в runbook было
несколько неточностей/пропусков, которые здесь исправлены:

1. **`GET /agent/readiness` не существует.** В API (Hono) такого роута нет
   (`packages/api/src/index.ts` монтирует только `/auth`, `/participants`, `/projects`,
   `/tasks`, `/chat`, `/settings`, `/runtime-profiles`, `/auth/codex`).
   Реальная проверка готовности LLM — `POST /runtime-profiles/validate`
   (`routes/runtimeProfiles.ts`, `{ ok: boolean, message, details, profile }`),
   а состояние системы — `GET /settings` (блок `runtimeReadiness`).
2. **Пропущен обязательный шаг: включение авто-очереди.**
   Импортированная задача приходит с `autoMode=true`, но координатор продвигает из
   `backlog` только проекты с `autoQueueMode=true` (`listAutoQueueProjects` фильтрует по
   `projects.autoQueueMode`). Без `PATCH /projects/:id/auto-queue-mode {"enabled":true}`
   задача застревает в backlog. → Шаг 6.
3. **Локальный репозиторий — не клон.** `POST /projects` создаёт `/home/www/demo` как
   пустой git-репозиторий с коммитом `"init: project scaffold"` и скаффолдом `.ai-factory/`
   (`initProject` → `initBaseProjectDirectory` + `ai-factory init`). Содержимое `main` с
   gitlab.com локально не видно. Для детерминированного демо рекомендуется зеркалирование
   (шаг 4.4); сам пайплайн работает и без него, т.к. `git pull --ff-only origin main`
   в нестрогом режиме — best-effort.
4. **`CODEX_BASE_URL` и `GITLAB_TOKEN` не валидируются env-схемой** — они читаются
   нижележащими слоями (Codex app-server: `buildCodexAppServerEnvWithStats` → `CODEX_BASE_URL`;
   GitLab API-клиент: `tokenFor()` → `process.env[tokenEnvVar]`). Поэтому их отсутствие не
   «упадёт» при старте, но связь не заработает. Обе переменные должны быть в `.env`.
5. **Пайплайн в skills-режиме.** Стадии `improve` и `verify` — опциональные и включаются
   только флагами задачи (`runPlanImprove`, `runPostVerify`); в демо стандартный маршрут
   `planning → plan_ready → implementing → review → done`.

---

## Приложение Б — Траблшутинг

| Симптом                                                  | Причина / что смотреть                                                                                                                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curl :3009` не отвечает                                 | Контейнер `api` не поднялся; `docker compose ... logs api`.                                                                                                                                               |
| GitLab-роуты отдают `403 feature_disabled`               | `GIT_PROVIDER` ≠ `gitlab` или `AIF_GITLAB_ISSUE_MR_ENABLED=false` (шаг 1), либо контейнер не перезапущен после правки `.env`.                                                                             |
| `PUT /projects/:id/gitlab` → `400 gitlab_authentication` | `GITLAB_TOKEN` не задан/неверен; у PAT нет скоупа `api`.                                                                                                                                                  |
| `PUT /projects/:id/gitlab` → `403 gitlab_forbidden`      | Токен валиден, но GitLab вернул `insufficient_granular_scope` — у PAT нет скоупа `api` (или роли Developer) на целевом проекте. Проверьте скоупы токена и доступ к `NAMESPACE/PROJECT`.                   |
| `PUT /projects/:id/gitlab` → `502 gitlab_upstream`       | Неожиданный сетевой сбой при вызове GitLab API: чаще всего транзиентный DNS (`getaddrinfo EAI_AGAIN gitlab.com`) — повторите запрос; если повторяется, проверьте сеть/DNS хоста (VPN, корпоративный DNS). |
| `validate` → `ok: false`                                 | router.ai недоступен/несовместим с Codex-протоколом; неверный ключ; модель без tool use.                                                                                                                  |
| Задача застряла в `backlog`                              | Не включена авто-очередь (шаг 6).                                                                                                                                                                         |
| `git push` в логах агента падает                         | Нет credential-helper (шаг 4.3); у PAT нет `write_repository`; роль ниже Developer.                                                                                                                       |
| Ветка задачи не появляется на gitlab.com                 | Смотрите `logs -f agent`: ошибка будет `StageManualBlockError("GitLab branch push failed...")`.                                                                                                           |
| MR не создаётся                                          | Проверьте, что ветка запушена, а `defaultBranch` репозитория — `main` (иначе укажите свой в `GET /projects/:id/gitlab`).                                                                                  |
| MR создан, но diff огромный                              | Локальный репозиторий не зеркалирован с gitlab.com (шаг 4.4).                                                                                                                                             |
| Задача не переходит в `verified` после merge             | Дождитесь синхронизации (≤ 60 с) или вызовите `POST .../gitlab/sync` вручную; проверьте, что MR действительно `merged`, а не `closed`.                                                                    |

---

## Приложение В — Где это в коде (для проверяющего)

| Что                                                 | Файл                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Ветки, base pull, создание feature-ветки            | `packages/shared/src/gitIsolation.ts` (`ensureFeatureBranch`)                           |
| Синхронизация + импорт Issue + переходы статусов    | `packages/api/src/routes/gitlab.ts`                                                     |
| GitLab REST-клиент (approvals, statuses, MR, notes) | `packages/api/src/services/gitlab.ts`                                                   |
| Push ветки + публикация MR из агента                | `packages/agent/src/gitlabWorkflow.ts` (`publishGitLabTask`, `SYNC_INTERVAL_MS=60_000`) |
| Пайплайн стадий                                     | `packages/agent/src/coordinator.ts` (`PIPELINE`, авто-очередь)                          |
| Авто-ревью гейт                                     | `packages/agent/src/reviewGate.ts`                                                      |
| Импорт задачи (autoMode/backlog)                    | `packages/data/src/gitlab.ts` (`importGitLabIssueTask`)                                 |
| Env-переменные                                      | `packages/shared/src/env.ts`                                                            |
| Compose-конфигурация (порты, тома, env_file)        | `docker-compose.production.yml`                                                         |
| Runbook-источник                                    | `.ai-factory/RESEARCH.md` → раздел «Runbook (final)»                                    |

---

## See Also

- [API Reference](api.md) — контракты GitLab Issue-to-MR и runtime-профилей
- [Configuration](configuration.md) — переменные окружения (GIT_PROVIDER, GITLAB_TOKEN, CODEX_BASE_URL)
- [Providers](providers.md) — адаптеры рантайма и профили
