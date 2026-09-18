/**
 * Публичный API пакета @aif/runtime (barrel-файл).
 *
 * Этот файл - единственная витрина пакета: всё, что видят api и agent,
 * проходит через него. Границы важны по двум причинам:
 *
 * 1. Инкапсуляция. Внутренние детали (адаптеры, парсеры, кэши) не должны
 *    просачиваться в потребителей: иначе рефакторинг внутри пакета ломает чужой
 *    код, и пакет теряет независимость от своих клиентов.
 * 2. Направление зависимостей. Потребители работают с абстракциями (RuntimeAdapter,
 *    RuntimeRegistry, контракты ошибок), а не с конкретными провайдерами. Поэтому
 *    factories адаптеров намеренно НЕ реэкспортируются значениями (см. блок
 *    перед адаптерными типами в конце файла) - только их типы для конфигурации.
 *
 * Группировка ниже повторяет модули пакета: контракты (./types.js) - ядро,
 * затем инфраструктура (errors, registry, capabilities, cache, timeouts),
 * затем сервисы (discovery, resolution, limitState, workflowSpec) и в конце
 * точечные экспорты вспомогательных модулей и адаптеров.
 *
 * Разница export и export type: первый уходит в рантайм-бандл, второй виден
 * только компилятору. Здесь это различие соблюдается осознанно: интерфейсы и
 * псевдонимы типов - через export type, а enum'ы и константы (значения, по ним
 * сравнивают в рантайме) - обычным export.
 */

// Ядро контрактов: интерфейс адаптера, capabilities, формы ввода/вывода запуска,
// события, сессии, лимиты и usage. Всё остальное в пакете надстраивается над
// этими типами, поэтому они идут первыми и их больше всего.
// Обрати внимание: RuntimeAdapter здесь экспортируется как type, а не значение -
// это интерфейс, конкретную реализацию потребители получают только через registry.
export {
  DEFAULT_RUNTIME_CAPABILITIES,
  getResultSessionId,
  resolveAdapterCapabilities,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeConnectionValidationInput,
  type RuntimeConnectionValidationResult,
  type RuntimeDescriptor,
  type RuntimeDiagnoseErrorInput,
  type RuntimeMcpInput,
  type RuntimeMcpInstallInput,
  type RuntimeMcpStatus,
  type RuntimeEvent,
  type RuntimeExecutionIntent,
  type RuntimeConversationMessage,
  type RuntimeToolCall,
  type RuntimeToolDefinition,
  // Кластер лимитов: enum'ы (RuntimeLimitPrecision/Scope/Source/Status) - это
  // значения: по ним сериализованные снимки сравнивают и ранжируют в рантайме,
  // поэтому export type для них был бы фатальной ошибкой - типов бы не хватило
  // на стороне клиента.
  type RuntimeLimitEventPayload,
  RuntimeLimitPrecision,
  RuntimeLimitScope,
  type RuntimeLimitSnapshot,
  RuntimeLimitSource,
  RuntimeLimitStatus,
  type RuntimeLimitWindow,
  RUNTIME_LIMIT_EVENT_TYPE,
  // Callback'и живого прогона: адаптер зовёт их по мере появления tool-use и
  // «вопрос агенту» - так UI показывает прогресс, не дожидаясь финального
  // RuntimeRunResult.
  type RuntimeSubagentStartCallback,
  type RuntimeToolQuestionPayload,
  type RuntimeToolUseCallback,
  type RuntimeModel,
  type RuntimeModelListInput,
  type RuntimeRunInput,
  type RuntimeRunResult,
  type RuntimeSession,
  type RuntimeSessionEventsInput,
  type RuntimeSessionForkInput,
  type RuntimeSessionGetInput,
  type RuntimeSessionListInput,
  // Транспорт - единственное место, где enum живёт и как значение (isRuntimeTransport
  // - type guard для разбора внешних данных), и как тип (полю профилей). Оба
  // экспорта нужны: только-тип не дал бы ни функции, ни множества значений.
  isRuntimeTransport,
  RUNTIME_TRANSPORTS,
  RuntimeTransport,
  // Usage-контракт: расход токенов/стоимость. UsageReporting и UsageSource - тоже
  // значения enum'ов, участвующие в ранговой логике отчётов.
  type RuntimeUsage,
  type RuntimeUsageContext,
  UsageReporting,
  UsageSource,
} from "./types.js";

