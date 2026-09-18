/**
 * Каталог моделей Codex: статичный дефолт + обогащение реально обнаруженных моделей.
 *
 * Идея в том, что источником истины остаётся app-server: он знает, какие модели доступны
 * конкретному пользователю. Но его ответы беднее нашего внутреннего контракта RuntimeModel
 * (нет лейблов, уровней усилия, флагов), поэтому обнаруженные модели проходят через
 * enrich/parse и дополняются сведениями из KNOWN_CODEX_MODELS.
 *
 * Ещё одна задача модуля — канонизация усилий (effort): Codex отдаёт сразу несколько полей
 * в разных форматах (supportedReasoningEfforts массивом объектов, defaultEffort строкой),
 * а наружу мы должны отдавать один предсказуемый набор ключей. Неизвестные поля удаляются,
 * чтобы не протекали в UI и в конфиг задач.
 *
 * Все входные данные — unknown: это ответы внешнего процесса, они могут отличаться от версии
 * к версии CLI. Поэтому каждый шаг разбора имеет защиту и возвращает undefined/null,
 * а не бросает исключение (Nullable Cast Rule: null остаётся в типе и проверяется явно).
 */

import type { RuntimeModel } from "../../../types.js";
import { normalizeModelEffort, normalizeModelEffortLevels } from "../../../modelEffort.js";

// Базовый набор уровней усилия, который поддерживает семейство gpt-5.4/5.3-codex.
const DEFAULT_CODEX_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"];

// Статичный список-фолбэк. Нужен, когда app-server недоступен (например, CLI не установлен),
// чтобы UI всё равно показал что-то осмысленное вместо пустого селекта.
const DEFAULT_CODEX_MODELS: RuntimeModel[] = [
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: [...DEFAULT_CODEX_EFFORT_LEVELS],
    },
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: [...DEFAULT_CODEX_EFFORT_LEVELS],
    },
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: [...DEFAULT_CODEX_EFFORT_LEVELS],
    },
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: [...DEFAULT_CODEX_EFFORT_LEVELS],
    },
  },
];

// Индекс известных моделей по нижнему регистру id. Пересобирается один раз при загрузке
// модуля; значения клонируются, чтобы никто снаружи не смог случайно мутировать эталон.
const KNOWN_CODEX_MODELS = new Map(
  DEFAULT_CODEX_MODELS.map((model) => [model.id.toLowerCase(), cloneRuntimeModel(model)]),
);

// Отдаём копии, а не сам массив: вызывающий смело может менять полученное,
// не портя константу модуля.
export function getDefaultCodexModels(): RuntimeModel[] {
  return DEFAULT_CODEX_MODELS.map(cloneRuntimeModel);
}

// Обогащение списка от сервера. Порядок ключей ниже сознательно таков: сначала данные сервера,
// затем значения из известного каталога как запасной вариант — если сервер поле не прислал.
export function enrichCodexDiscoveredModels(models: RuntimeModel[]): RuntimeModel[] {
  const enriched: RuntimeModel[] = [];
  // seen — защита от дубликатов. Сервер иногда отдаёт одну модель в разных регистрах
  // или на разных страницах пагинации, и в UI это выглядело бы как лишние записи.
  const seen = new Set<string>();

  for (const candidate of models) {
    const id = readString(candidate.id);
    // Модель без id бесполезна: по нему её выбирают и хранят в настройках задачи.
    if (!id) {
      continue;
    }

    // Сравнение и поиск в Map идут по нормализованному ключу, а в результат попадает
    // исходный id с сохранением регистра — так мы не меняем то, что вернул провайдер.
    const normalizedId = id.toLowerCase();
    if (seen.has(normalizedId)) {
      continue;
    }
    seen.add(normalizedId);

    const known = KNOWN_CODEX_MODELS.get(normalizedId);
    // Метаданные сливаются слоями: сведения из известного каталога дополняются тем,
    // что рассказал сервер о конкретной установке.
    const metadata = mergeModelMetadata(known?.metadata, candidate.metadata);
    enriched.push({
      id,
      // ?? — label и supportsStreaming от сервера встречаются не всегда;
      // для id-моделей стриминг работает по умолчанию (последний ?? true).
      label: candidate.label ?? known?.label,
      supportsStreaming: candidate.supportsStreaming ?? known?.supportsStreaming ?? true,
      ...(metadata ? { metadata } : {}),
    });
  }

  return enriched;
}

