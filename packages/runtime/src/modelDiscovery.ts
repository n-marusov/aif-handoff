/**
 * Обнаружение моделей и валидация соединений с TTL-кэшированием.
 *
 * UI настраивает профили рантаймов: выпадающие списки моделей и кнопка
 * «проверить соединение» дёргают провайдера по каждому чиху. Без кэша это
 * и медленно, и вежливо по отношению к rate-limit'ам - отсюда два кэша и
 * один сервис, инкапсулирующий медленный путь наружу.
 *
 * Ключи кэшей - не «runtimeId», а отпечаток всей значимой конфигурации
 * (транспорт, baseUrl, ключ, заголовки, options). Иначе правка профиля
 * молча отдавала бы устаревший список моделей - худший вид кэш-бага, потому
 * что он воспроизводится только у конкретного пользователя.
 *
 * Проектное правило «не ветвиться по тексту ошибок» соблюдено: сбои
 * адаптеров оборачиваются в RuntimeValidationError с сохранением cause -
 * категорийный разбор остаётся на ответственность классов из errors.ts.
 */

// crypto-хэши нужны для отпечатка конфигурации: ключ кэша не должен
// содержать секреты в открытом виде (см. fingerprintResolvedInputs).
import { createHash } from "node:crypto";
import { checkRuntimeCapabilities } from "./capabilities.js";
// Кэш - интерфейс, а не конкретная реализация: сервис принимает кэши извне
// (тесты подсовывают фейки с управляемым временем), а по умолчанию строит
// in-memory реализацию из cache.ts.
import { createRuntimeMemoryCache, type RuntimeCache } from "./cache.js";
import { RuntimeValidationError } from "./errors.js";
// validateResolvedRuntimeProfile - «структурная» проверка конфига без сети;
// адаптерская validateConnection - «живая». Сервис склеивает обе стадии.
// Два импорта из одного модуля: type-only забирает только интерфейс, а
// обычный - функцию. Раздельные строки подчёркивают, что в JS-выходе
// останется ровно один require (только ради функции), - мелочь, но именно
// из таких мелочей складывается zero-overhead абстракция.
import type { ResolvedRuntimeProfile } from "./resolution.js";
import { validateResolvedRuntimeProfile } from "./resolution.js";
import type { RuntimeRegistry } from "./registry.js";
import {
  resolveAdapterCapabilities,
  type RuntimeConnectionValidationResult,
  type RuntimeModel,
} from "./types.js";

// Опциональные методы логгера - стандартный минимализм пакетов runtime:
// вызывается через `?.method?.()`, сервис не зависит от конкретной реализации.
// info здесь не украшение: событие «обнаружено N моделей» - единица
// наблюдаемости для оператора, и debug/warn-сообщения его не заменяют.
export interface RuntimeModelDiscoveryLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

// Опции конструктора сервиса - образец dependency injection «с запасным
// дном»: всё необязательно, а без работы не остаётся никто. В продакшене
// кэши создаются дефолтными, в тестах - подменяются.
export interface RuntimeModelDiscoveryOptions {
  registry: RuntimeRegistry;
  cache?: RuntimeCache<RuntimeModel[]>;
  validationCache?: RuntimeCache<RuntimeConnectionValidationResult>;
  cacheTtlMs?: number;
  logger?: RuntimeModelDiscoveryLogger;
}

// Публичный контракт сервиса ровно двухмерный: «что есть» и «работает ли».
// forceRefresh - обход чтения кэша (не записи!): кнопка «обновить» в UI не
// должна выжигать кэш целиком, только заставить пересчитать этот ключ.
// Сервисный контракт. forceRefresh = false - дефолт параметра (ES2015):
// вызывающий без аргумента получает обычный кэшируемый путь; true - это
// всегда осознанное действие (кнопка refresh), а не забывание параметра.
export interface RuntimeModelDiscoveryService {
  listModels(resolved: ResolvedRuntimeProfile, forceRefresh?: boolean): Promise<RuntimeModel[]>;
  validateConnection(
    resolved: ResolvedRuntimeProfile,
    forceRefresh?: boolean,
  ): Promise<RuntimeConnectionValidationResult>;
}

