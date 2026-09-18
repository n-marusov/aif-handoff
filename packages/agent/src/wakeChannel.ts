/**
 * Канал «пробуждения» координатора: подписка на WebSocket API и ранний опрос.
 *
 * Зачем: периодический опрос - надёжный, но медленный путь. Событие task:created
 * ждёт в среднем половину интервала, а нужен отклик за секунды. Канал превращает
 * событие в немедленный вызов pollAndProcess, оставаясь необязательным ускорителем.
 *
 * Инварианты и подводные камни:
 * - Канал никогда не является источником истины: если он молчит или отключён,
 *   опрос по таймеру полностью покрывает работу. Отсюда все fallback-ветки.
 * - Дебаунс обязателен: одна стадия порождает целый залп событий, и без него
 *   несколько опросов пошли бы друг за другом в один момент.
 * - Переподключение с экспоненциальной задержкой и дрожанием: без дрожания
 *   несколько агентов переподключались бы синхронно и били по API волной.
 * - Таймер переподключения снимается с учёта (unref): висящий таймер не должен
 *   мешать процессу завершиться штатно.
 */

/**
 * Канал пробуждения по событиям — подписывается на WebSocket API за сигналами пробуждения координатора.
 * Выделен из notifier.ts ради единственной ответственности.
 */

import { WebSocket } from "ws";

import { logger, getEnv } from "@aif/shared";

// Используем пакет `ws` вместо глобального `WebSocket`. Глобальный
// `WebSocket` появился только в Node 21, а `engines.node` разрешает 20.19+.
// На Node 20.x это раньше давало непрерывный спам в лог
// `ReferenceError: WebSocket is not defined` плюс реконнект в частом цикле,
// заливавший stdout и маскировавший реальные ошибки агента.

const log = logger("wake-channel");

/** События, которые должны будить координатор. */
// Список заведомо узкий: сюда попадают только события, после которых состояние
// задач действительно может измениться. Широкий подписчик дал бы лишние опросы.
const WAKE_EVENTS = new Set(["task:created", "task:moved", "agent:wake"]);

type WakeCallback = (reason: string) => void;

let _ws: WebSocket | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _wakeCallback: WakeCallback | null = null;
// Модульное состояние, а не класс: канал глобальный на процесс, и такая форма
// упрощает тесты через _resetForTesting().
let _lastWakeTime = 0;
let _reconnectAttempts = 0;
let _closed = false;

const DEBOUNCE_MS = 2000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const READINESS_PROBE_TIMEOUT_MS = 3000;
const READINESS_MAX_RETRIES = 10;
const READINESS_RETRY_DELAY_MS = 2000;

function getWsUrl(): string {
  const env = getEnv();
  const httpBase = env.API_BASE_URL;
  // URL выводится из HTTP-адреса заменой схемы: отдельная переменная окружения
  // для WS означала бы два места, которые надо держать согласованными.
  return httpBase.replace(/^http/, "ws") + "/ws";
}

function getApiBaseUrl(): string {
  return getEnv().API_BASE_URL;
}

/** Проверяет endpoint health API, подтверждая готовность принимать соединения. */
export async function waitForApiReady(): Promise<boolean> {
  const baseUrl = getApiBaseUrl();
  const url = `${baseUrl}/health`;

  for (let attempt = 1; attempt <= READINESS_MAX_RETRIES; attempt++) {
    try {
      // Отдельный AbortController на попытку: иначе один зависший запрос съел бы
      // весь бюджет ретраев и проверка превратилась бы в бесконечное ожидание.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), READINESS_PROBE_TIMEOUT_MS);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        log.info({ attempt }, "API health endpoint responded");
        return true;
      }
      log.debug({ attempt, status: res.status }, "API not ready yet");
    } catch {
      log.debug({ attempt }, "API readiness probe failed — retrying");
    }

    // Пауза только между попытками: после последней ждать незачем, иначе старт
    // агента задержится на пустом месте.
    if (attempt < READINESS_MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, READINESS_RETRY_DELAY_MS));
    }
  }

  log.warn("API readiness probe exhausted retries — proceeding with WS connect anyway");
  // false не отменяет подключение: сокет умеет сам переподключаться, а отказ от
  // попытки оставил бы агента без ускорителя до ручного перезапуска.
  return false;
}

function handleMessage(data: string): void {
  // Тело сообщения приходит извне и может быть любым: разбор защищён, а ошибка
  // остаётся на уровне debug - битое сообщение не должно шуметь в логах.
  try {
    const parsed = JSON.parse(data);
    const eventType = parsed?.type as string | undefined;

    if (!eventType || !WAKE_EVENTS.has(eventType)) return;

    // Дебаунс окна, а не очереди: слишком частые события не накапливаются, а
    // просто схлопываются в один опрос. Так исключается лавина опросов.
    const now = Date.now();
    if (now - _lastWakeTime < DEBOUNCE_MS) {
      log.debug({ eventType, debounceMs: DEBOUNCE_MS }, "Wake debounced");
      return;
    }

    _lastWakeTime = now;
    log.info({ reason: eventType }, "Wake signal received");
    // Опциональная цепочка: колбэка может не быть (канал поднят до инициализации
    // координатора), и падать в таком случае нельзя.
    _wakeCallback?.(eventType);
  } catch {
    log.debug("Failed to parse WS message for wake channel");
  }
}

