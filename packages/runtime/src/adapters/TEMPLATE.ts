/**
 * Файл-руководство: живой шаблон для разработки адаптеров рантайма.
 *
 * Роль: TEMPLATE.ts - не исполняемый код (его никто не импортирует), а
 * документация в коде: единая точка, откуда автор нового адаптера узнаёт все
 * обязательные правила проекта - декларацию capabilities (включая контракт
 * usageReporting), обязательную обработку таймаутов, структуру ошибок и
 * требования к синхронизации документации (Runtime Adapter Sync Rule в AGENTS.md).
 *
 * Файл лежит рядом с реализациями (claude/, codex/, opencode/, openrouter/)
 * намеренно: правила, вынесенные в отдельный .md, устаревают незаметно, а это
 * руководство обновляется в том же PR, что и код адаптеров, и потому остаётся
 * правдивым. Скелет внизу - компилируемый TypeScript: опечатки в контрактах
 * видны на сборке, а не при первом деплое.
 *
 * Ниже - английская часть руководства (она для всех). Русские комментарии при
 * каждом разделе объясняют ПРИЧИНУ правила: что именно сломается, если его
 * нарушить.
 */

/**
 * ============================================================================
 * Шаблон Runtime-адаптера
 * ============================================================================
 *
 * Скопируйте этот файл, чтобы создать новый runtime-адаптер. Каждый адаптер
 * подключает систему к своему AI-провайдеру или backend исполнения.
 *
 * Архитектурная идея слоя: минимальный обязательный контракт (descriptor +
 * run()), а всё остальное - факультативные методы, включаемые флагами
 * capabilities. Поэтому новый провайдер добавляется отдельным каталогом в
 * adapters/ и не требует правок общего кода: api, агент и web работают только с
 * интерфейсом RuntimeAdapter и не знают, что у него под капотом. Отсюда и
 * формат "скопируй файл": базового класса-наследника нет намеренно - у каждого
 * провайдера свой жизненный цикл, а общее поведение живёт в хелперах
 * (timeouts.ts, toolEvents.ts), а не в иерархии классов.
 *
 * ## Быстрый старт
 *
 * 1. Создайте `adapters/<name>/index.ts` — скопируйте файл и реализуйте `run()`
 * 2. Создайте `adapters/<name>/errors.ts` — подкласс RuntimeExecutionError
 * 3. Зарегистрируйте в `bootstrap.ts`:
 *    ```ts
 *    builtInAdapters: [
 *      createClaudeRuntimeAdapter(),
 *      createCodexRuntimeAdapter(),
 *      createYourRuntimeAdapter(),  // <-- добавьте здесь
 *    ]
 *    ```
 *    Или загрузите динамически через env-переменную AIF_RUNTIME_MODULES.
 *
 * Порядок шагов отражает зависимости между ними. index.ts даёт системе
 * исполнителя; errors.ts даёт предсказуемую диагностику (без него сырая ошибка
 * провайдера долетает до координатора нечитаемой строкой, и классифицировать её
 * потом нечем); регистрация в bootstrap.ts делает адаптер видимым для реестра -
 * незарегистрированный адаптер не пройдёт readiness-проверку и не сможет быть
 * выбран ни одним профилем.
 *
 * ## Конвенция структуры файлов
 *
 * ```
 * adapters/<name>/
 *   index.ts        — фабрика: create<Name>RuntimeAdapter(options) → RuntimeAdapter
 *   errors.ts       — подкласс ошибки + функция-классификатор
 *   <transport>.ts  — логика по транспортам (например cli.ts, api.ts, sdk.ts)
 *   [sessions.ts]   — если есть supportsSessionList / supportsResume
 *   [diagnostics.ts]— если diagnoseError() требует опроса CLI или анализа stderr
 *   [hooks.ts]      — если в SDK есть система hooks/колбэков
 *   [options.ts]    — если парсинг намерения выполнения сложен
 * ```
 *
 * Разбиение по транспортам - не эстетика: у одного провайдера CLI, SDK и API
 * дают разный набор возможностей, и отдельные файлы честно показывают, какой
 * transport что реализует. Файлы в квадратных скобках создаются только под
 * конкретную capability: лишний модуль надо поддерживать, поэтому скелет
 * держится минимальным. Реестр при этом импортирует только index.ts: транспортные
 * файлы остаются внутренним делом адаптера, и их рефакторинг не задевает
 * потребителей.
 *
 * ## Типы транспортов
 *
 * | Транспорт | Когда использовать                               | Пример        |
 * |-----------|------------------------------------------------|---------------|
 * | SDK       | Вызов библиотеки в процессе (JS/TS SDK)         | Claude Agent SDK, Codex SDK |
 * | CLI       | Запуск подпроцесса, парсинг stdout              | `codex run --json` |
 * | API       | HTTP POST на удалённый эндпоинт                 | REST API, совместимый с OpenAI |
 *
 * Адаптер может поддерживать несколько транспортов (см. адаптер Codex: sdk.ts + cli.ts + api.ts).
 * Транспорт выбирается полем RuntimeProfile.transport.
 *
 * Каждый транспорт - это компромисс. SDK живёт в процессе и отдаёт
 * структурированные события напрямую, но тянет npm-зависимость в сборку и
 * привязан к её версии. CLI повторяет поведение терминала разработчика и не
 * требует библиотеки, зато навязывает парсинг stdout и разбор кодов выхода.
 * API не поднимает процесс, но авторизацию, ретраи и лимиты адаптер реализует
 * сам. Поэтому транспорт выбирается профилем, а не зашивается в адаптер.
 *
 * ## Возможности runtime → отображение на необязательные методы
 *
 * | Возможность               | Включает методы                                       |
 * |-------------------------|-------------------------------------------------------|
 * | supportsResume          | resume()                                              |
 * | supportsSessionFork     | forkSession()                                         |
 * | supportsSessionList     | listSessions(), getSession(), listSessionEvents()     |
 * | supportsModelDiscovery  | listModels()                                          |
 * | supportsAgentDefinitions| execution.agentDefinitionName пробрасывается в SDK     |
 * | supportsStreaming       | execution.onEvent получает дельты потока               |
 * | supportsApprovals       | согласования human-in-the-loop                        |
 * | supportsCustomEndpoint  | profile.baseUrl учитывается                           |
 *
 * Ставьте capabilities в false для нереализованных фич.
 * Система проверяет capabilities ДО вызова необязательных методов.
 *
 * Почему флаги проверяются ДО вызова, а не через try/catch: вызов
 * отсутствующего метода остановил бы workflow посередине выполнения, когда
 * часть работы уже сделана и часть состояния испорчена. capabilities - это
 * данные, доступные заранее: packages/runtime/src/capabilities.ts сверяет
 * нужные утверждения до старта и отказывает явно. Отсюда правило: ложный true
 * опаснее отсутствующей реализации - система будет требовать обещанного, а
 * честный false просто отключит опцию в UI. Часть флагов не добавляет методов,
 * а меняет поведение run(): supportsStreaming обязывает слать onEvent, а
 * supportsAgentDefinitions - пробрасывать имя агента в SDK, и такие обещания
 * проверить ещё труднее, чем наличие метода.
 *
 * ## Возможности runtime с учётом транспорта
 *
 * Если адаптер поддерживает несколько транспортов с разными наборами
 * возможностей, реализуйте `getEffectiveCapabilities(transport)`. Система зовёт
 * `resolveAdapterCapabilities(adapter, transport)` за эффективным набором.
 *
 * ```ts
 * getEffectiveCapabilities(transport: RuntimeTransport): RuntimeCapabilities {
 *   if (transport === RuntimeTransport.SDK) return SDK_CAPS;
 *   if (transport === RuntimeTransport.CLI) return CLI_CAPS;
 *   return DEFAULT_CAPS;
 * }
 * ```
 *
 * `descriptor.capabilities` описывает возможности транспорта по умолчанию.
 *
 * Контракт двух уровней: descriptor.capabilities отвечает на вопрос "что умеет
 * адаптер по умолчанию", getEffectiveCapabilities - "что умеет конкретный
 * транспорт". Реестр вызывает resolveAdapterCapabilities(adapter, transport)
 * перед каждым прогоном, включая проверку контракта usageReporting (см.
 * recordUsage в registry.ts). Если уровни перепутать, пользователь выберет
 * транспорт без обещанной опции и упрётся в runtime-ошибку там, где можно было
 * отказать ещё на старте.
 *
 * ## Чтение execution-опций в run()
 *
 * ```ts
 * async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
 *   const exec = input.execution;            // RuntimeExecutionIntent | undefined
 *   const prompt = input.prompt;
 *   const model = input.model;               // из профиля/override/env
 *   const projectRoot = input.projectRoot;
 *
 *   // Универсальные опции (доступны любому адаптеру):
 *   exec?.maxBudgetUsd       // лимит стоимости
 *   exec?.maxTurns           // лимит итераций
 *   exec?.startTimeoutMs     // таймаут первого вывода
 *   exec?.runTimeoutMs       // жёсткий таймаут всего запуска
 *   exec?.systemPromptAppend // добавка к system prompt
 *   exec?.environment        // env-переменные подпроцесса
 *   exec?.abortController    // сигнал отмены
 *   exec?.bypassPermissions  // обход проверок разрешений (нужен Токен доверия в hooks)
 *
 *   // Lifecycle-колбэки (fire-and-forget):
 *   exec?.onToolUse?.(toolName, detail)       // после каждого вызова инструмента
 *   exec?.onSubagentStart?.(name, id)         // при старте сабагента
 *   exec?.onStderr?.(chunk)                   // stderr подпроцесса
 *   exec?.onEvent?.(event)                    // потоковые события
 *
 *   // Специфичное для адаптера (непрозрачный мешок):
 *   const hooks = exec?.hooks ?? {};
 *   // Читайте из hooks всё, что нужно вашему адаптеру.
 *   // Например: hooks._trustToken, hooks.settingSources и т.п.
 * }
 * ```
 *
 * Поля intent разделены на три слоя по признаку "кто понимает смысл".
 * Generic-поля (maxTurns, maxBudgetUsd, таймауты) одинаково значимы для любого
 * провайдера, поэтому координатор заполняет их, не зная про адаптер; отмена
 * идёт через abortController, и игнорирование сигнала лишает пользователя
 * возможности остановить прогон. Lifecycle-колбэки - fire-and-forget:
 * подписчик не должен уметь остановить работу, и адаптер не ждёт его возврата.
 * А hooks - намеренно непрозрачный меш: провайдер-специфичные вещи (трастовый
 * Symbol-токен для bypassPermissions из trust.ts, sources настроек) не попадают
 * в общий контракт и не связывают руки остальным адаптерам. Symbol-форма
 * токена не случайна: подделать его извне нельзя, поэтому обход разрешений
 * остаётся прерогативой доверенных внутренних вызывающих.
 *
 * ## Выдача tool-событий (ОБЯЗАТЕЛЬНО для адаптеров с вызовами инструментов)
 *
 * Используйте runtime-нейтральные хелперы из `../../toolEvents.js`, чтобы все адаптеры
 * выдавали одинаковую форму событий `tool:use` и `tool:question`:
 *
 * ```ts
 * import { buildToolUseEvents } from "../../toolEvents.js";
 * import { parseMyProviderQuestion } from "./questions.js"; // ваш парсер
 *
 * for (const event of buildToolUseEvents({
 *   toolName: item.name,
 *   toolUseId: item.id ?? null,
 *   input: item.input,
 *   timestamp: new Date().toISOString(),
 *   questionPayload: parseMyProviderQuestion(item.name, item.id ?? null, item.input),
 * })) {
 *   exec?.onEvent?.(event);
 * }
 * ```
 *
 * Если у провайдера есть интерактивный инструмент «спросить пользователя», напишите
 * парсер, возвращающий `RuntimeToolQuestionPayload` (нормализованная форма: вопрос,
 * необязательный header и options[]); иначе передавайте `questionPayload: null`
 * и будет выдано только событие `tool:use`.
 *
 * Единая форма события - это то, что позволяет потребителям (WebSocket-мост,
 * канбан-доска, чат) не иметь веток "если провайдер такой-то". Адаптер, который
 * сам лепит JSON с другой формой, тихо ломает ленту инструментов в UI.
 * Нормализация вопроса - часть того же контракта: у каждого провайдера
 * интерактивный инструмент выглядит по-своему, но наружу обязан выйти
 * RuntimeToolQuestionPayload (вопрос + options[]), иначе чат не сможет
 * отрендерить варианты ответов одинаково для всех рантаймов.
 *
 * ## Обработка таймаутов (ОБЯЗАТЕЛЬНО)
 *
 * Все адаптеры ОБЯЗАНЫ поддерживать параметры таймаутов из `RuntimeExecutionIntent`.
 * Используйте общие утилиты таймаутов из `../../timeouts.js`:
 *
 * Реализация выбрана обёрткой над итератором, а не одним Promise.race на весь
 * цикл: стрим живёт долго, и нужно различать "провайдер молчит" (пауза между
 * событиями) и "прогон идёт слишком долго" (суммарный лимит). Один race на весь
 * прогон выражал бы только второй случай - startTimeoutMs просто негде было бы
 * измерять.
 *
 * ### Потоковые транспорты (SDK/SSE)
 * ```ts
 * import { withStreamTimeouts, isRetriableTimeoutError, resolveRetryDelay, sleepMs } from "../../timeouts.js";
 *
 * // Оборачивает async-итератор с защитами таймаутов
 * const abort = execution?.abortController ?? new AbortController();
 * const wrappedIterator = withStreamTimeouts(rawIterator, {
 *   startTimeoutMs: execution?.startTimeoutMs,
 *   runTimeoutMs: execution?.runTimeoutMs,
 * }, abort);
 *
 * // Потребляйте через for-await — таймауты применяются автоматически
 * for await (const event of wrappedIterator) { ... }
 *
 * // Повтор start-таймаута обрабатывается на уровне вызывающего:
 * try {
 *   return await runAttempt(input);
 * } catch (error) {
 *   if (isRetriableTimeoutError(error)) {
 *     await sleepMs(resolveRetryDelay(input.execution ?? {}));
 *     return runAttempt(input); // единственный повтор
 *   }
 *   throw error;
 * }
 * ```
 *
 * Ретраить разрешено только старт-таймаут: до первого байта провайдер ещё ничего
 * не сделал, и повтор безопасен. Обрыв в середине потока повторять нельзя -
 * часть tool-call уже могла исполниться, и повтор удвоил бы побочные эффекты.
 * Поэтому retry живёт на уровне вызывающего, а не внутри обёртки итератора.
 *
 * ### CLI-транспорты (дочерний процесс)
 * ```ts
 * import { withProcessTimeouts, makeProcessStartTimeoutError, makeProcessRunTimeoutError } from "../../timeouts.js";
 *
 * const timeouts = withProcessTimeouts(child, {
 *   startTimeoutMs: execution?.startTimeoutMs,
 *   runTimeoutMs: execution?.runTimeoutMs,
 * });
 *
 * child.on("close", async () => {
 *   timeouts.cleanup();
 *   if (await timeouts.startTimedOut) { /* повтор или бросок * / }
 *   if (timeouts.runTimedOut) { throw makeProcessRunTimeoutError(runMs); }
 * });
 * ```
 *
 * cleanup() в close - не вежливость, а обязательный шаг: незакрытый таймер
 * удерживает event loop Node (та же причина, что и unref/clearTimeout в
 * withTimeout из @aif/shared), и без него отменённые прогоны оставляли бы
 * висящие таймеры, мешающие штатному завершению процесса.
 *
 * ### HTTP-транспорты (безпотоковый fetch)
 * Для безпотокового HTTP `startTimeoutMs` неприменим (первый байт ≈ полный ответ).
 * Используйте `AbortSignal.timeout(runTimeoutMs)` напрямую в fetch:
 * ```ts
 * const signal = runTimeoutMs > 0 ? AbortSignal.timeout(runTimeoutMs) : undefined;
 * const response = await fetch(url, { ...init, signal });
 * ```
 *
 * Условие runTimeoutMs > 0 - не украшение: AbortSignal.timeout(0) срабатывает
 * немедленно, и наивная передача выключенного лимита превратила бы каждый
 * запрос в мгновенный аборт.
 *
 * **Тест-стража:** интеграционный тест `timeoutCoverage.test.ts` проверяет, что
 * все транспортные файлы адаптеров содержат паттерны таймаутов. Новый адаптер
 * без поддержки таймаутов не пройдёт этот тест.
 *
 * Почему это MANDATORY: конвейер ведёт автономный координатор, и зависший
 * вызов остановил бы задачу навсегда - ни человек, ни следующий этап не узнали
 * бы, что ждать бессмысленно. Отсюда два разных таймаута: startTimeoutMs
 * ловит "мёртвый" провайдер, который так и не начал отвечать (такую попытку
 * разумно повторить один раз - повторный запрос мог пройти), а runTimeoutMs
 * обрывает принципиально долгую работу, где повтор лишь сожжёт бюджет ещё раз.
 * Для non-streaming HTTP start-таймаут не применяют: первый байт там почти
 * равен готовому ответу, и отдельная защита дублировала бы общий лимит.
 *
 * ## Обработка ошибок
 *
 * Создайте подкласс ошибки в errors.ts:
 * ```ts
 * import { RuntimeExecutionError } from "../../errors.js";
 *
 * export class YourRuntimeAdapterError extends RuntimeExecutionError {
 *   public readonly adapterCode: string;
 *   constructor(message: string, adapterCode: string, cause?: unknown) {
 *     super(message, cause);
 *     this.name = "YourRuntimeAdapterError";
 *     this.adapterCode = adapterCode;
 *   }
 * }
 *
 * export function classifyYourRuntimeError(error: unknown): YourRuntimeAdapterError {
 *   const message = error instanceof Error ? error.message : String(error);
 *   // Классификация по паттернам → вернуть конкретный adapterCode
 *   return new YourRuntimeAdapterError(message, "YOUR_RUNTIME_ERROR", error);
 * }
 * ```
 *
 * Важная тонкость Structured Error Classification Rule (AGENTS.md): разбор
 * текста ошибки допустим только ЗДЕСЬ - внутри классификатора, в одном месте.
 * Он превращает неструктурированную ошибку провайдера в структурированную
 * (category из RuntimeErrorCategory + adapterCode), а весь остальной код
 * ветвится только по полям. Причина: тексты ошибок меняются без предупреждения
 * и не локализованы, а разбросанный .includes() по error.message даёт ложные
 * срабатывания, которые не ловит ни один тест. Поэтому подкласс обязан
 * сохранять adapterCode/httpStatus на объекте ошибки.
 *
 * ## Динамическая загрузка модулей
 *
 * Внешние адаптеры загружаются без правки bootstrap.ts:
 *
 * ```
 * AIF_RUNTIME_MODULES=@org/my-runtime-adapter
 * ```
 *
 * Модуль обязан экспортировать `registerRuntimeModule(registry)`:
 * ```ts
 * export function registerRuntimeModule(registry: RuntimeRegistry) {
 *   registry.registerRuntime(createYourRuntimeAdapter());
 * }
 * ```
 *
 * Механизм нужен для деплоя без форка репозитория: закрытый или экспериментальный
 * адаптер живёт в отдельном npm-пакете и подгружается в рантайме (module.ts).
 * Единственное требование к пакету - экспорт registerRuntimeModule: сам модуль
 * решает, что регистрировать, а реестр не различает встроенные и внешние
 * адаптеры, так что все контрактные проверки одинаковы для обоих видов.
 */

