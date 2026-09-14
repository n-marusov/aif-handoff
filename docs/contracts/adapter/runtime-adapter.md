[← README](../README.md)

# RuntimeAdapter Contract (`@aif/runtime`)

> Источник правды: `packages/runtime/src/types.ts`
> Версия: 1.0.0
> Статус: `implemented`

## Описание

Единый интерфейс для взаимодействия с AI-провайдерами (Claude Agent SDK, Codex CLI/API, OpenRouter API).
Все вызовы AI в системе проходят через этот слой абстракции.

## Основной интерфейс

```typescript
// packages/runtime/src/registry.ts — создание и вызов
interface RuntimeAdapter {
  run(input: RuntimeRunInput): Promise<RuntimeRunResult>;
  listModels?(input: RuntimeModelListInput): Promise<string[]>;
  getSession?(input: RuntimeSessionGetInput): Promise<RuntimeSession | null>;
  listSessions?(input: RuntimeSessionListInput): Promise<RuntimeSession[]>;
  listSessionEvents?(input: RuntimeSessionEventsInput): Promise<RuntimeEvent[]>;
  resume?(input: RuntimeRunInput): Promise<RuntimeRunResult>;
  forkSession?(input: RuntimeSessionForkInput): Promise<RuntimeRunResult>;
}
```

## Входные данные (`RuntimeRunInput`)

| Поле           | Тип                                        | Обязательность  | Описание                                                           |
| -------------- | ------------------------------------------ | --------------- | ------------------------------------------------------------------ |
| `runtimeId`    | `string`                                   | Обязательно     | Идентификатор адаптера (например, `claude`, `codex`, `openrouter`) |
| `providerId`   | `string`                                   | Опционально     | Идентификатор провайдера                                           |
| `profileId`    | `string \| null`                           | Опционально     | Идентификатор runtime-профиля                                      |
| `transport`    | `RuntimeTransport`                         | Опционально     | Тип транспорта (`agent_sdk`, `cli`, `api`, `stdio`)                |
| `prompt`       | `string`                                   | Обязательно     | Текст промпта                                                      |
| `messages`     | `RuntimeConversationMessage[]`             | Опционально     | Полная история для multi-turn                                      |
| `tools`        | `RuntimeToolDefinition[]`                  | Опционально     | Определения инструментов (function calling)                        |
| `toolChoice`   | `"auto" \| "none" \| "required" \| Record` | Опционально     | Стратегия выбора инструмента                                       |
| `systemPrompt` | `string`                                   | Опционально     | Системный промпт                                                   |
| `model`        | `string`                                   | Опционально     | Выбор модели                                                       |
| `sessionId`    | `string \| null`                           | Опционально     | Продолжение существующей сессии                                    |
| `resume`       | `boolean`                                  | Опционально     | Возобновить сессию                                                 |
| `stream`       | `boolean`                                  | Опционально     | Стриминг результата                                                |
| `projectId`    | `string`                                   | Опционально     | ID проекта для контекста                                           |
| `projectRoot`  | `string`                                   | Опционально     | Путь к корню проекта для worktree                                  |
| `cwd`          | `string`                                   | Опционально     | Рабочая директория                                                 |
| `execution`    | `RuntimeExecutionIntent`                   | Опционально     | Параметры выполнения (лимиты, таймауты, колбэки)                   |
| `usageContext` | `RuntimeUsageContext`                      | **Обязательно** | Метаданные учёта использования                                     |

## Результат (`RuntimeRunResult`)

| Поле           | Тип                      | Описание                                             |
| -------------- | ------------------------ | ---------------------------------------------------- |
| `outputText`   | `string`                 | Текстовый результат                                  |
| `sessionId`    | `string \| null`         | ID сессии для продолжения                            |
| `session`      | `RuntimeSession \| null` | Детали сессии                                        |
| `events`       | `RuntimeEvent[]`         | Поток событий выполнения                             |
| `usage`        | `RuntimeUsage \| null`   | Учёт токенов (не null при `usageReporting !== NONE`) |
| `toolCalls`    | `RuntimeToolCall[]`      | Вызовы инструментов                                  |
| `finishReason` | `string \| null`         | Причина завершения                                   |

## Capabilities (`RuntimeCapabilities`)

Каждый адаптер декларирует поддерживаемые возможности:

```typescript
interface RuntimeCapabilities {
  supportsResume: boolean; // resume()
  supportsSessionFork: boolean; // forkSession()
  supportsSessionList: boolean; // listSessions/getSession/listSessionEvents
  supportsWorkspaceTools?: boolean; // file edit tools
  supportsToolCalling?: boolean; // function calling
  supportsAgentDefinitions: boolean; // .claude/agents/
  supportsStreaming: boolean; // стриминг событий
  supportsModelDiscovery: boolean; // listModels()
  supportsApprovals: boolean; // approval workflows
  supportsCustomEndpoint: boolean; // custom baseUrl
  usageReporting: UsageReporting; // FULL | PARTIAL | NONE
}
```

## Транспорты (`RuntimeTransport`)

| Транспорт   | Описание                      |
| ----------- | ----------------------------- |
| `agent_sdk` | Claude Agent SDK (in-process) |
| `cli`       | Codex CLI (subprocess)        |
| `api`       | Codex API / OpenRouter API    |
| `stdio`     | STDIO-протокол                |

## Сессии

Сессии позволяют продолжить разговор в том же контексте. Поддерживаются:

- `resume()` — продолжить существующую сессию
- `forkSession()` — создать дочернюю сессию от родительской
- `listSessions()` / `getSession()` / `listSessionEvents()` — управление сессиями

## Учёт использования

Каждый успешный вызов runtime обязан передать `RuntimeUsage` (токены, стоимость) через
поле `usage`. Адаптеры декларируют уровень поддержки через `capabilities.usageReporting`:

- `FULL` — всегда возвращает usage
- `PARTIAL` — возвращает usage, когда провайдер сообщает
- `NONE` — транспорт не поддерживает учёт

## See Also

- [REST API](../rest/aif-api.md) — HTTP-эндпоинты системы
- [WebSocket Events](../websocket/events.md) — real-time протокол
- [Data Layer](../data/data-layer.md) — централизованный слой доступа к данным
- [README](../README.md) — реестр контрактов
