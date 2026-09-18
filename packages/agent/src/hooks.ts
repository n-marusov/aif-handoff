/**
 * Хуки активности агента: журналирование действий инструментов и субагентов, а
 * также определение корня монорепозитория, от которого агент отсчитывает пути.
 *
 * Почему файл устроен именно так:
 * - Журнал пишется в двух режимах. sync отдаёт строку в БД сразу и потому не
 *   теряет данные при падении процесса, но на плотном потоке tool-use упирается в
 *   частые транзакции SQLite. batch копит строки в памяти и сбрасывает их по
 *   размеру пачки, по максимальному возрасту или вручную. Выбор режима - это
 *   осознанный размен между сохранностью и нагрузкой на БД.
 * - Очередь на задачу живёт в памяти процесса, то есть это best-effort буфер: при
 *   аварийном завершении несохранённые строки теряются. Отсюда сброс перед
 *   границами стадий и при остановке процесса.
 * - При переполнении вытесняется самая старая запись, а не новая: последние
 *   события важнее для разбора зависшей задачи, а факт потери не скрывается.
 * - Максимальный возраст - это дебаунс, а не периодический таймер: отсчёт
 *   перезапускается на каждом событии, поэтому при непрерывном потоке сброс
 *   случается по размеру пачки, а возраст страхует только затишье.
 * - Таймер помечается unref: незакрытый setTimeout удерживает event loop, и
 *   процесс агента не завершился бы после остановки.
 * - Хуки принимают unknown и сужают тип через isRecord: сигнатуры событий
 *   рантайм-специфичны, и чужая форма входа не должна ронять рантайм.
 * - В лог попадает урезанное представление tool_input и только флаги о наличии
 *   ответа инструмента: сырые payload и содержимое файлов не логируются.
 */

import { appendTaskActivityLog } from "@aif/data";
import { logger, findMonorepoRootFromUrl, getEnv } from "@aif/shared";
import { broadcastTaskActivityProgress } from "./notifier.js";

const log = logger("agent-hooks");

// Корень вычисляется один раз на уровне модуля: агент запускается из произвольного
// cwd, но все рабочие пути должны быть привязаны к монорепозиторию. Значение в
// константе убирает повторный обход файловой системы на каждый вызов.
const PROJECT_ROOT = findMonorepoRootFromUrl(import.meta.url);

// Геттер остаётся единственной точкой входа для потребителей: если вычисление
// корня когда-нибудь станет ленивым или подменяемым в тестах, менять придётся
// только его, а не все места чтения константы.
/**
 * Возвращает корень монорепозитория, чтобы агенты работали в правильном cwd.
 */
export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

// Категории попадают в журнал текстовыми метками, а сам журнал хранится в БД
// строкой. Поэтому переименование значений - это изменение формата уже
// сохранённых записей, а не безобидный рефакторинг.
/** Категории журнала для записей активности. */
export type ActivityCategory = "Tool" | "Agent" | "Subagent";

// Сигнатура намеренно нейтральна к рантайму: @aif/agent не должен зависеть от
// типов конкретного SDK, иначе смена рантайма потянула бы правки сюда. Отсюда
// unknown на входе и обычный Record на выходе.
/**
 * Независимая от runtime сигнатура колбэка для hook-событий.
 * Удерживает @aif/agent без импортов типов конкретного SDK.
 */