// Импорт только из ../types.js: слой рантайма не должен знать про БД, логгер
// api или предметные схемы - иначе адаптер нельзя будет переиспользовать и
// протестировать вне процесса сервера.
import {
  DEFAULT_RUNTIME_CAPABILITIES,
  type RuntimeAdapter,
  type RuntimeModel,
  type RuntimeRunInput,
  type RuntimeRunResult,
} from "../types.js";

// Идентификаторы вынесены в опции, а не зашиты: один и тот же класс адаптера
// регистрируют несколькими экземплярами (разные эндпоинты, тесты, демо-профили),
// а реестру нужен уникальный id - без переопределения второй экземпляр не
// зарегистрировать.
export interface CreateExampleRuntimeAdapterOptions {
  runtimeId?: string;
  providerId?: string;
  displayName?: string;
}

// Фабрика, а не класс: адаптеру не нужно изменяемое состояние между вызовами,
// конфигурация схлопывается в замыкание (runtimeId, providerId), а реестру важно
// только соответствие интерфейсу RuntimeAdapter.
export function createExampleRuntimeAdapter(
  options: CreateExampleRuntimeAdapterOptions = {},
): RuntimeAdapter {
  // Дефолтные id заведомо не совпадают с именами реальных провайдеров:
  // скопированный без правки шаблон не должен конфликтовать в реестре с
  // "claude" или "codex".
  const runtimeId = options.runtimeId ?? "example";
  const providerId = options.providerId ?? "example-provider";

  // Id попадает в БД (runtime_profiles.runtime_id) и в события usage, поэтому
  // после релиза его нельзя менять без миграции: профиль, сохранённый со старым
  // id, перестанет резолвиться в адаптер.
  return {
    // descriptor - только данные, без логики: список доступных рантаймов
    // уходит с этими полями в UI до всякого запуска, поэтому они должны быть
    // сериализуемыми.
    descriptor: {
      id: runtimeId,
      // id - имя исполнителя, providerId - вендор модели: у codex id=codex,
      // а providerId=openai.
      providerId,
      displayName: options.displayName ?? "Example Runtime",
      // Оба поля ставятся парой: инициализация проекта выбирает рантайм по
      // флагу, а имя агента берёт из второго - наполовину заполненная пара
      // сломала бы `ai-factory init`.
      // Задайте оба поля, если runtime должен участвовать в `ai-factory init`.
      // supportsProjectInit: true,
      // projectInitAgentName: "example",
      // lightModel - дешёвая модель для автоматических проверок: review gate
      // в агенте просит именно её; null = "бери модель из профиля".
      lightModel: null, // cheap model for review-gate etc., or null for default
      // Здесь ИМЯ переменной, а не секрет: ключ не хранится ни в БД, ни в
      // профиле, а читается из окружения в момент запуска; placeholder нужен
      // UI, чтобы подсказать, где взять значение.
      defaultApiKeyEnvVar: "MY_API_KEY", // env var name shown in UI placeholder
      defaultModelPlaceholder: "my-model-v1", // model name shown in UI placeholder
      // Список транспортов, которые адаптер реально реализует: профиль с
      // другим транспортом система не позволит выбрать.
      supportedTransports: ["api"], // which transports this adapter handles
      capabilities: {
        // Значения по умолчанию - всё выключено (whitelist): система не
        // потребует незадекларированного, а ложное обещание дороже
        // отсутствующей реализации.
        ...DEFAULT_RUNTIME_CAPABILITIES,
        // Включайте только реализованное:
        // supportsStreaming: true,
        supportsModelDiscovery: true,
        // supportsCustomEndpoint: true,
        // supportsSessionFork: true, // при включении реализуйте forkSession()
        //
        // ОБЯЗАТЕЛЬНО: объявите контракт usage-reporting. DEFAULT_RUNTIME_CAPABILITIES
        // ставит UsageReporting.NONE — переопределите, если транспорт отдаёт
        // счётчики токенов. Варианты:
        //   - UsageReporting.FULL    — всегда возвращает ненулевой `usage` при успехе.
        //                              Обёртка реестра проверяет этот инвариант.
        //   - UsageReporting.PARTIAL — возвращает `usage`, когда провайдер его сообщает,
        //                              на части путей может вернуть null.
        //   - UsageReporting.NONE    — транспорт принципиально не может сообщать usage.
        //
        // Контрактные тесты в bootstrap.test.ts валят сборку, если это поле
        // отсутствует. См. docs/providers.md → "Usage reporting contract".
        // Смысл уровней: NONE снимает обязательства, PARTIAL допускает null на
        // части путей, а FULL проверяется реестром после каждого успешного
        // прогона: recordUsage в registry.ts сравнивает декларацию с фактом и
        // пишет ошибку при расхождении. Сам прогон при этом не рвётся - ответ
        // провайдера уже получен, - но нарушение становится видимым в логах, а
        // не тихой дырой в учёте токенов.
        // usageReporting: UsageReporting.FULL,
        //
        // Опционально: `supportsInteractiveQuestions: true`, если адаптер
        // разбирает нативный интерактивный инструмент вопроса провайдера в
        // runtime-нейтральные события `tool:question` через `buildToolUseEvents()`.
        // Consumers (например, маршрут чата) включают провайдер-специфичные
        // подсказки по этому флагу, чтобы другие runtime не наследовали Claude-каркас.
        // Флаг нужен потребителям, а не адаптеру: чат показывает подсказки про
        // интерактивные вопросы только рантаймам, которые честно их парсят,
        // иначе у других провайдеров появилась бы кнопка, которая ничего не
        // делает.
        // supportsInteractiveQuestions: true,
      },
    },

    // Единственный обязательный метод контракта: всё остальное в объекте
    // адаптера факультативно и включается флагами capabilities.
    async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
      // Реализуйте здесь выполнение вашего runtime.
      // См. раздел «Чтение execution-опций в run()» в JSDoc выше.
      //
      // ВАЖНО: RuntimeRunResult.usage ОБЯЗАТЕЛЕН. Верните либо ненулевой
      // `RuntimeUsage` (когда провайдер сообщает счётчики токенов), либо `null`
      // (когда нет). `undefined` — ошибка типов. Обёртка реестра читает
      // это поле и пересылает в usage sink каждый успешный запуск —
      // вашему адаптеру не нужно самому сохранять usage.
      // Учёт токенов централизован: реестр читает usage из результата и шлёт
      // его в sink, поэтому адаптер не ходит в БД сам (DB boundary в AGENTS.md)
      // и физически не может "забыть" про сохранение.
      // void input - подавление noUnusedParameters на заглушке: параметр обязан
      // быть в сигнатуре, но скелет его не читает.
      void input;
      // Заглушка кидает, а не возвращает пустой результат: случайно
      // зарегистрированный недописанный адаптер виден немедленно и громко.
      throw new Error(`${runtimeId} adapter: run() not implemented`);
    },

    // supportsModelDiscovery включён в скелете, поэтому реализация обязательна
    // даже здесь: именно listModels наполняет список моделей в UI. Discovery
    // кеширует ответы (modelDiscovery.ts), так что метод должен быть дешёвым и
    // идемпотентным при повторных вызовах.
    async listModels(): Promise<RuntimeModel[]> {
      // Контракт metadata: фронт решает, показывать ли регуляторы effort, по
      // supportsEffort и списку уровней, а не по угаданному названию модели.
      return [
        {
          id: "reasoning-model",
          metadata: {
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"],
          },
        },
        {
          id: "non-reasoning-model",
          metadata: {
            supportsEffort: false,
          },
        },
      ];
    },

    // Набор совпадает с таблицей "Capabilities -> optional methods" в шапке:
    // раскомментируется ровно тот метод, под который включён флаг. Мёртвый
    // флаг без метода заметит capabilities.ts или контрактный тест, а не
    // пользователь в проде. Двум стоящим ниже методам суждено ожить почти
    // всегда: validateConnection дёргает API при проверке профиля в UI, а
    // diagnoseError агент вызывает для уже упавшей ошибки, чтобы выдать
    // человеку понятную подсказку (см. subagentQuery.ts).
    // Раскомментируйте и реализуйте по мере включения возможностей:
    //
    // getEffectiveCapabilities(transport) {
    //   // Вернуть возможности конкретного транспорта, если они отличаются от descriptor.capabilities
    //   return this.descriptor.capabilities;
    // },
    // async resume(input) { ... },
    // async forkSession(input) { ... },
    // async listSessions(input) { ... },
    // async getSession(input) { ... },
    // async listSessionEvents(input) { ... },
    // async validateConnection(input) { ... },
    // async diagnoseError(input) { ... },
    // sanitizeInput(text) { return text.trim(); },
  };
}
