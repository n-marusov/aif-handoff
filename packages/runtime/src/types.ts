/**
 * Контракты всех runtime-адаптеров пакета @aif/runtime.
 *
 * Это единый «словарь» взаимодействия с исполнителями ИИ: api, agent, web и data
 * оперируют только типами из этого файла и никогда не заглядывают во внутренности
 * SDK конкретных вендоров (Claude Agent SDK, Codex CLI, OpenRouter HTTP). Собственно
 * адаптеры живут в `adapters/*` и реализуют здесь интерфейс RuntimeAdapter; система
 * работает со значением интерфейса, а не с конкретным классом — это классический
 * приём «зависимость от абстракции» (dependency inversion): подключение нового
 * рантайма становится плагином, а не правкой всего кода.
 *
 * Ключевая идея — широкая, но «мягкая» контрактовая граница: обязательных вещей в
 * адаптере всего две (descriptor и run()), остальные методы опциональны и доступны
 * только если соответствующий флаг в RuntimeCapabilities включён. Благодаря этому
 * минималистичный API-адаптер (OpenRouter) и полноценный CLI-адаптер (Claude)
 * сосуществуют в одном реестре, а вызывающий код не падает на неподдерживаемой функции.
 *
 * Всё содержимое файла — чистые типы и константы без I/O: файл собирается и в браузере
 * (фронтенд web), и в Node.js (api/agent). Поэтому здесь нет SDK-типов, drizzle или
 * node:* импортов — они сделали бы файл недоступным для браузерного бандла.
 */

import {
  isRuntimeTransport as _isRuntimeTransport,
  RUNTIME_TRANSPORTS as _RUNTIME_TRANSPORTS,
  RuntimeLimitPrecision as _RuntimeLimitPrecision,
  RuntimeLimitScope as _RuntimeLimitScope,
  RuntimeLimitSource as _RuntimeLimitSource,
  RuntimeLimitStatus as _RuntimeLimitStatus,
  RuntimeTransport as _RuntimeTransport,
} from "@aif/shared";
import type {
  RuntimeLimitEventPayload as _RuntimeLimitEventPayload,
  RuntimeLimitSnapshot as _RuntimeLimitSnapshot,
  RuntimeLimitWindow as _RuntimeLimitWindow,
} from "@aif/shared";

// Реэкспорт из @aif/shared — единый источник истины для браузера и сервера
// Единственный источник правды: значения enum'ов и type guards объявлены один раз в
// @aif/shared, а здесь они лишь переэкспортируются под исходными именами. Импорт с
// префиксом `_` нужен, чтобы локальное связывание не конфликтовало с `export const`.
export const RuntimeTransport = _RuntimeTransport;
// Идиома `(typeof Obj)[keyof typeof Obj]`: из значение-объекта выводится объединение
// литеральных строковых типов ("sdk" | "cli" | ...). Значения и тип живут в одном месте
// и физически не могут разойтись — ещё одна причина, почему enum'ы не дублируются.
export type RuntimeTransport = (typeof RuntimeTransport)[keyof typeof RuntimeTransport];
export const RUNTIME_TRANSPORTS = _RUNTIME_TRANSPORTS;
// Парный паттерн любого enum'а в проекте: список значений (для валидации форм) и
// type guard (для проверки пришедших извне строк). Экспортируются обе — и сервер,
// и UI работают с ними, а не с самодельными includes().
export const isRuntimeTransport = _isRuntimeTransport;
export const RuntimeLimitSource = _RuntimeLimitSource;
export type RuntimeLimitSource = (typeof RuntimeLimitSource)[keyof typeof RuntimeLimitSource];
export const RuntimeLimitStatus = _RuntimeLimitStatus;
export type RuntimeLimitStatus = (typeof RuntimeLimitStatus)[keyof typeof RuntimeLimitStatus];
export const RuntimeLimitPrecision = _RuntimeLimitPrecision;
export type RuntimeLimitPrecision =
  (typeof RuntimeLimitPrecision)[keyof typeof RuntimeLimitPrecision];
export const RuntimeLimitScope = _RuntimeLimitScope;
export type RuntimeLimitScope = (typeof RuntimeLimitScope)[keyof typeof RuntimeLimitScope];
// Ограничения провайдеров (rate-limit окна, снимки, события) — тоже общий словарь:
// адаптеры нормализуют свои заголовки 429/X-RateLimit к этим типам, и дальше по
// системе катится единый формат, понятный и web-бейджу, и агрегатору в api.
// Здесь только type-реэкспорт (без const) — значения лимитов живут в БД, не в типе.
export type RuntimeLimitWindow = _RuntimeLimitWindow;
export type RuntimeLimitSnapshot = _RuntimeLimitSnapshot;
export type RuntimeLimitEventPayload = _RuntimeLimitEventPayload;

/** Канонический тип runtime-события для обновлений снапшотов лимитов провайдера. */
// Строка с `as const` сужает тип до литерала "runtime:limit", а не широкого string.
// WebSocket-подписчики сравнивают тип события по этой константе: опечатка в имени
// события превращается в ошибку компиляции, а не в молчаливо теряемый апдейт лимитов.
export const RUNTIME_LIMIT_EVENT_TYPE = "runtime:limit" as const;

/**
 * Контракт отчётности об использовании — объявляет, может ли адаптер заполнить
 * `RuntimeRunResult.usage` после успешного запуска.
 *
 * - `FULL`    — адаптер всегда возвращает ненулевой `usage` при успешном запуске.
 *               Обёртка реестра громко логирует нарушение (в production) или
 *               валит контрактный тест (в разработке).
 * - `PARTIAL` — адаптер возвращает `usage`, когда провайдер его сообщает, но может
 *               вернуть `null` на тех транспортах/потоках, где
 *               провайдер не отдаёт финальный подсчёт токенов.
 * - `NONE`    — транспорт принципиально не может сообщать использование. Обёртка
 *               предупреждает, если `usage` ненулевой (неожиданно), и пропускает sink.record.
 *
 * Определён как const-объект (не строковый союз и не TS enum) по конвенции
 * `RuntimeTransport` в этой кодовой базе: вызывающий код ссылается на
 * `UsageReporting.FULL` вместо магических строк, компилятор TS ловит
 * опечатки, и новая варианта требует правки одного центрального файла.
 */
// Конст-объект вместо `enum`: TS enum генерирует рантайм-код и хуже дружит с
// tree-shaking и `isolatedModules`, а `as const` остаётся обычным объектом с точными
// литеральными типами. Такой же формат выбран для RuntimeTransport и UsageSource —
// в пакете сознательно один стиль на все перечисления.
export const UsageReporting = {
  FULL: "full",
  PARTIAL: "partial",
  NONE: "none",
} as const;
export type UsageReporting = (typeof UsageReporting)[keyof typeof UsageReporting];