export type RuntimeHookCallback = (
  input: unknown,
  toolUseId: string | undefined,
  options: unknown,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Очередь пакетного журнала активности
// ---------------------------------------------------------------------------

// Структурная запись вместо готовой строки: время фиксируется в момент события, а
// не в момент сброса пачки. Иначе все строки одной пачки получили бы одно и то же
// время flush, и хронология журнала перестала бы отражать реальный порядок.
interface QueueEntry {
  timestamp: string;
  category: ActivityCategory;
  detail: string;
}

// Очередь на каждую задачу отдельно, а не общая на процесс: сброс вызывается на
// границе стадии конкретной задачи, и общий буфер позволял бы пачке одной задачи
// выталкивать ещё не сброшенные строки другой.
/** Очередь в памяти для каждой задачи в batch-режиме. */
const taskQueues = new Map<string, QueueEntry[]>();

// Дескрипторы таймеров хранятся, чтобы отменять предыдущий дебаунс при следующем
// событии и снимать его при dispose. Без этого осиротевшие таймеры продолжали бы
// сбрасывать очередь уже завершённой задачи.
/** Дескрипторы таймеров сброса для каждой задачи. */
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Запись в БД и broadcast держатся в одной функции намеренно: UI узнаёт о новых
// строках только из broadcast, поэтому новая точка записи, забывшая про него,
// дала бы молча устаревший интерфейс.
/** Дописывает новые строки журнала в agentActivityLog задачи в БД и рассылает в UI. */
function appendActivityLogToDb(taskId: string, newLines: string): void {
  appendTaskActivityLog(taskId, newLines);
  broadcastTaskActivityProgress(taskId);
}

// Очередь опустошается через splice(0) до записи в БД: массив, переданный в запись
// по ссылке, мог бы измениться прямо во время работы, и часть событий потерялась
// бы или задвоилась. После splice буфер уже пуст, поэтому пришедшие позже строки
// попадут в следующую пачку.
/**
 * Сбрасывает отложенные записи активности одной задачи в БД.
 * Безопасно вызывать даже при пустой очереди (no-op).
 */
export function flushActivityQueue(taskId: string): void {
  const queue = taskQueues.get(taskId);
  if (!queue || queue.length === 0) {
    log.debug({ taskId, entries: 0 }, "Flush skipped — queue empty");
    return;
  }

  const entries = queue.splice(0);
  log.debug({ taskId, entries: entries.length, trigger: "flush" }, "Flushing activity queue");

  // Ошибку записи не пробрасываем: журналирование активности не должно ронять
  // стадию агента. Число потерянных строк уходит в лог, чтобы потеря была
  // заметной, а не молчаливой.
  try {
    const newLines = entries.map((e) => `[${e.timestamp}] ${e.category}: ${e.detail}`).join("\n");
    appendActivityLogToDb(taskId, newLines);
    log.info({ taskId, entries: entries.length, mode: "batch" }, "Activity queue flushed");
  } catch (err) {
    log.error({ err, taskId, lostEntries: entries.length }, "Failed to flush activity queue");
  }
}

/**
 * Сбрасывает все очереди задач. Используется при завершении или на границах стадий.
 */
// Снимок ключей делается заранее: итерация по живому Map, которую параллельно
// меняют обработчики сброса, дала бы непредсказуемый набор задач.
export function flushAllActivityQueues(): void {
  const taskIds = [...taskQueues.keys()];
  log.debug({ tasks: taskIds.length }, "Flushing all activity queues");
  for (const taskId of taskIds) {
    flushActivityQueue(taskId);
  }
}

// Порядок операций принципиален: снять таймер, сбросить остаток, удалить очередь.
// Удаление до сброса выбросило бы накопленные строки, а снятие таймера после -
// могло бы привести к повторному сбросу уже очищенной очереди.
/**
 * Убирает таймеры сброса и очереди для заданной задачи.
 * Вызывать, когда задача закончила стадию или процесс завершился.
 */
export function disposeActivityQueue(taskId: string): void {
  const timer = flushTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(taskId);
  }
  flushActivityQueue(taskId);
  taskQueues.delete(taskId);
  log.debug({ taskId }, "Activity queue disposed");
}

// Таймер переставляется, а не продлевается: старый снимается, новый отсчитывает
// maxAgeMs от текущего события. Это дебаунс, поэтому при непрерывном потоке
// событий сброс происходит по размеру пачки, а возраст срабатывает только в
// затишье.
/** Сбрасывает таймер max-age для задачи (batch-режим). */
function resetFlushTimer(taskId: string, maxAgeMs: number): void {
  const existing = flushTimers.get(taskId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    log.debug({ taskId, trigger: "max_age" }, "Max-age flush timer fired");
    flushActivityQueue(taskId);
    // Дескриптор убирается из карты после срабатывания: оставшийся дескриптор
    // заставил бы следующий reset снимать уже отстрелянный таймер и создавал бы
    // иллюзию живого сброса.
    flushTimers.delete(taskId);
  }, maxAgeMs);

  // Не даём таймеру удерживать процесс живым
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }

  flushTimers.set(taskId, timer);
}