// Приводит произвольное значение к «канонической» форме перед хешированием.
//
// Зачем: JSON.stringify не стабилен сам по себе - два объекта с одинаковыми
// полями в разном порядке дают разные строки, а Date и bigint вообще
// ломают сериализацию. Функция делает из конфига нормализованное дерево:
// ключи отсортированы, даты в ISO, bigint-ы строками.
//
// Рекурсия безопасна по контракту: на вход подаются поля разрешённого
// профиля (plain-конфиг), циклических структур там быть не может.
function normalizeCacheValue(value: unknown): unknown {
  // null и undefined схлопываются в одно: «поля нет» и «поле = null» не
  // должны создавать разные кэш-ключи для эквивалентных профилей.
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  // bigint не переживает JSON (исключение сериализатора), а попадать в
  // строку здесь достаточно: нам нужна стабильность, а не обратимость.
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  // Массивы сохраняют порядок: список заголовков [a,b] и [b,a] - разные
  // конфигурации в смысле сервера, схлопывать их нельзя.
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeCacheValue(entry));
  }
  if (typeof value === "object") {
    // Сортировка ключей через localeCompare - суть всей функции: без неё
    // одинаковые конфиги с разным порядком вложенных полей получили бы
    // разные отпечатки, и кэш промахивался бы на каждой перестановке.
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeCacheValue(entry)] as const);
    return Object.fromEntries(entries);
  }

  // Функции, символы, неизвестные формы: String(value) даёт хотя бы
  // детерминированную строку вместо выбрасывания - объект с методом и без
  // него останутся различными отпечатками.
  return String(value);
}

