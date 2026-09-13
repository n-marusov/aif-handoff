# Data Flow: Языковые настройки (GUI → config.yaml → Skills)

Как язык артефактов (`language.artifacts`) проходит полный цикл от веб-интерфейса до
сгенерированного плана.

## Схема потока

```
Web UI (GlobalSettingsDialog)
  │
  ├─ ConfigEditor загружает config через API
  │   api.getConfig(projectId)
  │   → GET /settings/config?projectId=...
  │   → resolveConfigPath(projectId)
  │   → readFile(project.rootPath/.ai-factory/config.yaml)
  │   → отдаёт AifConfig (включая language.ui, language.artifacts)
  │
  ├─ ConfigEditor отображает селекты с текущими значениями
  │   value={config.language?.ui ?? "en"}
  │   value={config.language?.artifacts ?? "en"}
  │
  ├─ Пользователь меняет язык и нажимает Save
  │   ConfigEditor.handleSave()
  │   → api.saveConfig(config, projectId)
  │   → PUT /settings/config?projectId=...
  │   → YAML.stringify(config) → writeFile(configPath, yaml)
  │   → clearProjectConfigCache(project.rootPath)
  │
  └─ Skills читают config.yaml при каждом запуске
      aif-plan / aif-fix / aif-implement (Step 0)
      → getProjectConfig(projectRoot)
      → readFile(projectRoot/.ai-factory/config.yaml)
      → парсит language.artifacts
      → передаёт в execution.systemPromptAppend
```

## Ключевые файлы и их роль

| Файл                                                          | Роль                                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/web/src/components/layout/GlobalSettingsDialog.tsx` | Диалог с шестерёнкой в хедере. Загружает config через `api.getConfig()`, рендерит `ConfigEditor` (строка 589) |
| `packages/web/src/components/settings/ConfigEditor.tsx`       | Компонент с селектами языка. Читает проп `config`, на Save вызывает `api.saveConfig()`                        |
| `packages/api/src/routes/settings.ts`                         | REST-роуты: `GET /settings/config` (чтение), `PUT /settings/config` (запись)                                  |
| `packages/shared/src/projectConfig.ts`                        | `getProjectConfig()` — чтение config.yaml с mtime-кэшем (строка 152). Вызывается всеми навыками               |
| `.ai-factory/config.yaml`                                     | Файл конфигурации проекта на диске                                                                            |

## Как навыки получают язык

Каждый навык (aif-plan, aif-fix и др.) в шаге 0 читает config.yaml:

```
getEnvLang(): { ui: "en" | "ru", artifacts: "en" | "ru", technical_terms: "keep" | "translate" }
  → getProjectConfig(projectRoot)     # projectConfig.ts
  → читает .ai-factory/config.yaml    # или defaults, если файла нет
  → normalizeLanguage(parsed.language) # BCP-47 валидация, fallback на en
  → возвращает AifProjectLanguage
```

Значение `artifacts` затем передаётся в `systemPromptAppend` и доставляется модели
через механизм, специфичный для адаптера (см. `docs/configuration.md` → Project Language,
таблица per-transport delivery).

## Кэширование config.yaml

`getProjectConfig()` использует mtime-based кэш (строка 152 `projectConfig.ts`):

```typescript
const configCache = new Map<string, { config: AifProjectConfig; mtimeMs: number }>();
```

- Кэш хранится **в памяти процесса**.
- Инвалидируется по `stat.mtimeMs`: если файл изменился, следующий вызов перечитывает.
- Явная инвалидация: `clearProjectConfigCache(projectRoot)` вызывается API после записи.

### Важно: cross-process cache

API (port 3009) и Agent — разные процессы. У каждого свой `configCache` Map.
При сохранении через GUI:

1. API очищает свой кэш → `clearProjectConfigCache(project.rootPath)` (settings.ts:296)
2. Agent НЕ получает уведомления — его кэш остаётся
3. При следующем запуске навыка Agent вызывает `getProjectConfig()`, сравнивает `mtimeMs`
4. Если mtime изменилась → кэш перечитывается

⇒ Задержка отсутствует: mtime-проверка происходит при каждом вызове навыка.

## Подтверждение: цепочка замкнута

В результате ревизии кода найдено:

- ✅ `ConfigEditor` импортируется в `GlobalSettingsDialog` (строка 14)
- ✅ `GlobalSettingsDialog` рендерит `ConfigEditor` с загруженным config (строки 589–593)
- ✅ `GlobalSettingsDialog` загружает config через `api.getConfig(projectId)` (строки 93–110)
- ✅ `PUT /settings/config` пишет в `.ai-factory/config.yaml` и чистит кэш API-процесса
- ✅ Навыки читают config.yaml через `getProjectConfig()` с mtime-кэшем
- ✅ `docs/configuration.md` разделы "Project Language" и "Project Config" актуальны

## Известные ограничения

1. **MCP-синхронизация не затрагивает config.yaml.** Режим 2 (ручной Claude Code
   через MCP) полагается на то, что config.yaml уже записан на диск. MCP-тулзы не
   имеют прямого读写 config-эндпоинта — только Handoff-статусы и планы. Если
   пользователь меняет язык в GUI → API пишет на диск → MCP-сессия подхватывает
   при следующем запуске навыка.
2. **Язык не влияет на web UI.** `language.ui` — информационное поле, зарезервированное
   для будущей локализации интерфейса. Только `language.artifacts` влияет на
   содержимое артефактов (планы, документы, ревью).
3. **Plan-аннотация Handoff.** При `HANDOFF_MODE=1` навык вставляет
   `<!-- handoff:task:<id> -->` первой строкой плана. Это технический маркер,
   на него не действует `language.artifacts` — он всегда на английском.

## Связанные документы

- [Configuration → Project Language](configuration.md#project-language) — формат
  language-блока и per-transport delivery
- [Configuration → Project Config](configuration.md#project-config-configyaml) —
  схема config.yaml и API-эндпоинты
- [MCP Sync](mcp-sync.md) — Handoff-режимы и синхронизация задач