// Sink - «приёмник» usage-событий: колбэк-абстракция, через которую данные об
// употреблении токенов утекают в базу/метрики. createNoopUsageSink - заглушка по
// умолчанию: потребитель не обязан настраивать учёт, и отсутствие sink не должно
// разваливать запуск.
export { createNoopUsageSink, type RuntimeUsageEvent, type RuntimeUsageSink } from "./usageSink.js";

// toolEvents: нормализация «сырых» tool-use сигналов адаптеров в единый формат
// событий. Экспортируется и входной тип BuildToolUseEventsInput: без него вызов
// из другого пакета был бы ручным конструированием непроверяемой структуры.
export {
  buildToolUseEvents,
  toolQuestionEvent,
  type BuildToolUseEventsInput,
} from "./toolEvents.js";

// module.js - загрузка ВНЕШНИХ адаптеров (не built-in): контракт модуля и
// регистратор, через который сторонний пакет объявляет себя рантайму. Экспортируется
// только механизм регистрации, сами модули не импортируются - их ищет bootstrap.
export {
  type RegisterRuntimeModule,
  type RuntimeModule,
  resolveRuntimeModuleRegistrar,
} from "./module.js";

// Иерархия ошибок рантайма. Здесь экспортируются и классы (значения, нужны для
// instanceof на стороне потребителя), и помощники классификации. Правило проекта:
// ветвление по ошибкам идёт только по структурированным полям (category,
// adapterCode, httpStatus), а classifyBy* - единственная точка, где «сырая»
// ошибка провайдера превращается в категорию. Поэтому они часть публичного API,
// а не внутренних деталей модуля.
export {
  RuntimeError,
  RuntimeCapabilityError,
  RuntimeExecutionError,
  RuntimeModuleLoadError,
  RuntimeModuleValidationError,
  RuntimeRegistrationError,
  RuntimeResolutionError,
  RuntimeValidationError,
  classifyByHttpStatus,
  classifyByMessageFallback,
  isExternalFailureCategory,
  isRuntimeErrorCategory,
  type RuntimeExecutionErrorMetadata,
  type RuntimeErrorCategory,
} from "./errors.js";

// Реестр адаптеров - точка поиска адаптера по runtimeId. createRuntimeRegistry
// (фабрика, а не класс-синглтон: разные процессы и тесты строят изолированные
// реестры) и сам класс RuntimeRegistry. Logger передаётся как тип-колбэк: реестр
// не тянет зависимость на pino и остаётся переносимым в браузер и тесты.
export {
  createRuntimeRegistry,
  type RegisterRuntimeOptions,
  RuntimeRegistry,
  type RuntimeRegistryLogger,
  type RuntimeRegistryOptions,
} from "./registry.js";

// Двойственность check/assert - осознанная: check-* возвращает результат и подходит
// для UI (нужно показать unsupported, не падая), assert-* бросает исключение и
// используется в пайплайне запуска, где отсутствие возможности фатально.
// Session-fork - отдельная функция: это редкая capability со своей логикой
// смягчения (SkipReason), и её не мешали в общий список намеренно.
export {
  assertRuntimeCapabilities,
  checkRuntimeCapabilities,
  checkRuntimeSessionForkSupport,
  type RuntimeCapabilityCheckInput,
  type RuntimeCapabilityCheckResult,
  type RuntimeCapabilityName,
  type RuntimeSessionForkSkipReason,
  type RuntimeSessionForkSupportInput,
  type RuntimeSessionForkSupportResult,
} from "./capabilities.js";

