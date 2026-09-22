# US + E2E Refactor Plan (что изменено и почему)

> Исполнительный документ рефакторинга среза «User Stories + E2E»: декомпозиция,
> контрактные фиксы, контурная изоляция и политика oracle-слоёв.
> Дата: 2026-09-21. Статус: исполнено (см. `FIX_PLAN.md` — P0/P1/P2 + workstream 4).

## 1. Что было разбито (US-декомпозиция)

История `US-integration.pr-mr.gitlab-issue-to-accepted` содержала 11 нумерованных +
13 негативных/граничных сценариев (A1–A13) — один «супер-файл» на весь жизненный цикл
GitLab Issue → MR → Accepted. Это перегружало историю и размывало границы oracle-слоёв.

**Разбита на 3 фокусированные истории:**

| Новая история                                       | Сценарии (прежние)                                  | Capability                                                                   | Primary layer          |
| --------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------- |
| `US-integration.pr-mr.gitlab-issue-shortcut-accept` | 10, 11, A8, A9                                      | `@core-e2e`                                                                  | API (state), GUI smoke |
| `US-integration.pr-mr.gitlab-plan-review`           | 3, 4, A1, A2, A3, A4                                | `@core-e2e` (детерминированный publish-plan), `@requires-llm` (approve-loop) | API                    |
| `US-integration.pr-mr.gitlab-pipeline-run`          | 1, 2, 5, 6, 7, 8, 9, A5, A6, A7, A10, A11, A12, A13 | `@core-e2e` (детерминированные части), `@requires-llm` (full loop L-10-full) | API                    |

**Совместимость:** прежний файл сохранён как алиас (якоря `1..11`, `A1..A13`
остаются валидными); в его шапке добавлена ссылка на новые истории. Таблица
«старый № → новая история/сценарий» ведётся в `docs/user-stories/README.md`
(секция Migration).

## 2. Что было исправлено в коде

### 2.1 P0.2 — контракт владения GitLab-импорта

- **Файл:** `packages/data/src/gitlab.ts` (`importGitLabIssueTask`).
- **Проблема:** импорт всегда создавал задачу с `executionOwner="ai"`, `autoMode=true`,
  игнорируя настройку проекта `autoQueueMode` (known-issue «GitLab shortcut executionOwner mismatch»).
- **Фикс:** владелец и `autoMode` определяются проектом на момент импорта:
  - `autoQueueMode=true` → `executionOwner="ai"`, `autoMode=true`;
  - `autoQueueMode=false` → `executionOwner="human"`, `autoMode=false`.
    Значение пишется и в `taskExecutorHistory`, и в `auditEvents.executionOwnerSnapshot`.
- **Следствие (семантика):** human-owned задачи исключены из auto-queue (существующее
  правило границы владения в `@aif/data`). Поэтому автономный контур требует включения
  `auto-queue-mode` **до** первого sync; иначе импортированная задача ожидает ручного
  старта. Это зафиксировано в US и в E2E.
- **Тесты:** `packages/data/src/__tests__/gitlab.test.ts` — 3 новых детерминированных
  теста (ai/autoMode=true, human/autoMode=false, executor-history/audit snapshot).
- **E2E-синхронизация:**
  - API `L-10c`: теперь ожидает `human` (проект создан без autoQueueMode);
  - API `L-10-full`, `L-10k`, GUI `L-10-full`: `auto-queue-mode` включается **до** sync;

### 2.2 P0.1 — контуры прогона `e2e:core` / `e2e:llm`

- **Проблема (Дефект A):** LLM-зависимые e2e падали `fail` (жёсткий assert
  в `ensureLlmRuntime`) при выключенном `AIF_LLM_INTEGRATION`, смешивая регрессии
  продукта с недоступностью интеграции.