/** Вычисляет задержку переподключения с экспоненциальным backoff + джиттером. */
export function getReconnectDelay(attempt: number): number {
  const exponential = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
  // Дрожание аддитивное и случайное: без него все процессы после общего сбоя
  // переподключались бы синхронно и создавали пик на API.
  const jitter = Math.floor(Math.random() * exponential * 0.3);
  return exponential + jitter;
}

function scheduleReconnect(): void {
  // Два ранних выхода: таймер уже стоит, либо канал закрыт намеренно. Второй
  // случай важен при завершении процесса - переподключение после close лишнее.
  if (_reconnectTimer || _closed) return;
  if (!_wakeCallback) {
    log.debug("No wake callback registered — skipping reconnect");
    return;
  }

  const delay = getReconnectDelay(_reconnectAttempts);
  log.info(
    { attempt: _reconnectAttempts + 1, delayMs: delay },
    "Scheduling wake channel reconnect",
  );

  const callback = _wakeCallback;
  // Колбэк захватывается в локальную переменную до таймера: если за время
  // ожидания канал переподключат заново, старый таймер не утащит новый колбэк.
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _reconnectAttempts++;
    connectWakeChannel(callback);
  }, delay);
  // unref: таймер не должен держать процесс живым, иначе штатное завершение
  // будет ждать до 30 секунд впустую.
  if (typeof _reconnectTimer === "object" && "unref" in _reconnectTimer) {
    _reconnectTimer.unref();
  }
}

/**
 * Подключается к WebSocket API для приёма сигналов пробуждения.
 * Возвращает true, если подключение инициировано (ещё не обязательно открыто).
 */
export function connectWakeChannel(onWake: WakeCallback): boolean {
  _wakeCallback = onWake;
  // Повторное подключение снимает флаг закрытия: канал должен уметь ожить после
  // closeWakeChannel, иначе переподключение после сбоя окажется вечно выключено.
  _closed = false;
  const wsUrl = getWsUrl();

  try {
    _ws = new WebSocket(wsUrl);

    _ws.addEventListener("open", () => {
      // Счётчик сбрасывается только на успешном открытии: до этого момента
      // задержка должна расти, иначе будет шторм попыток при живом порте.
      _reconnectAttempts = 0;
      log.info({ wsUrl }, "Wake channel connected");
    });

    _ws.addEventListener("message", (event) => {
      // event.data бывает Buffer при бинарном кадре: приводим к строке, чтобы
      // разбор не падал с невнятной ошибкой.
      handleMessage(typeof event.data === "string" ? event.data : String(event.data));
    });

    _ws.addEventListener("close", () => {
      log.warn("Wake channel disconnected — scheduling reconnect");
      // Ссылка сбрасывается до планирования: scheduleReconnect проверяет
      // состояние, и живой указатель на закрытый сокет сбивал бы проверки.
      _ws = null;
      scheduleReconnect();
    });

    _ws.addEventListener("error", (err) => {
      log.error({ err }, "Wake channel error");
    });

    return true;
  } catch (err) {
    // Синхронный выброс конструктора: не роняем агента, а планируем повтор и
    // сообщаем вызывающему, что подключение не инициировано.
    log.error({ err, wsUrl }, "Failed to initiate wake channel connection");
    scheduleReconnect();
    return false;
  }
}

/** Аккуратно закрывает канал пробуждения. */
export function closeWakeChannel(): void {
  // _closed выставляется первым: обработчик close не должен запланировать
  // переподключение уже закрытого канала.
  _closed = true;
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  if (_ws) {
    _ws.close();
    _ws = null;
  }
  _wakeCallback = null;
  // Счётчик обнуляется при закрытии: следующий connectWakeChannel начнётся с
  // минимальной задержки, а не с накопленной в прошлой жизни.
  _reconnectAttempts = 0;
  log.debug("Wake channel closed");
}

/** True, если WS пробуждения сейчас подключён (OPEN). */
// Проверяется именно readyState OPEN: наличие объекта _ws не означает, что
// соединение установлено (например, в состоянии CONNECTING оно ещё живо).
export function isWakeChannelConnected(): boolean {
  return _ws?.readyState === WebSocket.OPEN;
}

/** Сбрасывает внутреннее состояние — только для тестов. */
// Сброс всех модульных переменных: тесты гоняются в одном процессе, и без этого
// состояние одного теста протекало бы в следующий.
export function _resetForTesting(): void {
  _ws = null;
  _reconnectTimer = null;
  _wakeCallback = null;
  _lastWakeTime = 0;
  _reconnectAttempts = 0;
  _closed = false;
}
