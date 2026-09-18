/**
 * HTTP(S)-прокси: env-переменные для spawn-процессов и dispatcher для fetch.
 *
 * Проблема в том, что прокси настраиваются в двух непересекающихся мирах:
 * - CLI-агенты (claude, codex), запускаемые как дочерние процессы, читают
 *   HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY из окружения сами;
 * - нативный fetch/undici в самом процессеNode их НЕ читает: ему нужен
 *   ProxyAgent-dispatcher, который передаётся в каждый RequestInit.
 * Этот модуль - единая реализация общей семантики (приоритеты, NO_PROXY),
 * чтобы поведение «через прокси или нет» не расходилось у fetch и у spawn.
 *
 * Соблюдается де-факто стандарт curl и подобных инструментов: scheme-specific
 * переменная > ALL_PROXY > ничего, а NO_PROXY имеет абсолютный приоритет над
 * всеми. Env читается через параметр env с дефолтом process.env: функции остаются
 * чистыми и тестируемыми без подмены глобального окружения.
 */

import { ProxyAgent, type Dispatcher } from "undici";

// Полный набор из восьми имён: и верхний, и нижний регистр. Исторически
// POSIX-инструменты используют нижний регистр (env-переменные в shell -
// чувствительны к регистру), а многие библиотеки пишут UPPER_CASE; корректный
// клиент обязан поддерживать оба. Список - единый источник правды для
// isProxyEnvironmentKey, которой пользуются при сборке окружения spawn.
export const PROXY_ENV_VARS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

// RequestInit + необязательное поле dispatcher: нестандартное расширение fetch,
// которое понимает только undici. Тип нужен, чтобы не кастовать объект на каждом
// месте вызова и явно показать: сюда можно положить ProxyAgent.
export interface RequestInitWithDispatcher extends RequestInit {
  dispatcher?: Dispatcher;
}

// Кэш диспетчеров на уровне модуля. ProxyAgent держит пул сокетов и фоновые
// таймеры: создавать его на каждый запрос означало бы копировать соединения и
// не отдавать их GC. Ключ - не только URL прокси, но и таймауты (см.
// dispatcherCacheKey), иначе первый созданный агент навязал бы свои таймауты
// всем остальным пользователям того же прокси.
const dispatcherCache = new Map<string, Dispatcher>();

// Таймауты проксируются в ProxyAgent напрямую: bodyTimeout/headersTimeout -
// имена undici, и здесь они описаны как опции, а не как константы, потому что
// разные вызовы (discovery, чат, загрузка) имеют разный приемлемый latency.
export interface ProxyDispatcherOptions {
  bodyTimeout?: number;
  headersTimeout?: number;
}

// Проверка «это прокси-переменная?», полезная при фильтрации окружения для
// spawn (протащить/не протолкнуть прокси в дочерний процесс). Костыль as
// (typeof PROXY_ENV_VARS)[number] - идиома для readonly-кортежей: includes у
// кортежа литералов ожидает аргумент строго из этого союза, а не любую string;
// каст здесь безопасен, потому что проверка как раз и определяет принадлежность.
export function isProxyEnvironmentKey(key: string): boolean {
  return PROXY_ENV_VARS.includes(key as (typeof PROXY_ENV_VARS)[number]);
}

// Разбор URL терпелив к строке/объекту, но бросает на мусоре - callers должны
// передавать валидный URL.
// NO_PROXY проверяется первым и коротко замыкает: обход - исключение из правил,
// оно не может «перекрыться» более специфичной переменной.
// readEnv(...) ?? readEnv(lowercase) - канонический порядок: UPPER_CASE ищется
// раньше, как это делают curl и компания; все - fallback последнего уровня.
// Для неизвестных схем (ftp: и прочих) остаётся только ALL_PROXY: схема-специфичные
// переменные к ним неприменимы.
export function resolveProxyUrlForRequest(
  url: string | URL,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;
  if (shouldBypassProxy(parsedUrl, env.NO_PROXY ?? env.no_proxy)) {
    return null;
  }

  const allProxy = readEnv(env.ALL_PROXY) ?? readEnv(env.all_proxy);
  if (parsedUrl.protocol === "https:") {
    return readEnv(env.HTTPS_PROXY) ?? readEnv(env.https_proxy) ?? allProxy;
  }
  if (parsedUrl.protocol === "http:") {
    return readEnv(env.HTTP_PROXY) ?? readEnv(env.http_proxy) ?? allProxy;
  }
  return allProxy;
}

