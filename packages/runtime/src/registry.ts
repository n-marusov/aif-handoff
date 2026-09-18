/**
 * RuntimeRegistry — реестр адаптеров исполнителей ИИ.
 *
 * Это единственная точка, через которую весь код системы (api, agent, web-бэкенд)
 * получает адаптер по runtimeId. Реестр решает три задачи:
 *
 * 1. Хранение: Map по нормализованному id, повторная регистрация запрещена без
 *    явного `replace: true` — молчаливая перезапись скрыла бы баг конфигурации.
 * 2. Украшение (decorator): resolveRuntime возвращает не «голый» адаптер, а обёртку
 *    wrapAdapter, которая в одном месте навешивает сквозные заботы: подмену
 *    префикса skill-команд, директиву языка проекта, policy model-effort и запись
 *    расхода токенов в usage-sink. Ни один вызывающий код не может «забыть» это,
 *    потому что проходит через обёртку физически иначе, чем через реестр.
 * 3. Подключаемость: registerRuntimeModule грузит внешние адаптеры динамическим
 *    import() и вызывает из экспортируемую функцию-реграратор — плагин-контракт.
 *
 * Позиция в системе: types.ts задаёт контракты, bootstrap.ts собирает built-in
 * адаптеры, resolution.ts решает, какой профиль применить, а этот файл связывает
 * resolved-профиль с живым объектом адаптера и всей обвязкой.
 */

// Расширение `.js` в относительных импортах при том, что файлы живые `.ts` —
// требование Node-резолвера для ESM: в рантайме модули уже скомпилированы, и import
// обязан указывать на итоговое имя. TypeScript проверяет типы по .ts, а loader
// грузит .js — синтаксис импорта отражает рантайм, а не исходники.
import { getProjectConfig } from "@aif/shared";
// Импорт ошибок по одному имени класса вместо `import * as errors` — осознанный
// выбор: список используемых ошибок виден прямо в импортах, и мёртвая зависимость
// от errors.js заметна при рефакторинге. Каждый из пяти классов отвечает за свой
// слой отказа: регистрация / разрешение / загрузка модуля / валидация модуля /
// исполнение — и вызывающие коды ветвятся по классу, а не по тексту сообщения.
import {
  RuntimeExecutionError,
  RuntimeModuleLoadError,
  RuntimeModuleValidationError,
  RuntimeRegistrationError,
  RuntimeResolutionError,
} from "./errors.js";
import { buildLanguageDirective } from "./languagePolicy.js";
import {
  getRuntimeModelEffortConfig,
  hasConfiguredModelEffort,
  normalizeConfiguredModelEffort,
  stripRuntimeModelEffortMetadata,
  validateRuntimeModelEffort,
} from "./modelEffort.js";
import {
  createRuntimeModelDiscoveryService,
  type RuntimeModelDiscoveryService,
} from "./modelDiscovery.js";
import { resolveRuntimeModuleRegistrar } from "./module.js";
import { transformSkillCommandPrefix } from "./promptPolicy.js";
import type { ResolvedRuntimeProfile } from "./resolution.js";
import {
  resolveAdapterCapabilities,
  UsageReporting,
  type RuntimeAdapter,
  type RuntimeDescriptor,
  type RuntimeModel,
  type RuntimeRunInput,
  type RuntimeRunResult,
  type RuntimeSessionForkInput,
} from "./types.js";
import { createNoopUsageSink, type RuntimeUsageSink } from "./usageSink.js";

