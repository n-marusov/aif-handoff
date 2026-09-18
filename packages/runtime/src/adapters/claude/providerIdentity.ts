/**
 * Определение провайдера за Anthropic-совместимым эндпоинтом.
 *
 * Один и тот же адаптер Claude разговаривает и с настоящим Anthropic, и с похожими на
 * него провайдерами (Z.AI GLM Coding Plan, Alibaba coding plan на антропическом
 * протоколе), а у каждого свои особенности: где брать квоты, в какой переменной лежит
 * ключ, нужно ли вообще читать ~/.claude/settings.json. Модуль отвечает на вопрос
 * «кто на другом конце» и выдаёт устойчивую идентичность ClaudeProviderIdentity, по
 * которой дальше ветвится логика квот и аутентификации.
 *
 * Различение идёт по двум публичным признакам: hostname/путь baseUrl и префиксу ключа
 * (sk-sp-). Это эвристики, а не гарантия API: при смене адресов провайдером расширять
 * распознавание нужно именно здесь. Самих секретов в идентичности нет: для опознания
 * служит хеш-отпечаток, поэтому идентичность не страшно записать в БД или в лог.
 */

// Модуль использует только стандартную библиотеку Node: node:crypto - для хеша
// отпечатка, node:fs - для чтения файла настроек, node:os/node:path - для пути к
// домашнему каталогу. Внешних зависимостей нет: идентификация провайдера должна
// работать в любом окружении, включая минимальный контейнер.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Путь к файлу настроек Claude Code: при транспортах sdk/cli пользователь мог
// настроить эндпоинт именно там, а не в профиле Handoff.
const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
// Базовый URL Anthropic по умолчанию (когда ANTHROPIC_BASE_URL не задан). Служит
// фолбэком для зоны отпечатка: «URL не указан» и «явно api.anthropic.com» должны
// считаться одним и тем же аккаунтом.
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

// «Const-объект + производный union-тип» - идиоматичный способ сделать в TypeScript
// enum без enum: значения доступны в рантайме (сравнимы через ===), а тип допускает
// только перечисленные литералы. Перечисление заморожено as const - мутация значений
// исказила бы сравнения во всех потребителях.
export const ClaudeProviderFamily = {
  ANTHROPIC_NATIVE: "anthropic-native",
  ZAI_GLM_CODING: "zai-glm-coding",
  ALIYUN_CODING_PLAN_ANTHROPIC: "aliyun-coding-plan-anthropic",
  OTHER_ANTHROPIC_COMPATIBLE: "other-anthropic-compatible",
} as const;

// `keyof typeof ОБЪЕКТ` даёт объединение ключей, а индексация им - объединение
// значений: получаем ClaudeProviderFamily = "anthropic-native" | "zai-glm-coding" | ...
// без дублирования строк. Дописать семейство - значит добавить поле в объект выше.
export type ClaudeProviderFamily = (typeof ClaudeProviderFamily)[keyof typeof ClaudeProviderFamily];

// Локальные настройки Claude Code, прочитанные из settings.json: только те два поля,
// которые влияют на выбор эндпоинта и ключа.
export interface ClaudeLocalSettingsIdentity {
  // Эндпоинт из ANTHROPIC_BASE_URL: именно он решает, к какому семейству относится
  // запуск, если профиль URL не задал.
  baseUrl: string | null;
  // Токен из ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY: используется как фолбэк источника
  // ключа и как приоритетный источник для Z.AI.
  authToken: string | null;
}

// Итоговая идентичность провайдера - сериализуемые данные без секретов: из неё
// строятся providerMeta и записи в истории лимитов, и реальный ключ сюда попасть не
// должен. apiKeyEnvVar хранит ИМЯ переменной, а не значение.
export interface ClaudeProviderIdentity {
  providerFamily: ClaudeProviderFamily;
  providerLabel: string;
  // Откуда у этого провайдера принято брать квоты: sdk_event (rate_limit_event в
  // потоке), headers (HTTP-заголовки api-транспорта), zai_monitor (опрос
  // монитор-эндпоинтов Z.AI), none (провайдер не отдаёт данных о квотах).
  quotaSource: "sdk_event" | "headers" | "zai_monitor" | "none";
  baseUrl: string | null;
  baseOrigin: string | null;
  apiKeyEnvVar: string | null;
  accountFingerprint: string | null;
  accountLabel: string | null;
}