// Универсальный TTL-кэш в памяти. Экспортируется фабрика + типы, а не экземпляр:
// каждая подсистема (например, discovery моделей) держит свой кэш со своим TTL,
// общего глобального кэша нет намеренно - слишком разная свежесть у данных.
export { createRuntimeMemoryCache, type RuntimeCache, type RuntimeCacheOptions } from "./cache.js";

// limitState: извлечение и нормализация снимков rate-limit из чужих данных
// (события адаптеров, сообщения ошибок). Все функции - чистые «читатели»:
// они не хранят глобальное состояние здесь, состояние живёт в вызывающем слое,
// поэтому набор экспортов - только разбор/подпись/кэширование по содержимому.
export {
  buildRuntimeLimitBroadcastCacheKey,
  buildRuntimeLimitCacheSignature,
  extractLatestRuntimeLimitSnapshot,
  extractRuntimeLimitSnapshotFromError,
  extractRuntimeLimitSnapshotFromEvent,
  observeRuntimeLimitEvent,
} from "./limitState.js";

// Сервис discovery моделей: перечисление моделей провайдера + валидация
// соединения, поверх кэша выше. Опять фабрика (create*), а не синглтон: у каждого
// профиля/рантайма свой экземпляр со своим кэшем и своим logger'ом.
export {
  createRuntimeModelDiscoveryService,
  type RuntimeModelDiscoveryLogger,
  type RuntimeModelDiscoveryOptions,
  type RuntimeModelDiscoveryService,
} from "./modelDiscovery.js";

// Разрешение профиля рантайма (task → project → system → env fallback) и его
// валидация. isValidEnvVarName - публичный, потому что имя env-переменной вводит
// пользователь в UI, и валидировать его нужно ДО обращения к процессу.
// redactResolvedRuntimeProfile - инструмент безопасности: профиль содержит
// секреты, и копия с вырезанными значениями - единственный вариант залогировать
// или отдать профиль наружу без утечки токенов.
export {
  isValidEnvVarName,
  redactResolvedRuntimeProfile,
  resolveRuntimeProfile,
  validateResolvedRuntimeProfile,
  type ResolveRuntimeProfileInput,
  type ResolvedRuntimeProfile,
  type RuntimeProfileLike,
  type RuntimeResolutionEnv,
  type RuntimeResolutionLogger,
  type RuntimeValidationResult,
} from "./resolution.js";

// promptPolicy: что именно отправлять агенту - агент-определение (system prompt)
// или slash-команду. transformSkillCommandPrefix экспортируется отдельно, потому
// что префикс команд нужно уметь разбирать и вне основного policy-пути (например,
// в UI для отображения).
export {
  resolveRuntimePromptPolicy,
  transformSkillCommandPrefix,
  type RuntimePromptPolicyInput,
  type RuntimePromptPolicyLogger,
  type RuntimePromptPolicyResult,
} from "./promptPolicy.js";

// Спецификация воркфлоу: kind (planning/implement/...), политика переиспользования
// сессии и требуемые capabilities. createRuntimeWorkflowSpec - фабрика, валидирующая
// комбинации: не всякая пара (kind, reuse policy) осмысленна, и это проверяется
// здесь, а не в каждом месте запуска.
export {
  createRuntimeWorkflowSpec,
  type RuntimeWorkflowExecutionMode,
  type RuntimeSessionReusePolicy,
  type RuntimeWorkflowFallbackStrategy,
  type RuntimeWorkflowKind,
  type RuntimeWorkflowPromptInput,
  type RuntimeWorkflowSpec,
  type RuntimeWorkflowSpecInput,
} from "./workflowSpec.js";

// bootstrap - основная точка входа для потребителей: собрать реестр со встроенными
// адаптерами одним вызовом. Именно этот экспорт (а не factories адаптеров) -
// единственный поддерживаемый путь получения адаптера, см. комментарий в конце файла.
export { bootstrapRuntimeRegistry, type BootstrapRuntimeRegistryOptions } from "./bootstrap.js";

// languagePolicy: директива о языке ответа. Экспортируется только build-функция -
// политика простая и stateless, сервис с состоянием не нужен.
export { buildLanguageDirective, type LanguageDirectiveInput } from "./languagePolicy.js";

