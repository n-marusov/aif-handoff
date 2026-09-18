/**
 * Нормализация и валидация уровней reasoning-effort между провайдерами.
 *
 * Каждый рантайм (Claude, Codex, OpenCode, OpenRouter) называет уровни «думания»
 * по-своему, ждёт их в своём поле options и поддерживает свой набор значений.
 * Вместо разбросанных по адаптерам проверок здесь собран единый слой:
 * нормализация произвольного входного значения, таблица конфигураций по runtimeId
 * и валидация выбранного уровня против данных discovery (метаданных модели) либо
 * против fallback-набора провайдера.
 *
 * Ключевая идея валидации: неверный effort не должен проскакивать к API
 * провайдера. Если уровень не поддерживается, он удаляется из options, а вызывающий
 * код получает структурированный ответ (source/reasonCode) и может показать
 * пользователю, что было принято, а что отброшено.
 *
 * Порядок приоритета источников уровней: явный запрет модели (supportsEffort ===
 * false) > список supportedEffortLevels из discovery > общий fallback-список
 * провайдера. Чем конкретнее данные, тем они главнее: модель всегда «знает» о себе
 * больше, чем усреднённый список провайдера.
 */

import type { RuntimeModel, RuntimeRunInput } from "./types.js";
// type-only импорт: типы существуют только на этапе компиляции и не попадают в
// итоговый JS. Держать все контракты в одном types.ts и импортировать их как
// типы - стандартный способ избежать циклов зависимостей внутри пакета.

// as const превращает массив в кортеж литеральных строк: TS знает не только тип
// "string", а точные значения. Эти списки - внешний контракт провайдера, и опечатка
// в них должна быть видна компилятору, а не всплывать только в HTTP-ответе.
export const CLAUDE_MODEL_EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
// Уровни Codex: здесь нет "max", но есть "minimal" - модели OpenAI используют
// другой край шкалы. Смысловой вывод: списки НЕ взаимозаменяемы, и "max",
// валидный для Claude, был бы отвергнут Codex - отсюда и нужна валидация по
// runtimeId, а не один общий список на всё.
export const CODEX_MODEL_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
// У OpenCode есть дополнительный уровень "none" - модели провайдера умеют
// полностью отключать размышления, чего Claude в этом списке не имеет.
export const OPENCODE_MODEL_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export const OPENROUTER_MODEL_EFFORT_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
// Порядок здесь - не алфавит, а осмысленный: от максимального уровня к минимальному.
// Шлюз OpenRouter принимает расширенный набор (включая "max" и "none"), который
// шире обычного списка того же провайдера, поэтому он вынесен в отдельную константу.
export const OPENROUTER_GATEWAY_MODEL_EFFORT_LEVELS = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
] as const;

// Исторический формат: Claude когда-то принимал effort числом 1..4. Профили и
// сохранённые настройки с тех пор могли не мигрировать, поэтому числовые значения
// всё ещё распознаются и переводятся в строки (см. normalizeConfiguredModelEffort).
const CLAUDE_NUMERIC_MODEL_EFFORT_LEVELS: Record<number, string> = {
  1: "low",
  2: "medium",
  3: "high",
  4: "max",
};

// Описание того, как конкретный рантайм оперирует effort. optionKey - имя поля в
// options, которое уйдёт провайдеру; fallbackLevels - список уровней, которым можно
// доверять, когда метаданные модели (discovery) не дают ничего лучшего.
export interface RuntimeModelEffortConfig {
  // Дискриминант зашит прямо в тип: опечатка в имени поля не сможет уехать в
  // рантайм, а switch/проверки по optionKey покрываются исчерпывающе.
  optionKey: "effort" | "modelReasoningEffort" | "reasoningEffort";
  // readonly не даёт случайно изменить общий список-константу: он один на все
  // вызовы, и мутация отравила бы валидацию для всех задач сразу.
  fallbackLevels: readonly string[];
}