export interface ResolveClaudeProviderIdentityInput {
  providerId?: string | null;
  transport?: string | null;
  baseUrl?: string | null;
  apiKeyEnvVar?: string | null;
  apiKey?: string | null;
  env?: Record<string, string | undefined>;
  defaultModel?: string | null;
  // Тестовый шов для ~/.claude/settings.json: передача null моделирует «файла нет»,
  // а undefined - «не вмешиваться, прочитать настоящий файл». Именно поэтому здесь
  // различаются «не задано» и «задано null», а не проверяется truthiness.
  localSettingsOverride?: ClaudeLocalSettingsIdentity | null;
}

// Промежуточный контекст аутентификации: один и тот же набор решений используется и
// при построении идентичности, и при возврате самого токена, поэтому две экспортные
// функции не могут разойтись в выборе ключа или baseUrl.
interface ResolvedAuthContext {
  baseUrl: string | null;
  baseOrigin: string | null;
  apiKeyEnvVar: string | null;
  apiKey: string | null;
  localSettings: ClaudeLocalSettingsIdentity | null;
}

// Разбор недоверенных данных с null-результатом: правила проекта требуют явного
// `| null` в типе и проверки перед доступом, поэтому каждый вызывающий обязательно
// guard'ит значение, и нет способа «заглушить» nullable кастом.
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Пустая/пробельная строка приравнивается к отсутствию: так у всех URL- и
// env-хелперов одно представление «значения нет», и цепочки `??` читаются однозначно.
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// new URL бросает на мусоре, а baseUrl - произвольный текст из профиля или файла
// настроек. Перехват в null вместо исключения позволяет всей цепочке ниже считать
// значение «возможно, отсутствующим», а не обрабатывать сбой на каждом уровне.
function parseUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    // catch без параметра: причина (TypeError от new URL) здесь не нужна и не логируется -
    // важен только факт «распарсить нельзя».
    return null;
  }
}

// Конечные слэши срезаются: «https://api.z.ai/v1/» и «https://api.z.ai/v1» должны
// опознаваться как один адрес, а URL сравнивает строки строго.
function normalizeBaseUrl(value: string | null | undefined): string | null {
  const parsed = parseUrl(value ?? null);
  return parsed ? parsed.toString().replace(/\/+$/, "") : null;
}

// Origin (схема + хост + порт) отбрасывает путь: отпечаток аккаунта и опрос квот живут
// по разным правилам, но оба привязаны к серверу, а не к конкретному эндпоинту.
function normalizeBaseOrigin(value: string | null | undefined): string | null {
  const parsed = parseUrl(value ?? null);
  return parsed ? parsed.origin.toLowerCase() : null;
}

// Хост и путь приводятся к нижнему регистру: по DNS-конвенции регистр не важен, и без
// нормализации сравнения вида host === "api.z.ai" пропускали бы "API.Z.ai",
// встречающийся в настройках пользователей.
function normalizeHost(value: string | null | undefined): string | null {
  const parsed = parseUrl(value ?? null);
  return parsed ? parsed.hostname.toLowerCase() : null;
}

// Путь нужен отдельно от хоста для распознавания Aliyun-эндпоинтов (/apps/anthropic):
// один и тот же хост может обслуживать несколько протоколов, и различает их именно путь.
function normalizePathname(value: string | null | undefined): string | null {
  const parsed = parseUrl(value ?? null);
  return parsed ? parsed.pathname.replace(/\/+$/, "").toLowerCase() : null;
}

// Человекочитаемая метка из hostname для «остальных» провайдеров: убираем www и
// капитализируем сегменты - фолбэк для отображения, когда семейство не распознано.
// Это не идентификация: подпись не влияет на решения о квотах и аутентификации.
function formatHostLabel(hostname: string | null): string {
  if (!hostname) return "Anthropic-compatible";
  return (
    hostname
      // Цепочка вызовов читается сверху вниз: убрать www, разбить по точкам, выкинуть
      // пустые сегменты (могут появиться от двойной точки), капитализировать каждый и
      // собрать обратно.
      .replace(/^www\./, "")
      .split(".")
      .filter((segment) => segment.length > 0)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(".")
  );
}