- **Фикс:**
  - npm-таргеты: `e2e:core`, `e2e:llm` (root + `packages/web`), плюс `e2e:gui:llm` /
    `e2e:api:llm` с grep-фильтрами по тегу `@requires-llm`;
  - тесты L-10-full (GUI/API), L-10k (API) помечены `@requires-llm`;
  - `ensureLlmRuntime` → `test.skip(...)` (core-контур: пропуск с причиной);
  - fail-fast preflight `packages/web/scripts/e2e-llm-preflight.mjs` проверяет
    `AIF_LLM_INTEGRATION=1` + `runtimeReadiness.enabledRuntimeProfileCount > 0`;
  - `scripts/e2e-docker.mjs` поддержал режимы `--llm`, `--llm-gui`, `--llm-api`;
    Makefile добавил цель `e2e-llm`.

### 2.3 P1.1 — устойчивый branch-хелпер

- **Файл:** `packages/web/e2e/shared/gitlab.ts` (`createGitLabBranchWithCommit`).
- **Проблема (Дефект B):** helper получал HTTP 400 (ветка уже существует/гонка),
  без диагностики тела ответа.
- **Фикс:** pre-check существующей ветки (GET, 404 → создать); при 400 выполняется
  read-after-write проверка ветки (без ветвления по тексту сообщения): если ветка уже
  появилась, переиспользуется; иначе пробрасывается структурированная ошибка
  (`error`, `message`, `branch`, `ref`). После успешного POST — read-верификация.
  Helper возвращает эффективное имя ветки (`Promise<string>`); вызывающие спектры
  используют именно возвращённое значение.

### 2.4 P1.2 — worktree-гигиена e2e-корней

- **Файл:** `scripts/e2e-docker.mjs` (`cleanE2eTestRoots`, вызывается в `prepareStack`).
- **Проблема (Дефект C):** planner уходил в `blocked_external` из-за `dirty_worktree`
  (`?? .ai-factory/plans/`) в тестовых корнях.
- **Фикс:** перед прогоном удаляются `.ai-factory/` артефакты в эталонном проекте
  (`/home/www/vnc`) и изолированных корнях (`/home/www/e2e-*`); `git clean -fd` только
  по `.ai-factory`; явная проверка `git status --porcelain --untracked-files=no`
  с warning-диагностикой при грязном tracked-статусе (best-effort cleanup).

### 2.5 P1.3 / 4.3 — политика oracle-слоёв

- Зафиксирована матрица ответственности (Легенда в `us-e2e-trace-matrix.md`):
  API = state machine/владение/sync; GUI = UX/интерактив.
- В спекты добавлены primary-layer-аннотации (комментарии с US-ссылками).
- Полная таблица дубликатов и решений — `docs/qa/us-e2e-trace-matrix.md` §Duplicate oracles.

### 2.6 P2.1 — корреляция `traceId`/`testId`

- Новый хелпер `packages/web/e2e/shared/trace.ts` (`runTraceId()`, `testIdFor()`,
  `logTraceStep()`).
- В GitLab-спекты добавлены `[e2e:<testId>] [trace:<traceId>]` логи на ключевых шагах.
- Mapping «шаг ↔ лог-событие» — в `docs/qa/us-e2e-trace-matrix.md` §Correlation IDs.

## 3. Политика oracle-границ (ответственность слоёв)

| Аспект                                             | Слой                    | Примеры                                                                        |
| -------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| State machine, переходы, негативные сценарии       | API                     | `stateMachine` unit; `task-lifecycle`; `negative A`; `L-10j`                   |
| Владение (ownership, revision/CAS)                 | API                     | `handoff.spec.ts`; `L-10c` import ownership                                    |
| Семантика синхронизации VCS                        | API                     | `gitlab sync` routes; `L-10d` publish-plan                                     |
| Публикация/переиспользование MR (single-MR)        | API                     | `L-10d`, `L-10-full`                                                           |
| UX-поток, рендеринг, пользовательские действия     | GUI                     | доска/колонки/форма (`kanban-board`, `add-task-form`), детали (`task-details`) |
| UI-триггеры интеграций (connect/sync/merge кнопки) | GUI                     | `L-10`, `L-10b`                                                                |
| WS-события (получение и отображение)               | API primary / GUI smoke | `E2E-API-007`; `realtime.spec.ts`                                              |

## 4. Known-issues disposition (итог)

