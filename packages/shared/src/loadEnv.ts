/**
 * Загрузка корневых .env-файлов для всех Node-пакетов монорепозитория.
 *
 * Порядок разрешения значений: .env, затем .env.local (переопределяет первый) и в
 * последнюю очередь уже заданное извне process.env - оно имеет высший приоритет, поэтому
 * переменные, переданные контейнером, не перебиваются файлами на диске.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { findMonorepoRootFromUrl } from "./monorepoRoot.js";

// Пути считаются от корня монорепозитория, а не от cwd: пакеты запускаются из разных
// рабочих каталогов, а .env в проекте один.
const MONOREPO_ROOT = findMonorepoRootFromUrl(import.meta.url);
const ROOT_ENV_PATH = resolve(MONOREPO_ROOT, ".env");
const ROOT_ENV_LOCAL_PATH = resolve(MONOREPO_ROOT, ".env.local");

// Флаг идемпотентности: функция вызывается из нескольких мест (в том числе побочным
// импортом логгера), а читать и разбирать те же файлы повторно незачем.
let envLoaded = false;

/**
 * Загружает корневые .env-файлы один раз для всех Node-пакетов. Сначала применяется
 * .env, затем его переопределяет .env.local. Явно заданные переменные окружения процесса
 * имеют приоритет над обоими файлами.
 */
export function ensureRootEnvLoaded(): void {
  if (envLoaded) return;

  // Во время тестов .env не загружается: окружение задаётся через vi.stubEnv или
  // process.env, и файл на диске перебил бы подстановки.
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    envLoaded = true;
    return;
  }

  const resolvedEnv: Record<string, string> = {};

  if (existsSync(ROOT_ENV_PATH)) {
    Object.assign(resolvedEnv, parseDotenv(readFileSync(ROOT_ENV_PATH)));
  }
  if (existsSync(ROOT_ENV_LOCAL_PATH)) {
    Object.assign(resolvedEnv, parseDotenv(readFileSync(ROOT_ENV_LOCAL_PATH)));
  }

  // Записывается только то, что ещё не задано: реальное окружение процесса важнее
  // файлов на диске, иначе .env перетирал бы параметры контейнера.
  for (const [key, value] of Object.entries(resolvedEnv)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  envLoaded = true;
}

// Побочный эффект на уровне модуля: любой импорт этого файла сразу применяет
// корневой .env, поэтому порядок импортов в пакетах значим.
ensureRootEnvLoaded();