// Обёртка над предыдущей: превращает URL прокси в живой объект-транспорт.
// undefined (а не null) на «без прокси» - RequestInit.dispatcher ожидает именно
// undefined как «нет значения», чтобы не переопределять явно выставленное поле.
// Логика кэша классическая check-create-store: гонок тут нет, потому что весь код
// синхронный (Node однопоточен между await, а здесь await нет вообще).
export function resolveProxyDispatcher(
  url: string | URL,
  env: NodeJS.ProcessEnv = process.env,
  options: ProxyDispatcherOptions = {},
): Dispatcher | undefined {
  const proxyUrl = resolveProxyUrlForRequest(url, env);
  if (!proxyUrl) {
    return undefined;
  }

  const normalizedProxyUrl = normalizeProxyUrl(proxyUrl);
  const cacheKey = dispatcherCacheKey(normalizedProxyUrl, options);
  let dispatcher = dispatcherCache.get(cacheKey);
  if (!dispatcher) {
    dispatcher = createProxyDispatcher(normalizedProxyUrl, options);
    dispatcherCache.set(cacheKey, dispatcher);
  }
  return dispatcher;
}

// Функция для мест, «где уже есть RequestInit, нужно тихо добавить прокси»: fetch(url,
// withProxyDispatcher(url, init)). Если прокси нет, возвращается ТОТ ЖЕ объект,
// а не копия: не плодим мусор и не ломаем сравнение по ссылкам у вызывающих.
export function withProxyDispatcher(
  url: string | URL,
  init: RequestInit = {},
  env: NodeJS.ProcessEnv = process.env,
): RequestInitWithDispatcher {
  const dispatcher = resolveProxyDispatcher(url, env);
  return dispatcher ? { ...init, dispatcher } : init;
}

// Единственное место, где рождается ProxyAgent. Опции разворачиваются поверх
// uri: если их нет, undici применяет свои дефолты - явного дублирования значений
// по умолчанию в коде нет специально.
function createProxyDispatcher(proxyUrl: string, options: ProxyDispatcherOptions): Dispatcher {
  return new ProxyAgent({ uri: proxyUrl, ...options });
}

// URL прокси нормализуется перед использованием и перед ключом кэша: два
// «разных» написания одного прокси (http://proxy:3128/ и http://proxy:3128) не
// должны плодить два ProxyAgent. socks: переименовывается в socks5:, потому что
// undici понимает только socks5-схему, а пользователи пишут в env и socks://.
function normalizeProxyUrl(proxyUrl: string): string {
  const parsed = new URL(proxyUrl);
  if (parsed.protocol === "socks:") {
    parsed.protocol = "socks5:";
  }
  return parsed.toString();
}

// Ключ кэша обязан различать ВСЕ входы createProxyDispatcher, иначе второй вызов
// с другими таймаутами получил бы первый агент с чужими настройками. Шаблонный
// литерал различает и undefined (=> пусто), и 0 (=> "0"): это разные
// конфигурации, и они не должны столкнуться в одном ключе. Разделители | и имена
// полей гарантируют, что разные комбинации не склеятся в одинаковую строку.
function dispatcherCacheKey(proxyUrl: string, options: ProxyDispatcherOptions): string {
  return `${proxyUrl}|body=${options.bodyTimeout ?? ""}|headers=${options.headersTimeout ?? ""}`;
}