| Известная проблема                                       | Disposition                      | Где закрыта/учтена                                     |
| -------------------------------------------------------- | -------------------------------- | ------------------------------------------------------ |
| E2E GUI: нет композера комментариев                      | REFINE                           | Trace matrix (gap), остаётся открытой с классификацией |
| E2E GUI: US колонки ≠ статусы                            | REFINE                           | Trace matrix + US (статус Plan Ready убран)            |
| E2E GUI auth/roles при `PARTICIPANTS_MODE_ENABLED=false` | ENV                              | `@env-dependent`, L-08b/L-06 skipped                   |
| E2E GUI bootstrap connect/sync без сценария              | REFINE                           | Покрыто `L-10`/`L-10c` (connect/sync UI)               |
| E2E GUI list-view vs no drag&drop                        | REFINE                           | L-01e описывает кнопочный реордер                      |
| E2E GUI L-01d health-check без US-trace                  | REFINE                           | Классифицирована как infra-smoke (matrix note)         |
| Лишний файл `nul`                                        | DEFER                            | Вне scope; удаляется вручную                           |
| Логгер `component` changed                               | ACCEPTED                         | Следствие переноса парсеров в shared                   |
| `schema.ts` 0% в shared                                  | ACCEPTED                         | Покрытие держится в data                               |
| E2E perf-гейт флейки                                     | ENV                              | Локальный бюджет; ai:validate не блокирует             |
| Общие task operations в `@aif/data`                      | ACCEPTED                         | Архитектурное решение Task 21                          |
| `pushPlan` MCP field vs file                             | ACCEPTED                         | Контрактное различие                                   |
| Текст ошибок MCP                                         | ACCEPTED                         | Контракт-level                                         |
| Usage-broadcast tied to registry                         | ACCEPTED                         | Consequence Task 24                                    |
| Done rework через generic implementer                    | DEFER                            | Вне scope; триггер — фикс-направленный ревью           |
| `$aif-evolve` после 5+ патчей                            | DEFER                            | Вне scope                                              |
| GitLab shortcut executionOwner                           | **FIX**                          | P0.2                                                   |
| Дефекты A–F                                              | **FIX** (A,B,C,E,F) / REFINE (D) | P0.1, P1.1, P1.2, P1.3, P2.1                           |

## 5. Метрики (before/after)

| Метрика                             | Before                               | After                                       | Delta                                              |
| ----------------------------------- | ------------------------------------ | ------------------------------------------- | -------------------------------------------------- |
| US-файлов                           | 23                                   | 25 (+2: split 1→3, −1 superseded as alias)  | +2                                                 |
| E2E API сценариев                   | 7 (gitlab-api) + 8 (прочие api) ≈ 15 | 15 (2 помечены `@requires-llm`)             | 0                                                  |
| E2E GUI сценариев                   | 12 + 2 root ≈ 14                     | 14 (1 помечен `@requires-llm`)              | 0                                                  |
| Дублирующих oracle-scenarios        | ~6 пар (см. §Duplicate oracles)      | 6 пар с документированным primary/secondary | классифицированы, не устранены без потери покрытия |
| LLM-зависимых сценариев (были fail) | 3 fail когда AIF_LLM_INTEGRATION off | 3 skip (core) / fail-fast preflight (llm)   | fail → skip                                        |
| Lane-разделение                     | нет                                  | `e2e:core` / `e2e:llm`                      | +2 таргета, preflight                              |

> Замечание: полный прогон e2e требует Docker-стек (`make e2e-docker`); единичные
> package-тесты на затронутые изменения (data gitlab, api gitlab, agent autoQueue)
> выполнены зелёными в рамках валидации этого плана.

## 6. Дальнейшие шаги

1. Прогнать `make e2e` (core) и `make e2e-llm` на стенде с LLM-ключом;
2. Прогнать `npm run ai:validate` (полный гейт);
3. Добавить `X-E2E-Trace-Id` проброс в `api/common.ts`/`gui/common.ts` (P2.1 follow-up);
4. Реализовать L-08b/L-06 при включении participants-mode на стенде.
