/**
 * Работа с файлом конфигурации Codex (~/.codex/config.toml).
 *
 * Главная причина существования модуля: Codex CLI читает адрес OpenAI-совместимого шлюза
 * (router.ai и подобные) только из config.toml — переменные OPENAI_BASE_URL / CODEX_BASE_URL
 * он намеренно игнорирует. Поэтому перед запуском CLI мы дописываем в конфиг блок провайдера
 * и выбираем его как model_provider.
 *
 * Инвариант: запись идемпотентна и не разрушает чужие настройки (MCP-серверы, доверие к
 * проектам, другие провайдеры). Ошибки записи не фатальны — конфиг может быть только для
 * чтения; вызывающий просто получает имена и путь и логирует предупреждение.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@aif/shared";

const log = logger("codex-config");

// CODEX_HOME позволяет изолировать конфиг (например, в тестах или в контейнере),
// поэтому переменная окружения приоритетнее домашнего каталога.
/** Возвращает домашний каталог Codex ($CODEX_HOME или ~/.codex). */
export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/** Выводит стабильное имя провайдера из хоста base URL (например routerai.ru → routerai). */
export function providerNameFromBaseUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname;
    // Берём только первый лейбл домена: имя провайдера в TOML читаемо и не содержит дефисов.
    // ?? "custom" на случай пустого лейбла (например, для IPv4-адреса).
    return host.split(".")[0] ?? "custom";
  } catch {
    // new URL бросает на невалидном baseUrl — откатываемся на безопасное имя, а не падаем.
    return "custom";
  }
}

export interface EnsureCodexProviderConfigInput {
  baseUrl: string;
  apiKeyEnvVar: string;
  /** Необязательный default id модели, объявляемый в блоке провайдера. */
  model?: string | null;
  /** Wire API провайдера. Codex CLI v0.145 использует `responses` для кастомных провайдеров. */
  wireApi?: string;
  /** Явное имя провайдера; по умолчанию — первый лейбл хоста baseUrl. */
  providerName?: string;
}

// Простая проверка наличия блока по заголовку [model_providers.<name>]: полноценный
// TOML-парсер здесь избыточен, а ложное срабатывание возможно лишь при точном совпадении.
function blockExists(configText: string, header: string): boolean {
  return configText.includes(header);
}

/**
 * Гарантирует, что `~/.codex/config.toml` объявляет кастомного model provider
 * на настроенный base URL и выбирает его как `model_provider`. Это обязательно
 * для локальных Codex CLI транспортов против OpenAI-совместимых шлюзов
 * (например router.ai): CLI читает `model_providers.<name>.base_url` из
 * config.toml и игнорирует env OPENAI_BASE_URL / CODEX_BASE_URL (см.
 * BLOCKED_ENV_KEYS в cli.ts).
 *
 * Идемпотентно: существующее содержимое (MCP-серверы, доверие проектов, другие
 * провайдеры) сохраняется; блок провайдера дописывается только при отсутствии,
 * и верхнеуровневый ключ `model_provider` ставится один раз. Ошибки не
 * фатальны — вызывающий логирует их.
 */
export function ensureCodexProviderConfig(input: EnsureCodexProviderConfigInput): {
  providerName: string;
  configPath: string;
} {
  const providerName =
    input.providerName?.trim() || providerNameFromBaseUrl(input.baseUrl) || "custom";
  const configPath = join(codexHome(), "config.toml");
  // Заголовок служит одновременно ключом идемпотентности и якорем для будущей замены блока.
  const header = `[model_providers.${providerName}]`;

  try {
    // recursive: конфиг может отсутствовать вместе с каталогом ~/.codex (свежая машина).
    mkdirSync(codexHome(), { recursive: true });
    // Читаем терпимо: отсутствующий файл — это пустая строка, а не ошибка.
    const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";

    if (blockExists(existing, header)) {
      log.debug({ providerName, configPath }, "Codex provider config already present");
      return { providerName, configPath };
    }

    // Блок собирается построчно из массива: так проще сверять формат и добавлять
    // опциональные поля условно, не склеивая строки вручную.
    const providerBlock = [
      "",
      header,
      `name = "${providerName}"`,
      `base_url = "${input.baseUrl.replace(/\/+$/, "")}"`,
      `env_key = "${input.apiKeyEnvVar}"`,
      `wire_api = "${input.wireApi ?? "responses"}"`,
      // model добавляется только если он непустой: пустое значение сбивает CLI с толку.
      ...(input.model?.trim() ? [`model = "${input.model.trim()}"`] : []),
      "",
    ].join("\n");

    // model_provider — top-level ключ: в TOML он должен стоять до первого заголовка таблицы,
    // иначе достанется последнему блоку. Отсюда две ветки: заменить существующий ключ
    // (регулярка по началу строки) либо вставить строку в самое начало файла.
    const hasModelProvider = /^model_provider\s*=/.test(existing);
    // trimEnd + гарантированный перевод строки: без него два TOML-выражения склеятся.
    const body = existing.trimEnd() + (existing.trim().length > 0 ? "\n" : "") + providerBlock;
    const withSelection = hasModelProvider
      ? body.replace(/^model_provider\s*=.*$/m, `model_provider = "${providerName}"`)
      : `model_provider = "${providerName}"\n` + body;

    writeFileSync(configPath, withSelection, { encoding: "utf8" });
    log.info(
      { providerName, configPath, baseUrl: input.baseUrl },
      "Configured Codex model provider",
    );
    return { providerName, configPath };
  } catch (err) {
    // Ошибка записи не пробрасывается: адаптер продолжит работу, а пользователь увидит
    // предупреждение с причиной. Возвращаем вычисленные значения в любом случае.
    log.warn(
      { providerName, configPath, err: err instanceof Error ? err.message : String(err) },
      "Failed to write Codex provider config",
    );
    return { providerName, configPath };
  }
}