/**
 * Добавляет структурированную запись активности в agentActivityLog задачи.
 * Формат: `[timestamp] Category: detail`
 *
 * В режиме `sync` (по умолчанию): пишет в БД немедленно.
 * В режиме `batch`: копится в памяти и сбрасывается при достижении размера
 * пачки, возраста max age или ручном сбросе.
 */
export function logActivity(taskId: string, category: ActivityCategory, detail: string): void {
  // Время фиксируется здесь и одинаково для обоих режимов: порядок строк в журнале
  // не должен зависеть от того, когда произошёл сброс пачки.
  const env = getEnv();
  const timestamp = new Date().toISOString();

  log.debug({ taskId, category, detail, mode: env.ACTIVITY_LOG_MODE }, "Activity logged");

  // Синхронный режим идёт мимо очереди: строка и уведомление уходят на каждом
  // событии. Это максимальная сохранность ценой отдельной транзакции на каждый
  // tool-use, поэтому на плотном потоке режим упирается в БД.
  if (env.ACTIVITY_LOG_MODE === "sync") {
    const entry = `[${timestamp}] ${category}: ${detail}`;
    try {
      appendActivityLogToDb(taskId, entry);
    } catch (err) {
      log.error({ err, taskId }, "Failed to update agent activity log");
    }
    return;
  }

  // --- batch-режим ---
  // Очередь создаётся лениво при первом событии: для задач, которые ничего не
  // логируют в batch-режиме, записей в карте не появляется вовсе, поэтому карта не
  // растёт вместе с числом обработанных задач.
  let queue = taskQueues.get(taskId);
  if (!queue) {
    queue = [];
    taskQueues.set(taskId, queue);
  }

  // При переполнении вытесняется самая старая запись, а не отбрасывается новая:
  // последние события важнее для разбора зависшей задачи. Факт потери не
  // скрывается - в warning уходит время выброшенной строки.
  // Ограничение очереди — при переполнении вытесняется старейшая запись
  if (queue.length >= env.ACTIVITY_LOG_QUEUE_LIMIT) {
    const dropped = queue.shift();
    log.warn(
      { taskId, queueLimit: env.ACTIVITY_LOG_QUEUE_LIMIT, droppedTimestamp: dropped?.timestamp },
      "Activity queue limit reached — dropping oldest entry",
    );
  }

  queue.push({ timestamp, category, detail });
  log.debug({ taskId, queueSize: queue.length }, "Activity entry enqueued");

  // Сбрасываем, если достигнут размер пачки
  if (queue.length >= env.ACTIVITY_LOG_BATCH_SIZE) {
    log.debug({ taskId, trigger: "batch_size" }, "Batch size flush triggered");
    flushActivityQueue(taskId);
    // Таймер переставляется даже после сброса: следующая пачка должна получить
    // полный интервал maxAgeMs, а не остаток от предыдущей.
    // Сбрасываем таймер max-age: только что произошёл flush
    resetFlushTimer(taskId, env.ACTIVITY_LOG_BATCH_MAX_AGE_MS);
    return;
  }

  // (Пере)запускаем таймер max-age
  resetFlushTimer(taskId, env.ACTIVITY_LOG_BATCH_MAX_AGE_MS);
}

// Проверка именно на "обычный" объект: массив тоже проходит typeof === "object",
// но доступ к нему как к словарю полей бессмыслен. События рантаймов приходят как
// unknown, поэтому сужение типа делается здесь и только здесь.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// Многострочные значения схлопываются в одну строку: формат журнала построчный, и
// переводы строк внутри детали сломали бы его разбор. Фильтр по пустым строкам
// нужен, чтобы первой meaningful считалась именно непустая строка.
/**
 * Приводит многострочную строку к однострочному виду для журнала активности.
 * Если есть переносы — оставляет первую осмысленную строку, заменяя
 * остальное маркером продолжения.
 */
export function sanitizeForActivityLog(raw: string, maxLen = 200): string {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  const first = lines[0].slice(0, maxLen);
  if (lines.length === 1) return first;
  return `${first} [+${lines.length - 1} lines]`;
}