// Результат валидации спроектирован как «аудит-запись»: он отделяет то, что
// пользователь ЗАДАЛ (configuredEffort), от того, что реально БУДЕТ ОТПРАВЛЕНО
// (acceptedEffort). Различие важно для UI: значение может быть валидным по форме,
// но не поддерживаться конкретной моделью, и это нужно показать, а не глотать.
export interface RuntimeModelEffortValidation {
  // Возможно обновлённый input: единственное место, где options гарантированно
  // безопасны для отправки. Игнорировать это поле и взять исходный input - всё
  // равно что обойти валидацию.
  input: RuntimeRunInput;
  configuredEffort: string | null;
  acceptedEffort: string | null;
  // Копия массива (не ссылка на const-кортеж): потребители могут сортировать и
  // фильтровать его для отображения, не рискуя общим состоянием модуля.
  allowedEffortLevels: string[];
  source: "discovery" | "fallback" | "none";
  // reasonCode - машинно-читаемый код, а не текст: сообщения меняются и
  // локалиуются, код остаётся стабильным контрактом для UI и логов.
  reasonCode: "unsupported_model_effort" | null;
}

// Реестр конфигураций по runtimeId. Map, а не объект: ключи приходят из внешних
// данных (профили, задачи), и Map не наследует свойства прототипа - исключается
// классическая ловушка вида cfg["constructor"]. Неизвестный рантайм даёт честный
// null вместо мусора из Object.prototype.
const MODEL_EFFORT_CONFIGS = new Map<string, RuntimeModelEffortConfig>([
  [
    // Ключи реестра - всегда канонический нижний регистр: любое сравнение с
    // runtimeId пользователя обязано проходить через ту же нормализацию, что и
    // в getRuntimeModelEffortConfig.
    "claude",
    {
      optionKey: "effort",
      fallbackLevels: CLAUDE_MODEL_EFFORT_LEVELS,
    },
  ],
  [
    "codex",
    {
      // У каждого провайдера своё имя поля в нативном API. Реестр - единственное
      // место, где это различие зашито: выше по коду все работают с абстрактным
      // optionKey и не помнят, что у Codex это modelReasoningEffort.
      optionKey: "modelReasoningEffort",
      fallbackLevels: CODEX_MODEL_EFFORT_LEVELS,
    },
  ],
  [
    "opencode",
    {
      // Третье по счёту имя поля: три провайдера - три разных ключа. Именно эта
      // таблица превращает «узнай имя поля из switch по runtimeId» в один look-up.
      optionKey: "reasoningEffort",
      fallbackLevels: OPENCODE_MODEL_EFFORT_LEVELS,
    },
  ],
  [
    "openrouter",
    {
      // OpenRouter переиспользует короткое имя effort (как Claude), но с другим
      // набором уровней: совпадение optionKey не делает списки взаимозаменяемыми,
      // поэтому fallbackLevels здесь свой.
      optionKey: "effort",
      fallbackLevels: OPENROUTER_MODEL_EFFORT_LEVELS,
    },
  ],
]);

// Symbol как «печать проверки». Значение effort проходит валидацию один раз, но
// options - произвольный Record<string, unknown>, и позже его может прочитать
// любой код. Symbol-ключ почти невозможно подделать извне: его не перенесёт
// JSON.parse, не покажет spread обычного объекта из внешних данных и нельзя
// угадать по имени. Поэтому наличие метки = «это значение уже прошло
// validateRuntimeModelEffort», и resolveModelEffortOption доверяет ему.
const VALIDATED_MODEL_EFFORT = Symbol("validated-model-effort");

// Маркер хранит не только значение, но и поле, для которого оно валидировано:
// так одна метка не может «зачесть» другой optionKey. Тип поля извлечён из самой
// конфигурации (индексный доступ ["optionKey"]), а не дублирует литералы: если к
// union полей добавят новое имя, маркер примет его автоматически.
interface ValidatedModelEffortMarker {
  optionKey: RuntimeModelEffortConfig["optionKey"];
  value: string;
}

// Тип options с необязательной меткой. Метка привязана к конкретному optionKey и
// значению: переиспользование «печати» для другого поля или другого уровня не
// сработает, поэтому marker проверяется по обоим элементам сразу.
type ModelEffortOptions = Record<string, unknown> & {
  [VALIDATED_MODEL_EFFORT]?: ValidatedModelEffortMarker;
};

