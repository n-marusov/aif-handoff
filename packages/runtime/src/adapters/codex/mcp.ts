/**
 * Мост конфигурации MCP-серверов для Codex.
 *
 * Codex хранит MCP-серверы в своём единственном файле ~/.codex/config.toml, в таблицах
 * вида [mcp_servers.<имя>]. Этот модуль умеет читать оттуда статус, устанавливать и удалять
 * запись, ничего не ломая в остальном файле.
 *
 * Почему вместо честного парсинга и сборки TOML здесь есть ручная работа со строками при
 * удалении: полноценный round-trip через библиотеку потерял бы комментарии и форматирование
 * пользователя. Поэтому разбор идёт парсером (безопасно), а вырезание секции — построчно,
 * чтобы сохранить все чужие строки байт в байт.
 *
 * Все данные читаются защитно: TOML — внешний, редактируемый руками файл, и любое поле
 * может отсутствовать или иметь не тот тип. Битые узлы молча пропускаются, а не роняют установку.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { RuntimeMcpInput, RuntimeMcpInstallInput, RuntimeMcpStatus } from "../../types.js";

// Путь зашит константой: у Codex нет отдельного API для MCP-конфига, только файл.
const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

// Сужённое представление записи MCP-сервера. extends Record<string, unknown> нужен,
// чтобы объект можно было отдавать в stringifyToml как произвольный TOML-блок.
interface CodexMcpServerEntry extends Record<string, unknown> {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  bearer_token_env_var?: string;
}

// Type guard для unknown -> Record. Проверка на массив обязательна: typeof [] === "object",
// но TOML-таблица и JSON-массив — разные вещи, и без этого [] прошёл бы как объект.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Не-массив трактуем как пустой список: у MCP-записи args может отсутствовать,
// и вызывающему удобнее всегда получать массив, чем разбираться с undefined.
function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  // filter с предикатом-типом отбрасывает нестроковые элементы и сужает тип до string[].
  return value.filter((item): item is string => typeof item === "string");
}

// Возвращает undefined (а не {}) для непригодного env: это позволяет выше отличить
// "env не задан" от "env пустой" и не создавать лишнюю секцию в TOML.
function normalizeEnv(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  if (entries.length === 0) {
    return undefined;
  }

  // Сортировка ключей даёт стабильный результат: файл конфига не меняется от запуска к
  // запуску, а значит не появляются ложные диффы в git и в проверках идемпотентности.
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) as Record<
    string,
    string
  >;
}

// Приводит произвольный TOML-узел к известной форме или возвращает null.
// null здесь — это "запись непригодна", что позволяет вызывающему просто пропустить её.
function normalizeServerEntry(value: unknown): CodexMcpServerEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const entry: CodexMcpServerEntry = {};

  // Копируем только поля, которые реально присутствуют и имеют верный тип:
  // так мы не протащим мусор и не перезапишем валидные значения undefined.
  if (typeof value.url === "string") {
    entry.url = value.url;
  }

  if (typeof value.command === "string") {
    entry.command = value.command;
    // args есть смысл читать только вместе с command: у HTTP-сервера их не бывает.
    entry.args = normalizeStringArray(value.args);
  }

  // Без url и без command запускать нечего — такая запись бессмысленна, отбрасываем её.
  if (!entry.url && !entry.command) {
    return null;
  }

  if (typeof value.cwd === "string") {
    entry.cwd = value.cwd;
  }

  const env = normalizeEnv(value.env);
  // Проверка на truthy, а не на != null: normalizeEnv отдаёт undefined для пустого env,
  // и тогда поле просто не появляется в нормализованной записи.
  if (env) {
    entry.env = env;
  }

  if (typeof value.bearer_token_env_var === "string") {
    entry.bearer_token_env_var = value.bearer_token_env_var;
  }

  return entry;
}

// Разбор всего файла: нужна только таблица mcp_servers, остальное не наше дело.
function parseMcpServers(toml: string): Record<string, CodexMcpServerEntry> {
  // Пустой файл — штатная ситуация (свежая установка), не гоняем парсер впустую.
  if (!toml.trim()) {
    return {};
  }

  try {
    // parseToml бросает на синтаксически битом TOML — обрабатываем ниже.
    // as {...} затем сужается isRecord (Nullable Cast Rule: тип не отбрасывает возможность null/мусора).
    const parsed = parseToml(toml) as { mcp_servers?: unknown };
    if (!isRecord(parsed.mcp_servers)) {
      return {};
    }

    const servers: Record<string, CodexMcpServerEntry> = {};
    for (const [name, value] of Object.entries(parsed.mcp_servers)) {
      const entry = normalizeServerEntry(value);
      // Пропускаем непригодные записи, а не падаем: чужой мусор в конфиге не повод
      // ломать работу с остальными, валидными MCP-серверами.
      if (entry) {
        servers[name] = entry;
      }
    }

    return servers;
  } catch {
    // Битый TOML трактуем как отсутствие серверов: установка потом перезапишет секцию.
    return {};
  }
}

// Сериализация одной записи в готовый TOML-фрагмент с заголовком таблицы.
// Собираем промежуточный объект вручную: stringifyToml не умеет пропускать поля,
// а нам нужно, чтобы в файл попало только заданное (иначе появятся пустые args/env).
function serializeMcpSection(name: string, entry: CodexMcpServerEntry): string {
  const serverConfig: Record<string, unknown> = {};
  if (entry.url) {
    serverConfig.url = entry.url;
  }
  if (entry.command) {
    serverConfig.command = entry.command;
  }
  if (entry.args && entry.args.length > 0) {
    // Пустой args не пишем: для stdio-сервера без аргументов ключ только мешает.
    serverConfig.args = entry.args;
  }
  if (entry.cwd) {
    serverConfig.cwd = entry.cwd;
  }
  if (entry.env && Object.keys(entry.env).length > 0) {
    // Повторная сортировка перед сериализацией: записи, пришедшей извне (не из парсера),
    // она тоже нужна, чтобы результат оставался детерминированным.
    serverConfig.env = Object.fromEntries(
      Object.entries(entry.env).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  if (entry.bearer_token_env_var) {
    serverConfig.bearer_token_env_var = entry.bearer_token_env_var;
  }

  // stringifyToml ставит перевод строки в конце — trim() убирает его, чтобы вызывающий
  // сам решал, как разделять блоки в общем файле.
  return stringifyToml({
    mcp_servers: {
      [name]: serverConfig,
    },
  }).trim();
}

// Удаление секции сервера построчно. Главная причина не использовать парсер: round-trip
// переформатировал бы весь файл и уничтожил комментарии пользователя.
function removeServerSections(toml: string, serverName: string): string {
  const mainSectionHeader = `[mcp_servers.${serverName}]`;
  // Секция env — отдельная вложенная таблица, её надо вырезать вместе с основной.
  const envSectionHeader = `[mcp_servers.${serverName}.env]`;
  // Регексп любого заголовка секции: служит маркером конца вырезаемого блока.
  const sectionHeaderRegex = /^\[[^\]]+]\s*$/;
  const keptLines: string[] = [];
  let skipping = false;

  for (const line of toml.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === mainSectionHeader || trimmed === envSectionHeader) {
      // Нашли целевую секцию: дальше пропускаем строки до следующего заголовка.
      skipping = true;
      continue;
    }

    if (skipping && sectionHeaderRegex.test(trimmed)) {
      // Встретили чужую секцию — она уже не наша, прекращаем вырезать.
      skipping = false;
    }

    if (!skipping) {
      keptLines.push(line);
    }
  }

  return (
    keptLines
      .join("\n")
      // Схлопываем тройные переводы строки: после вырезания секции остаются двойные пустые
      // строки, и файл выглядит неряшливо при повторных установках/удалениях.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// Отсутствующий или недоступный файл — это пустая строка, а не ошибка:
// установку в этом случае надо просто создать с нуля.
async function readToml(): Promise<string> {
  try {
    return await readFile(CODEX_CONFIG_PATH, "utf-8");
  } catch {
    return "";
  }
}

// Каталог ~/.codex может не существовать на свежей машине, поэтому создаём его
// рекурсивно перед записью — иначе writeFile упадёт с ENOENT.
async function writeToml(content: string): Promise<void> {
  const dir = dirname(CODEX_CONFIG_PATH);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(CODEX_CONFIG_PATH, content, "utf-8");
}

export async function getCodexMcpStatus(input: RuntimeMcpInput): Promise<RuntimeMcpStatus> {
  const toml = await readToml();
  const servers = parseMcpServers(toml);
  // in вместо чтения значения: проверяем только наличие записи, содержимое не интересует.
  const installed = input.serverName in servers;
  return {
    installed,
    serverName: input.serverName,
    // Возвращаем null, а не undefined: контракт RuntimeMcpStatus требует явной формы,
    // а вызывающий обязан проверить installed перед доступом к config.
    config: installed ? servers[input.serverName] : null,
  };
}

// Установка сделана как upsert: сначала удаляем старую секцию с тем же именем,
// затем добавляем свежую. Так повторный вызов никогда не даёт дубликатов —
// идемпотентность важнее минимальности записи.
export async function installCodexMcpServer(input: RuntimeMcpInstallInput): Promise<void> {
  let toml = await readToml();
  toml = removeServerSections(toml, input.serverName);

  // Форма записи диктуется транспортом: у HTTP-сервера есть url и имя переменной
  // с токеном, у stdio — команда, аргументы, рабочий каталог и окружение.
  const entry: CodexMcpServerEntry =
    input.transport === "streamable_http"
      ? {
          url: input.url,
          bearer_token_env_var: input.bearerTokenEnvVar,
        }
      : {
          command: input.command,
          args: input.args ?? [],
          cwd: input.cwd,
          env: input.env,
        };

  const section = serializeMcpSection(input.serverName, entry);

  // Две ветки склейки: в непустой файл добавляем пустую строку-разделитель,
  // в пустой — только саму секцию.
  toml = toml ? `${toml}\n\n${section}\n` : `${section}\n`;
  await writeToml(toml);
}

export async function uninstallCodexMcpServer(input: RuntimeMcpInput): Promise<void> {
  // После вырезания файл может остаться пустым или начать с лишних переводов строк —
  // тернарник нормализует оба случая.
  const toml = removeServerSections(await readToml(), input.serverName);
  await writeToml(toml ? `${toml}\n` : "");
}