/**
 * Канонический набор источников usage-контекста. Каждая точка вызова,
 * обращающаяся к runtime, выбирает одно из этих значений и тем самым объявляет
 * свой логический поток, — так дашборды группируют трафик, а «неизвестный
 * источник» невозможен.
 *
 * Новый источник — это осознанная однострочная правка здесь: это единственное
 * место, где набор источников определён во всём монорепо.
 */
export const UsageSource = {
  // Каждый источник токенов — это точка входа, откуда система зовёт LLM. Без
  // обязательного тега «кто заплатил» невозможно ни распределить стоимость по задачам,
  // ни понять, какая фича съела бюджет. Ниже — весь исчерпывающий список таких мест.
  /** Пользовательский маршрут чата (packages/api/src/routes/chat.ts). */
  CHAT: "chat",
  /** Фоновый (fire-and-forget) исполнитель /aif-commit (services/commitGeneration.ts). */
  COMMIT: "commit",
  /** Первый проход генерации roadmap, пишущий ROADMAP.md (services/roadmapGeneration.ts). */
  ROADMAP_GENERATE: "roadmap-generate",
  /** Второй проход roadmap, извлекающий JSON-задачи (services/roadmapGeneration.ts). */
  ROADMAP_EXTRACT: "roadmap-extract",
  /** Fast Fix задачи (services/fastFix.ts). */
  FAST_FIX: "fast-fix",
  /** Фоновый (fire-and-forget) исполнитель /aif-qa (services/qaRunner.ts). */
  QA: "qa",
  /** Создание переиспользуемой seed-сессии для потоков разогрева проекта. */
  WARMUP: "warmup",
  /** Выполнение сабагента из координатора агента (agent/subagentQuery.ts). */
  SUBAGENT: "subagent",
  /** Внутренняя проверка адаптера, используемая потоками Discovery моделей (listModels()). */
  MODEL_DISCOVERY: "model-discovery",
  /** Тестовые фикстуры — допустимы только внутри прогонов vitest. */
  TEST: "test",
} as const;
export type UsageSource = (typeof UsageSource)[keyof typeof UsageSource];

/**
 * Флаги возможностей runtime, которые объявляет каждый адаптер.
 * Система проверяет их перед вызовом необязательных методов — если флаг false,
 * соответствующий необязательный метод RuntimeAdapter никогда не будет вызван.
 */
// Машинно-проверяемое описание возможностей адаптера. Это не документация «для людей»,
// а данные: workflow-движок (capabilities.ts) бросает ошибку, если шаг требует флаг,
// которого у профиля нет. Поэтому флаги обязаны честными — врать здесь хуже, чем молчать.
export interface RuntimeCapabilities {
  // Сессии образуют иерархию возможностей: resume (продолжить) — fork (ответвить)
  // — list (перечислить). Уровни включаются независимо: у OpenRouter нет ни одного,
  // у Codex есть resume, у Claude — всё сразу.
  /** Адаптер может продолжить предыдущую сессию через resume(). */
  supportsResume: boolean;
  /** Адаптер может ответвить исходную сессию в дочернюю до выполнения промпта. */
  supportsSessionFork: boolean;
  /** Адаптер может перечислять/читать сессии через listSessions(), getSession(), listSessionEvents(). */
  // Чтение истории сессий включается отдельно от продолжения: UI может показывать
  // журнал разговоров рантайма, даже если продолжить их нельзя.
  supportsSessionList: boolean;
  // Опциональные флаги через `?:` — исторически добавлялись позже обязательных;
  // отсутствие флага читается как false, что позволяет не править все старые адаптеры.
  /** Адаптер может выполнять правки workspace/файлов локальными или серверными инструментами. */
  supportsWorkspaceTools?: boolean;
  /** Адаптер поддерживает совместимые с OpenAI function/tool вызовы, возвращаемые хосту для локального исполнения. */
  supportsToolCalling?: boolean;
  /** Адаптер поддерживает определения .claude/agents/ (agentDefinitionName в намерении выполнения). */
  // Определяемые агенты (markdown-описания ролей) — фича файловой среды Claude:
  // HTTP-адаптеры не читают .claude/agents, и workflow-планировщик для них выбирает
  // fallback-режим slash-команды (см. promptPolicy.ts).
  supportsAgentDefinitions: boolean;
  /** Адаптер выдаёт потоковые события во время run(). */
  // Стриминг влияет не только на UX: при supportsStreaming=false движок не ждёт
  // onEvent-сигналов и не применяет startTimeoutMs как «ожидание первого вывода».
  supportsStreaming: boolean;
  /** Адаптер может перечислять доступные модели через listModels(). */
  // Discovery моделей питает UI-селектор и effort-проверку в реестре; без флага
  // система не будет дёргать сеть при каждом открытии настроек.
  supportsModelDiscovery: boolean;
  /** Адаптер поддерживает workflow согласований (human-in-the-loop). */
  // Approvals — согласование опасных шагов человеком; есть только у рантаймов с
  // собственным механизмом permission-prompt (Claude), не у чистого HTTP.
  supportsApprovals: boolean;
  /** Адаптер поддерживает настройку собственного baseUrl / endpoint. */
  // Флаг для UI: если true, поле baseUrl редактируемо (прокси, self-hosted шлюзы,
  // router.ai); иначе показывать его бессмысленно — адаптер игнорирует значение.
  supportsCustomEndpoint: boolean;
  /**
   * Адаптер может выполнять workflow сабагентов через изолированные сессии
   * skill-команд (не сводя их к общему резервному промпту на одну сессию).
   */
  // Два флага субагентов описывают разные модели исполнения: «изолированные» —
  // отдельные сессии под каждый skill, «нативные» — субагенты внутри одного
  // родительского прогона провайдера. Планировщик выбирает тактику по ним;
  // без обоих — одиночный фолбэк-промпт, хуже по качеству, но всегда рабочий.
  supportsIsolatedSubagentWorkflows?: boolean;
  /**
   * Адаптер может выполнять нативные сабагент-workflow под управлением
   * провайдера (например, кастомные агенты Codex + делегирование в одном родительском запуске).
   */
  supportsNativeSubagentWorkflows?: boolean;
  /**
   * Контракт отчётности об использовании адаптера. Обязателен, чтобы каждый новый
   * адаптер принимал явное решение — обёртка реестра использует его для контроля
   * инвариантов `RuntimeRunResult.usage`.
   */
  // Поле обязательное именно для того, чтобы автор нового адаптера не мог «забыть»
  // про учёт токенов: компилятор вынуждает явно выбрать FULL/PARTIAL/NONE.
  // bootstrap.test.ts дополнительно ломает сборку, если адаптер не объявил флаг.
  usageReporting: UsageReporting;
  /**
   * Адаптер выдаёт интерактивные события `tool:question` (например, Claude
   * `AskUserQuestion`). Consumers используют флаг, чтобы включать провайдер-
   * специфичные подсказки промптов и элементы UI лишь там, где они есть, —
   * прочие runtime не наследуют шум. Необязателен — по умолчанию false.
   */
  // Без флага chat UI не показывал бы карточку вопроса для чужих рантаймов, а
  // промпт-инженерия не совала бы модели подсказку «спрашивай пользователя» там,
  // где спрашивать нечем. Дефолт false через `?:` — старые адаптеры не правятся.
  supportsInteractiveQuestions?: boolean;
}