// projectInit: первичная подготовка проекта под рантайм. Возвращает результат с
// текстом ошибок (InitProjectResult), а не бросает исключения: инициализация -
// пользовательская операция, и «почему не вышло» важнее самого факта неудачи.
export { initProject, type InitProjectOptions, type InitProjectResult } from "./projectInit.js";

// trust.js: «печать» обхода разрешений. Токен - opaque Symbol, существование
// которого нельзя подтвердить перебором строк; единственный способ получить его -
// импортировать из этого пакета. Поэтому наружу отдаётся страж isValidTrustToken,
// а не механизм сравнения «вручную».
export { isValidTrustToken, RUNTIME_TRUST_TOKEN, type RuntimeTrustToken } from "./trust.js";

// timeouts.js: таймауты процессов и потоков. Ключевые детали, вынесенные в API:
// TIMEOUT_RETRIABLE_KEY - маркер в объекте ошибки (вместо pattern matching по
// тексту!), isRetriableTimeoutError читает именно его; sleepMs/resolveRetryDelay -
// общая тактика backoff, чтобы адаптеры не изобретали свои задержки. make*-функции
// строят ошибки с этим маркером: так «можно ли повторить» решается структурой
// ошибки, а не догадками по message.
export {
  isRetriableTimeoutError,
  makeProcessRunTimeoutError,
  makeProcessStartTimeoutError,
  resolveRetryDelay,
  sleepMs,
  TIMEOUT_RETRIABLE_KEY,
  type ProcessTimeoutResult,
  type TimeoutIntent,
  type TimeoutLogger,
  withProcessTimeouts,
  withStreamTimeouts,
} from "./timeouts.js";

// Re-экспорт из @aif/shared: часть limit-контракта (нормализация снимков,
// безопасные причины ошибок, sanitize provider-meta) живёт в shared, потому что
// эти данные пересекают границу пакетов и сериализуются. Перечисление их здесь -
// сознательная фасадная техника: потребитель @aif/runtime получает весь
// limit-контракт из одного места и не заботится, в каком пакете что лежит.
export {
  buildRuntimeLimitSignature,
  mapSafeRuntimeErrorReason,
  normalizeRuntimeLimitSnapshot,
  resolveRuntimeLimitFutureHint,
  sanitizeProviderMeta,
  selectViolatedWindowForExactThreshold,
  type RuntimeLimitFutureHint,
  type RuntimeLimitFutureHintSource,
  type SafeRuntimeErrorCategory,
  type SafeRuntimeErrorReason,
} from "@aif/shared";

/**
 * Фабрики адаптеров намеренно НЕ реэкспортируются из корня пакета.
 *
 * Единственный поддерживаемый способ получить runtime-адаптер — через
 * `bootstrapRuntimeRegistry()` / `createRuntimeRegistry()` → `resolveRuntime()`,
 * который оборачивает каждый адаптер конвейером учёта. Прямой импорт фабрики
 * обходит эту обёртку и молча теряет учёт токенов — внешним потребителям так
 * делать нельзя. Правило ESLint `no-restricted-imports` в корне репозитория
 * запрещает глубокие импорты вида `@aif/runtime/src/adapters/...` вне `packages/runtime/**`.
 */
// По-русски то же самое: типы адаптеров (logger, options) доступны для описания
// конфигурации, а сами create*Factory - нет. Нарушитель, получивший адаптер в обход
// bootstrap, потерял бы учёт токенов без какого-либо шума: именно поэтому граница
// держится не только соглашением, но и ESLint-правилом.
export type {
  ClaudeRuntimeAdapterLogger,
  CreateClaudeRuntimeAdapterOptions,
} from "./adapters/claude/index.js";

export type {
  CodexRuntimeAdapterLogger,
  CreateCodexRuntimeAdapterOptions,
} from "./adapters/codex/index.js";

