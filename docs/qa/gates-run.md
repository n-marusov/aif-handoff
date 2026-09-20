# Запуск детерминированных гейтов — AIF Handoff

Справочник по запуску и интерпретации детерминированных гейтов (классы G1/AG/FG,
каталог — [gates.md](gates.md)). Гейты — скрипты в `scripts/gates/`, единая точка
входа — раннер `scripts/gates/run.mjs`.

## Быстрый запуск

```bash
# Все детерминированные гейты (G1 + AG + FG) с отчётом
npm run gates:report          # = node scripts/gates/run.mjs --out scripts/gates/results/aif-gate-result.json

# По группам
npm run gates:g1              # G1 — валидация артефактов спецификации
npm run gates:ag              # AG — архитектурные гейты
npm run gates:fg              # FG — качество тестов

# Один гейт
node scripts/gates/run.mjs --gate G1-LINK
```

Через Makefile:

```bash
make gate-g1       # G1-валидаторы
make gate-ag       # архитектурные AG-гейты
make gate-fg       # FG-гейты качества тестов
make gates         # все детерминированные гейты (входит в `make gate`)
```

## Отчёт `aif-gate-result.json`

Каждый прогон пишет машинно-читаемый отчёт (по умолчанию —
`scripts/gates/results/aif-gate-result.json`, gitignored):

```json
{
  "schemaVersion": "1.0.0",
  "runId": "…",
  "timestamp": "…",
  "repo": "aif-handoff",
  "batch": { "status": "pass|warn|fail", "total": 17, "passed": 10, "warned": 5, "failed": 2 },
  "gates": [
    {
      "id": "G1-LINK",
      "name": "Целостность ссылок",
      "group": "G1",
      "status": "pass",
      "durationMs": 43,
      "checks": [{ "scope": "docs/…:12", "status": "fail", "message": "…" }]
    }
  ]
}
```

- `status: pass|warn|fail` на уровень гейта и батча.
- Код выхода раннера: `0` — нет `fail`, `1` — есть `fail`, `2` — ошибка использования.
- `warn` — не блокирует батч и служит сигналом владельцу артефакта (например,
  «подозрительная» ссылка глоссария или крупный модуль).

## Гейты

| Гейт              | Что проверяет                                                                | Статус |
| ----------------- | ---------------------------------------------------------------------------- | ------ |
| `G1-FMT`          | Обязательные поля/структура по типу каталога (UC/US/BR/FR/NFR)               | pass   |
| `G1-ID`           | Схема идентификаторов файлов и заголовков каталогов                          | pass   |
| `G1-LINK`         | Целостность относительных ссылок в `docs/` (gitignored-пути пропускаются)    | pass   |
| `G1-TRACE`        | UC — «Источник требований»; BR — раздел «Трассируемость»                     | warn\* |
| `G1-PRIO`         | Приоритет P0/P1/P2 в UC; упоминание тест-покрытия для P0/P1                  | warn\* |
| `G1-METRIC`       | Размытые формулировки в критериях приёмки                                    | pass   |
| `G1-GHERKIN`      | Теги и структура Gherkin в US-файлах                                         | warn\* |
| `G1-GLOSS`        | Структура определений и целостность якорей связанных терминов                | warn\* |
| `G1-DUP`          | Уникальность ID каталогов                                                    | pass   |
| `G1-TBD`          | Маркеры `[TBD-*]` зарегистрированы в `open-questions.md`                     | pass   |
| `G1-MACHINE`      | `docs/contracts/INDEX.yaml` валиден и согласован с README-реестром           | pass   |
| `AG-CYCLES`       | Циклы зависимостей между пакетами `@aif/*`                                   | pass   |
| `AG-LAYERS`       | Запрещённые рёбра слоёв clean architecture                                   | pass   |
| `AG-BOUNDARIES`   | Прямые импорты `@aif/data/db`/drizzle/better-sqlite3 в api/agent/runtime/mcp | pass   |
| `AG-STRUCT`       | Размер модулей (пороги `GATE_STRUCT_MAX_LINES`/`GATE_STRUCT_MAX_MEGA`)       | warn\* |
| `FG-TEST-QUALITY` | Скип/only-маркеры, тривиальные always-pass, тесты без assert                 | warn\* |
| `FG-MUTATION`     | Политика: thresholds в `stryker.conf.mjs`, критичные пакеты в mutate-скоупе  | warn\* |

\* — `warn` означает «есть замечания для владельца», батч при этом не падает
(гейт исполняется строго по детерминированной части; эвристические проверки не
блокируют CI, а выносятся в отчёт).

## CI

`.github/workflows/gates.yml` запускает `npm run gates:report` на push в `main` и
PR, публикует `aif-gate-result.json` артефактом (retention 14 дней). Гейты входят
в `make ci-gate` (контейнерный эквивалент — `ci-gates`).

## Как добавить гейт

1. Создайте валидатор `scripts/gates/validators/<id>.mjs`, экспортирующий
   `export const GATE = { id, name, group }` и `export async function run({ repoRoot }) → { checks, summary }`.
2. Зарегистрируйте модуль в `scripts/gates/registry.mjs` (namespace-import + `toGate(...)`).
3. Прогоните `node scripts/gates/run.mjs --gate <ID>`.
4. Обновите таблицу выше и статус в [gates.md](gates.md).