// Разумные значения по умолчанию: всё выключено, учёт токенов — NONE. Адаптер
// получает этот набор через spread и переопределяет только то, что реально умеет.
// Инверсия «всё закрыто, кроме объявленного» безопаснее обратного: невызованный метод
// — это деградация функции, а ложно обещанный — падение в рантайме.
export const DEFAULT_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: false,
  supportsSessionFork: false,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: false,
  supportsModelDiscovery: false,
  supportsApprovals: false,
  supportsCustomEndpoint: false,
  supportsWorkspaceTools: false,
  supportsToolCalling: false,
  supportsIsolatedSubagentWorkflows: false,
  supportsNativeSubagentWorkflows: false,
  usageReporting: UsageReporting.NONE,
  supportsInteractiveQuestions: false,
};

// «Визитная карточка» адаптера: статические метаданные, известные до любого запуска.
// Реестр, UI-селекторы транспортов и promptPolicy читают именно descriptor; он обязан
// быть дешёвым на создание и не требовать сетевых запросов или чтения диска.
export interface RuntimeDescriptor {
  // Стабильный ключ в реестре и в БД (runtime_profiles.runtimeId): после публикации
  // менять нельзя, профили пользователей ссылаются на него строкой.
  // runtimeId — реализация (например "codex"), providerId — вендор ("openai"):
  // один вендор может иметь несколько реализаций, и лимиты/ключи при этом общие.
  id: string;
  providerId: string;
  displayName: string;
  description?: string;
  version?: string;
  // defaultTransport vs supportedTransports: первое — что выбрать при отсутствии
  // выбора, второй — что вообще разрешено показывать в UI. Разные вопросы — разные поля.
  defaultTransport?: RuntimeTransport;
  capabilities: RuntimeCapabilities;
  /** Дешёвая/быстрая модель для лёгких задач (review-gate, проверка планов и т.п.). null = использовать default. */
  // «Лёгкая» модель — дешёвый вариант для черновых прогонов (авто-review gate,
  // проверка планов). Так система платит за Sonnet/Haiku там, где не нужен флагман.
  lightModel?: string | null;
  /** Имя env-переменной API-ключа по умолчанию (например "ANTHROPIC_API_KEY", "OPENAI_API_KEY"). Для подсказок UI и выводов. */
  // Здесь хранится ИМЯ переменной окружения, а не секрет: ключ никогда не попадает
  // в метаданные и БД, только ссылка на ENV. UI показывает это имя как placeholder.
  defaultApiKeyEnvVar?: string;
  /** Упорядоченный список env-имён, которые резолвинг пробует для поиска API-ключа. Первое существующее значение побеждает. */
  // Это машинно используемая версия defaultApiKeyEnvVar: резолвинг идёт по списку
  // слева направо (явный ключ важнее auth-токена и т.п.), а не по одному имени.
  apiKeyEnvCandidates?: string[];
  /** Имя env-переменной base URL по умолчанию (например "OPENAI_BASE_URL"). Для placeholder-подсказок UI. */
  defaultBaseUrlEnvVar?: string;
  /** Конкретный базовый URL по умолчанию, либо null — «библиотека провайдера решает сама» (например Anthropic SDK). */
  // В отличие от defaultBaseUrlEnvVar (имя env для проброса), это готовое значение:
  // OpenRouter публикует SaaS-адрес как часть контракта, и он зашит здесь намеренно.
  defaultBaseUrl?: string | null;
  /** Placeholder имени модели для UI (например "claude-sonnet-4-5", "gpt-5.4"). */
  // Обе «плейсхолдер»-пары нужны, чтобы web-форма не хардкодила вендорские строки:
  // меняешь адаптер — подсказки в форме меняются сами, потому что источник один.
  defaultModelPlaceholder?: string;
  /** Имя env-переменной с моделью по умолчанию (например "ANTHROPIC_MODEL", "OPENAI_MODEL"). */
  defaultModelEnvVar?: string;
  /** Спецификация reasoning-effort: ключ в options и fallback-набор уровней. */
  // Единый источник правды вместо таблицы MODEL_EFFORT_CONFIGS по runtimeId.
  // optionKey — имя поля, которое уйдёт провайдеру; fallbackLevels — список, которому
  // доверяем, когда метаданные модели (discovery) не дают ничего лучшего.
  effort?: {
    optionKey: "effort" | "modelReasoningEffort" | "reasoningEffort";
    fallbackLevels: readonly string[];
  };
  /** Транспорты runtime, которые поддерживает адаптер. UI фильтрует по ним селектор транспортов. */
  // Белый список транспортов для UI: если адаптер не поддерживает SDK, пользователь
  // просто не увидит эту опцию вместо неизбежной ошибки при запуске.
  supportedTransports?: RuntimeTransport[];
  /**
   * Символ-префикс для вызова skill/slash-команд.
   * Claude использует "/" (default), Codex — "$".
   * promptPolicy применяет его для преобразования skill-команд до отправки в runtime.
   */
  // Реестр подменяет префикс промпта (/aif-plan -> $aif-plan) ровно в одном месте —
  // wrapAdapter в registry.ts. Без этого флага каждый вызывающий код должен был бы
  // знать конвенции каждого рантайма, и первая же смена профиля ломала бы промпты.
  skillCommandPrefix?: string;
  /**
   * Поддерживается ли этот runtime командой `ai-factory init --agents`.
   * В init-команду передаются только рантаймы с этим флагом.
   * API-only рантаймы (например OpenRouter) без локальных инструментов агентов ставят false или не указывают.
   */
  // Флаг-выключатель для чистых HTTP-адаптеров: у OpenRouter нет локального каталога
  // агентов, и генерировать для него .claude-подобную структуру — мусор в проекте.
  supportsProjectInit?: boolean;
  /**
   * Идентификатор агента, передаваемый в `ai-factory init --agents`.
   * Обязателен для рантаймов с `supportsProjectInit: true`.
   */
  projectInitAgentName?: string;
}

/** Универсальный колбэк вызова инструмента — адаптер приводит свой нативный формат к этому. */
// Колбэки-адаптеры: рантайм сам решает, как извлечь из своего нативного потока событий
// имя инструмента и деталь. Вызывающий код получает «универсальный» сигнал и не зависит
// от формата Claude hooks или Codex JSONL. Функциональные типы вместо интерфейсов —
// потому что здесь важна единственная сигнатура, а не состояние.
export type RuntimeToolUseCallback = (toolName: string, detail: string) => void;