// Пустая строка приравнивается к unset: HTTP_PROXY="" означает «не задано»,
// а не «прокси-адрес из пустой строки». Trim спасает от случайных пробелов в
// .env-файлах, которые иначе ушли бы в URL и дали бы необъяснимую ошибку парсинга.
function readEnv(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Разбор NO_PROXY по семантике curl: список через запятую, *«» - обход всего,
// домен с точкой в начале - суффиксное совпадение, опциональный :port сужает
// правило до конкретного порта.
// Порт подставляется дефолтным значением, если URL его не указал: иначе запись
// "example.com:80" не совпала бы с http://example.com (у которого port === "").
// Вся цепочка split/map/filter - отказ от регулярок ради читаемости: пустые
// сегменты от двойных запятых и пробелы вокруг значений отбиваются здесь, а не
// в matchesNoProxyEntry.
function shouldBypassProxy(url: URL, noProxyValue: string | undefined): boolean {
  const noProxy = readEnv(noProxyValue);
  if (!noProxy) {
    return false;
  }

  const hostname = normalizeHostname(url.hostname);
  const port = url.port || defaultPort(url.protocol);

  return noProxy
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .some((entry) => matchesNoProxyEntry(entry, hostname, port));
}

// Совпадение одной записи NO_PROXY с hostname:port.
// Wildcard-«звёздочка» проверяется первой: «нет проверки» дороже любой эвристики.
// Запись с портом и несовпавшим портом - отказ без сравнения хоста: порт часть
// правила.
function matchesNoProxyEntry(entry: string, hostname: string, port: string): boolean {
  if (entry === "*") {
    return true;
  }

  const { host: rawHost, port: entryPort } = splitNoProxyEntry(entry);
  if (entryPort && entryPort !== port) {
    return false;
  }

  const host = normalizeHostname(rawHost);
  if (!host) {
    // Пустой хост после нормализации (например, запись ":8080") - правило
    // бессмысленно, игнорируем вместо «совпадает со всем».
    return false;
  }
  if (host.startsWith(".")) {
    // Явный суффиксный стиль ".example.com": вариант A - hostname ровно домен
    // без точки, вариант B - заканчивается на ".example.com" вместе с точкой.
    const suffix = host.slice(1);
    return hostname === suffix || hostname.endsWith(host);
  }
  // «example.com» без точки совпадает и с самим собой, и с поддоменами:
  // приписываем точку слева и сравниваем хвост - так user.example.com попадает
  // под правило, а notexample.com - нет (проверка с точкой отсекает «прилепленные»
  // совпадения).
  return hostname === host || hostname.endsWith(`.${host}`);
}

// Разделение записи вида host:port с учётом IPv6. Квадратные скобки - маркер
// IPv6 ([::1]:8080): порт ищем после закрывающей скобки, иначе двоичные
// адресные «:» разрезали бы хост пополам.
// Без скобок спасает трюк с двумя индексами: двоеточие трактуется как разделитель
// порта только если оно в строке ровно ОДНО (indexOf === lastIndexOf). В IPv6 без
// скобок (::1) двоеточий несколько - это хост, а не host:port.
function splitNoProxyEntry(entry: string): { host: string; port: string | null } {
  if (entry.startsWith("[") && entry.includes("]")) {
    const closing = entry.indexOf("]");
    const host = entry.slice(0, closing + 1);
    const rest = entry.slice(closing + 1);
    return rest.startsWith(":") ? { host, port: rest.slice(1) } : { host, port: null };
  }

  const colonIndex = entry.lastIndexOf(":");
  if (colonIndex > -1 && entry.indexOf(":") === colonIndex) {
    return { host: entry.slice(0, colonIndex), port: entry.slice(colonIndex + 1) };
  }

  return { host: entry, port: null };
}

// Хосты DNS регистронезависимы, а hostname из URL - обычно в нижнем, но NO_PROXY
// вводит человек и он может написать EXAMPLE.COM. Скобки при IPv6-адресах
// снимаются: в hostname из URL их нет, и сравнение «[::1]» vs «::1» провалилось
// бы, если бы пользователь обёртки оставил и в правиле.
function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

// URL.port пуст для стандартных портов (http://x == http://x:80). Подставляем
// дефолт, чтобы сравнение порта в matchesNoProxyEntry было честным: и «x:80» в
// NO_PROXY, и голый x должны совпадать с http://x.
// '' для прочих схем - совпадение возможно только если порт явно указан.
function defaultPort(protocol: string): string {
  if (protocol === "https:") return "443";
  if (protocol === "http:") return "80";
  return "";
}