// Отпечаток значимой части конфига: sha256 от нормализованного JSON,
// урезанный до 16 hex-символов (64 бита).
//
// Две причины не строить ключ из полей напрямую:
// 1) apiKey не должен покидать память процесса в открытом виде - в ключ
//    попадает только его хеш. Утечка кэш-ключей (логи, метрики) не должна
//    становиться утечкой секрета.
// 2) headers/options - произвольные объекты, и любое изменение в них должно
//    менять ключ. Ручной перечислить невозможно, а normalize+hash ловит всё.
//
// 64-битного префикса sha256 достаточно: каталог профилей конечен и мал,
// вероятность коллизии пренебрежима против риска держать полные дайджесты.
function fingerprintResolvedInputs(resolved: ResolvedRuntimeProfile): string {
  // Discovery моделей зависит от транспорта/аутентификации/конфига, а не только от runtimeId/baseUrl.
  // Стабильный отпечаток здесь нужен, чтобы правка профиля не переиспользовала устаревшие записи кэша.
  const normalized = normalizeCacheValue({
    apiKeyEnvVar: resolved.apiKeyEnvVar,
    // slice(0, 16): из дайджеста берётся полширины - экономия в памяти и
    // логах при сохранении стойкости к случайным совпадениям.
    apiKeyHash: resolved.apiKey
      ? createHash("sha256").update(resolved.apiKey).digest("hex").slice(0, 16)
      : null,
    headers: resolved.headers,
    options: resolved.options,
  });
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

// Ключ списка моделей: все значимые измерения профиля через двоеточие.
//
// Разделитель - потенциная мина составных ключей: массив ["a:b", "c"] и
// ["a", "b:c"] дали бы одинаковую строку. Здесь компоненты нормализованы
// (baseUrl, model - валидные строки без двоеточий в роли идентификаторов),
// а финальный компонент - фиксированной длины hex, так что сдвиг границы
// не приводит к коллизии. Это не гарантия по типам, а соглашение,
// которое стоит помнить при добавлении новых полей в ключ.
function modelCacheKey(resolved: ResolvedRuntimeProfile): string {
  return [
    resolved.runtimeId,
    resolved.providerId,
    // Литералы-заглушки обязательны: undefined превратился бы в пустой
    // сегмент, и профили «без профиля» и «с полем undefined» склеились бы
    // в один ключ.
    resolved.profileId ?? "none",
    resolved.transport,
    resolved.baseUrl ?? "default",
    resolved.model ?? "none",
    fingerprintResolvedInputs(resolved),
  ].join(":");
}

// Префикс "validation:" разделяет пространства двух кэшей. Формально это
// перестраховка (кэши и так разные объекты), но дешёвая: случайный обмен
// записями между кэшами становится невозможен даже при ошибках рефакторинга.
function validationCacheKey(resolved: ResolvedRuntimeProfile): string {
  return `validation:${modelCacheKey(resolved)}`;
}

// Фабрика сервиса (а не класс): наружу уходят только два метода, приватное
// состояние (кэши, трекер, TTL) остаётся в замыкании - подменить его изнутри
// невозможно.
export function createRuntimeModelDiscoveryService(
  options: RuntimeModelDiscoveryOptions,
): RuntimeModelDiscoveryService {
  // Math.max(..., 1): TTL в ноль или NaN превратил бы кэш в «хранилище с
  // мгновенным протуханием»: каждое чтение тогда ходило бы в сеть, что
  // ровно наоборот цели модуля.
  const cacheTtlMs = Math.max(options.cacheTtlMs ?? 60_000, 1);
  // Оба кэша и TTL захвачены в замыкание обоих методов: единая политика
  // хранения для discovery и validation гарантирована структурой, а не
  // аккуратностью вызывающих. Тесты могут подставить свои кэши и свой
  // now-часы - в продакшене их никто не видит.
  const modelCache =
    options.cache ?? createRuntimeMemoryCache<RuntimeModel[]>({ defaultTtlMs: cacheTtlMs });
  // Раздельные кэши для двух операций осознанны: список моделей и статус
  // соединения протухают по-разному и должны переживать перезапись соседа.
  // Разные пространства ключей (см. validationCacheKey) довершают изоляцию.
  const validationCache =
    options.validationCache ??
    createRuntimeMemoryCache<RuntimeConnectionValidationResult>({ defaultTtlMs: cacheTtlMs });
  // Трекер медленных путей: cacheKey -> время последнего промаха.
  //
  // Это не кэш и не защита - это канареечка: повторный медленный путь по
  // тому же ключу до истечения TTL означает, что кэш либо протухает
  // мгновенно (баг часов), либо ключ не стабилен (баг отпечатка). Оба
  // звучат как warn, потому что система деградирует медленно, а не ломается.
  const modelSlowPathTracker = new Map<string, number>();

  return {
    async listModels(
      resolved: ResolvedRuntimeProfile,
      forceRefresh = false,
    ): Promise<RuntimeModel[]> {
      // Все методы живут в одном объектном литерале и делят замыкание
      // (кэши, трекер, TTL, logger) - это и есть «приватные поля» до
      // появления #private в классе; разрыв между методами невозможен.
      const cacheKey = modelCacheKey(resolved);
      // forceRefresh обходит только чтение: свежий результат всё равно
      // запишется в кэш, и последующие обычные вызовы получат его бесплатно.
      if (!forceRefresh) {
        const cached = modelCache.get(cacheKey);
        if (cached) {
          options.logger?.debug?.(
            { runtimeId: resolved.runtimeId, profileId: resolved.profileId, cacheHit: true },
            "Returning cached runtime model list",
          );
          return cached;
        }
      }
      // Отсчёт slow path заводится до всей тяжёлой работы (резолв адаптера,
      // capabilities, сеть) - длительность должна включать и накладные
      // расходы сервиса, иначе метрика врёт о провайдере.
      const slowPathStartedAt = Date.now();
      options.logger?.debug?.(
        {
          runtimeId: resolved.runtimeId,
          profileId: resolved.profileId,
          cacheHit: false,
          forceRefresh,
          // TTL в контексте промаха: без него не понять, почему запись не
          // спасла - она могла быть просто старше срока.
          cacheTtlMs,
        },
        "Running uncached runtime model discovery slow path",
      );
      // Сигнал канареечки (см. modelSlowPathTracker): промах кэша там, где
      // он быть не должен. forceRefresh-вызов исключён из подозрений -
      // там повтор это нажатие кнопки пользователем, а не баг.
      const previousSlowPathAt = modelSlowPathTracker.get(cacheKey);
      if (
        !forceRefresh &&
        previousSlowPathAt != null &&
        slowPathStartedAt - previousSlowPathAt < cacheTtlMs
      ) {
        options.logger?.warn?.(
          {
            runtimeId: resolved.runtimeId,
            profileId: resolved.profileId,
            cacheTtlMs,
            // Дельта до прошлого промаха в логе: по ней видно, что именно
            // сломалось - TTL крошечный или ключ нестабиальный на каждом вызове.
            elapsedSincePreviousSlowPathMs: slowPathStartedAt - previousSlowPathAt,
          },
          "Runtime model discovery slow path repeated before cache TTL elapsed",
        );
      }
      modelSlowPathTracker.set(cacheKey, slowPathStartedAt);

      // Резолв адаптера из реестра живёт ВНЕ try: если рантайма нет в
      // реестре, наружу уходит RuntimeResolutionError от registry, а не
      // обёрнутый RuntimeValidationError. Это не недосмотр, а разделение:
      // «нет такого рантайма» - поломка конфигурации системы, а не сбой
      // discovery конкретного профиля.
      const adapter = options.registry.resolveRuntime(resolved.runtimeId);
      // Возможности вычисляются с учётом транспорта, а не берутся из
      // адаптера целиком: у одного адаптера CLI умеет discovery, а
      // API-транспорт - нет. Разрешение «адаптер x транспорт» - смысл
      // resolveAdapterCapabilities, и обходить его нельзя.
      const capabilities = resolveAdapterCapabilities(adapter, resolved.transport);
      const capabilityResult = checkRuntimeCapabilities({
        runtimeId: resolved.runtimeId,
        workflowKind: "model-discovery",
        capabilities,
        required: ["supportsModelDiscovery"],
      });
      // Двойная проверка (capabilities И наличие метода) - не паранойя,
      // а страховка от расхождения деклараций: адаптер может заявить
      // supportsModelDiscovery: true, но не реализовать listModels.
      if (!capabilityResult.ok || !adapter.listModels) {
        throw new RuntimeValidationError(
          `Runtime "${resolved.runtimeId}" does not support model discovery`,
        );
      }

      try {
        const models = await adapter.listModels({
          runtimeId: resolved.runtimeId,
          providerId: resolved.providerId,
          profileId: resolved.profileId,
          // ?? undefined вместо ?? "": разница для адаптера принципиальная -
          // пустая строка это «модель = пустая строка», а undefined - «не
          // спрашивай про конкретную модель».
          model: resolved.model ?? undefined,
          transport: resolved.transport,
          // Достаём projectRoot из мешанины options с проверкой typeof:
          // options - Record<string, unknown>, и доверять типу внутри нельзя.
          projectRoot:
            typeof resolved.options.projectRoot === "string"
              ? resolved.options.projectRoot
              : undefined,
          headers: resolved.headers,
          // Условные spreads (`cond ? {k:v} : {}`) добавляют поля только при
          // непустом значении. Адаптеры различают «параметр не передан» и
          // «передан undefined/пустой»; profileId с ?? на выходе ключа,
          // например, остался бы строкой "none".
          //
          // Порядок ключей в объекте значим: эти spreads идут ПОСЛЕ
          // resolved.options и перекрывают одноимённые ключи из мешка -
          // канонические значения профиля всегда приоритетнее случайных опций.
          options: {
            ...resolved.options,
            ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
            ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
            ...(resolved.apiKeyEnvVar ? { apiKeyEnvVar: resolved.apiKeyEnvVar } : {}),
          },
          // Дублирование значений (условно в options и безусловно в
          // прямых полях) - не оплошность, а два канала доставки: typed
          // контракт вызова и произвольный мешок адаптерских опций. Поля
          // выше - гарантия контракта; спред ниже - совместимость с адаптерами,
          // читающими только options.
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
          apiKeyEnvVar: resolved.apiKeyEnvVar,
        });
        // Запись в кэш сразу после успеха и до логирования: логгер может
        // быть шумным, а кэш-окно должно открыться как можно раньше.
        modelCache.set(cacheKey, models, cacheTtlMs);
        const discoveryDurationMs = Date.now() - slowPathStartedAt;
        options.logger?.debug?.(
          {
            runtimeId: resolved.runtimeId,
            profileId: resolved.profileId,
            cacheHit: false,
            forceRefresh,
            discoveryDurationMs,
          },
          "Runtime model discovery slow path completed",
        );
        options.logger?.info?.(
          {
            runtimeId: resolved.runtimeId,
            profileId: resolved.profileId,
            // Количество вместо содержимого: список моделей легко занимает
            // десятки строк и в info-лог без раздувания не просится, а его
            // отсутствие или провал видны именно по count.
            modelCount: models.length,
          },
          "Runtime model discovery completed",
        );
        return models;
      } catch (error) {
        // Обёртка с сохранением cause: наружу уходит доменный тип ошибки,
        // а оригинал (таймаут fetch, 429-ошибка SDK) доступен через err.cause
        // для логов и тонкой диагностики - без парсинга строк.
        throw new RuntimeValidationError(
          `Model discovery failed for runtime "${resolved.runtimeId}"`,
          error,
        );
      }
    },

    async validateConnection(
      resolved: ResolvedRuntimeProfile,
      forceRefresh = false,
    ): Promise<RuntimeConnectionValidationResult> {
      const cacheKey = validationCacheKey(resolved);
      if (!forceRefresh) {
        const cached = validationCache.get(cacheKey);
        if (cached) {
          options.logger?.debug?.(
            { runtimeId: resolved.runtimeId, profileId: resolved.profileId, cacheHit: true },
            "Returning cached runtime connection validation result",
          );
          return cached;
        }
      }

      // Проверка прав на уровне профиля (валидация структуры, наличие ключа
      // в env и т.п.) выполняется в обеих ветках до обращения к сети:
      // дешёвый отказ до дорогого запроса - общий принцип конвейеров.
      const baseValidation = validateResolvedRuntimeProfile(resolved);
      const adapter = options.registry.resolveRuntime(resolved.runtimeId);

      if (!adapter.validateConnection) {
        // Структурно валидный конфиг без живого теста: ok:true с оговоркой в
        // message. В details утаскиваются только warnings - их негде больше
        // увидеть, а они подсказывают оператору про полуконфиг (например,
        // baseUrl без ключа).
        const result: RuntimeConnectionValidationResult = baseValidation.ok
          ? { ok: true, message: "Runtime adapter has no explicit connection check" }
          : {
              ok: false,
              message: baseValidation.message,
              details: { warnings: baseValidation.warnings },
            };
        validationCache.set(cacheKey, result, cacheTtlMs);
        return result;
      }

      try {
        const result = await adapter.validateConnection({
          runtimeId: resolved.runtimeId,
          providerId: resolved.providerId,
          profileId: resolved.profileId,
          // Тот же приём ?? undefined, что и в listModels: пустая строка
          // модели означала бы «проверь модель с именем ""».
          model: resolved.model ?? undefined,
          transport: resolved.transport,
          // Здесь unconditional-поля против условного спреда в listModels:
          // baseUrl/apiKey передаются всегда. Но есть тонкость перекрывания:
          // без условного spread присваивание со значением undefined
          // ЗАТРИРАЕТ одноимённый ключ из resolved.options - здесь это
          // намеренно: валидация должна видеть именно разрешённый профиль,
          // а не случайный остаток из options-мешка.
          // Разница с listModels осознанная: discovery строит запрос,
          // validation диагностирует.
          options: {
            ...resolved.options,
            baseUrl: resolved.baseUrl,
            apiKey: resolved.apiKey,
            apiKeyEnvVar: resolved.apiKeyEnvVar,
            headers: resolved.headers,
          },
        });
        validationCache.set(cacheKey, result, cacheTtlMs);
        options.logger?.info?.(
          {
            runtimeId: resolved.runtimeId,
            profileId: resolved.profileId,
            ok: result.ok,
          },
          "Runtime connection validation completed",
        );
        return result;
      } catch (error) {
        // Сбой сети НЕ кэшируется: в отличие от ok:false (это ответ
        // провайдера, который стоит помнить TTL), исключение - мгновенная
        // неполадка. Закешированный отказ бэкенда заставил бы UI показывать
        // протухшую ошибку ещё минуту после починки сети.
        throw new RuntimeValidationError(
          `Connection validation failed for runtime "${resolved.runtimeId}"`,
          error,
        );
      }
    },
  };
}