/** Универсальный колбэк старта сабагента — адаптер приводит свой формат к этому. */
// Парный колбэк к onToolUse: нужен coordinator'у и UI, чтобы видеть, когда внутри
// запуска рождается субагент, и связать его сообщения с родительской задачей.
export type RuntimeSubagentStartCallback = (name: string, id: string) => void;

/**
 * Adapter-нейтральные параметры выполнения, передаваемые через `RuntimeRunInput.execution`.
 *
 * Адаптеры читают только поддерживаемые поля, остальное игнорируют.
 * Универсальные колбэки (`onToolUse`, `onSubagentStart`, `onStderr`, `onEvent`)
 * дают вызывающему lifecycle-события без знания внутренностей адаптера.
 *
 * Мешок `hooks` хранит непрозрачный специфичный конфиг адаптера (например
 * токены доверия, настройки SDK). Адаптеры разбирают его сами, система не инспектирует.
 */
// «Мешок намерений» запуска: вызывающий код описывает ЧТО он хочет (бюджет, таймауты,
// отмена, колбэки), а адаптер решает КАК это выразить в своём SDK/CLI. Поля, которые
// адаптер не понимает, молча игнорируются — это сознательный отказ от жёсткой валидации
// в пользу совместимости: старый вызывающий код не ломается при росте intents.
// Таймауты намеренно разделены: startTimeoutMs — «рантайм вообще ожил?», runTimeoutMs —
// «сколько можно жить после». У CLI-адаптеров это разные режимы отказа.
export interface RuntimeExecutionIntent {
  // Бюджет и число шагов — страховка от «runaway agent»: цикл think->tool->think
  // может съесть состояние, если его не ограничить. null у maxBudgetUsd отличается
  // от undefined: «явно без лимита» против «адаптер сам решит».
  maxBudgetUsd?: number | null;
  maxTurns?: number;
  /** Таймаут ожидания первого вывода из потока выполнения runtime (мс). */
  // «Мёртвый процесс» виден по отсутствию первого вывода — ждать его отдельно нужно,
  // чтобы не держать пользователя полным таймаутом всего запуска из-за зависшего CLI.
  startTimeoutMs?: number;
  /** Пауза перед одной автоматической повторной попыткой после таймаута старта (мс). */
  // Ретрайд ровно один и только на старте: «завис до первого вывода» — почти
  // всегда транзитный сбой запуска CLI; повторный прогон после начала работы уже
  // не безопасен (могли выполниться side-effect'ы инструментов).
  startRetryDelayMs?: number;
  includePartialMessages?: boolean;
  // Имя из .claude/agents/<name>.md: рантаймы с нативными определениями агентов
  // подмешивают их системный промпт сами. promptPolicy.ts решает, когда вместо имени
  // отправлять slash-команду — отсюда развилка agentDefinitionName vs skill-command.
  agentDefinitionName?: string;
  // Конкатенация к системному промпту вместо замены: базовый промпт рантайма трогать
  // нельзя (он отвечает за инструменты и формат), можно только дописать сверху.
  // Именно сюда реестр внедряет директиву языка проекта (см. registry.ts).
  systemPromptAppend?: string;
  environment?: Record<string, string>;
  abortController?: AbortController;
  // AbortController — стандартный способ пробросить отмену сквозь границы async-кода:
  // пользователь закрыл чат — контроллер дёргается — адаптер убивает subprocess или
  // обрывает HTTP-стрим. Без этой ссылки отменить начатый запуск извне невозможно.
  /** Колбэк чанков stderr для runtime на основе подпроцессов. */
  // stderr subprocess'а — главный источник диагностики зависших CLI-адаптеров;
  // агент буферизует его кольцевым буфером (stderrCollector.ts) и показывает при падении.
  onStderr?: (chunk: string) => void;
  /** Колбэк событий runtime (текст из потока, вызовы инструментов и т.п.). */
  // Единая точка входа всех RuntimeEvent: WebSocket-мост и пишущий в БД логгер
  // подписываются сюда. Колбэк вызывается из стрима адаптера — он обязан быть
  // быстрым и не бросать: медленный consumer здесь тормозит чтение провайдера.
  onEvent?: (event: RuntimeEvent) => void;
  /** Универсальный колбэк после каждого вызова инструмента — адаптер подключает его к своей нативной hook-системе. */
  onToolUse?: RuntimeToolUseCallback;
  /** Универсальный колбэк старта сабагента — адаптер подключает его к своей нативной hook-системе. */
  onSubagentStart?: RuntimeSubagentStartCallback;
  /** Жёсткий таймаут всего запуска/подпроцесса (мс). Отличается от `timeoutMs` — это таймаут старта потока. */
  // Страховка от «вечного» процесса: даже живой стрим не должен жить бесконечно.
  // Пары start/run таймаутов достаточно, чтобы любой зависший subprocess был убит
  // с предсказуемой и диагностируемой ошибкой вместо накопления сирот в контейнере.
  runTimeoutMs?: number;
  /** Обходить ли проверки разрешений runtime (требует Токен доверия в hooks). */
  // Опасный режим: реестр допускает его только вместе с непрозрачным trust-токеном
  // (см. trust.ts). Токен — символ, который нельзя подделать через JSON-десериализацию,
  // поэтому внешний код не может «додумать» bypassPermissions без внутреннего допуска.
  bypassPermissions?: boolean;
  /** JSON Schema структурированного вывода — адаптер передаёт её провайдеру, если тот поддерживает. */
  // Структурированный вывод — способ вытащить из LLM данные без хрупкого парсинга
  // текста. Адаптеры без поддержки схемой пренебрегают: результат остаётся текстом,
  // и вызывающий код обязан это учитывать (fallback-ветка всегда нужна).
  outputSchema?: Record<string, unknown>;
  // Единственный «escape hatch» контракта: всё, что нельзя выразить нейтральным полем,
  // кладётся сюда и читается только самим адаптером. Цена — отсутствие типизации
  // (Record<string, unknown>), поэтому мешок маленький и осознанный, а не «склад всего».
  /** Непрозрачные adapter-specific hooks — передаются адаптеру без интерпретации. */
  hooks?: Record<string, unknown>;
}

/**
 * Метаданные области, прикреплённые к каждому запуску, чтобы usage-sink уровня
 * реестра фиксировал кто/что/где потратил токены. `source` обязателен — компилятор
 * TypeScript вынуждает каждую точку вызова осознанно выбрать тег.
 *
 * Необязательные поля области (`projectId`, `taskId`, `chatSessionId`) позволяют
 * sink агрегировать использование по сущностям; вызывают те, что известны.
 */