// Единая точка приведения «чего угодно» к каноническому виду уровня. Вход - unknown
// (данные из профилей, БД, HTTP), поэтому не-строка молча становится null, а
// регистр и пробелы не имеют значения: " High " и "high" - одно и то же.
export function normalizeModelEffort(value: unknown): string | null {
  // Ранний выход для null/undefined/чисел/объектов: нормализация не угадывает
  // смысл, а только приводит форму. Числовой effort Claude обрабатывается
  // отдельным слоем (normalizeConfiguredModelEffort), сюда он уже не доходит.
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

// Отвечает на ДРУГОЙ вопрос: «пытался ли пользователь задать effort?», а не
// «валидно ли значение?». Для строк считается заполненным только непустое,
// для чисел и прочих типов - всё, что не null/undefined (числовой effort Claude
// корректен, хотя normalizeModelEffort на нём вернёт null). Разделение нужно
// validateRuntimeModelEffort: «не задано» и «задано криво» - разные исходы.
export function hasConfiguredModelEffort(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  // != null (не !==) отсекает сразу и null, и undefined - единственный способ
  // проверить оба «пустых» значения одним сравнением в JS/TS.
  return value != null;
}

// Нормализация с учётом специфики рантайма: только Claude понимает числа, причём
// даже некорректный ввод (1.5, NaN, Infinity) приводит в чувство до поиска:
// Math.floor убирает дробную часть, Number.isFinite отсекает специальные числа,
// а отсутствующий ключ в словаре даёт undefined, который ?? превращает в null.
// runtimeId тоже нормализуется, потому что ключи профилей приходят из внешних
// данных и могут отличаться регистром.
export function normalizeConfiguredModelEffort(runtimeId: string, value: unknown): string | null {
  if (
    runtimeId.trim().toLowerCase() === "claude" &&
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return CLAUDE_NUMERIC_MODEL_EFFORT_LEVELS[Math.floor(value)] ?? null;
  }
  return normalizeModelEffort(value);
}

// Разбор metadata.supportedEffortLevels из discovery. Возвращаемое undefined -
// намеренное трёхзначное «неизвестно» (не массив / всё отфильтровалось), тогда как
// пустой массив означал бы «модель поддерживает ноль уровней». Выше по коду это
// различие решает, идти за fallback-списком провайдера или доверять discovery.
// Set убирает дубликаты: метаданные модели мог собрать человек, и повтор «high»
// не должен превращаться в два разрешённых уровня.
export function normalizeModelEffortLevels(value: unknown): string[] | undefined {
  // Не-массив - не ошибка, а «данных нет»: metadata мог остаться от старой
  // версии discovery или быть заполнен частично.
  if (!Array.isArray(value)) {
    return undefined;
  }

  const unique = new Set<string>();
  for (const entry of value) {
    // Каждый элемент проходит через normalizeModelEffort, поэтому в «сыром»
    // массиве из metadata допустимы мусор и другой регистр: элементы, которые не
    // удалось привести к строке, просто пропускаются вместо падения парсера.
    const normalized = normalizeModelEffort(entry);
    if (normalized) {
      unique.add(normalized);
    }
  }

  // Пустое после фильтрации множество сворачивается в undefined: «ничего
  // разборного» эквивалентно «данных не было», иначе один мусор в metadata
  // полностью отключал бы fallback-список провайдера.
  return unique.size > 0 ? [...unique] : undefined;
}

// Единственный способ получить конфигурацию рантайма: нормализация ключа здесь
// обязательна, иначе "Claude" и "claude" разойдутся на разные (и один пустой) результат.
export function getRuntimeModelEffortConfig(runtimeId: string): RuntimeModelEffortConfig | null {
  return MODEL_EFFORT_CONFIGS.get(runtimeId.trim().toLowerCase()) ?? null;
}

// Type guard: после isModelEffortLevel(x, levels) TypeScript сужает тип x до
// литералов из levels. Это позволяет сравнивать строку из внешних данных с
// const-кортежами выше без приведения типов через as.
export function isModelEffortLevel<T extends string>(
  value: string | null,
  levels: readonly T[],
): value is T {
  // Дженерик T extends string выводится из литерального массива: вызов
  // isModelEffortLevel(x, CLAUDE_MODEL_EFFORT_LEVELS) сужает x до
  // "low" | "medium" | "high" | "max" без единого as.
  return value !== null && levels.some((level) => level === value);
}

// Чтение уже валидированного effort из options на стороне адаптера. Первый
// источник истины - fallback-список провайдера: если значение в нём, ничего
// проверять не нужно. Если же уровень взят из discovery конкретной модели (он
// может отсутствовать в общем списке провайдера), доверие обеспечивает только
// символ-метка, оставленная validateRuntimeModelEffort.
export function resolveModelEffortOption(
  options: Record<string, unknown>,
  optionKey: RuntimeModelEffortConfig["optionKey"],
  fallbackLevels: readonly string[],
): string | null {
  const normalized = normalizeModelEffort(options[optionKey]);
  if (!normalized) {
    // Пусто/криво - считаем что effort не задан, адаптер пойдёт со значением
    // по умолчанию провайдера.
    return null;
  }
  if (fallbackLevels.some((level) => level === normalized)) {
    return normalized;
  }

  // Метка проверяется по паре (optionKey, value): валидация для "effort" не должна
  // «прогреть» значение в "reasoningEffort" или наоборот.
  const marker = (options as ModelEffortOptions)[VALIDATED_MODEL_EFFORT];
  return marker?.optionKey === optionKey && marker.value === normalized ? normalized : null;
}

// Главный «шлюз» модуля: вызывается перед запуском воркфлоу и решает, доедет ли
// effort до провайдера. Возвращает НОВЫЙ input с очищенными/помеченными options
// вместо мутации исходного: вход может принадлежать другому вызову или кэшу, и
// тихая порча общего объекта была бы хуже явного отказа.
export function validateRuntimeModelEffort(
  input: RuntimeRunInput,
  models: RuntimeModel[] | null,
): RuntimeModelEffortValidation {
  const config = getRuntimeModelEffortConfig(input.runtimeId);
  const options = input.options ?? {};
  // Все три чтения options зависят от config: если рантайм не оперирует effort,
  // поле в options для него просто не имеет смысла и не диагностируется.
  const rawEffort = config ? options[config.optionKey] : null;
  const hasConfiguredEffort = config ? hasConfiguredModelEffort(rawEffort) : false;
  const configuredEffort = config
    ? normalizeConfiguredModelEffort(input.runtimeId, rawEffort)
    : null;

  // Ветвь «ничего не задано» (или рантайм вообще не оперирует effort): input
  // возвращается как есть, source "none" сигнализирует вызывающему коду, что
  // проверять и показывать нечего.
  if (!config || !hasConfiguredEffort) {
    // Пустой source "none" означает «валидация не требовалась»: вызывать код волен
    // показать configuredEffort как есть, ничего не было ни принято, ни отброшено.
    return {
      input,
      configuredEffort,
      acceptedEffort: configuredEffort,
      allowedEffortLevels: [],
      source: "none",
      reasonCode: null,
    };
  }

  // Значение задано, но нормализовать его нельзя (мусор: объект, число для не-Claude
  // рантайма, NaN). Такое значение нельзя отправлять провайдеру - поле вырезается из
  // копии options, чтобы запрос всё равно ушёл и не упал из-за кривой настройки.
  // allowedEffortLevels заполняется fallback-списком: UI показывает, что вообще
  // допустимо, и пользователь может починить выбор.
  if (!configuredEffort) {
    const sanitizedOptions = { ...options };
    delete sanitizedOptions[config.optionKey];
    return {
      input: {
        ...input,
        options: sanitizedOptions,
      },
      configuredEffort,
      acceptedEffort: null,
      allowedEffortLevels: [...config.fallbackLevels],
      source: "fallback",
      reasonCode: "unsupported_model_effort",
    };
  }

  // На этом этапе configuredEffort - гарантированно нормализованная непустая
  // строка, и остаётся решить единственный вопрос: поддерживает ли её модель.

  // Дальше effort валидируется против конкретной выбранной модели. models?.find
  // безопасен: discovery мог ещё не отработать (null), тогда это не ошибка,
  // а переход на fallback-список провайдера.
  const selectedModel = input.model
    ? (models?.find((model) => model.id === input.model) ?? null)
    : null;
  const discoveredLevels = normalizeModelEffortLevels(
    selectedModel?.metadata?.supportedEffortLevels,
  );
  // hasDiscoveryPolicy означает «модель явно описала свои возможности»: либо
  // список уровней, либо явный запрет effort. Только в этом случае источник
  // помечается как "discovery"; иначе решение принято по общим спискам провайдера.
  const hasDiscoveryPolicy =
    selectedModel?.metadata?.supportsEffort === false || discoveredLevels !== undefined;
  // supportsEffort === false имеет абсолютный приоритет: пустой список
  // «разрешённых» уровней, даже если metadata одновременно несёт непустой
  // supportedEffortLevels (противоречивые данные трактуются консервативно).
  const allowedEffortLevels =
    selectedModel?.metadata?.supportsEffort === false
      ? []
      : (discoveredLevels ?? [...config.fallbackLevels]);
  const source = hasDiscoveryPolicy ? "discovery" : "fallback";
  // Источник фиксируется ДО сравнения со списком: он описывает, откуда взялся
  // вердикт, а не каков он. Даже отказ, основанный на discovery, помечается как
  // discovery - это подсказка для отладки: винить надо метаданные модели, а не
  // общий список провайдера.

  // Уровень разрешён: в options записывается каноническое значение (не то, что
  // ввёл пользователь), и ставится символ-метка. Метка нужна потому, что позже
  // resolveModelEffortOption может увидеть уровень, которого нет в fallback-списке
  // провайдера, но который discovery разрешил для этой модели.
  if (allowedEffortLevels.some((level) => level === configuredEffort)) {
    // Spread сохраняет остальные поля options и саму метку при перезаписи:
    // валидация трогает ровно одно поле, а не пересобирает объект с нуля.
    const markedOptions: ModelEffortOptions = {
      ...options,
      [config.optionKey]: configuredEffort,
      [VALIDATED_MODEL_EFFORT]: {
        optionKey: config.optionKey,
        value: configuredEffort,
      },
    };
    return {
      input: {
        ...input,
        options: markedOptions,
      },
      configuredEffort,
      acceptedEffort: configuredEffort,
      allowedEffortLevels,
      source,
      reasonCode: null,
    };
  }

  // Финальная ветвь: нормализованный, но не поддерживаемый выбранной моделью
  // уровень. То же лечение, что и для мусора: поле вырезается, запрос уходит с
  // effort по умолчанию, а reasonCode даёт вызывающему коду сигнал предупредить
  // пользователя вместо тихой подмены поведения модели.
  const sanitizedOptions = { ...options };
  delete sanitizedOptions[config.optionKey];

  return {
    input: {
      ...input,
      options: sanitizedOptions,
    },
    configuredEffort,
    acceptedEffort: null,
    allowedEffortLevels,
    source,
    reasonCode: "unsupported_model_effort",
  };
}

// Удаление effort-метаданных из списка моделей - используется перед отдачей
// models наружу (API/UI) или перед кэшированием, где эти поля не нужны или не
// должны светиться. Функция чистая: исходные объекты не мутируются, копируется
// только metadata. Если после вычитания полей не осталось, отдаётся undefined, а
// не пустой объект - так потребители видят «метаданных нет» одним сравнением,
// а не перебором ключей. Модели без metadata возвращаются тем же объектом:
// лишние копии на ровном месте только нагружают GC.
export function stripRuntimeModelEffortMetadata(models: RuntimeModel[]): RuntimeModel[] {
  return models.map((model) => {
    // Короткий путь: без metadata нечего вырезать, возвращается исходная ссылка -
    // это и быстрее, и сохраняет идентичность объекта для memo-сравнений в UI.
    if (!model.metadata) {
      return model;
    }

    const metadata = { ...model.metadata };
    // Вырезание ровно тех трёх полей, что читает валидация: это зеркало к
    // selectedModel?.metadata?.* выше. Если discovery начнёт писать новое
    // effort-поле, его нужно добавить и сюда, иначе оно утечёт наружу.
    delete metadata.supportsEffort;
    delete metadata.supportedEffortLevels;
    delete metadata.defaultEffort;

    return {
      ...model,
      // Тернарник возвращает undefined (не пустой {}), когда metadata опустела:
      // приводить модель к каноническому «нет метаданных» виду, а не к «пустой
      // объект». Это различают потребители, проверяющие model.metadata == null.
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  });
}