// Логгер — не конкретный pino, а минимальный структурный интерфейс: реестр создаётся
// и в api (там pino), и в тестах (там хочется молчание), и в MCP-процессе. DI через
// опцию конструктора вместо глобального логгера держит реестр переносимым.
// Метод error опционален (`error?`) — у части лёгких обёрток его нет, и реестр
// вызывает его только через `log.error?.(...)`, чтобы не падать на неполном логгере.
export interface RuntimeRegistryLogger {
  debug(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

export interface RegisterRuntimeOptions {
  // source — не украшательство: в debug-логе видно, откуда взялся адаптер (built-in,
  // динамический модуль или ручная регистрация в тесте). Без этого отладка
  // «почему здесь два claude» превращается в расследование.
  source?: "builtin" | "module" | "manual";
  // Явный флаг перезамены: по умолчанию повторная регистрация того же id — ошибка.
  // Тестам и горячим перечитываниям модулей нужен escape hatch, но только осознанный.
  replace?: boolean;
}

export interface RuntimeRegistryOptions {
  logger?: RuntimeRegistryLogger;
  // builtInAdapters передаются из bootstrap.ts, а не хардкодятся здесь: так реестр
  // не зависит от конкретного набора адаптеров и остаётся переиспользуемым ядром.
  builtInAdapters?: RuntimeAdapter[];
  /**
   * Sink, принимающий `RuntimeUsageEvent` каждого успешного запуска, адаптер
   * которого вернул ненулевой `usage`. По умолчанию — no-op sink. Процессы API и
   * agent передают sink на БД из `@aif/data`, и каждый LLM-вызов пишется
   * в `usage_events` с агрегацией по задачам/проектам.
   */
  usageSink?: RuntimeUsageSink;
  modelEffortDiscoveryEnabled?: boolean;
}

// Fallback- logger на console.* — осознанный минимум: он не тянет pino в браузерный
// бандл и в процессы, где shared-конфиг логгера недоступен (MCP, скрипты).
// Префиксы в сообщениях ([runtime-registry], [runtime-module]) — чтобы среди логов
// контейнера можно было отфильтровать сообщения реестра одной командой grep.
function createFallbackLogger(): RuntimeRegistryLogger {
  return {
    debug(context, message) {
      console.debug("[runtime-registry]", message, context);
    },
    warn(context, message) {
      console.warn("WARN [runtime-module]", message, context);
    },
    error(context, message) {
      console.error("ERROR [runtime-registry]", message, context);
    },
  };
}

// Ключи реестра нормализуются (trim + lowercase), а не хранятся как в descriptor:
// id профилей приходят из UI, БД и ENV, где регистр и пробелы — обычное дело.
// «Claude», « claude» и «claude» должны указывать на один объект адаптера, иначе
// дубликаты в реестре неизбежны.
function normalizeRuntimeId(runtimeId: string): string {
  return runtimeId.trim().toLowerCase();
}

/**
 * Оборачивает адаптер, чтобы `run()` и `resume()` получали две сквозные заботы
 * в единственном месте, через которое проходит каждый вызов:
 *
 * 1. **Преобразования промптов** — переписывает префиксы skill-команд, чтобы
 *    вызывающим не знать конвенций каждого runtime (например `/aif-plan` → `$aif-plan`).
 * 2. **Конвейер учёта** — читает `result.usage` после каждого успешного запуска и
 *    пересылает в настроенный `RuntimeUsageSink`, сверяя заявленный адаптером
 *    контракт `usageReporting`. Благодаря этому учёт невозможно забыть на
 *    месте вызова: любой новый код с `usageContext` автоматически получает
 *    запись токенов,
 *    а компилятор TypeScript не пропустит вызовы без него.
 */
// Декоратор: возвращаемый объект — тот же RuntimeAdapter, но с перехваченными
// методами. Ключевой архитектурный выбор: обвязка живёт в реестре, а не в каждом
// адаптере, поэтому новый адаптер получает учёт токенов и язык проекта бесплатно,
// не зная об их существовании. Функции-хелперы внутри захватывают adapter, usageSink
// и log замыканием — состояние обёртки не хранится отдельно от вызова.
function wrapAdapter(
  adapter: RuntimeAdapter,
  usageSink: RuntimeUsageSink,
  log: RuntimeRegistryLogger,
  modelEffortDiscoveryEnabled: boolean,
  // Policy-логика живёт в реестре, но передаётся сюда колбэком: wrapAdapter остаётся
  // чистой функцией без ссылки на RuntimeRegistry, и её можно юнит-тестировать с
  // любой подставной policy. Это же позволяет обходить циклическую зависимость
  // «обёртка вызывает реестр, реестр создаёт обёртку».
  applyModelEffortPolicy: (
    adapter: RuntimeAdapter,
    input: RuntimeRunInput,
  ) => Promise<RuntimeRunInput>,
): RuntimeAdapter {
  // Префикс берётся из descriptor один раз при обёртке: если он "/" (Claude) или
  // отсутствует, transformPrompt становится identity и не платит за строковый проход.
  const prefix = adapter.descriptor.skillCommandPrefix;
  const needsPromptTransform = Boolean(prefix) && prefix !== "/";

  function transformPrompt(input: RuntimeRunInput): RuntimeRunInput {
    // Единственная правка промпта на этом уровне: text-in/text-out, без прикосновения
    // к messages/systemPrompt — их семантика принадлежит адаптеру, а префикс команды
    // — общий контракт skill-режима, который система обязана выполнять сама.
    if (!needsPromptTransform) return input;
    // prefix! — единственное место, где не-null assertion здесь оправдан: флаг
    // needsPromptTransform уже гарантирует, что prefix непустой, но TypeScript
    // не выводит это из связи двух переменных — только из локального условия.
    // input возвращается новым объектом (spread), а не мутацией: вызывающий код
    // держит свой RuntimeRunInput и ожидает, что реестр его не тронет. Негласное
    // правило всех обёрток в этом файле — чистота по отношению к аргументам.
    return { ...input, prompt: transformSkillCommandPrefix(input.prompt, prefix!) };
  }

  /**
   * Вставляет директиву о языке проекта в `execution.systemPromptAppend`.
   *
   * Покрывает каждый AI-вызов через реестр — сабагенты, генерация roadmap,
   * генерация коммитов, fast fix, чат, reviewGate — чтобы настройка проекта
   * `language.artifacts` доходила до модели, и каждой точке вызова не нужно
   * помнить о пересылке.
   *
   * Директива добавляется ПОСЛЕ существующего `systemPromptAppend`, чтобы
   * правила scope (project-scope, review-diff-scope) сохранили визуальный
   * акцент. При пустом `artifacts` или `en` директива пуста, и вход
   * возвращается без изменений. Ошибки чтения конфига проглатываются (WARN):
   * языковая подсказка не должна ломать `run()`.
   */
  // try/catch вокруг чтения конфига — принципиальный момент: директива языка
  // украшает промпт, но не участвует в бизнес-логике. Уронить из-за неё рабочий
  // запуск означало бы перепутать местами критичность фич и цены ошибки.
  function applyLanguageDirective(input: RuntimeRunInput): RuntimeRunInput {
    // Без projectRoot спросить некого: язык проекта — часть конфигурации репозитория,
    // а не процесса. Запуски вне проекта (например, глобальные утилиты) идут без директивы.
    const projectRoot = input.projectRoot;
    if (!projectRoot) return input;

    let directive = "";
    try {
      const cfg = getProjectConfig(projectRoot);
      directive = buildLanguageDirective({
        artifacts: cfg.language.artifacts,
        technicalTerms: cfg.language.technical_terms,
      });
    } catch (error) {
      log.warn(
        {
          runtimeId: adapter.descriptor.id,
          projectRoot,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to resolve project language config — skipping language directive injection",
      );
      return input;
    }

    if (!directive) return input;

    // Порядок конкатенации важен: существующий append содержит scope-правила
    // (обзор только diff, проект-скоуп), которые должны остаться ближе к началу
    // системного промпта — языковая директива добавляется после них.
    const existing = input.execution?.systemPromptAppend ?? "";
    const merged = existing ? `${existing}\n\n${directive}` : directive;

    log.debug(
      {
        runtimeId: adapter.descriptor.id,
        projectRoot,
        artifactsLength: merged.length,
      },
      "Injected project language directive into systemPromptAppend",
    );

    return {
      ...input,
      execution: {
        ...input.execution,
        systemPromptAppend: merged,
      },
    };
  }

  // Учёт вызывается только на успешном пути: если adapter.run бросил, до recordUsage
  // дело не доходит — оплаченный впустую retry/timeout не должен искажать агрегаты.
  // Исключения из самого recordUsage не выпускаются наружу: проваленный учёт не имеет
  // права превращать успешный ответ провайдера в ошибку для caller'а.
  function recordUsage(input: RuntimeRunInput, result: RuntimeRunResult): void {
    // Разрешает возможность на транспорте: мульти-транспортные адаптеры (codex
    // с SDK/CLI/API) могут объявлять разные контракты usage-reporting на каждый
    // транспорт. При неизвестном транспорте — откат к default из descriptor.
    // Учёт проверяется по возможностям конкретного транспорта, а не адаптера в
    // целом: у Codex SDK-транспорт может отдавать usage, а CLI — нет, и одно
    // descriptor-флаг здесь был бы либо ложным обвинением, либо ложным оправданием.
    const effectiveCaps = resolveAdapterCapabilities(adapter, input.transport);
    const reporting = effectiveCaps.usageReporting;

    // TypeScript требует `usage: RuntimeUsage | null`, но внешние JS-адаптеры
    // могут вернуть `undefined`, вовсе забыв поле. Для проверки контракта
    // null и undefined одинаковы.
    // Нестрогое `== null` — единственный легитимный случай == в кодовой базе:
    // оно ловит и null, и undefined одним выражением. Строгое === пришлось бы
    // писать дважды, а «забытое» поле — ровно тот JS-кейс, ради которого тут всё.
    if (result.usage == null) {
      if (reporting === UsageReporting.FULL) {
        // Runtime-assert уровня C: адаптер обещал FULL, но вернул
        // null/undefined. Бросить здесь — сломать вызывающему середину запуска,
        // хотя провайдер реально ответил, поэтому громко логируем и идём
        // дальше. Метрика/алерт на этот лог — страховка в production;
        // на dev это ловит контрактный тестовый стенд.
        log.error?.(
          {
            runtimeId: adapter.descriptor.id,
            providerId: adapter.descriptor.providerId,
            usageReporting: reporting,
          },
          "adapter declared usageReporting=FULL but returned null/undefined usage — likely bug in adapter",
        );
      }
      return;
    }

    if (reporting === UsageReporting.NONE) {
      // Обратный случай нарушенного контракта: usage есть там, где его «физически
      // быть не может». Событие при этом записывается — лучше неточный декларированный
      // флаг, чем потерянные реальные токены; но warn сигнализирует, что descriptor
      // отстал от жизни и требует правки.
      log.warn(
        {
          runtimeId: adapter.descriptor.id,
          providerId: adapter.descriptor.providerId,
          usageReporting: reporting,
        },
        "adapter declared usageReporting=NONE but returned non-null usage — descriptor may be stale",
      );
    }

    // Runtime-assert уровня 3: usageContext дан на уровне типов, но каст мог
    // его смыть. Защищаем sink от мусора.
    // Трехслойная защита — не многословие, а разные границы: типы ловят ошибку на
    // этапе компиляции СВОЕГО кода, runtime-проверка — чужого (JS-адаптер, cast из
    // JSON). Убери любой слой — и через год кто-то зальёт в БД события-пустышки.
    const context = input.usageContext;
    if (!context || typeof context.source !== "string" || context.source.length === 0) {
      log.error?.(
        {
          runtimeId: adapter.descriptor.id,
          providerId: adapter.descriptor.providerId,
        },
        "RuntimeRunInput.usageContext.source is required but was missing — usage event dropped",
      );
      return;
    }

    try {
      usageSink.record({
        context,
        runtimeId: adapter.descriptor.id,
        providerId: adapter.descriptor.providerId,
        profileId: input.profileId ?? null,
        // transport/workflowKind/usageReporting пишутся в событие, а не только берутся
        // из input «на память»: агрегаты стоимости разрезаются по профилю, транспорту
        // и типу workflow без join с другими таблицами.
        transport: input.transport,
        workflowKind: input.workflowKind,
        usageReporting: reporting,
        usage: result.usage,
        // recordedAt — момент записи, а не окончания ответа провайдера: для срезов
        // стоимости важна временная метка локального процесса, синхронная с БД-часами.
        recordedAt: new Date(),
      });
    } catch (sinkError) {
      // Контракт sink запрещает бросать, но защита в глубину: ошибка здесь
      // не должна достигать вызывающего, который уже получил результат.
      // Идиома `x instanceof Error ? x.message : String(x)` повторяется в файле
      // осознанно: у catch-переменной тип unknown, и это единственный способ достать
      // текст, не потеряв не-Error броски (строки, объекты) — String() их сериализует
      // в внятный «[object Object>»-в-худшем-случае, undefined тут быть не может.
      log.error?.(
        {
          runtimeId: adapter.descriptor.id,
          error: sinkError instanceof Error ? sinkError.message : String(sinkError),
        },
        "usageSink.record threw — dropping event",
      );
    }
  }

  // Порядок конвейера зафиксирован: prompt-трансформации -> language -> model-effort
  // -> реальный запуск -> учёт. Язык проекта добавляется уже после подмены префикса,
  // чтобы skill-команды в append не исказились; effort-policy идёт последней, потому
  // что видит финальный shape input. Наружу возвращается result без изменений —
  // обёртка ничего не «дописывает» в ответ, только наблюдаема слева.
  async function wrappedRun(input: RuntimeRunInput): Promise<RuntimeRunResult> {
    const transformed = applyLanguageDirective(transformPrompt(input));
    const validated = await applyModelEffortPolicy(adapter, transformed);
    const result = await adapter.run(validated);
    recordUsage(validated, result);
    return result;
  }

  async function wrappedResume(
    input: RuntimeRunInput & { sessionId: string },
  ): Promise<RuntimeRunResult> {
    // Проверка «метод вообще есть» внутри обёртки — defence-in-depth: контракт
    // return-объекта ниже уже гарантирует undefined для отсутствующего resume,
    // но адаптер мог быть заменён/расширен после обёртки, и исключение с внятным
    // текстом лучше тихого «method is not a function» из недр вызова.
    if (!adapter.resume) {
      throw new RuntimeExecutionError(
        `Runtime "${adapter.descriptor.id}" does not implement resume()`,
      );
    }
    const transformed = applyLanguageDirective(transformPrompt(input)) as RuntimeRunInput & {
      sessionId: string;
    };
    // Касты ниже — не подавление ошибок, а возврат сужения: transformPrompt принимает
    // базовый RuntimeRunInput и возвращает его же ширину, а нам нужно донести до
    // adapter.resume обязательный sessionId. Данные при этом не меняются.
    const validated = (await applyModelEffortPolicy(adapter, transformed)) as RuntimeRunInput & {
      sessionId: string;
    };
    const result = await adapter.resume(validated);
    recordUsage(validated, result);
    return result;
  }

  async function wrappedForkSession(input: RuntimeSessionForkInput): Promise<RuntimeRunResult> {
    // Зеркало guarded-логики resume: отсутствие метода проверяется до всякой
    // трансформации промпта — незачем платить строковыми проходами за вызов, который
    // гарантированно не случится.
    if (!adapter.forkSession) {
      throw new RuntimeExecutionError(
        `Runtime "${adapter.descriptor.id}" does not implement forkSession()`,
      );
    }
    const transformed = applyLanguageDirective(transformPrompt(input)) as RuntimeSessionForkInput;
    const validated = (await applyModelEffortPolicy(
      adapter,
      transformed,
    )) as RuntimeSessionForkInput;
    const result = await adapter.forkSession(validated);
    recordUsage(validated, result);
    return result;
  }

  // listModels тоже под обёрткой, хотя ничего не исполняет: фильтрация metadata —
  // тот же класс «сквозная забота», что и учёт. Централизованно её гарантировать
  // надёжнее, чем договориться с каждым адаптером отдельно.
  async function wrappedListModels(
    // Типизация через индирект: Parameters<...>[0] вытаскивает вход listModels из
    // интерфейса, а NonNullable снимает `| undefined` у опционального метода.
    // Если сигнатура контракта изменится, здесь обновляться ничего не будет —
    // тип сожмётся сам. Оператор `!` у adapter.listModels безопасен: обёртка
    // создаётся только когда метод реально есть (см. return ниже).
    input: Parameters<NonNullable<RuntimeAdapter["listModels"]>>[0],
  ) {
    const models = await adapter.listModels!(input);
    // Метаданные effort — служебные для самой системы (какие уровни reasoning умеет
    // модель); в discovery-UI они наружу не нужны, и срезается это здесь, центрированно.
    return modelEffortDiscoveryEnabled ? models : stripRuntimeModelEffortMetadata(models);
  }

  return {
    // Spread адаптера сохраняет все опциональные методы «как есть» (diagnoseError,
    // listSessions и т.д.) — обёртке перехватывать их не нужно. Ниже важен приём
    // `adapter.resume ? wrappedResume : undefined`: если у оригинала метода нет,
    // он обязан остаться отсутствующим, иначе вызывающий код по `'resume' in adapter`
    // решит, что resume поддерживается, и получит рантайм-ошибку вместо graceful
    // деградации. Присутствие метода — часть контракта не меньше его поведения.
    ...adapter,
    run: wrappedRun,
    resume: adapter.resume ? wrappedResume : undefined,
    forkSession: adapter.forkSession ? wrappedForkSession : undefined,
    listModels: adapter.listModels ? wrappedListModels : undefined,
  };
}

// Класс-хранилище, а не модуль-синглтон: в процессе живут несколько независимых
// реестров (prod, тесты, отдельные bootstrap-конфигурации с разными наборами
// адаптеров). Глобальный реестр сделал бы тесты связанными и позволил бы одному
// процессу отравить конфигурацию другого.
export class RuntimeRegistry {
  // Map вместо объекта: нужны порядок обхода (listRuntimes сортирует по id, но
  // стабильный базовый порядок полезен в логах) и честная проверка has/get без
  // рисков прототипа ("__proto__" как ключ в plain-object — готовый баг).
  private readonly adapters = new Map<string, RuntimeAdapter>();
  // readonly поля + инжекция в конструкторе: конфигурация реестра неизменна после
  // создания. Единственная изменяемость — содержимое Map, и только через методы.
  private readonly log: RuntimeRegistryLogger;
  private readonly usageSink: RuntimeUsageSink;
  private readonly modelEffortDiscoveryEnabled: boolean;
  // Ленивая кэшируемая подсервис: discovery-сервис со своим TTL-кэшем нужен только
  // когда effort-проверка включена. null вместо создания в конструкторе экономит
  // кэш и таймеры в каждом процессе, где реестр используется для простого run().
  private modelEffortDiscoveryService: RuntimeModelDiscoveryService | null = null;

  constructor(options: RuntimeRegistryOptions = {}) {
    // ?? а не ||: пустая строка или 0 в опциях — валидные значения, они не должны
    // молча заменяться дефолтом. Зерно здесь: «нет опции» означает именно null/undefined.
    this.log = options.logger ?? createFallbackLogger();
    this.usageSink = options.usageSink ?? createNoopUsageSink();
    // Строгое сравнение с true: неопределённая опция трактуется как «выключено».
    // Фолбэк безопасный — функция включается только по явной конфигурации.
    this.modelEffortDiscoveryEnabled = options.modelEffortDiscoveryEnabled === true;

    // Регистрация built-in'ов происходит в конструкторе: реестр либо полностью
    // рабочий объект, либо не создан вовсе. Полуреестра существовать не может —
    // иначе первая же гонка «создал, но ещё не наполнил» дала бы RuntimeResolutionError
    // на адаптер, который «вот-вот появится».
    if (options.builtInAdapters?.length) {
      this.registerBuiltInRuntimes(options.builtInAdapters);
    }
  }

  // Accessor вместо поля: инкапсулирует ленивую инициализацию, а не просто «if null».
  // Повторные вызовы дёшевы, а кэш моделей живёт в одном экземпляре на реестр —
  // два сервиса имели бы два независимых кэша на один вопрос.
  private getModelEffortDiscoveryService(): RuntimeModelDiscoveryService {
    if (!this.modelEffortDiscoveryService) {
      this.modelEffortDiscoveryService = createRuntimeModelDiscoveryService({
        registry: this,
        // TTL 60 секунд: effort-проверка идёт перед каждым запуском, а список моделей
        // меняется редко. Столько же — кэш соединения discovery: меньше — лишние
        // запросы к провайдеру на каждый run, больше — устаревшие effort-вердикты.
        cacheTtlMs: 60_000,
        logger: this.log,
      });
    }
    return this.modelEffortDiscoveryService;
  }

  // Профиль для discovery строится из входных данных запуска: effort нужно
  // проверять против того же транспорта/ключа, которым реально выполняется run.
  private buildModelEffortDiscoveryProfile(
    adapter: RuntimeAdapter,
    input: RuntimeRunInput,
  ): ResolvedRuntimeProfile | null {
    // Discovery без транспорта невозможен: transport определяет, какой profile-
    // сеттинг вообще осмыслен. null — сигнал «не проверяем», а не ошибка: effort-
    // политика не имеет права валить запуск из-за недоступности own discovery.
    if (!input.transport) {
      return null;
    }

    const options: Record<string, unknown> = {
      // projectRoot добавляется условно: пустая строка в options означала бы «проект
      // в каталоге ""», а отсутствие ключа — «проекта нет». Разница существенна для
      // discovery-адаптеров, читающих локальные конфиги проекта.
      ...(input.options ?? {}),
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
    };
    const effortConfig = getRuntimeModelEffortConfig(input.runtimeId);
    if (effortConfig) {
      // Ключ effort вычитается из options: discovery-профиль — внутренняя копия
      // входных настроек, и effort-ключ в нём только сбивал бы с толку listModels.
      delete options[effortConfig.optionKey];
    }
    // readOption — «приведение к канону»: пустые строки в настройках профиля
    // физически возможны (UI-инпуты), и здесь они становятся null один раз,
    // а не плодятся как truthy-мусор по всему discovery-пути.
    const readOption = (key: string): string | null => {
      const value = options[key];
      return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
    };

    return {
      // source "runtime-execution" помечает, что профиль собран из входных данных
      // запуска, а не из БД: discovery-сервис обязан корректно обрабатывать такие
      // «профили без профиля», иначе effort-проверка не запустится ни разу.
      source: "runtime-execution",
      profileId: input.profileId ?? null,
      runtimeId: input.runtimeId,
      // providerId из input приоритетен: вызывающий слой знает фактического вендора
      // конкретного запуска (профиль может быть переиспользован между вендорами).
      providerId: input.providerId ?? adapter.descriptor.providerId,
      transport: input.transport,
      baseUrl: readOption("baseUrl"),
      apiKeyEnvVar: readOption("apiKeyEnvVar"),
      apiKey: readOption("apiKey"),
      model: input.model ?? null,
      headers: input.headers ?? {},
      options,
    };
  }

  // Полоса препятствий перед каждым run/resume/fork:
  // (1) фича выключена -> вход без изменений; (2) effort не настроен -> без изменений;
  // (3) effort настроен -> пытаемся получить список моделей и валидируем уровень
  // против него. Ключевой принцип: discovery — best effort; его ошибка не отменяет
  // запуск, а лишь понижает проверку до fallback allowlist (см. лог warn ниже).
  // Прерывать прогон LLM из-за недоступности списка моделей — значит делать
  // второстепенное главным.
  private async applyModelEffortPolicy(
    adapter: RuntimeAdapter,
    input: RuntimeRunInput,
  ): Promise<RuntimeRunInput> {
    if (!this.modelEffortDiscoveryEnabled) {
      return input;
    }

    const config = getRuntimeModelEffortConfig(input.runtimeId);
    // Имя опции effort различается у вендоров (codex: model_reasoning_effort, ...),
    // поэтому оно не хардкод, а lookup по runtimeId — та же таблица, что и у
    // strip/validate-функций в modelEffort.ts. null config = рантайм вообще без effort.
    const rawEffort = config ? input.options?.[config.optionKey] : null;
    if (!config || !hasConfiguredModelEffort(rawEffort)) {
      return input;
    }
    // Нормализация до валидного значения: «high» и «HIGH» и « high » — один уровень;
    // дальнейшие сравнения идут уже по канонической форме.
    const configuredEffort = normalizeConfiguredModelEffort(input.runtimeId, rawEffort);

    let models: RuntimeModel[] | null = null;
    const discoveryProfile = this.buildModelEffortDiscoveryProfile(adapter, input);
    // Все четыре условия — не паранойя, а необходимость полного набора данных для
    // честной проверки: настроенный effort + discovery-профиль + конкретная модель
    // + наличие listModels у адаптера. Не хватает любого — models остаётся null,
    // и валидатор сам решает деградировать на allowlist (см. validation.source).
    if (configuredEffort && discoveryProfile && input.model && adapter.listModels) {
      // Один аргумент-контекст с причинами (reasonCode, errorName) вместо двух
      // параметров: этот формат — контракт shared-логгера (pino-style context),
      // и единый стиль по всему пакету важнее экономии пары символов.
      try {
        models = await this.getModelEffortDiscoveryService().listModels(discoveryProfile);
      } catch (error) {
        this.log.warn(
          {
            runtimeId: input.runtimeId,
            providerId: input.providerId ?? adapter.descriptor.providerId,
            profileId: input.profileId ?? null,
            model: input.model,
            reasonCode: "model_effort_discovery_unavailable",
            errorName: error instanceof Error ? error.name : typeof error,
          },
          "Runtime model effort discovery was unavailable; using fallback allowlist",
        );
      }
    }

    const validation = validateRuntimeModelEffort(input, models);
    if (validation.reasonCode) {
      // Невалидный effort не бросается исключением: конфигурация пришла из UI и
      // могла устареть (модель перестала поддерживать уровень). Молча игнорируем
      // неподдерживаемый уровень и оставляем предупреждение с полным контекстом
      // (reasonCode, разрешённые уровни, источник проверки) — по кодам, не по тексту.
      this.log.warn(
        {
          runtimeId: input.runtimeId,
          providerId: input.providerId ?? adapter.descriptor.providerId,
          profileId: input.profileId ?? null,
          model: input.model ?? null,
          configuredEffort: validation.configuredEffort,
          allowedEffortLevels: validation.allowedEffortLevels,
          validationSource: validation.source,
          reasonCode: validation.reasonCode,
        },
        "Ignoring unsupported runtime model effort",
      );
    }

    return validation.input;
  }

  // registerBuiltInRuntime — узкий API для bootstrap-фабрики; снаружи предпочитают
  // ему registerRuntime с source. Отдельное имя нужно, чтобы built-in-путь нельзя
  // было случайно перепутать с ручным зарегистрированием тестового адаптера.
  registerBuiltInRuntime(adapter: RuntimeAdapter): void {
    this.registerRuntime(adapter, { source: "builtin" });
  }

  // Пакетная регистрация — convenience поверх цикла: bootstrap передаёт весь набор
  // built-in адаптеров разом, и отдельный метод избавляет caller'а от своего цикла,
  // в котором легко забыть source: "builtin".
  registerBuiltInRuntimes(adapters: RuntimeAdapter[]): void {
    for (const adapter of adapters) {
      this.registerBuiltInRuntime(adapter);
    }
  }

  // Единая точка входа для всех источников адаптеров. Три решения принимаются здесь:
  // id нормализован и непустой, дубликат не перезаписывается молча, и факт (за)мены
  // уходит в debug-лог с source — откуда именно пришёл этот адаптер.
  registerRuntime(adapter: RuntimeAdapter, options: RegisterRuntimeOptions = {}): void {
    const runtimeId = normalizeRuntimeId(adapter.descriptor.id);
    if (!runtimeId) {
      // Пустой id — мусор в конфиге адаптера; ловится как ошибка регистрации, а не
      // как неожиданное поведение Map с ключом "". Fail fast на входе дешевле,
      // чем отладка «потерянного» адаптера на выходе.
      throw new RuntimeRegistrationError("Runtime adapter descriptor.id cannot be empty");
    }

    const existing = this.adapters.get(runtimeId);
    if (existing && !options.replace) {
      // Дубликат — почти всегда баг конфигурации (модуль загрузился дважды, два
      // профиля названы одним id). Разрешить перезапись молча — значит позволить
      // тихому конфликту; поэтому по умолчанию это исключение.
      throw new RuntimeRegistrationError(`Runtime "${runtimeId}" is already registered`);
    }

    this.adapters.set(runtimeId, adapter);
    // source ?? "manual": вызывающий код может не знать своего источника (ручной
    // тест) — лог честно сохраняет «неизвестно», а не выдумывает «builtin».
    this.log.debug(
      {
        runtimeId,
        providerId: adapter.descriptor.providerId,
        source: options.source ?? "manual",
        replace: Boolean(existing && options.replace),
      },
      "Registered runtime adapter",
    );
  }

  // resolveRuntime — горячий путь: каждая задача получает обёрнутый адаптер здесь.
  // Обёртка создаётся на вызов, а не хранится: это дёшево (несколько замыканий),
  // зато реестр гарантированно использует актуальные usageSink/log настройки, и сам
  // Map остаётся чистым хранилищем оригиналов (listRuntimes отдаёт descriptor'ы без
  // следов декорирования). Caller не может получить «голый» адаптер, даже очень
  // стараясь, — это и есть механизм, делающий учёт/язык/префиксы незабываемыми.
  // Замыкание на this (стрелочная функция) нужно, чтобы policy видела актуальный
  // реестр: wrapAdapter — чистая функция и про реестр ничего не знает (аргумент-колбэк).
  // Метод бросает RuntimeResolutionError — «неизвестный runtimeId» это ошибка,
  // а для «попробовать без исключения» есть tryResolveRuntime ниже.
  resolveRuntime(runtimeId: string): RuntimeAdapter {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    const adapter = this.adapters.get(normalizedRuntimeId);

    if (!adapter) {
      throw new RuntimeResolutionError(`Runtime "${normalizedRuntimeId}" is not registered`);
    }

    this.log.debug({ runtimeId: normalizedRuntimeId }, "Resolved runtime adapter");
    return wrapAdapter(
      adapter,
      this.usageSink,
      this.log,
      this.modelEffortDiscoveryEnabled,
      (resolvedAdapter, input) => this.applyModelEffortPolicy(resolvedAdapter, input),
    );
  }

  // tryResolveRuntime — не «catch-обёртка над resolveRuntime», а отдельная реализация
  // намеренно: семантика «нет адаптера» здесь штатный ответ, а не исключение. Дублирование
  // вызова wrapAdapter — сознательная цена за это разделение (вызывать this.resolveRuntime
  // в try/catch было бы компактнее, но дороже и размыло бы границу «ошибка vs null»).
  tryResolveRuntime(runtimeId: string): RuntimeAdapter | null {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    const adapter = this.adapters.get(normalizedRuntimeId) ?? null;

    if (adapter) {
      this.log.debug({ runtimeId: normalizedRuntimeId }, "Resolved runtime adapter");
    }

    return adapter
      ? wrapAdapter(
          adapter,
          this.usageSink,
          this.log,
          this.modelEffortDiscoveryEnabled,
          (resolvedAdapter, input) => this.applyModelEffortPolicy(resolvedAdapter, input),
        )
      : null;
  }

  // hasRuntime — дешёвый предикат без обёртки: на «есть ли такой?» отвечать через
  // resolveRuntime означало бы создавать замыкания wrapAdapter впустую, а через
  // tryResolveRuntime — ещё и логировать разрешение, которого не было.
  hasRuntime(runtimeId: string): boolean {
    return this.adapters.has(normalizeRuntimeId(runtimeId));
  }

  // listRuntimes возвращает только descriptor'ы, а не адаптеры: наружу не утекают
  // замыкания обёрток и методы, способные выполнить код; UI получает ровно то,
  // что нужно для рендера списка. Сортировка по id — стабильный порядок в combobox'e
  // независимо от порядка регистрации (Map сохраняет insertion order).
  // localeCompare, а не <: порядок не зависит от региона/юникодных тонкостей id.
  listRuntimes(): RuntimeDescriptor[] {
    return [...this.adapters.values()]
      .map((adapter) => adapter.descriptor)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  // removeRuntime возвращает boolean (как Map.delete) — честный ответ «было или
  // не было», чтобы вызывающий код (cleanup в тестах, выгрузка модуля) мог отличить
  // идемпотентный повтор от реального удаления без гонки с hasRuntime().
  removeRuntime(runtimeId: string): boolean {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    const removed = this.adapters.delete(normalizedRuntimeId);
    this.log.debug({ runtimeId: normalizedRuntimeId, removed }, "Removed runtime adapter");
    return removed;
  }

  // Динамическая загрузка внешнего адаптера. moduleSpecifier уходит в import() как
  // есть: esbuild/tsx резолвят specifier в момент сборки/запуска, а переменная здесь
  // обязана быть не-литеральной — иначе бандлер не сможет оставить динамический импорт.
  // Две разные ошибки (load vs validation) не случайны: «модуль не найден» и
  // «модуль есть, но не-адаптер» требуют разного лечения, и смешивать их в логгере
  // означало бы годы неправильных диагностик.
  async registerRuntimeModule(moduleSpecifier: string): Promise<void> {
    let moduleExport: unknown;
    try {
      // import() выполнен lazily: модуль-адаптер может тянуть тяжёлые SDK, и
      // loading его заранее (top-level import) раздул бы старт каждого процесса.
      // Тип unknown на выходе — честное «мы ничего не знаем про чужой код»:
      // вся доверка происходит в applyRuntimeModule, а не здесь.
      moduleExport = await import(moduleSpecifier);
    } catch (error) {
      // Cause (второй аргумент) сохраняет исходную ошибку до переупаковки: в логах
      // видно и «не удалось загрузить модуль X», и «почему» (MODULE_NOT_FOUND,
      // синтаксическая ошибка внутри плагина...). Без cause диагностика чужих
      // модулей была бы невозможна.
      this.log.warn({ moduleSpecifier, error }, "Failed to load runtime module");
      throw new RuntimeModuleLoadError(
        `Failed to import runtime module "${moduleSpecifier}"`,
        error,
      );
    }

    await this.applyRuntimeModule(moduleExport, moduleSpecifier);
  }

  // Отдельный метод от registerRuntimeModule: экспорт уже можно получить из своих
  // соображений (e.g. preload, тесты), и валидация не должна требовать файловой
  // доступности модуля. Registrar ищется через resolveRuntimeModuleRegistrar (module.ts)
  // — контракт: модуль экспортирует функцию registerRuntimeModule(registry).
  async applyRuntimeModule(moduleExport: unknown, moduleId = "runtime-module"): Promise<void> {
    // Экспорт ищется, а не вызывается наугад: resolveRuntimeModuleRegistrar проверяет
    // форму (функция с ожидаемым именем) прежде чем передавать control модулю.
    // Неизвестная форма unknown здесь — единственный честный тип для чужого import().
    const register = resolveRuntimeModuleRegistrar(moduleExport);
    if (!register) {
      this.log.warn({ moduleId }, "Invalid runtime module export");
      throw new RuntimeModuleValidationError(
        `Module "${moduleId}" does not export registerRuntimeModule(registry)`,
      );
    }

    // Инверсия управления: модуль сам решает, что регистрировать (один адаптер,
    // несколько, алиасы) — registry лишь предоставляет this как параметр колбэка.
    // Ошибки, thrown из недр модуля, переупаковываются с указанием moduleId,
    // чтобы в стеке было видно, ЧЕЙ код упал, — чужие плагины не должны уметь
    // маскироваться под ошибки платформы.
    try {
      await register(this);
      this.log.debug({ moduleId }, "Registered runtime module");
    } catch (error) {
      this.log.warn({ moduleId, error }, "Failed while executing runtime module");
      throw new RuntimeModuleLoadError(
        `Module "${moduleId}" failed during registerRuntimeModule(registry)`,
        error,
      );
    }
  }
}

// Фабрика вместо прямого new в consumer'ах: оставляет за собой право менять способ
// конфигурации (опции, дефолты, подмена реализации) без правок везде, где реестр
// создаётся. Дешёвая страховка на будущее — пока что просто обёртка над конструктором.
export function createRuntimeRegistry(options: RuntimeRegistryOptions = {}): RuntimeRegistry {
  return new RuntimeRegistry(options);
}