export interface RuntimeUsageContext {
  // Обязательное поле без `?` — это не бюрократия, а механизм: забыть тег источника
  // теперь физически невозможно, вызов без него не компилируется. Так учёт токенов
  // перестаёт зависеть от внимательности разработчика нового функционала.
  /**
   * Логический источник запуска. Одно из канонических значений `UsageSource` —
   * enum единственный источник истины о происхождении токенов, поэтому
   * дашборды группируют трафик без произвольных тегов.
   */
  source: UsageSource;
  projectId?: string | null;
  taskId?: string | null;
  chatSessionId?: string | null;
  // Иерархия «сущность -> сущность»: задача принадлежит проекту, чат-сессия — тоже.
  // Все поля допускают null, потому что запуск может быть вне любой сущности
  // (системный warmup), а sink один — событие должно заполняться полностью всегда.
}

export interface RuntimeToolDefinition {
  // Форма нарочно повторяет OpenAI function-calling схема: это lingua franca,
  // которую понимают и OpenRouter, и Codex, и совместимые шлюзы. Свой формат
  // инструментов Claude адаптер конвертирует в этот внутри себя.
  // parameters — JSON Schema аргументов: единственный переносимый способ описать
  // форму вызова, который все вендоры уже научились читать.
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface RuntimeToolCall {
  // arguments — строка JSON, а не объект: провайдеры отдают аргументы инструмента
  // кусками стрима, и только у получателя достаточно контекста, чтобы их парсить.
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface RuntimeConversationMessage {
  // Роль — литеральный union, а не enum-объект: здесь не нужны рантайм-значения
  // (данные приходят от провайдера и только читаются), достаточно проверки типов.
  role: "system" | "user" | "assistant" | "tool";
  // content может быть null: ассистентский ход, состоящий только из tool-call'ов,
  // — не пустота из вежливости, а сигнал «текста нет, смотри toolCalls».
  content?: string | null;
  // toolCallId связывает ответ tool-роли с конкретным вызовом ассистента; без этой
  // пары провайдер отвергнет историю как несогласованную.
  toolCallId?: string;
  toolCalls?: RuntimeToolCall[];
}

// Главный «вход» любого запуска: что сказать, какой моделью, в каком проекте и
// с какими намерениями. Почти всё опционально, кроме prompt и usageContext:
// второй выбрана обязательной сознательно (см. комментарий к RuntimeUsageContext) —
// реестр читает этот контекст для записи каждого успешного запуска в usage-хранилище.
export interface RuntimeRunInput {
  // «Координаты» выбора исполнителя: runtimeId -> в реестр, providerId -> вендор,
  // profileId -> какой именно конфигурационный слой применить (для логов и учёта),
  // workflowKind -> тип шага пайплайна (planning/implementing/...), нужен для
  // группировки расхода и для переиспользования сессий внутри workflow.
  runtimeId: string;
  providerId?: string;
  profileId?: string | null;
  workflowKind?: string;
  transport?: RuntimeTransport;
  prompt: string;
  /** Полная беседа для API-циклов инструментов; без неё адаптеры берут `prompt`. */
  messages?: RuntimeConversationMessage[];
  tools?: RuntimeToolDefinition[];
  // toolChoice — «принудиловка» для функций-вызовов: auto (модель решает),
  // none (запретить), required (обязать вызвать). Четвёртая форма — объект от
  // провайдера (принудить конкретный tool); она проходит насквозь без интерпретации,
  // потому что её семантика принадлежит только API-адаптерам.
  toolChoice?: "auto" | "none" | "required" | Record<string, unknown>;
  systemPrompt?: string;
  // model не резолвится здесь — это обязанность вызывающего слоя (resolution.ts
  // уже отдал профиль). Сюда попадает либо финальная модель, либо явный override.
  model?: string;
  // Пара sessionId+resume — «слабое звено» переносимости: адаптер без resume
  // обязан честно и предсказуемо отработать без них (проигнорировать или бросить
  // структурированную ошибку), а не тихо начать новый разговор.
  sessionId?: string | null;
  resume?: boolean;
  stream?: boolean;
  projectId?: string;
  projectRoot?: string;
  cwd?: string;
  // headers — транспортно-специфичные HTTP-заголовки (например x-session-id для
  // шлюза); CLI-адаптеры их игнорируют — норма «прочитал что умею, остальное мимо».
  headers?: Record<string, string>;
  // options — «сырой» слой профиля (путь к CLI, effort, температура): в отличие от
  // типизированных полей выше, сюда конфигурация из БД попадает без посредников.
  options?: Record<string, unknown>;
  execution?: RuntimeExecutionIntent;
  /**
   * Метаданные области для учёта использования. Обязательно: обёртка реестра
   * читает их, чтобы записать каждый успешный запуск в usage sink. Точки вызова
   * не могут их опустить — код без области не скомпилируется в TypeScript.
   */
  // projectId/projectRoot/cwd описывают «где выполняется», а не «что сказать»:
  // CLI-адаптеры стартуют subprocess именно в projectRoot, и ошибка в этом поле —
  // это запуск агента не в том репозитории. sessionId + resume образуют пару
  // «куда продолжить», а stream переключает режим доставки (ожидание vs события).
  // Единственное обязательное «служебное» поле интерфейса — компилятор превращает
  // забытый учёт токенов из тихого бага в ошибку сборки.
  usageContext: RuntimeUsageContext;
}

export interface RuntimeSessionForkInput extends RuntimeRunInput {
  // Наследование + одно поле вместо дублирования: fork — это обычный запуск,
  // у которого есть родительская сессия, из которой ответвляется контекст.
  sourceSessionId: string;
}

export interface RuntimeEvent {
  // type намеренно широкая строка: поток событий растёт быстрее контракта.
  type: string;
  // timestamp — ISO-строка, а не число: события переезжают между WS, БД и
  // pino-консолью в человекочитаемом виде без конвертеров на каждом краю.
  timestamp: string;
  // level заполняется только у событийных ошибок/warning'ов: у большинства
  // потоковых событий (текст, tool-use) серьёзность не определена.
  level?: "debug" | "info" | "warn" | "error";
  message?: string;
  // data — необязательный груз события: text/chunk'и несут только текст,
  // структурные события (tool-use, limits) кладут сюда свой payload.
  data?: Record<string, unknown>;
}

/**
 * Runtime-нейтральный payload для событий интерактивных вопросов (`tool:question`).
 * Адаптеры с инструментом «спросить пользователя» (например, Claude
 * `AskUserQuestion`) разбирают свою нативную форму в эту структуру перед
 * выдачей, чтобы consumers (чат UI, планировщики) рисовали вопросы одинаково,
 * какой бы runtime их ни породил.
 */
// Прокси-паттерн на данных: UI не знает Claude это вопрос или Codex — он рендерит
// этот снимок и отправляет ответ обратно в ту же сессию. Отсюда и toolUseId:
// стримы умеют переизлучать события, а по id повтор отсекается.
export interface RuntimeToolQuestionPayload {
  /** Идентификатор вызова инструмента адаптера, если есть — дедуплицирует повторные выдачи. */
  toolUseId: string | null;
  /** Исходное имя инструмента, как его видит адаптер (например "AskUserQuestion"). */
  toolName: string;
  /** Один или несколько вопросов, объединённых вместе. Большинство адаптеров присылают ровно один. */
  // Массив ради редкого кейса Claude: несколько вопросов одним tool-call'ом.
  // UI рендерит их одной карточкой, поэтому разбивать на отдельные вызовы было бы хуже.
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
}

export interface RuntimeUsage {
  // inputTokens/outputTokens/totalTokens — сырьё для всех денежных агрегатов.
  // costUsd опционален: не каждый провайдер отдаёт цену за запрос (часть считает её
  // сам по тарифной таблице), поэтому цена не может быть обязательной.
  // Все три счётчика обязательны: парсить «частично заполненный» usage сложнее, чем
  // обработать явный null на уровне всего объекта — контракты FULL/PARTIAL/NONE
  // решают дилемму «недооценка или паника» в пользу честного null.
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface RuntimeSession {
  // Сессия — внешний объект провайдера, поэтому id хранится как есть, без перекодировки;
  // дедуплиикация с локальной БД идёт по связке (runtimeId, id), а не по одному id.
  id: string;
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
  model?: string | null;
  title?: string | null;
  // Даты — строки ISO: сессии переживают перезапуски и пересылаются по JSON, а
  // Date-объект при сериализации всё равно превращается в строку — проще не играть.
  createdAt: string;
  updatedAt: string;
  // metadata непрозрачна и специфична для вендора: система её не читает, только
  // хранит и возвращает — адаптер эволюционирует схему без миграции общей модели.
  metadata?: Record<string, unknown>;
}

// Итог запуска. Обратите внимание на symmetry с capabilities: результат тоже
// «широкий и мягкий» — необработанные поля (raw, toolCalls, finishReason) остаются
// опциональными, потому что их наличие зависит и от адаптера, и от транспорта.
export interface RuntimeRunResult {
  // outputText опционален не из небрежности: прогон может закончиться только
  // tool-вызовом (API-цикл) или abort'ом без финального текста. Потребитель обязан
  // проверять presence, а не кидаться в undefined.
  outputText?: string;
  sessionId?: string | null;
  // session — полный снимок сессии, когда адаптер получил его «бесплатно» из ответа
  // провайдера; sessionId при этом дублируется: потребителям чаще нужен только id,
  // а оба поля опциональны — запуск вне сессий (warmup, discovery) это норма.
  session?: RuntimeSession | null;
  // events — накопленный стрим для НЕ-стриминговых режимов: кто не подписывался на
  // onEvent по ходу прогона, получает журнал постфактум в итоге.
  events?: RuntimeEvent[];
  /**
   * Использование токенов/стоимости этого запуска. ОБЯЗАТЕЛЬНО: адаптеры должны
   * явно вернуть либо объект `RuntimeUsage`, либо `null`. `undefined` недопустим —
   * он молча скрывал бы недостающую реализацию. Адаптеры, чей транспорт
   * не умеет сообщать использование, объявляют `capabilities.usageReporting = "none"`
   * и возвращают здесь `null`.
   */
  // Именно это поле порождает контракт UsageReporting: «неизвестно» здесь не
  // выражается через undefined — только честный null. Разница принципиальна:
  // undefined = «адаптер забыл поле» (баг), null = «данных нет по объективным
  // причинам» (норма, занесённая в descriptor).
  usage: RuntimeUsage | null;
  // raw — «черный ящик» провайдера: полный ответ/снимок для отладки и глубоких
  // потребителей (импорт истории Claude). unknown заставляет потребителя самому
  // сужать тип с проверками — сознательная цена за гибкость.
  raw?: unknown;
  // toolCalls — если модель закончила ход вызовами функций, это её главный результат:
  // хост-исполнитель (supportsToolCalling) обязан открутить цикл tool -> result ->
  // resume, иначе история останется висять на незавершённом вызове.
  toolCalls?: RuntimeToolCall[];
  // finishReason — вердикт провайдера о причине остановки (stop/length/content_filter);
  // широкая строка, а не union: значения чужих API меняются без спроса, система лишь
  // логирует их и не принимает по ним решений уровня бизнес-логики.
  finishReason?: string | null;
}

/**
 * Извлекает идентификатор сессии из результата запуска с учётом возможностей runtime.
 * Возвращает null, если runtime не поддерживает сессии или в результате нет сессии.
 */
// Небольшой, но важный хелпер: без него каждый потребитель сам решал бы, читать ли
// result.sessionId или result.session?.id, и где-нибудь обязательно ошибся бы.
// Проверка capabilities в начале — защита от адаптеров, которые возвращают id
// «на всякий случай», даже не поддерживая сессии: система тогда не начинает держать
// ссылку на сессию, которая не может быть продолжена.
export function getResultSessionId(
  result: RuntimeRunResult,
  capabilities?: RuntimeCapabilities,
): string | null {
  if (capabilities && !capabilities.supportsResume && !capabilities.supportsSessionList) {
    return null;
  }
  return result.sessionId ?? result.session?.id ?? null;
}

// Семейство Input-интерфейсов для сессионных запросов. Общность формы (runtimeId +
// profileId + transport + headers/options) — не случайность: эти поля образуют
// «координаты подключения» к рантайму, одинаковые для любого действия. Опциональные
// profileId/transport нужны для вызовов вне контекста сохранённого профиля (например,
// системный профиль из ENV).
export interface RuntimeSessionListInput {
  // limit — pagination: провайдеры могут хранить тысячи сессий, UI показывает
  // последнюю страницу; отсутствие limit означает «сколько вендор отдаст по умолчанию».
  runtimeId: string;
  providerId?: string;
  profileId?: string | null;
  projectRoot?: string;
  transport?: RuntimeTransport;
  limit?: number;
  options?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface RuntimeSessionGetInput {
  runtimeId: string;
  providerId?: string;
  profileId?: string | null;
  projectRoot?: string;
  transport?: RuntimeTransport;
  sessionId: string;
  options?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface RuntimeSessionEventsInput extends RuntimeSessionGetInput {
  // Наследование от Get-входа: список событий — это «тот же запрос, но с pagination»,
  // различие только в limit. Держать два почти идентичных интерфейса — путь к дрейфу.
  limit?: number;
}

// Усечённая копия run-входа: только то, что нужно чтобы «постучаться» к провайдеру.
// Отсутствие prompt подчёркивает семантику: validateConnection — проверка
// конфигурации и сети, а не генерация; реальные запросы здесь не выполняются.
export interface RuntimeConnectionValidationInput {
  runtimeId: string;
  providerId?: string;
  profileId?: string | null;
  model?: string;
  transport?: RuntimeTransport;
  options?: Record<string, unknown>;
}

export interface RuntimeConnectionValidationResult {
  // ok — машиночитаемый вердикт для readiness-дэшбордов; message — человекочитаемое
  // пояснение, которое можно показать в UI без перевода. details — сырые данные
  // провайдера для диагностики (латency, код ошибки), формат не стандартизирован.
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export interface RuntimeModel {
  // id уходит в запросы, label — только для отображения: вендоры любят длинные
  // маркетинговые имена, а выбор пользователя должен сериализоваться коротким id.
  id: string;
  label?: string;
  supportsStreaming?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RuntimeModelListInput {
  // Здесь виден разрыв абстракций: profileId ведёт к БД, а baseUrl/apiKey — к
  // моментальному подключению. Разрешитель профиля (resolution.ts) может решить,
  // что ключ лежит в ENV с другим именем, — и передать итоговое значение сюда.
  // apiKey — уже разыменованный секрет: поле живёт только в памяти процесса и никогда
  // не сериализуется в логи (см. redactResolvedRuntimeProfile в resolution.ts).
  runtimeId: string;
  providerId?: string;
  profileId?: string | null;
  projectRoot?: string;
  model?: string;
  transport?: RuntimeTransport;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  baseUrl?: string | null;
  apiKeyEnvVar?: string | null;
  apiKey?: string | null;
}

export interface RuntimeMcpInput {
  // Имя сервера — стабильный ключ в клиентских конфигах (claude.json, config.toml);
  // все три MCP-метода адаптера оперируют им, поэтому оно единственное обязательное.
  serverName: string;
}

// Размеченное объединение (discriminated union) по полю transport: stdio-вариант
// описывает локальный запуск команды, streamable_http — удалённый URL. Приём
// `url?: never` запрещает передавать поля чужого варианта: без него лишний ключ
// молча проскочил бы структурную проверку типов, и адаптер получил бы противоречивый
// вход. Switch по transport в адаптере получает исчерпывающую типизацию вариантов.
// Два взаимоисключающих варианта установки MCP-сервера. stdio: клиент сам запускает
// локальный процесс (command+args+env) — доверенный сценарий одного машина. http:
// удалённый endpoint с bearer-токеном через ENV — формат, который пишут в конфиги
// Codex/Claude инсталляторы. Кросс-поля закрыты never: stdio-вариант физически не
// может притащить url, и наоборот — противоречивый вход не пройдёт компиляцию.
export type RuntimeMcpInstallInput =
  | (RuntimeMcpInput & {
      transport?: "stdio";
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      url?: never;
      bearerTokenEnvVar?: never;
    })
  | (RuntimeMcpInput & {
      transport: "streamable_http";
      url: string;
      bearerTokenEnvVar?: string;
      command?: never;
      args?: never;
      cwd?: never;
      env?: never;
    });

export interface RuntimeMcpStatus {
  // installed отдельно от config: UI показывает статус без чтения клиентских файлов
  // настроек целиком — config отдаётся только когда он действительно нужен.
  installed: boolean;
  serverName: string;
  config?: Record<string, unknown> | null;
}

export interface RuntimeDiagnoseErrorInput {
  // error: unknown, а не Error — в JS бросают что угодно (строки, объекты), и контракт
  // обязан это выдерживать; stderrTail — хвост потока ошибок subprocess, часто именно
  // там первопричина (отсутствующий бинарник, отказ OAuth), а не в самом исключении.
  error: unknown;
  stderrTail?: string;
  projectRoot?: string;
}

/**
 * Интерфейс Runtime-адаптера.
 *
 * ## Обязательное
 * - `descriptor` — статические метаданные: id, provider, capabilities, lightModel
 * - `run()` — выполнить промпт и вернуть результат
 *
 * ## Необязательное — под gate возможностей
 * Реализуйте их, когда флаги `descriptor.capabilities` истинны:
 * - `resume()` — возобновить существующую сессию (supportsResume)
 * - `forkSession()` — Форк сессии в дочерний запуск (supportsSessionFork)
 * - `listSessions()` / `getSession()` / `listSessionEvents()` — управление сессиями (supportsSessionList)
 * - `listModels()` — перечислить доступные модели (supportsModelDiscovery)
 * - `validateConnection()` — health check для readiness-эндпоинта
 *
 * ## Необязательное — удобства
 * - `diagnoseError()` — человекочитаемое объяснение из ошибки адаптера + stderr
 * - `sanitizeInput()` — срезать специфичные для runtime внутренние теги из сообщений пользователя
 *
 * ## Конвенция структуры файлов адаптера
 * ```
 * adapters/<name>/
 *   index.ts    — фабрика: create<Name>RuntimeAdapter(options)
 *   errors.ts   — классификация ошибок (наследники RuntimeExecutionError)
 *   <transport>.ts — логика запуска по транспортам (например cli.ts, api.ts, stream.ts)
 *   [optional]  — hooks.ts, sessions.ts, diagnostics.ts, options.ts
 * ```
 */
// Центральный контракт пакета: всё остальное вранье без него не существует. Обязательных
// членов ровно два — descriptor (метаданные) и run() (единственное действие, которое
// гарантированно умеет любой адаптер). Всё прочее — опциональные методы с суффиксом `?`:
// TypeScript заставляет проверяющий код учитывать возможность их отсутствия, а
// capabilities-флаги описывают, будет ли он отсутствовать практически.
export interface RuntimeAdapter {
  /** Статические метаданные: идентичность и возможности этого runtime. */
  descriptor: RuntimeDescriptor;

  // --- Ядро (обязательное) ---

  /** Выполнить промпт. Это единственный обязательный метод. */
  // Единственная гарантированная точка входа. Любая логика системы в итоге сводится
  // к вызову run() с заполненным usageContext — остальное лишь уточнения намерений.
  run(input: RuntimeRunInput): Promise<RuntimeRunResult>;

  /**
   * Вернуть эффективные возможности для конкретного Транспорта runtime.
   * Адаптеры с несколькими транспортами, различающимися возможностями,
   * реализуют его, чтобы система знала, что доступно на каждом транспорте.
   * Без реализации откатывается к `descriptor.capabilities`.
   */
  // Зачем: флаг «на весь адаптер» врёт, когда возможности расходятся по транспортам
  // (у Codex CLI умеет resume через файлы сессий, а чистый API — нет). Нереализованный
  // метод — норма для одно-транспортных адаптеров, отсюда необязательность.
  getEffectiveCapabilities?(transport: RuntimeTransport): RuntimeCapabilities;

  // --- Управление сессиями (необязательное, под gate возможностей) ---

  // Блок сессий целиком следует правилу «флаг -> метод»: методы типизированы как
  // опциональные (`resume?` и т.д.), и TypeScript не даст вызвать их без проверки
  // на undefined — то есть без осознанного решения. Даже «случайный» вызов
  // listSessions на OpenRouter становится ошибкой компиляции, а не рантайма.
  /** Возобновить существующую сессию (Возобновление сессии). Gate: supportsResume. */
  resume?(input: RuntimeRunInput & { sessionId: string }): Promise<RuntimeRunResult>;
  /** Форк сессии: ответвить исходную сессию в дочерний запуск. Gate: supportsSessionFork. */
  forkSession?(input: RuntimeSessionForkInput): Promise<RuntimeRunResult>;
  /** Перечислить последние сессии. Gate: supportsSessionList. */
  // list*/getSession возвращают канонический RuntimeSession, а не сырой формат
  // провайдера: конвертация — ответственность адаптера, единообразие — системы.
  listSessions?(input: RuntimeSessionListInput): Promise<RuntimeSession[]>;
  /** Получить одну сессию по идентификатору. Gate: supportsSessionList. */
  // Возврат null вместо «нет» — осознанно: отсутствие сессии это штатный кейс
  // (пользователь удалил историю в CLI), исключение здесь было бы шумом.
  getSession?(input: RuntimeSessionGetInput): Promise<RuntimeSession | null>;
  /** Перечислить сообщения/события внутри сессии. Gate: supportsSessionList. */
  listSessionEvents?(input: RuntimeSessionEventsInput): Promise<RuntimeEvent[]>;

  // --- Discovery и проверка соединений (необязательное) ---

  // Ветер readiness-проверки: readiness.ts обходит все зарегистрированные рантаймы
  // и зовёт validateConnection, чтобы UI показал «что настроено и работает».
  /** Проверить, доступен ли runtime и настроен ли он. */
  validateConnection?(
    input: RuntimeConnectionValidationInput,
  ): Promise<RuntimeConnectionValidationResult>;
  /** Перечислить доступные модели. Gate: supportsModelDiscovery. */
  // listModels кормит не только UI-селектор: effort-валидация в реестре тоже зовёт
  // его (через discovery-сервис с кэшем), поэтому адаптерам нельзя требовать
  // интерактивного входа за этот список.
  listModels?(input: RuntimeModelListInput): Promise<RuntimeModel[]>;

  // --- Удобства (необязательное) ---

  /** Диагностика ошибок конкретного адаптера — человекочитаемое объяснение из ошибки + stderr. */
  diagnoseError?(input: RuntimeDiagnoseErrorInput): Promise<string>;
  /** Срезать специфичные для runtime внутренние теги/разметку из пользовательского ввода перед хранением. */
  // sanitizeInput — «анти-инъекция» наоборот: адаптерские runtime-теги (например
  // маркеры системных сообщений Claude), попав в чужой рантайм, превращаются в мусор
  // контекста. Снятие тегов до хранения сохраняет историю переносимой между средами.
  sanitizeInput?(text: string): string;

  // --- MCP-интеграция (необязательное) ---

  // Три метода-«двойника» для инсталлятора handoff-сервера: адаптер сам знает,
  // где живёт его конфиг (~/.claude.json vs ~/.codex/config.toml) и в каком формате,
  // поэтому система не заводит централизованного редактора чужих файлов настроек.
  /** Инициализировать структуру каталогов проекта для runtime через ai-factory init. */
  // Синхронный void, единственный во всём интерфейсе: init пишет файлы локально,
  //await здесь не за чем — и вызывающий код (проект-визард) не должен строить
  // ложные ожидания про асинхронность.
  initProject?(projectRoot: string): void;

  /** Текущий статус установки MCP-сервера для этого runtime. */
  getMcpStatus?(input: RuntimeMcpInput): Promise<RuntimeMcpStatus>;
  /** Установить MCP-сервер в конфигурацию этого runtime. */
  installMcpServer?(input: RuntimeMcpInstallInput): Promise<void>;
  /** Удалить MCP-сервер из конфигурации этого runtime. */
  uninstallMcpServer?(input: RuntimeMcpInput): Promise<void>;

  /**
   * Порт стратегии нативных субагентов (Codex). Опциональная «выносная» логика:
   * promptPolicy достигает её через этот порт, а не импортом `adapters/**`, чтобы
   * ядро не зависело от конкретного адаптера (Task 11). Адаптеры без нативных
   * субагентов порт не объявляют — политика работает с не-Codex умолчанием.
   */
  subagentStrategy?: RuntimeSubagentStrategyPort;
}

/**
 * Порт стратегии нативных субагентов, который адаптер может объявить, чтобы
 * promptPolicy не импортировала `adapters/**`. Ядро работает только с этими
 * полями/методами; конкретный адаптер (Codex) владеет реализацией.
 */
export interface RuntimeSubagentStrategyPort {
  /** Имя native-стратегии (значение-литерал "native"). */
  nativeStrategy: string;
  /** Резолвер стратегии: native/isolated/null по рантайму, опциям и env-флагу. */
  resolveStrategy(
    runtimeId: string,
    runtimeOptions?: Record<string, unknown>,
    options?: { nativeSubagentsEnabled?: boolean },
  ): RuntimeSubagentStrategyResolution;
  /** Готовность нативных ассетов проекта; null = «не применимо». */
  resolveReadiness(projectRoot?: string | null): RuntimeSubagentReadiness | null;
  /** Инструкция-хвост для субагента по типу workflow. */
  getGuidance(workflowKind: string): string;
}

/** Резолвер-результат стратегии (зеркало CodexSubagentStrategyResolution). */
export interface RuntimeSubagentStrategyResolution {
  strategy: string | null;
  reason: string;
  configuredValue?: string;
  nativeSubagentsEnabled: boolean;
}

/** Готовность нативных ассетов проекта (зеркало CodexNativeSubagentReadiness). */
export interface RuntimeSubagentReadiness {
  ready: boolean;
  missingPaths: string[];
}

/**
 * Получить эффективные возможности адаптера, при желании — для конкретного транспорта.
 *
 * Адаптеры с несколькими наборами возможностей реализуют
 * `getEffectiveCapabilities(transport)`. Если транспорт передан и метод
 * реализован, возвращаются транспорт-специфичные возможности.
 * Иначе — откат к статичным `descriptor.capabilities`.
 */
// Функция-помощник, а не метод интерфейса: логика «транспорт переопределяет
// дескриптор» повторялась бы в десятках мест вызова, а здесь она сказана один раз.
// Порядок приоритета: транспортно-специфичные возможности -> статические из descriptor.
// Без этой функции многотранспортный Codex (CLI без resume, API без стрима) не смог бы
// честно описать себя одним набором флагов.
export function resolveAdapterCapabilities(
  adapter: RuntimeAdapter,
  transport?: RuntimeTransport,
): RuntimeCapabilities {
  if (transport && adapter.getEffectiveCapabilities) {
    return adapter.getEffectiveCapabilities(transport);
  }
  return adapter.descriptor.capabilities;
}