// Стратегии субагентов Codex (native - делегировать рантайму, isolated - эмулировать
// координатору): выбор стратегии вводится пользователем в опциях профиля, поэтому
// словарь допустимых значений (const-объект, а не просто union типов) - часть
// публичного контракта: внешние конфигурации не должны хардкодить строки наугад.
// Внутри пакета это же импортирует promptPolicy для выбора формы промпта.
export {
  CODEX_SUBAGENT_STRATEGIES,
  CODEX_SUBAGENT_STRATEGY_OPTION,
  getNativeSubagentWorkflowGuidance,
  resolveCodexSubagentStrategy,
  type CodexSubagentStrategy,
} from "./adapters/codex/subagentStrategy.js";
// Файл конфигурации провайдера Codex (каталог codexHome, регистрация провайдера
// по baseUrl): эти примитивы использует сам CLI-адаптер при каждом прогоне, а
// наружу они отдаются для диагностики/настройки профилей. Ограничение «фабрики
// наружу» здесь не действует: это работа с файлами config.toml, а не с объектом
// адаптера в обход usage-пайплайна.
export {
  codexHome,
  ensureCodexProviderConfig,
  providerNameFromBaseUrl,
  type EnsureCodexProviderConfigInput,
} from "./adapters/codex/config.js";

// Чтение журналов сессий Codex (JSONL-файлы на диске): лимит-снимки, метаданные,
// события. Этот пласт специфичного для Codex API вынесен наружу намеренно,
// потому что другие пакеты (agent, api) действительно эти данные запрашивают -
// например, для отображения оставшихся лимитов. Fingerprint'ы (auth, account)
// позволяют отличить сессии одного аккаунта от другого при переключении логинов.
export {
  buildCodexAuthFingerprint,
  classifyCodexSessionFileStatus,
  findCodexSessionFileInfoById,
  getCodexAuthIdentity,
  listCodexSessionFileInfos,
  listLatestCodexLimitSnapshots,
  normalizeCodexProjectPath,
  readCodexSessionEventsFromFile,
  readCodexSessionLimitSnapshotsFromAppend,
  readCodexSessionLimitSnapshotsFromFile,
  readCodexSessionMetaFromFile,
  readCodexSnapshotAccountFingerprint,
  readLatestCodexSessionLimitSnapshotFromFile,
  getLatestCodexModelLimitSnapshot,
  selectPreferredCodexLimitSnapshot,
  type CodexAuthIdentity,
  type CodexAppendLimitSnapshotsResult,
  type CodexIndexedFileState,
  type CodexSessionFileInfo,
  type CodexSessionFileStatus,
  type CodexSessionMeta,
} from "./adapters/codex/sessions.js";
// Идентичность Claude-провайдера (семейство auth: то ли OAuth-подписка, то ли
// API-ключ, то ли локальные настройки). Экспорт и значения-enum'а, и его
// псевдонима как типа (as ClaudeProviderFamilyType) - не дублирование: enum
// живёт в двух вселенных (значение и тип), а псевдоним даёт доступ к именно
// типовой половине без конфликта имён в экспортном списке.
export {
  ClaudeProviderFamily,
  resolveClaudeProviderAuth,
  resolveClaudeProviderIdentity,
  type ClaudeLocalSettingsIdentity,
  type ClaudeProviderFamily as ClaudeProviderFamilyType,
  type ClaudeProviderIdentity,
  type ResolveClaudeProviderIdentityInput,
} from "./adapters/claude/providerIdentity.js";

// Замыкание файла - последовательное повторение одного узора: для каждого
// встроенного адаптера наружу отдаются ТОЛЬКО типы логгера и опций создания.
// Это позволяет api/agent типизировать конфигурацию профиля, не получая в руки
// саму фабрику - см. аннотированный блок выше про usage-пайплайн.
export type {
  CreateOpenCodeRuntimeAdapterOptions,
  OpenCodeRuntimeAdapterLogger,
} from "./adapters/opencode/index.js";

export type {
  CreateOpenRouterRuntimeAdapterOptions,
  OpenRouterAdapterLogger,
} from "./adapters/openrouter/index.js";