// Разбор одной записи от сервера. null означает "не модель" — вызывающий просто
// проигнорирует такую запись, что защищает от новых неизвестных типов в ответе.
export function parseCodexRuntimeModel(value: unknown): RuntimeModel | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const model = value as Record<string, unknown>;
  // У Codex исторически два варианта поля с идентификатором, проверяем оба:
  // сначала современное model, затем старое id.
  const id = readString(model.model) ?? readString(model.id);
  if (!id) {
    return null;
  }

  // Метаданные собираются в мутабельный объект, а не в литерал: полей много,
  // и большинство добавляется условно, по мере проверки типа.
  const metadata: Record<string, unknown> = {};
  const description = readString(model.description);
  if (description) {
    metadata.description = description;
  }

  const supportedEffortLevels = normalizeSupportedReasoningEfforts(model.supportedReasoningEfforts);
  if (supportedEffortLevels) {
    metadata.supportsEffort = true;
    metadata.supportedEffortLevels = supportedEffortLevels;
  } else if (Array.isArray(model.supportedReasoningEfforts)) {
    // Массив был, но не распознался как уровни усилия: доверяем серверу и явно
    // фиксируем supportsEffort=false, чтобы старая эвристика не включала выбор усилия.
    metadata.supportsEffort = false;
  }

  // defaultEffort говорит, что модель умеет усилие, даже если список уровней не пришёл:
  // иначе UI не даст выбрать значение, которое уже стоит по умолчанию.
  const defaultEffort = normalizeModelEffort(model.defaultReasoningEffort);
  if (defaultEffort) {
    metadata.supportsEffort = true;
    metadata.defaultEffort = defaultEffort;
  }

  // Дальше — только безопасное копирование типизированных полей. Проверка typeof
  // важна даже для "очевидных" boolean: ответ приходит из внешнего процесса,
  // и мусор в поле лучше потерять, чем протащить в UI как валидное значение.
  if (typeof model.hidden === "boolean") {
    metadata.hidden = model.hidden;
  }
  if (typeof model.isDefault === "boolean") {
    metadata.isDefault = model.isDefault;
  }
  if (typeof model.supportsPersonality === "boolean") {
    metadata.supportsPersonality = model.supportsPersonality;
  }
  if (Array.isArray(model.inputModalities)) {
    // Фильтр по типу отсеивает нестроковые элементы: контракт metadata ждёт string[].
    metadata.inputModalities = model.inputModalities.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  if (readString(model.upgrade)) {
    // Проверка через readString, а запись — исходного значения: так мы не подменяем
    // содержимое подсказки об апгрейде своей нормализацией.
    metadata.upgrade = model.upgrade;
  }
  if (model.upgradeInfo && typeof model.upgradeInfo === "object") {
    metadata.upgradeInfo = model.upgradeInfo;
  }
  if (model.availabilityNux && typeof model.availabilityNux === "object") {
    metadata.availabilityNux = model.availabilityNux;
  }

  return {
    id,
    label: readString(model.displayName) ?? undefined,
    // Стриминг считается доступным всегда: app-server используется именно как потоковый канал.
    supportsStreaming: true,
    // Пустой metadata не добавляется вовсе: так поле остаётся undefined,
    // а не пустым объектом, который ломает проверки в UI.
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

// Клонирование на один уровень вложенности: этого достаточно, потому что в metadata нет
// вложенных объектов, которые мы правим точечно — хватает копии объекта и массивов.
function cloneRuntimeModel(model: RuntimeModel): RuntimeModel {
  return {
    ...model,
    ...(model.metadata ? { metadata: structuredCloneCompatible(model.metadata) } : {}),
  };
}

function structuredCloneCompatible(value: Record<string, unknown>): Record<string, unknown> {
  const cloned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    // Массивы копируются отдельно: остальные значения — примитивы, их можно присвоить как есть.
    cloned[key] = Array.isArray(entry) ? [...entry] : entry;
  }
  return cloned;
}

// Слияние метаданных из двух источников: базового (известный каталог) и обнаруженного.
// Возвращает undefined, если после чистки не осталось ни одного поля — тогда metadata
// не попадает в объект модели вообще.
function mergeModelMetadata(
  known: Record<string, unknown> | undefined,
  discovered: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {
    // Порядок важен: discovered стоит вторым и перекрывает known — свежие данные
    // от сервера приоритетнее наших статических представлений о модели.
    ...(known ? structuredCloneCompatible(known) : {}),
    ...(discovered ? structuredCloneCompatible(discovered) : {}),
  };

  if (merged.supportsEffort === false) {
    // Сервер сказал "усилия нет" — убираем и список уровней: держать его было бы противоречиво.
    delete merged.supportedEffortLevels;
  } else {
    // Канонизация: принимаем и уже готовое supportedEffortLevels, и сырое
    // supportedReasoningEfforts, но наружу отдаём только первый вариант.
    const supportedEffortLevels =
      normalizeModelEffortLevels(merged.supportedEffortLevels) ??
      normalizeSupportedReasoningEfforts(merged.supportedReasoningEfforts);
    if (supportedEffortLevels) {
      merged.supportedEffortLevels = supportedEffortLevels;
      merged.supportsEffort = true;
    } else {
      // Уровней нет: если флаг не был явно true, удаляем и его,
      // чтобы не осталось висячего supportsEffort без списка.
      delete merged.supportedEffortLevels;
      if (merged.supportsEffort !== true) {
        delete merged.supportsEffort;
      }
    }
  }

  // Приводим defaultEffort к канонической форме, принимая оба исторических имени поля.
  const defaultEffort =
    normalizeModelEffort(merged.defaultEffort) ??
    normalizeModelEffort(merged.defaultReasoningEffort);
  if (defaultEffort) {
    merged.defaultEffort = defaultEffort;
  } else {
    // Невалидное значение удаляется, а не пробрасывается дальше как есть.
    delete merged.defaultEffort;
  }
  // Сырые поля-источники больше не нужны: наружу идёт только канонический набор.
  delete merged.defaultReasoningEffort;
  delete merged.supportedReasoningEfforts;

  return Object.keys(merged).length > 0 ? merged : undefined;
}

// Нормализация уровня усилия.
// Codex отдаёт массив объектов вида { reasoningEffort: "high" }, а не готовые строки,
// поэтому для каждого элемента достаём вложенное поле и нормализуем его.
function normalizeSupportedReasoningEfforts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const unique = new Set<string>();
  for (const entry of value) {
    // Элемент может быть чем угодно: в массиве встречается и мусор.
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const normalized = normalizeModelEffort((entry as Record<string, unknown>).reasoningEffort);
    // Set заодно убирает дубликаты: сервер может прислать один уровень дважды.
    if (normalized) {
      unique.add(normalized);
    }
  }

  // undefined, а не пустой массив: вызывающий отличает "уровней нет" от "список пустой",
  // и именно на undefined строится ветка supportsEffort = false в parse.
  return unique.size > 0 ? [...unique] : undefined;
}

// Единый внутренний readString. Возвращает null (не пустую строку) для всего,
// что не является непустой строкой — так вызывающий код явно обрабатывает отсутствие значения.
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