// Отпечаток аккаунта - sha256 от "origin|key", обрезанный до 16 hex-символов.
// Обрезка осознана: цель не криптографическая защита, а группировка снимков «один
// аккаунт на одном хосте» в UI, и 64 бит для этого достаточно. Origin входит в хеш,
// потому что один и тот же ключ на разных провайдерах - это разные аккаунты. Сам ключ
// нигде не сохраняется: хеш обратно к нему не разворачивается.
function computeAccountFingerprint(origin: string | null, apiKey: string | null): string | null {
  // Без ключа отпечаток бессмысленен: он опознаёт аккаунт, а не провайдера.
  if (!apiKey) return null;
  // Origin входит в область хеша: один и тот же ключ на разных хостах - разные
  // аккаунты, поэтому и отпечатки должны различаться.
  const scope = origin ?? DEFAULT_ANTHROPIC_BASE_URL;
  // sha256 от «область|ключ»: одна и та же пара всегда дает один отпечаток, а сам
  // ключ в него необратимо не восстанавливается.
  return createHash("sha256").update(`${scope}|${apiKey}`).digest("hex").slice(0, 16);
}

// Чтение ~/.claude/settings.json - настроек Claude Code. Два независимых try/catch -
// два разных режима отказа: файла может не быть (свежая машина) или он может быть
// повреждён (ручная правка JSON). Оба означают «локальной информации нет», а не сбой
// модуля: идентичность строится и без файла.
function readClaudeLocalSettings(): ClaudeLocalSettingsIdentity | null {
  // let без инициализатора: присваивание происходит в try, а catch завершается return,
  // поэтому после блока переменная гарантированно определена.
  let raw: string;
  try {
    raw = readFileSync(CLAUDE_SETTINGS_PATH, "utf8");
  } catch {
    return null;
  }

  let parsedJson: unknown;
  try {
    // JSON.parse бросает SyntaxError на повреждённом файле: это не сбой модуля, а
    // отсутствие локальных настроек, поэтому второй catch возвращает null.
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = asRecord(parsedJson);
  // Опциональные цепочки env?. и env[..]: asRecord может вернуть null, и ?. корректно
  // сворачивает обращение в undefined вместо исключения. Чтение идет по одной ветке
  // вложенности за раз - каждая проверяется своим asRecord выше.
  const env = asRecord(parsed?.env);
  // ANTHROPIC_AUTH_TOKEN имеет приоритет над ANTHROPIC_API_KEY: первый - конвенция
  // сторонних прокси (Z.AI и подобные), второй - родной Anthropic; провайдеры со своим
  // токеном часто называют его именно AUTH_TOKEN.
  const baseUrl = normalizeBaseUrl(readString(env?.ANTHROPIC_BASE_URL));
  const authToken = readString(env?.ANTHROPIC_AUTH_TOKEN) ?? readString(env?.ANTHROPIC_API_KEY);

  if (!baseUrl && !authToken) {
    // Файл есть, но о провайдере в нем ничего нет: считаем это отсутствием локальных
    // настроек, а не пустым объектом - так потребители видят единый «нет данных».
    return null;
  }

  return {
    baseUrl,
    authToken,
  };
}

// Тестовый шов работает по `!== undefined`, а не по truthiness: передача null -
// легитимная просьба «настроек нет», и её нельзя спутать с «не вмешиваться».
function resolveLocalSettingsIdentity(
  input: ResolveClaudeProviderIdentityInput,
): ClaudeLocalSettingsIdentity | null {
  if (input.localSettingsOverride !== undefined) {
    return input.localSettingsOverride;
  }

  // Читать файл имеет смысл только для транспортов sdk/cli: api-транспорт в него
  // вообще не заглядывает, и притворное чтение породило бы призрачные настройки.
  if (input.transport === "sdk" || input.transport === "cli") {
    return readClaudeLocalSettings();
  }

  return null;
}

// Особенность Z.AI: если эндпоинт настроен через Claude Code, реальный токен
// пользователя лежит в файле, а ключ уровня профиля относится к другому аккаунту
// (например, к anthropic). Для sdk/cli + zai верим файлу, а не профилю.
function shouldPreferLocalSettingsAuthToken(
  input: ResolveClaudeProviderIdentityInput,
  localSettings: ClaudeLocalSettingsIdentity | null,
  resolvedBaseUrl: string | null,
): boolean {
  if (!localSettings?.authToken) {
    return false;
  }

  const transport = readString(input.transport);
  if (transport !== "sdk" && transport !== "cli") {
    return false;
  }

  const family = resolveProviderFamily(
    resolvedBaseUrl ?? localSettings.baseUrl ?? null,
    input.providerId ?? null,
    localSettings.authToken,
  );

  return family === ClaudeProviderFamily.ZAI_GLM_CODING;
}

// Цепочка приоритета поиска ключа, от явного к неявному: (1) локальные настройки для
// Z.AI, (2) литеральное значение из профиля, (3) названная в профиле переменная
// окружения, (4) переменные, угаданные по хосту, (5) токен из локальных настроек.
// Совпадение на любом шаге возвращает и значение, и имя источника, чтобы дальше никто
// не гадал повторно.
function resolveConfiguredApiKey(
  input: ResolveClaudeProviderIdentityInput,
  localSettings: ClaudeLocalSettingsIdentity | null,
  resolvedBaseUrl: string | null,
): { apiKey: string | null; apiKeyEnvVar: string | null } {
  if (shouldPreferLocalSettingsAuthToken(input, localSettings, resolvedBaseUrl)) {
    return {
      apiKey: localSettings?.authToken ?? null,
      apiKeyEnvVar: "ANTHROPIC_AUTH_TOKEN",
    };
  }

  if (input.apiKey) {
    return {
      apiKey: readString(input.apiKey),
      apiKeyEnvVar: readString(input.apiKeyEnvVar),
    };
  }

  // Переменная названа, но пуста: не возвращаем её и продолжаем поиск - устаревшая
  // ссылка в профиле не повод потерять рабочий ключ из окружения.
  const env = input.env ?? process.env;
  const explicitEnvVar = readString(input.apiKeyEnvVar);
  if (explicitEnvVar) {
    const explicitValue = readString(env[explicitEnvVar]);
    if (explicitValue) {
      return {
        apiKey: explicitValue,
        apiKeyEnvVar: explicitEnvVar,
      };
    }
  }

  const host = normalizeHost(resolvedBaseUrl);
  const path = normalizePathname(resolvedBaseUrl);
  const providerId = (input.providerId ?? "").trim().toLowerCase();

  // Set кандидатов: порядок вставки важен (for..of обходит Set именно в порядке
  // добавления), поэтому при нескольких определённых переменных побеждает первая
  // гипотеза, а не случайная из хеш-таблицы.
  const candidateEnvVars = new Set<string>();
  if (host === "api.z.ai" || host === "open.bigmodel.cn" || host === "dev.bigmodel.cn") {
    // Z.AI исторически принимает и собственные токены, и ANTHROPIC_AUTH_TOKEN. Та же
    // тройка хостов используется в resolveProviderFamily: правила распознавания
    // провайдера живут в двух местах, и менять их нужно согласованно.
    candidateEnvVars.add("ANTHROPIC_AUTH_TOKEN");
    candidateEnvVars.add("ZAI_API_KEY");
  }
  if (host?.includes("coding.dashscope.aliyuncs.com")) {
    candidateEnvVars.add("DASHSCOPE_API_KEY");
    candidateEnvVars.add("OPENAI_API_KEY");
    candidateEnvVars.add("ANTHROPIC_AUTH_TOKEN");
  }
  if (providerId === "anthropic" || !resolvedBaseUrl) {
    // Отсутствие baseUrl означает дефолтный эндпоинт SDK, то есть родной Anthropic -
    // стандартные переменные тоже становятся кандидатами.
    candidateEnvVars.add("ANTHROPIC_API_KEY");
    candidateEnvVars.add("ANTHROPIC_AUTH_TOKEN");
  }
  if (path?.includes("/apps/anthropic")) {
    candidateEnvVars.add("ANTHROPIC_AUTH_TOKEN");
  }

  for (const envVar of candidateEnvVars) {
    // Возвращается explicitEnvVar ?? envVar: если имя было зафиксировано профилем, оно
    // сохраняется в apiKeyEnvVar даже когда само значение взято из угаданной переменной.
    const value = readString(env[envVar]);
    if (value) {
      return {
        apiKey: value,
        apiKeyEnvVar: explicitEnvVar ?? envVar,
      };
    }
  }

  if (localSettings?.authToken) {
    // Последний шанс перед сдачей: токен из файла, если ничего другого не подошло.
    // Явно названная в профиле переменная всё ещё приоритетна для имени источника.
    return {
      apiKey: localSettings.authToken,
      apiKeyEnvVar: explicitEnvVar ?? "ANTHROPIC_AUTH_TOKEN",
    };
  }

  return {
    apiKey: null,
    apiKeyEnvVar: explicitEnvVar,
  };
}

// Главная функция распознавания семейства. Порядок проверок - от частного к общему:
// один и тот же URL формально может подойти под несколько шаблонов (например, путь
// /apps/anthropic на чужом хосте), поэтому сначала точное совпадение хоста, потом
// эвристики по пути/префиксу ключа, и только затем native и catch-all.
function resolveProviderFamily(
  baseUrl: string | null,
  providerId: string | null,
  apiKey: string | null,
): ClaudeProviderFamily {
  // Хост и путь нормализуются один раз: далее сравнения идут по уже каноничным строкам,
  // а опциональный `?.includes` спасает от null, когда URL не распознан вообще.
  const host = normalizeHost(baseUrl);
  const path = normalizePathname(baseUrl);
  const normalizedProviderId = (providerId ?? "").toLowerCase();

  if (host === "api.z.ai" || host === "open.bigmodel.cn" || host === "dev.bigmodel.cn") {
    return ClaudeProviderFamily.ZAI_GLM_CODING;
  }

  if (host?.includes("coding.dashscope.aliyuncs.com") && path?.includes("/apps/anthropic")) {
    // Оба признака обязательны: хост указывает на Alibaba, а путь - на антропический
    // фасад того же сервиса (там же может жить и OpenAI-совместимый интерфейс).
    return ClaudeProviderFamily.ALIYUN_CODING_PLAN_ANTHROPIC;
  }

  if (apiKey?.startsWith("sk-sp-")) {
    // Префикс sk-sp- - маркер coding-плана Alibaba: по нему семейство опознаётся даже
    // когда baseUrl не содержит dashscope (прокси, свой домен). Это эвристика, а не
    // гарантия: если префикс переймут другие, они попадут в это семейство - известный
    // компромисс в пользу простоты.
    return ClaudeProviderFamily.ALIYUN_CODING_PLAN_ANTHROPIC;
  }

  if (!baseUrl && normalizedProviderId === "anthropic") {
    // Профиль с providerId "anthropic" без явного URL - это SDK на своём дефолтном
    // эндпоинте, то есть тоже родной Anthropic.
    return ClaudeProviderFamily.ANTHROPIC_NATIVE;
  }

  if (host === "api.anthropic.com" || host?.endsWith(".anthropic.com")) {
    // Помимо точного хоста ловятся и поддомены компании: региональные или
    // корпоративные эндпоинты Anthropic ведут себя как родной провайдер по квотам.
    return ClaudeProviderFamily.ANTHROPIC_NATIVE;
  }

  // Catch-all для всего остального: протокол, скорее всего, антропический, но
  // о квотах и конвенциях именования мы ничего не знаем - и не делаем вид, что знаем.
  return ClaudeProviderFamily.OTHER_ANTHROPIC_COMPATIBLE;
}

// Метка для человека: фиксированное имя для известных семейств и отформатированный
// hostname в остальных случаях. switch исчерпывающий по смыслу, а default играет роль
// ветки «остальные», а не заглушки.
function resolveProviderLabel(family: ClaudeProviderFamily, baseUrl: string | null): string {
  // switch по union-типу читается как таблица соответствия, а default - это ветка
  // «остальные», а не заглушка: для неизвестных семейств берется метка из хоста.
  switch (family) {
    case ClaudeProviderFamily.ANTHROPIC_NATIVE:
      return "Anthropic";
    case ClaudeProviderFamily.ZAI_GLM_CODING:
      return "Z.AI GLM Coding Plan";
    case ClaudeProviderFamily.ALIYUN_CODING_PLAN_ANTHROPIC:
      return "Alibaba Coding Plan";
    default:
      return formatHostLabel(normalizeHost(baseUrl));
  }
}

// Выбор источника квот по семейству и транспорту. Для родного Anthropic с api-
// транспортом доступны HTTP-заголовки (ratelimit-*), а для sdk/cli остаются только
// события потока. Z.AI - монитор-эндпоинт, другого канала у него нет. Alibaba - none,
// и это факт о провайдере, а не забытая ветка.
function resolveQuotaSource(
  family: ClaudeProviderFamily,
  transport: string | null | undefined,
): ClaudeProviderIdentity["quotaSource"] {
  switch (family) {
    case ClaudeProviderFamily.ZAI_GLM_CODING:
      return "zai_monitor";
    case ClaudeProviderFamily.ANTHROPIC_NATIVE:
      return transport === "api" ? "headers" : "sdk_event";
    case ClaudeProviderFamily.ALIYUN_CODING_PLAN_ANTHROPIC:
      return "none";
    default:
      return transport === "api" ? "headers" : "sdk_event";
  }
}

// Сборка контекста аутентификации: явный baseUrl из профиля приоритетнее взятого из
// локальных настроек - профилем управляют из UI, а файл на машине под ответственностью
// пользователя, который мог забыть о его существовании.
function resolveAuthContext(input: ResolveClaudeProviderIdentityInput): ResolvedAuthContext {
  // Порядок вычислений важен: сначала локальные настройки (из файла или оверрайда),
  // затем нормализация явного URL из профиля, и только потом выбор приоритета между ними.
  const localSettings = resolveLocalSettingsIdentity(input);
  const explicitBaseUrl = normalizeBaseUrl(input.baseUrl);
  const localBaseUrl = localSettings?.baseUrl ?? null;
  // Явный URL профиля важнее: профиль редактируется из UI и предполагает намеренное
  // решение, а локальный файл пользователь мог оставить с прошлых экспериментов.
  const baseUrl = explicitBaseUrl ?? localBaseUrl;
  const { apiKey, apiKeyEnvVar } = resolveConfiguredApiKey(input, localSettings, baseUrl);

  return {
    baseUrl,
    // baseOrigin с фолбэком на api.anthropic.com: отпечаток аккаунта должен быть
    // устойчив для всех запусков «без URL», иначе один и тот же аккаунт превращался бы
    // в несколько анонимных записей в истории квот.
    baseOrigin: normalizeBaseOrigin(baseUrl) ?? DEFAULT_ANTHROPIC_BASE_URL,
    apiKey,
    apiKeyEnvVar,
    localSettings,
  };
}

// Публичная точка входа для случаев, когда сам токен не нужен: идентичность требуется
// для нормализации квот (limit.ts) и для отображения в UI.
export function resolveClaudeProviderIdentity(
  input: ResolveClaudeProviderIdentityInput,
): ClaudeProviderIdentity {
  const authContext = resolveAuthContext(input);
  // Семейство и метка выводятся только из уже принятых в resolveAuthContext решений
  // (URL и ключ): расхождения между полями идентичности невозможны по построению.
  const family = resolveProviderFamily(
    authContext.baseUrl,
    input.providerId ?? null,
    authContext.apiKey,
  );
  const providerLabel = resolveProviderLabel(family, authContext.baseUrl);
  const accountFingerprint = computeAccountFingerprint(authContext.baseOrigin, authContext.apiKey);

  return {
    providerFamily: family,
    providerLabel,
    quotaSource: resolveQuotaSource(family, input.transport),
    baseUrl: authContext.baseUrl,
    baseOrigin: authContext.baseOrigin,
    apiKeyEnvVar: authContext.apiKeyEnvVar,
    accountFingerprint,
    accountLabel: null,
  };
}

// Та же идентичность, но с resolved-ключом наружу. Секрет покидает модуль только
// через эту функцию и отдельным полем, никогда внутри identity: identity
// сериализуется в БД и логи, а ключ - нет.
export function resolveClaudeProviderAuth(input: ResolveClaudeProviderIdentityInput): {
  identity: ClaudeProviderIdentity;
  authToken: string | null;
} {
  const authContext = resolveAuthContext(input);
  // Тот же расчёт, что и в resolveClaudeProviderIdentity, плюс возврат ключа: тело
  // продублировано осознанно - так единственным источником истины остается
  // resolveAuthContext, а секрет не «просачивается» через саму структуру identity.
  const family = resolveProviderFamily(
    authContext.baseUrl,
    input.providerId ?? null,
    authContext.apiKey,
  );
  const providerLabel = resolveProviderLabel(family, authContext.baseUrl);

  return {
    identity: {
      providerFamily: family,
      providerLabel,
      quotaSource: resolveQuotaSource(family, input.transport),
      baseUrl: authContext.baseUrl,
      baseOrigin: authContext.baseOrigin,
      apiKeyEnvVar: authContext.apiKeyEnvVar,
      accountFingerprint: computeAccountFingerprint(authContext.baseOrigin, authContext.apiKey),
      accountLabel: null,
    },
    authToken: authContext.apiKey,
  };
}