// Разбор идёт по фиксированному набору известных инструментов, а всё остальное
// даёт пустую строку: имена и формы входа зависят от рантайма, а выводить сюда
// сырой JSON нельзя - он раздул бы каждую строку журнала.
/** Краткая деталь из tool_input по имени инструмента. */
function summarizeToolInput(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): string {
  if (!toolInput) return "";

  switch (toolName) {
    case "Bash": {
      const cmd = sanitizeForActivityLog(String(toolInput.command ?? ""));
      return cmd ? ` \`${cmd}\`` : "";
    }
    case "Read":
    case "Write":
    case "Edit":
      return toolInput.file_path ? ` ${toolInput.file_path}` : "";
    case "Glob":
      return toolInput.pattern ? ` ${toolInput.pattern}` : "";
    case "Grep":
      return toolInput.pattern ? ` /${toolInput.pattern}/` : "";
    case "Agent": {
      const desc = toolInput.description ?? toolInput.subagent_type ?? "";
      return desc ? ` ${desc}` : "";
    }
    default:
      return "";
  }
}

// Контекст собирается перечислением полей, а не spread: в событиях бывают крупные
// и чувствительные данные, и логировать их целиком нельзя. Команда дополнительно
// обрезается, потому что длинные shell-строки раздувают лог сильнее всего.
function buildHookLogContext(data: Record<string, unknown>): Record<string, unknown> {
  const toolInput = isRecord(data.tool_input) ? data.tool_input : undefined;
  const toolResponse = isRecord(data.tool_response) ? data.tool_response : undefined;

  return {
    session_id: data.session_id,
    agent_type: data.agent_type,
    hook_event_name: data.hook_event_name,
    tool_name: data.tool_name,
    tool_use_id: data.tool_use_id,
    cwd: data.cwd,
    permission_mode: data.permission_mode,
    transcript_path: data.transcript_path,
    tool_input: toolInput
      ? {
          file_path: toolInput.file_path,
          pattern: toolInput.pattern,
          command:
            typeof toolInput.command === "string" ? toolInput.command.slice(0, 200) : undefined,
        }
      : undefined,
    tool_response: toolResponse
      ? {
          type: toolResponse.type,
          // Специально не логируем payload/содержимое ответа: логи должны оставаться маленькими и безопасными.
          has_file: Boolean(toolResponse.file),
          has_content: Boolean(
            toolResponse.content || (isRecord(toolResponse.file) && toolResponse.file.content),
          ),
        }
      : undefined,
  };
}

// Незнакомая форма входа молча пропускается: хук висит на событиях чужого
// рантайма, и падение здесь сломало бы не логирование, а сам рантайм.
/**
 * Создаёт callback хука PostToolUse, журналирующего активность инструментов.
 */
export function createActivityLogger(taskId: string): RuntimeHookCallback {
  return async (input, _toolUseId, _options) => {
    if (!isRecord(input)) return {};
    const data = input as Record<string, unknown>;
    const toolName = String(data.tool_name ?? "unknown");
    const toolInput = isRecord(data.tool_input) ? data.tool_input : undefined;
    const detail = summarizeToolInput(toolName, toolInput);

    log.debug({ taskId, toolName, hookInput: buildHookLogContext(data) }, "Agent tool use logged");

    logActivity(taskId, "Tool", `${toolName}${detail}`);
    // Пустой объект - требование контракта хука: возвращаемое значение никем не
    // читается, но вернуть undefined вместо объекта нельзя.
    return {};
  };
}

// Имя субагента приходит под разными ключами в разных рантаймах, поэтому берётся
// первое непустое. Короткий идентификатор нужен только для того, чтобы отличать
// параллельные запуски в журнале.
/**
 * Создаёт callback хука SubagentStart, журналирующий запуск сабагентов.
 */
export function createSubagentLogger(taskId: string): RuntimeHookCallback {
  return async (input, _toolUseId, _options) => {
    if (!isRecord(input)) return {};
    const data = input as Record<string, unknown>;
    const agentName = String(
      data.agent_name ?? data.subagent_type ?? data.agent_type ?? data.description ?? "unknown",
    );
    const agentId = String(data.agent_id ?? data.session_id ?? "");
    const idSuffix = agentId ? ` (${agentId.slice(0, 8)})` : "";

    log.info({ taskId, agentName, hookInput: buildHookLogContext(data) }, "Subagent started");

    logActivity(taskId, "Subagent", `${agentName} started${idSuffix}`);
    return {};
  };
}
