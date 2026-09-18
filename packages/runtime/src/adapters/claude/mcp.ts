/**
 * Управление записью MCP-сервера handoff в пользовательских настройках Claude Code.
 *
 * Claude Code хранит список mcpServers в ~/.claude.json, и установщик из Web UI
 * пишет туда напрямую. Альтернатива — просить пользователя выполнить `claude mcp
 * add` руками, но тогда теряются и идемпотентность, и возможность показать
 * результат в интерфейсе.
 *
 * Все три операции читают и перезаписывают конфиг целиком по одному принципу: файл
 * принадлежит пользователю, и всё, что не касается mcpServers, должно остаться
 * нетронутым (сохранение неизвестных ключей — причина индексной сигнатуры в
 * ClaudeConfig).
 */

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeMcpInput, RuntimeMcpInstallInput, RuntimeMcpStatus } from "../../types.js";

// Путь вычисляется при импорте модуля: homedir() не меняется в течение жизни
// процесса, а держать его в константе удобнее, чем пересчитывать на каждом вызове.
const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");

// Индексная сигнатура — не для удобства, а ради живучести чужих данных: в файле
// лежат десятки пользовательских настроек, и перезапись после install не должна
// их терять. Типизировано только то, что мы действительно читаем.
interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

async function readConfig(): Promise<ClaudeConfig> {
  // Отсутствующий и битый конфиг обрабатываются одинаково — как «пустой». Плюс:
  // установка работает до первого запуска claude, когда файла ещё нет.
  // Осознанный компромисс: после битого JSON установка перезапишет файл целиком,
  // и это допустимо для личного конфига CLI (резервной копии мы не делаем).
  try {
    const raw = await readFile(CLAUDE_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as ClaudeConfig;
  } catch {
    return {};
  }
}

async function writeConfig(config: ClaudeConfig): Promise<void> {
  // Отступ в два пробела и завершающий перевод строки — не прихоть: файл читают и
  // правят люди, и такой формат даёт минимальный diff в их правках и в git.
  await writeFile(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export async function getClaudeMcpStatus(input: RuntimeMcpInput): Promise<RuntimeMcpStatus> {
  const config = await readConfig();
  // Оператор in, а не истинность значения: запись может существовать с любым
  // содержимым (объект, невалидный по нашим меркам) — для статуса «установлено»
  // достаточно самого факта ключа, а его вид отдаётся наружу как есть.
  const servers = config.mcpServers ?? {};
  const installed = input.serverName in servers;
  return {
    installed,
    serverName: input.serverName,
    config: installed ? (servers[input.serverName] as Record<string, unknown>) : null,
  };
}

export async function installClaudeMcpServer(input: RuntimeMcpInstallInput): Promise<void> {
  const config = await readConfig();
  // Секция создаётся, если её нет: запись в undefined упала бы, а отдельная ветка
  // «а если секции не было» только запутала бы код.
  if (!config.mcpServers) config.mcpServers = {};

  if (input.transport === "streamable_http") {
    // Наш транспортный нейтральный термин и словарь Claude не совпадают: у него
    // это "http". Перевод словарей — здесь, на границе с чужим конфигом.
    config.mcpServers[input.serverName] = {
      type: "http",
      url: input.url,
    };
  } else {
    // Для stdio ключи собираются условными спредами: Claude терпит отсутствие
    // cwd/env, но явный undefined в JSON превратился бы в мусорный ключ или упал бы
    // при сериализации.
    config.mcpServers[input.serverName] = {
      type: "stdio",
      command: input.command,
      args: input.args ?? [],
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.env ? { env: input.env } : {}),
    };
  }
  await writeConfig(config);
}

export async function uninstallClaudeMcpServer(input: RuntimeMcpInput): Promise<void> {
  const config = await readConfig();
  // Запись выполняется только если было что удалять: лишняя перезапись меняла бы
  // mtime файла и заставляла пользователя думать, что что-то поменялось.
  if (config.mcpServers && input.serverName in config.mcpServers) {
    delete config.mcpServers[input.serverName];
    await writeConfig(config);
  }
}
